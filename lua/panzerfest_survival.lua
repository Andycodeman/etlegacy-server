--[[
    Panzerfest & Survival Mode
    ETMan's ET:Legacy Server

    Kill Streak: Every 5 kills = faster fire rate (max 7x at 30 kills)
    Survival: Every 30 seconds alive = faster movement (max 4x at 3 minutes)
    Panzerfest: At 30 kills, everyone hunts you for 2 minutes!

    HUMANS ONLY - bots are excluded from all bonuses

    CVARs:
    - g_killstreakEnabled (0/1)
    - g_killstreakKillsPerLevel (default 5)
    - g_killstreakMaxLevel (default 6)
    - g_survivalEnabled (0/1)
    - g_survivalInterval (default 30000 ms)
    - g_survivalMaxLevel (default 6)
    - g_survivalSpeedBonus (default 50 = 50% per level)
    - g_panzerfestEnabled (0/1)
    - g_panzerfestKills (default 30)
    - g_panzerfestDuration (default 30000 ms per phase)
    - g_panzerfestCooldown (default 60000 ms)
]]--

local mode = {}

-- Configuration (loaded from CVARs in onInit)
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
    panzerfestDuration = 30000, -- 30 seconds per phase (4 phases = 2 min)
    panzerfestCooldown = 60000, -- 1 minute cooldown
    panzerfestMultiplier = 7,   -- 7x fire rate boost (phase 1)
    panzerfestSpeedBoost = 400, -- 4x speed (400%)
}

-- State tracking
mode.playerState = {}  -- { [clientNum] = { kills, spawnTime, killstreakLevel, survivalLevel, lastHudUpdate } }
mode.panzerfest = {
    active = false,
    targetClientNum = -1,
    startTime = 0,
    phase = 0,  -- 0=inactive, 1=boost, 2=both_slowdown, 3=fire_slowdown, 4=survive, 5=victory
    phaseStartTime = 0,
    lastTick = 0,
    currentMultiplier = 100,
    currentSpeedScale = 100,
    currentDelay = 0,
    originalTeams = {},  -- { [clientNum] = originalTeam }
    cooldownEndTime = 0,
    messageIndex = 1,
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
    local connected = et.gentity_get(clientNum, "pers.connected")
    if connected ~= 2 then return false end  -- CON_CONNECTED = 2
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
        lastHudUpdate = 0,
    }
    clearEffects(clientNum)
end

-- Send HUD bonus update to client (graphical bars)
-- Format: panzerfest_bonus <killStreakLevel> <survivalLevel> <panzerfestPhase> <timeLeft> <isTarget>
local function sendHudUpdate(clientNum, levelTime)
    local state = mode.playerState[clientNum]
    if not state then return end

    -- Only update HUD every 500ms to reduce network traffic but keep responsive
    if levelTime - (state.lastHudUpdate or 0) < 500 then
        return
    end
    state.lastHudUpdate = levelTime

    local killstreakLevel = state.killstreakLevel or 0
    local survivalLevel = state.survivalLevel or 0
    local panzerfestPhase = mode.panzerfest.phase or 0
    local timeLeft = 0
    local isTarget = 0

    -- Calculate panzerfest time left if active
    if mode.panzerfest.active then
        local totalElapsed = levelTime - mode.panzerfest.startTime
        local totalDuration = mode.config.panzerfestDuration * 4  -- 4 phases
        timeLeft = math.floor((totalDuration - totalElapsed) / 1000)
        if timeLeft < 0 then timeLeft = 0 end

        if mode.panzerfest.targetClientNum == clientNum then
            isTarget = 1
        end
    end

    -- Only send if there's something to show (avoid spamming zeros)
    if killstreakLevel == 0 and survivalLevel == 0 and panzerfestPhase == 0 then
        return
    end

    -- Send update to client (custom command for C HUD rendering)
    local cmd = string.format("panzerfest_bonus %d %d %d %d %d",
        killstreakLevel, survivalLevel, panzerfestPhase, timeLeft, isTarget)
    et.trap_SendServerCommand(clientNum, cmd)

    -- Debug log (remove after testing)
    -- log("Sending HUD: " .. cmd .. " to client " .. clientNum)
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
    if mode.panzerfest.active then return end  -- No bonuses during panzerfest (except target)

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
                local health = et.gentity_get(i, "health") or 0
                state.spawnTime = (health > 0) and now or 0
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
    local phaseDuration = mode.config.panzerfestDuration

    -- Phase 1: BOOST (30 seconds at max fire rate + max speed)
    if mode.panzerfest.phase == 1 then
        if phaseElapsed >= phaseDuration then
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

        if phaseElapsed >= phaseDuration then
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

        if phaseElapsed >= phaseDuration then
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
        if phaseElapsed >= phaseDuration then
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

-- Track if we've loaded CVARs (delayed to let crazymode.cfg execute first)
mode.configLoaded = false
mode.configLoadTime = 0

-- Helper to get cvar with proper default handling (empty string = use default)
local function getCvar(name, default)
    local value = et.trap_Cvar_Get(name)
    if value == nil or value == "" then
        return default
    end
    return value
end

-- Load config from CVARs (called after a short delay to let exec commands run)
local function loadConfig()
    -- Debug: log raw CVAR values
    log("^3Loading CVARs...")
    log("  g_killstreakEnabled = '" .. tostring(et.trap_Cvar_Get("g_killstreakEnabled")) .. "'")
    log("  g_survivalEnabled = '" .. tostring(et.trap_Cvar_Get("g_survivalEnabled")) .. "'")
    log("  g_panzerfestEnabled = '" .. tostring(et.trap_Cvar_Get("g_panzerfestEnabled")) .. "'")

    mode.config.killstreakEnabled = tonumber(getCvar("g_killstreakEnabled", "1")) == 1
    mode.config.killsPerLevel = tonumber(getCvar("g_killstreakKillsPerLevel", "5")) or 5
    mode.config.maxKillstreakLevel = tonumber(getCvar("g_killstreakMaxLevel", "6")) or 6

    mode.config.survivalEnabled = tonumber(getCvar("g_survivalEnabled", "1")) == 1
    mode.config.survivalInterval = tonumber(getCvar("g_survivalInterval", "30000")) or 30000
    mode.config.maxSurvivalLevel = tonumber(getCvar("g_survivalMaxLevel", "6")) or 6
    mode.config.speedBonusPerLevel = tonumber(getCvar("g_survivalSpeedBonus", "50")) or 50

    mode.config.panzerfestEnabled = tonumber(getCvar("g_panzerfestEnabled", "1")) == 1
    mode.config.panzerfestKills = tonumber(getCvar("g_panzerfestKills", "30")) or 30
    mode.config.panzerfestDuration = tonumber(getCvar("g_panzerfestDuration", "30000")) or 30000
    mode.config.panzerfestCooldown = tonumber(getCvar("g_panzerfestCooldown", "0")) or 0

    mode.configLoaded = true

    log("^2Panzerfest & Survival Mode config loaded")
    log("  Kill Streak: " .. (mode.config.killstreakEnabled and "^2ENABLED" or "^1DISABLED"))
    log("  Survival: " .. (mode.config.survivalEnabled and "^2ENABLED" or "^1DISABLED"))
    log("  Panzerfest: " .. (mode.config.panzerfestEnabled and "^2ENABLED" or "^1DISABLED"))
end

function mode.onInit(levelTime)
    -- IMPORTANT: Fresh map start - reset EVERYTHING
    -- This handles cases where shutdown didn't complete properly

    -- Clear any lingering player effects from previous map
    for i = 0, (tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64) - 1 do
        clearEffects(i)
    end

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
        messageIndex = 1,
    }
    mode.configLoaded = false
    mode.configLoadTime = levelTime + 500  -- Wait 500ms for exec commands to run

    log("^2Panzerfest & Survival Mode initialized (config loads after 500ms)")
end

function mode.onShutdown()
    -- CRITICAL: If panzerfest is active during map change, restore teams FIRST
    if mode.panzerfest.active then
        log("^1WARNING: Map changing during active Panzerfest! Restoring teams...")

        -- Restore original teams before map ends
        for clientNum, originalTeam in pairs(mode.panzerfest.originalTeams) do
            if originalTeam and (originalTeam == 1 or originalTeam == 2) then
                -- Use immediate exec instead of append for map change
                local teamName = (originalTeam == 1) and "red" or "blue"
                et.trap_SendConsoleCommand(et.EXEC_NOW, "forceteam " .. clientNum .. " " .. teamName .. "\n")
                log("  Restored player " .. clientNum .. " to team " .. teamName)
            end
        end

        -- Reset panzerfest state
        mode.panzerfest.active = false
        mode.panzerfest.originalTeams = {}
    end

    -- Clear all effects
    for clientNum, _ in pairs(mode.playerState) do
        clearEffects(clientNum)
    end
    mode.playerState = {}
    mode.configLoaded = false

    log("^2Panzerfest & Survival Mode shutdown - all state reset")
end

function mode.onPlayerConnect(clientNum, isBot)
    -- isBot is 0 for humans in ET Lua
    if isBot == 0 then
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
        setSpeedScale(clientNum, 100)  -- Reset speed, keep fire rate
        -- Re-apply kill streak bonus
        if state.killstreakLevel > 0 and not mode.panzerfest.active then
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
        state.lastHudUpdate = 0  -- Force HUD update on next frame
    end
    clearEffects(clientNum)

    -- Send HUD reset to client (all zeros)
    et.trap_SendServerCommand(clientNum, "panzerfest_bonus 0 0 0 0 0")

    -- Check if panzerfest target died
    if mode.panzerfest.active and mode.panzerfest.targetClientNum == clientNum then
        -- Don't end during victory pause
        if mode.panzerfest.phase ~= 5 then
            mode.endPanzerfest(true)
        end
    end
end

function mode.onRunFrame(levelTime)
    -- Delayed config load (wait for exec commands to run)
    if not mode.configLoaded and levelTime >= mode.configLoadTime then
        loadConfig()
    end

    -- Don't process if config not loaded yet
    if not mode.configLoaded then
        return
    end

    -- Update panzerfest phases
    if mode.panzerfest.active then
        mode.updatePanzerfest(levelTime)
        -- Send HUD updates to all players during panzerfest
        for clientNum, state in pairs(mode.playerState) do
            if isPlayerActive(clientNum) and isHuman(clientNum) then
                sendHudUpdate(clientNum, levelTime)
            end
        end
    else
        -- Update survival bonuses for all players
        for clientNum, state in pairs(mode.playerState) do
            if isPlayerActive(clientNum) and isHuman(clientNum) then
                updateSurvivalBonus(clientNum, levelTime)
                -- Send HUD updates
                sendHudUpdate(clientNum, levelTime)
            end
        end
    end
end

return mode
