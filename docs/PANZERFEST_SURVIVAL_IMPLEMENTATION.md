# Panzerfest & Survival Mode Implementation Plan

## Overview

Re-implementing the JayMod Panzerfest and Survival modes for ET:Legacy using a **hybrid Lua + C** approach. Lua handles game logic (tracking kills, time alive, phases) while C code applies the actual speed/fire rate multipliers.

## Feature Summary

### 1. Kill Streak Fire Rate Bonus (HUMANS ONLY)
- Every **5 kills** = +1 bonus level (max 6 levels)
- Level 1: 2x fire rate, Level 2: 3x, ... Level 6: 7x fire rate
- Resets on death

### 2. Survival Speed Bonus (HUMANS ONLY)
- Every **30 seconds alive** = +1 bonus level (max 6 levels)
- Level 1: 1.5x speed, Level 2: 2x, ... Level 6: 4x speed
- Resets on death

### 3. Panzerfest Mode (Triggered at 30 kills)
When a player reaches 30 kills:
1. **Everyone switches teams** to hunt them (except the target)
2. **Target gets max bonuses** for 30 seconds: 7x fire rate + 4x speed
3. **Phase 2 (30s)**: Both bonuses decrease every 5 seconds
4. **Phase 3 (30s)**: Speed locked at 1x, fire rate adds delay
5. **Phase 4 (30s)**: Max penalties - survive to win!
6. **If target dies**: Panzerfest ends, everyone returns to original teams
7. **If target survives 2 minutes**: LEGENDARY victory!

---

## Architecture

### Existing Infrastructure (Already in Place)

| Component | Location | Purpose |
|-----------|----------|---------|
| `rickrollSpeedScale` | `g_local.h:1025` | Per-player speed multiplier (Lua-writable) |
| Speed application | `g_active.c:1516-1518` | Applies `rickrollSpeedScale` to `ps.speed` |
| Lua field binding | `g_lua.c:1245` | Exposes `rickrollSpeedScale` to Lua |
| RocketMode pattern | `lua/rocket_mode.lua` | Example of Lua game mode |

### New Components Needed

| Component | Location | Purpose |
|-----------|----------|---------|
| `rickrollFireRateMultiplier` | `g_local.h` | Per-player fire rate multiplier |
| Fire rate application | `bg_pmove.c:PM_Weapon()` | Apply fire rate multiplier to `addTime` |
| Lua field binding | `g_lua.c` | Expose new field to Lua |
| Game mode Lua script | `lua/panzerfest_survival.lua` | All game logic |

---

## Implementation Steps

### Phase 1: C Code Modifications (Required for Fire Rate)

#### Step 1.1: Add fire rate field to g_local.h
```c
// After line 1048 (rickrollHomingRockets):
// Fire rate multiplier for kill streak / panzerfest (100 = normal, 200 = 2x faster, etc.)
int rickrollFireRateMultiplier;

// Fire rate delay in ms (for panzerfest phase 3-4, adds delay between shots)
int rickrollFireRateDelay;
```

#### Step 1.2: Expose to Lua in g_lua.c
```c
// After line 1267:
_et_gclient_addfield(rickrollFireRateMultiplier,    FIELD_INT,   0),
_et_gclient_addfield(rickrollFireRateDelay,         FIELD_INT,   0),
```

#### Step 1.3: Apply fire rate in bg_pmove.c (PM_Weapon function)

Around line 4193 (before `pm->ps->weaponTime += addTime;`):
```c
// Apply fire rate multiplier from Lua (panzerfest/kill streak)
#ifdef GAMEDLL
{
    extern gclient_t *level_clients;
    if (pm->ps->clientNum >= 0 && pm->ps->clientNum < MAX_CLIENTS) {
        gclient_t *client = &level_clients[pm->ps->clientNum];
        if (client) {
            // Apply multiplier (100 = normal, 200 = 2x faster)
            if (client->rickrollFireRateMultiplier > 0 && client->rickrollFireRateMultiplier != 100) {
                addTime = (addTime * 100) / client->rickrollFireRateMultiplier;
                if (addTime < 50) addTime = 50;  // Minimum 50ms between shots
            }
            // Apply delay (for panzerfest phase 3-4)
            if (client->rickrollFireRateDelay > 0) {
                addTime += client->rickrollFireRateDelay;
            }
        }
    }
}
#endif
```

**Note:** `level_clients` needs to be accessible. Check if there's a better way to get client data in bg_pmove.c context.

---

### Phase 2: Lua Implementation

#### Step 2.1: Create lua/panzerfest_survival.lua

```lua
--[[
    Panzerfest & Survival Mode

    Kill Streak: Every 5 kills = faster fire rate (max 7x at 30 kills)
    Survival: Every 30 seconds alive = faster movement (max 4x at 3 minutes)
    Panzerfest: At 30 kills, everyone hunts you for 2 minutes!
]]--

local mode = {}

-- Configuration (can be overridden by CVARs)
mode.config = {
    -- Kill streak fire rate bonus
    killstreakEnabled = true,
    killsPerLevel = 5,          -- Kills per bonus level
    maxKillstreakLevel = 6,     -- Max 6 levels = 7x fire rate

    -- Survival speed bonus
    survivalEnabled = true,
    survivalInterval = 30000,   -- 30 seconds per level
    maxSurvivalLevel = 6,       -- Max 6 levels = 4x speed
    speedBonusPerLevel = 50,    -- 50% per level (150%, 200%, 250%, 300%, 350%, 400%)

    -- Panzerfest
    panzerfestEnabled = true,
    panzerfestKills = 30,       -- Kills to trigger
    panzerfestDuration = 120000, -- 2 minutes total
    panzerfestCooldown = 60000, -- 1 minute cooldown
    panzerfestMultiplier = 7,   -- 7x fire rate boost (phase 1)
    panzerfestSpeedBoost = 400, -- 4x speed (400%)
}

-- State tracking
mode.playerState = {}  -- { [clientNum] = { kills, spawnTime, killstreakLevel, survivalLevel } }
mode.panzerfest = {
    active = false,
    targetClientNum = -1,
    startTime = 0,
    phase = 0,  -- 0=inactive, 1=boost, 2=both_slowdown, 3=fire_slowdown, 4=survive, 5=victory
    phaseStartTime = 0,
    lastTick = 0,
    currentMultiplier = 1,
    currentSpeedScale = 100,
    currentDelay = 0,
    originalTeams = {},  -- { [clientNum] = originalTeam }
    cooldownEndTime = 0,
}

-- Funny messages (from JayMod)
mode.phase2Messages = {
    "^3Your panzer is getting heavier...",
    "^3Your arms are getting tired!",
    "^3The panzer gods are losing interest...",
    "^3Did someone put lead in your rockets?",
    "^3Your trigger finger is cramping up!",
    "^3Keep fighting! Don't give up!"
}

mode.phase3Messages = {
    "^1Your reflexes are slowing...",
    "^1The rockets feel like bricks!",
    "^1Are you even trying anymore?",
    "^1Grandma could reload faster!",
    "^1The panzer gods are laughing!",
    "^1Almost there... hang in there!"
}

mode.failureMessages = {
    "^1COULDN'T HANDLE THE HEAT!",
    "^1ALL THAT HYPE FOR NOTHING!",
    "^1MAYBE STICK TO MEDIC NEXT TIME!",
    "^1THE PEASANTS HAVE RISEN!",
    "^1NOT SO TOUGH NOW, ARE YA?",
    "^1SKILL ISSUE DETECTED!"
}

--=============================================================================
-- HELPER FUNCTIONS
--=============================================================================

local function log(msg)
    et.G_Print("[PanzerfestSurvival] " .. msg .. "\n")
end

local function isBot(clientNum)
    local name = et.gentity_get(clientNum, "pers.netname") or ""
    return name:find("%[BOT%]") ~= nil
end

local function isHuman(clientNum)
    return not isBot(clientNum)
end

local function getMaxClients()
    return tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
end

local function isPlayerActive(clientNum)
    if et.gentity_get(clientNum, "inuse") ~= 1 then return false end
    if et.gentity_get(clientNum, "pers.connected") ~= 2 then return false end  -- CON_CONNECTED
    local team = et.gentity_get(clientNum, "sess.sessionTeam")
    return team == 1 or team == 2  -- TEAM_AXIS or TEAM_ALLIES
end

local function sendCP(clientNum, msg)
    et.trap_SendServerCommand(clientNum, 'cp "' .. msg .. '"')
end

local function sendChat(msg)
    et.trap_SendServerCommand(-1, 'chat "' .. msg .. '"')
end

local function sendCPAll(msg)
    et.trap_SendServerCommand(-1, 'cp "' .. msg .. '"')
end

--=============================================================================
-- SPEED & FIRE RATE APPLICATION
--=============================================================================

-- Apply speed scale (100 = normal, 200 = 2x, etc.)
local function setSpeedScale(clientNum, scale)
    et.gentity_set(clientNum, "rickrollSpeedScale", scale)
end

-- Apply fire rate multiplier (100 = normal, 200 = 2x faster, etc.)
local function setFireRateMultiplier(clientNum, multiplier)
    et.gentity_set(clientNum, "rickrollFireRateMultiplier", multiplier)
end

-- Apply fire rate delay (adds ms between shots)
local function setFireRateDelay(clientNum, delayMs)
    et.gentity_set(clientNum, "rickrollFireRateDelay", delayMs)
end

-- Clear all effects for a player
local function clearEffects(clientNum)
    setSpeedScale(clientNum, 100)
    setFireRateMultiplier(clientNum, 100)
    setFireRateDelay(clientNum, 0)
end

--=============================================================================
-- PLAYER STATE MANAGEMENT
--=============================================================================

function mode.initPlayer(clientNum)
    mode.playerState[clientNum] = {
        kills = 0,
        spawnTime = 0,
        killstreakLevel = 0,
        survivalLevel = 0,
    }
    clearEffects(clientNum)
end

function mode.cleanupPlayer(clientNum)
    mode.playerState[clientNum] = nil
    clearEffects(clientNum)
end

--=============================================================================
-- KILL STREAK FIRE RATE BONUS
--=============================================================================

local function updateKillStreakBonus(clientNum)
    if not mode.config.killstreakEnabled then return end
    if not isHuman(clientNum) then return end

    local state = mode.playerState[clientNum]
    if not state then return end

    -- Calculate bonus level
    local newLevel = math.floor(state.kills / mode.config.killsPerLevel)
    if newLevel > mode.config.maxKillstreakLevel then
        newLevel = mode.config.maxKillstreakLevel
    end

    if newLevel ~= state.killstreakLevel then
        state.killstreakLevel = newLevel

        -- Apply fire rate multiplier: Level 1 = 200 (2x), Level 6 = 700 (7x)
        local multiplier = 100 + (newLevel * 100)
        setFireRateMultiplier(clientNum, multiplier)

        -- Notify player
        if newLevel > 0 then
            if newLevel == mode.config.maxKillstreakLevel then
                sendCP(clientNum, "^1KILL STREAK: ^6MAXIMUM FIRE RATE!")
            else
                sendCP(clientNum, "^1KILL STREAK: ^3Fire Rate Level " .. newLevel)
            end
        end

        log("Player " .. clientNum .. " kill streak level: " .. newLevel .. " (fire rate: " .. multiplier .. "%)")
    end

    -- Check for panzerfest trigger
    if mode.config.panzerfestEnabled and state.kills >= mode.config.panzerfestKills then
        mode.startPanzerfest(clientNum)
    end
end

--=============================================================================
-- SURVIVAL SPEED BONUS
--=============================================================================

local function updateSurvivalBonus(clientNum, levelTime)
    if not mode.config.survivalEnabled then return end
    if not isHuman(clientNum) then return end
    if mode.panzerfest.active then return end  -- Paused during panzerfest

    local state = mode.playerState[clientNum]
    if not state or state.spawnTime <= 0 then return end

    -- Calculate time alive
    local aliveTime = levelTime - state.spawnTime

    -- Calculate bonus level
    local newLevel = math.floor(aliveTime / mode.config.survivalInterval)
    if newLevel > mode.config.maxSurvivalLevel then
        newLevel = mode.config.maxSurvivalLevel
    end

    if newLevel ~= state.survivalLevel then
        state.survivalLevel = newLevel

        -- Apply speed scale: Level 1 = 150%, Level 6 = 400%
        local speedScale = 100 + (newLevel * mode.config.speedBonusPerLevel)
        setSpeedScale(clientNum, speedScale)

        -- Notify player
        if newLevel > 0 then
            if newLevel == mode.config.maxSurvivalLevel then
                sendCP(clientNum, "^2SURVIVAL: ^6MAXIMUM SPEED!")
            else
                sendCP(clientNum, "^2SURVIVAL: ^3Speed Level " .. newLevel)
            end
        end

        log("Player " .. clientNum .. " survival level: " .. newLevel .. " (speed: " .. speedScale .. "%)")
    end
end

--=============================================================================
-- PANZERFEST MODE
--=============================================================================

function mode.startPanzerfest(clientNum)
    if mode.panzerfest.active then return end
    if not mode.config.panzerfestEnabled then return end

    local now = et.trap_Milliseconds()
    if now < mode.panzerfest.cooldownEndTime then return end

    local targetTeam = et.gentity_get(clientNum, "sess.sessionTeam")
    if targetTeam ~= 1 and targetTeam ~= 2 then return end

    local enemyTeam = (targetTeam == 1) and 2 or 1
    local targetName = et.gentity_get(clientNum, "pers.netname") or "Unknown"

    -- Store original teams and switch everyone
    mode.panzerfest.originalTeams = {}
    for i = 0, getMaxClients() - 1 do
        if isPlayerActive(i) then
            local team = et.gentity_get(i, "sess.sessionTeam")
            mode.panzerfest.originalTeams[i] = team

            -- Switch teammates to enemy team (not the target, not spectators)
            if i ~= clientNum and team == targetTeam then
                local teamName = (enemyTeam == 1) and "red" or "blue"
                et.trap_SendConsoleCommand(et.EXEC_APPEND, "forceteam " .. i .. " " .. teamName .. "\n")
            end
        end
    end

    -- Start panzerfest
    mode.panzerfest.active = true
    mode.panzerfest.targetClientNum = clientNum
    mode.panzerfest.startTime = now
    mode.panzerfest.phaseStartTime = now
    mode.panzerfest.lastTick = now
    mode.panzerfest.phase = 1  -- BOOST
    mode.panzerfest.currentMultiplier = mode.config.panzerfestMultiplier * 100  -- 700 = 7x
    mode.panzerfest.currentSpeedScale = mode.config.panzerfestSpeedBoost  -- 400 = 4x
    mode.panzerfest.currentDelay = 0
    mode.panzerfest.messageIndex = 1

    -- Apply max bonuses to target
    setFireRateMultiplier(clientNum, mode.panzerfest.currentMultiplier)
    setSpeedScale(clientNum, mode.panzerfest.currentSpeedScale)

    -- Reset all other players' bonuses
    for i = 0, getMaxClients() - 1 do
        if isPlayerActive(i) and i ~= clientNum then
            local state = mode.playerState[i]
            if state then
                state.kills = 0
                state.spawnTime = 0
                state.killstreakLevel = 0
                state.survivalLevel = 0
            end
            clearEffects(i)
        end
    end

    -- BIG ANNOUNCEMENT
    sendCPAll("\n^1=================================\n" ..
              "^3" .. targetName .. "\n" ..
              "^1IS A BADASS AND THE PANZER GODS\n" ..
              "^1HAVE REWARDED THEM WITH\n" ..
              "^6*** ^1P^3A^1N^3Z^1E^3R^1F^3E^1S^3T^1! ^6***\n" ..
              "^1=================================\n" ..
              "^27x FIRE RATE + 4x SPEED!\n" ..
              "^2GO GET EM!!!")

    sendChat("^1*** ^6PANZERFEST! ^1*** ^3" .. targetName .. " ^7is a ^1BADASS^7! ^27x FIRE + 4x SPEED! ^22 MINUTES TO SURVIVE!")

    log("PANZERFEST started! Target: " .. targetName .. " with " .. mode.playerState[clientNum].kills .. " kills")
end

function mode.endPanzerfest(targetDied)
    if not mode.panzerfest.active then return end

    local targetName = "Unknown"
    if mode.panzerfest.targetClientNum >= 0 then
        targetName = et.gentity_get(mode.panzerfest.targetClientNum, "pers.netname") or "Unknown"
    end

    -- Announcement
    if targetDied then
        local msg = mode.failureMessages[math.random(#mode.failureMessages)]
        sendCPAll("\n^1=================================\n" ..
                  "^3" .. targetName .. "\n" ..
                  msg .. "\n" ..
                  "^1=================================\n" ..
                  "^2THE PEASANTS WIN THIS ROUND!")
        sendChat("^1*** PANZERFEST OVER! *** ^3" .. targetName .. " ^1GOT REKT! ^7" .. msg)
    end

    -- Restore original teams
    for clientNum, originalTeam in pairs(mode.panzerfest.originalTeams) do
        if isPlayerActive(clientNum) then
            local currentTeam = et.gentity_get(clientNum, "sess.sessionTeam")
            if currentTeam ~= originalTeam and (originalTeam == 1 or originalTeam == 2) then
                local teamName = (originalTeam == 1) and "red" or "blue"
                et.trap_SendConsoleCommand(et.EXEC_APPEND, "forceteam " .. clientNum .. " " .. teamName .. "\n")
            end
        end
    end

    -- Reset all players
    local now = et.trap_Milliseconds()
    for i = 0, getMaxClients() - 1 do
        if isPlayerActive(i) then
            local state = mode.playerState[i]
            if state then
                state.kills = 0
                state.killstreakLevel = 0
                state.survivalLevel = 0
                -- Restart survival timer for alive players
                local isDead = et.gentity_get(i, "health") <= 0
                state.spawnTime = isDead and 0 or now
            end
            clearEffects(i)
        end
    end

    -- Start cooldown
    mode.panzerfest.cooldownEndTime = now + mode.config.panzerfestCooldown

    -- Reset state
    mode.panzerfest.active = false
    mode.panzerfest.targetClientNum = -1
    mode.panzerfest.phase = 0
    mode.panzerfest.originalTeams = {}

    log("PANZERFEST ended. Target died: " .. tostring(targetDied))
end

function mode.updatePanzerfest(levelTime)
    if not mode.panzerfest.active then return end

    local now = levelTime
    local phaseElapsed = now - mode.panzerfest.phaseStartTime
    local totalElapsed = now - mode.panzerfest.startTime
    local targetClient = mode.panzerfest.targetClientNum

    -- Phase 1: BOOST (30 seconds at max fire rate + max speed)
    if mode.panzerfest.phase == 1 then
        if phaseElapsed >= 30000 then
            -- Transition to Phase 2
            mode.panzerfest.phase = 2
            mode.panzerfest.phaseStartTime = now
            mode.panzerfest.lastTick = now
            mode.panzerfest.messageIndex = 1

            sendCPAll("^1THE PANZER GODS GROW WEARY...\n^3Your power begins to fade!")
            sendChat("^1*** PHASE 2: SLOWDOWN! *** ^3Fire rate AND speed decreasing! 90 seconds left...")

            log("PANZERFEST Phase 2 - Both decreasing")
        end

    -- Phase 2: BOTH SLOWDOWN (30 seconds, both decrease every 5s)
    elseif mode.panzerfest.phase == 2 then
        -- Every 5 seconds, decrease both
        if now - mode.panzerfest.lastTick >= 5000 then
            mode.panzerfest.lastTick = now

            -- Decrease fire rate (700 -> 600 -> 500 -> 400 -> 300 -> 200 -> 100)
            mode.panzerfest.currentMultiplier = mode.panzerfest.currentMultiplier - 100
            if mode.panzerfest.currentMultiplier < 100 then
                mode.panzerfest.currentMultiplier = 100
            end

            -- Decrease speed (400 -> 350 -> 300 -> 250 -> 200 -> 150 -> 100)
            mode.panzerfest.currentSpeedScale = mode.panzerfest.currentSpeedScale - 50
            if mode.panzerfest.currentSpeedScale < 100 then
                mode.panzerfest.currentSpeedScale = 100
            end

            -- Apply
            setFireRateMultiplier(targetClient, mode.panzerfest.currentMultiplier)
            setSpeedScale(targetClient, mode.panzerfest.currentSpeedScale)

            -- Message
            if mode.panzerfest.messageIndex <= #mode.phase2Messages then
                sendChat(mode.phase2Messages[mode.panzerfest.messageIndex] ..
                        " ^7(Fire: ^3" .. (mode.panzerfest.currentMultiplier / 100) .. "x^7, Speed: ^3" ..
                        string.format("%.1f", mode.panzerfest.currentSpeedScale / 100) .. "x^7)")
                mode.panzerfest.messageIndex = mode.panzerfest.messageIndex + 1
            end
        end

        if phaseElapsed >= 30000 then
            -- Transition to Phase 3
            mode.panzerfest.phase = 3
            mode.panzerfest.phaseStartTime = now
            mode.panzerfest.lastTick = now
            mode.panzerfest.messageIndex = 1
            mode.panzerfest.currentMultiplier = 100  -- Normal fire rate
            mode.panzerfest.currentSpeedScale = 100  -- Normal speed
            mode.panzerfest.currentDelay = 0

            setFireRateMultiplier(targetClient, 100)
            setSpeedScale(targetClient, 100)

            sendCPAll("^1SPEED LOCKED AT NORMAL!\n^3Fire rate still dropping!")
            sendChat("^1*** PHASE 3: FIRE RATE PENALTY! *** ^3Speed normal, fire rate getting WORSE! 60 seconds left...")

            log("PANZERFEST Phase 3 - Fire rate delay")
        end

    -- Phase 3: FIRE SLOWDOWN (30 seconds, speed at 1x, fire rate adds delay)
    elseif mode.panzerfest.phase == 3 then
        -- Every 5 seconds, increase delay
        if now - mode.panzerfest.lastTick >= 5000 then
            mode.panzerfest.lastTick = now

            mode.panzerfest.currentDelay = mode.panzerfest.currentDelay + 1000  -- +1 second
            if mode.panzerfest.currentDelay > 6000 then
                mode.panzerfest.currentDelay = 6000
            end

            setFireRateDelay(targetClient, mode.panzerfest.currentDelay)

            -- Message
            if mode.panzerfest.messageIndex <= #mode.phase3Messages then
                sendChat(mode.phase3Messages[mode.panzerfest.messageIndex] ..
                        " ^7(Delay: ^1+" .. (mode.panzerfest.currentDelay / 1000) .. " sec^7)")
                mode.panzerfest.messageIndex = mode.panzerfest.messageIndex + 1
            end
        end

        if phaseElapsed >= 30000 then
            -- Transition to Phase 4
            mode.panzerfest.phase = 4
            mode.panzerfest.phaseStartTime = now
            mode.panzerfest.currentDelay = 6000

            setFireRateDelay(targetClient, 6000)

            sendCPAll("^1MAXIMUM PENALTY!\n^3SURVIVE 30 MORE SECONDS!")
            sendChat("^1*** PHASE 4: SURVIVE! *** ^3Max delay, normal speed. ^230 SECONDS TO GO!")

            log("PANZERFEST Phase 4 - Survive")
        end

    -- Phase 4: SURVIVE (30 seconds at max penalty)
    elseif mode.panzerfest.phase == 4 then
        if phaseElapsed >= 30000 then
            -- VICTORY!
            mode.panzerfest.phase = 5
            mode.panzerfest.phaseStartTime = now

            local targetName = et.gentity_get(targetClient, "pers.netname") or "Unknown"

            sendCPAll("\n^6*****************************************\n" ..
                      "^2           MOMENT OF SILENCE\n" ..
                      "^6*****************************************\n" ..
                      "\n" ..
                      "^3" .. targetName .. "\n" ..
                      "^2HAS ACHIEVED THE IMPOSSIBLE!\n" ..
                      "\n" ..
                      "^6**** ^2ABSOLUTE LEGEND ^6****\n" ..
                      "^2SURVIVED 2 FULL MINUTES!\n" ..
                      "^6*****************************************")

            sendChat("^6*** ^2INCREDIBLE! ^6*** ^3" .. targetName .. " ^2SURVIVED 2 MINUTES! ^6A TRUE WARRIOR! ^2ALL HAIL THE PANZER GOD!")

            log("PANZERFEST: " .. targetName .. " SURVIVED!")
        end

    -- Victory Pause (3 seconds)
    elseif mode.panzerfest.phase == 5 then
        if phaseElapsed >= 3000 then
            sendChat("^2*** PANZERFEST COMPLETE! *** ^7Resuming normal play. ALL HAIL THE CHAMPION!")
            mode.endPanzerfest(false)
        end
    end
end

--=============================================================================
-- EVENT HOOKS
--=============================================================================

function mode.onInit(levelTime)
    mode.playerState = {}
    mode.panzerfest = {
        active = false,
        targetClientNum = -1,
        startTime = 0,
        phase = 0,
        phaseStartTime = 0,
        lastTick = 0,
        currentMultiplier = 100,
        currentSpeedScale = 100,
        currentDelay = 0,
        originalTeams = {},
        cooldownEndTime = 0,
    }
    log("^2Panzerfest & Survival Mode initialized")
end

function mode.onShutdown()
    -- Clear all effects
    for clientNum, _ in pairs(mode.playerState) do
        clearEffects(clientNum)
    end
    mode.playerState = {}
end

function mode.onPlayerConnect(clientNum, isBot)
    if isBot == 0 then  -- Human
        mode.initPlayer(clientNum)
    end
end

function mode.onPlayerDisconnect(clientNum)
    mode.cleanupPlayer(clientNum)

    -- Check if panzerfest target left
    if mode.panzerfest.active and mode.panzerfest.targetClientNum == clientNum then
        mode.endPanzerfest(true)
    end
end

function mode.onPlayerSpawn(clientNum, revived)
    local state = mode.playerState[clientNum]
    if not state then return end

    if revived == 0 then  -- Full spawn, not revive
        -- Reset bonuses on spawn (death resets everything)
        state.kills = 0
        state.killstreakLevel = 0
        state.survivalLevel = 0
        state.spawnTime = et.trap_Milliseconds()
        clearEffects(clientNum)
    else
        -- Revive - keep kill streak, restart survival timer
        state.spawnTime = et.trap_Milliseconds()
        state.survivalLevel = 0
        -- Re-apply kill streak bonus
        if state.killstreakLevel > 0 then
            local multiplier = 100 + (state.killstreakLevel * 100)
            setFireRateMultiplier(clientNum, multiplier)
        end
    end
end

function mode.onPlayerKill(killer, victim)
    if not isHuman(killer) then return end
    if killer == victim then return end  -- Suicide
    if victim == 1022 then return end  -- World kill

    local state = mode.playerState[killer]
    if not state then return end

    state.kills = state.kills + 1
    updateKillStreakBonus(killer)
end

function mode.onPlayerDeath(clientNum)
    local state = mode.playerState[clientNum]
    if state then
        state.kills = 0
        state.killstreakLevel = 0
        state.survivalLevel = 0
        state.spawnTime = 0
    end
    clearEffects(clientNum)

    -- Check if panzerfest target died
    if mode.panzerfest.active and mode.panzerfest.targetClientNum == clientNum then
        -- Don't end during victory pause
        if mode.panzerfest.phase ~= 5 then
            mode.endPanzerfest(true)
        end
    end
end

function mode.onRunFrame(levelTime)
    -- Update panzerfest phases
    if mode.panzerfest.active then
        mode.updatePanzerfest(levelTime)
    else
        -- Update survival bonuses for all players
        for clientNum, state in pairs(mode.playerState) do
            if isPlayerActive(clientNum) and isHuman(clientNum) then
                updateSurvivalBonus(clientNum, levelTime)
            end
        end
    end
end

return mode
```

---

### Phase 3: Integration with main.lua

#### Step 3.1: Load the module
```lua
-- In lua/main.lua, after the rocketMode loading section:

--[[
    PANZERFEST & SURVIVAL MODE
    Kill streak = faster fire rate
    Survival = faster movement
    Panzerfest = everyone vs you at 30 kills!
]]--
local panzerfestEnabled = true
local panzerfest = nil

if panzerfestEnabled then
    local success, err = pcall(function()
        panzerfest = dofile("legacy/lua/panzerfest_survival.lua")
    end)
    if not success then
        et.G_Print("^1[ERROR] ^7Failed to load Panzerfest/Survival: " .. tostring(err) .. "\n")
        panzerfestEnabled = false
    end
end
```

#### Step 3.2: Hook up the callbacks
```lua
-- In et_InitGame:
if panzerfestEnabled and panzerfest then
    panzerfest.onInit(levelTime)
end

-- In et_ShutdownGame:
if panzerfestEnabled and panzerfest then
    panzerfest.onShutdown()
end

-- In et_ClientConnect:
if panzerfestEnabled and panzerfest then
    panzerfest.onPlayerConnect(clientNum, isBot)
end

-- In et_ClientDisconnect:
if panzerfestEnabled and panzerfest then
    panzerfest.onPlayerDisconnect(clientNum)
end

-- In et_ClientSpawn:
if panzerfestEnabled and panzerfest then
    panzerfest.onPlayerSpawn(clientNum, revived)
end

-- In et_Obituary:
if panzerfestEnabled and panzerfest then
    panzerfest.onPlayerKill(killer, victim)
    panzerfest.onPlayerDeath(victim)
end

-- In et_RunFrame:
if panzerfestEnabled and panzerfest then
    panzerfest.onRunFrame(levelTime)
end
```

---

## Progress Tracking

### Status: IN PROGRESS

| Phase | Step | Description | Status |
|-------|------|-------------|--------|
| 1 | 1.1 | Add `rickrollFireRateMultiplier` to g_local.h | [ ] |
| 1 | 1.2 | Expose new field to Lua in g_lua.c | [ ] |
| 1 | 1.3 | Apply fire rate multiplier in bg_pmove.c | [ ] |
| 1 | 1.4 | Build and test C changes | [ ] |
| 2 | 2.1 | Create panzerfest_survival.lua | [ ] |
| 2 | 2.2 | Implement kill streak tracking | [ ] |
| 2 | 2.3 | Implement survival bonus | [ ] |
| 2 | 2.4 | Implement panzerfest mode | [ ] |
| 2 | 2.5 | Test in isolation | [ ] |
| 3 | 3.1 | Integrate with main.lua | [ ] |
| 3 | 3.2 | Test full integration | [ ] |
| 4 | 4.1 | Deploy to local server | [ ] |
| 4 | 4.2 | Deploy to VPS | [ ] |
| 4 | 4.3 | Final testing with real players | [ ] |

---

## Testing Plan

### Unit Tests (Local)
1. **Kill Streak**: Kill bots, verify fire rate increases
2. **Survival**: Stay alive, verify speed increases
3. **Panzerfest Trigger**: Get 30 kills, verify mode activates
4. **Team Switch**: Verify all players switch to hunt target
5. **Phase Progression**: Verify all 4 phases transition correctly
6. **Target Death**: Verify mode ends and teams restore
7. **Victory**: Survive 2 minutes, verify celebration

### Integration Tests (VPS)
1. Multiple human players
2. Bot interactions
3. Map changes during panzerfest
4. Player disconnect during panzerfest

---

## CVARs for Configuration

**All settings exposed as CVARs** so they can be changed from server.cfg, rcon, or other scripts.

```cfg
# panzerfest_survival.cfg (or add to server.cfg)

#=============================================================================
# KILL STREAK FIRE RATE BONUS
#=============================================================================
set g_killstreakEnabled "1"           # 0 = disabled, 1 = enabled
set g_killstreakKillsPerLevel "5"     # Kills per bonus level
set g_killstreakMaxLevel "6"          # Max 6 levels = 7x fire rate

#=============================================================================
# SURVIVAL SPEED BONUS
#=============================================================================
set g_survivalEnabled "1"             # 0 = disabled, 1 = enabled
set g_survivalInterval "30000"        # Milliseconds per level (30 seconds)
set g_survivalMaxLevel "6"            # Max 6 levels
set g_survivalSpeedBonus "50"         # Percent per level (50 = 1.5x, 2x, 2.5x...)

#=============================================================================
# PANZERFEST MODE
#=============================================================================
set g_panzerfestEnabled "1"           # 0 = disabled, 1 = enabled
set g_panzerfestKills "30"            # Kills to trigger panzerfest
set g_panzerfestCooldown "60"         # Seconds cooldown between panzerfests
set g_panzerfestDuration "30"         # Seconds per phase (4 phases = 2 min)
set g_panzerfestFireRateBoost "7"     # Initial fire rate multiplier (7x)
set g_panzerfestSpeedBoost "400"      # Initial speed (400 = 4x)
```

### Lua reads CVARs at runtime
The Lua script reads these CVARs in `et_InitGame` and can be reloaded with map restart:
```lua
mode.config.killstreakEnabled = tonumber(et.trap_Cvar_Get("g_killstreakEnabled")) == 1
mode.config.killsPerLevel = tonumber(et.trap_Cvar_Get("g_killstreakKillsPerLevel")) or 5
-- etc.
```

---

## Notes

1. **The fire rate modification requires C code changes** - cannot be done in pure Lua
2. **Speed scaling already works** via existing `rickrollSpeedScale` field
3. **Team switching uses console commands** - may need testing for edge cases
4. **Bots are excluded** from all bonuses (as specified)
5. **JayMod used C++ directly** - we're using Lua for logic, C for application
