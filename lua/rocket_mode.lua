--[[
    Rocket Mode - Cycling between Normal, Freeze, and Homing rockets

    All players can cycle between rocket modes by pressing their panzer/bazooka
    keybind while already holding the panzer/bazooka.

    Modes:
    - NORMAL: Standard rockets (no special effects)
    - FREEZE: Rockets freeze enemies on hit
    - HOMING: Rockets track nearest enemy

    Implementation:
    - Track each player's current rocket mode
    - Detect when player tries to switch to panzer while already on panzer
    - Cycle to next mode and apply the appropriate effect
]]--

local rocketMode = {}

-- Weapon IDs
local WEAPON = {
    PANZERFAUST = 5,
    BAZOOKA = 53
}

-- Rocket mode constants
rocketMode.MODE = {
    NORMAL = 1,
    FREEZE = 2,
    HOMING = 3,
    FREEZE_HOMING = 4
}

-- Mode display info
rocketMode.modeInfo = {
    [1] = { name = "NORMAL",        color = "^7", description = "Standard rockets" },
    [2] = { name = "FREEZE",        color = "^4", description = "Rockets freeze enemies" },
    [3] = { name = "HOMING",        color = "^2", description = "Rockets track enemies" },
    [4] = { name = "FREEZE+HOMING", color = "^5", description = "Homing rockets that freeze" }
}

-- Per-player state
-- { [clientNum] = { mode = 1, lastWeapon = 0, lastSwitchTime = 0 } }
rocketMode.playerState = {}

-- Configuration
-- Homing presets (cone angle): 45=MILD, 60=MODERATE, 90=STRONG, 120=EXTREME, 150=LEGENDARY, 180=INSANE
-- C code presets (g_missile.c): BALANCED(turn=0.08), STRONG(turn=0.15), LEGENDARY(turn=0.20)
rocketMode.config = {
    freezeDuration = 10000,  -- 10 seconds freeze
    homingConeAngle = 60,    -- 60 degree cone (MODERATE - must aim toward enemy)
    doubleTapWindow = 500,   -- ms window to detect double-tap (not used currently)
    debug = false
}

--=============================================================================
-- HELPER FUNCTIONS
--=============================================================================

local function log(msg)
    et.G_Print("[RocketMode] " .. msg .. "\n")
end

local function debug(msg)
    if rocketMode.config.debug then
        et.G_Print("[RocketMode Debug] " .. msg .. "\n")
    end
end

-- Check if weapon is a panzer/bazooka
local function isPanzerWeapon(weaponId)
    return weaponId == WEAPON.PANZERFAUST or weaponId == WEAPON.BAZOOKA
end

-- Get player's current weapon
local function getPlayerWeapon(clientNum)
    return et.gentity_get(clientNum, "ps.weapon") or 0
end

-- Initialize player state
function rocketMode.initPlayer(clientNum)
    rocketMode.playerState[clientNum] = {
        mode = rocketMode.MODE.NORMAL,
        lastWeapon = 0,
        lastSwitchTime = 0
    }
    -- Clear any lingering effects
    et.gentity_set(clientNum, "rickrollPanzerFreeze", 0)
    et.gentity_set(clientNum, "rickrollHomingRockets", 0)
    debug("Initialized player " .. clientNum)
end

-- Clean up player state
function rocketMode.cleanupPlayer(clientNum)
    if rocketMode.playerState[clientNum] then
        -- Clear effects
        et.gentity_set(clientNum, "rickrollPanzerFreeze", 0)
        et.gentity_set(clientNum, "rickrollHomingRockets", 0)
        rocketMode.playerState[clientNum] = nil
        debug("Cleaned up player " .. clientNum)
    end
end

--=============================================================================
-- MODE MANAGEMENT
--=============================================================================

-- Apply the current mode's effects to the player
function rocketMode.applyMode(clientNum)
    local state = rocketMode.playerState[clientNum]
    if not state then return end

    local mode = state.mode

    -- Clear all effects first
    et.gentity_set(clientNum, "rickrollPanzerFreeze", 0)
    et.gentity_set(clientNum, "rickrollHomingRockets", 0)

    -- Apply new mode's effect
    if mode == rocketMode.MODE.FREEZE then
        et.gentity_set(clientNum, "rickrollPanzerFreeze", rocketMode.config.freezeDuration)
        et.G_Print("[RocketMode] applyMode: Set FREEZE for client " .. clientNum .. "\n")
    elseif mode == rocketMode.MODE.HOMING then
        et.gentity_set(clientNum, "rickrollHomingRockets", rocketMode.config.homingConeAngle)
        et.G_Print("[RocketMode] applyMode: Set HOMING for client " .. clientNum .. "\n")
    elseif mode == rocketMode.MODE.FREEZE_HOMING then
        -- Combined mode: both freeze AND homing
        et.gentity_set(clientNum, "rickrollPanzerFreeze", rocketMode.config.freezeDuration)
        et.gentity_set(clientNum, "rickrollHomingRockets", rocketMode.config.homingConeAngle)
        et.G_Print("[RocketMode] applyMode: Set FREEZE+HOMING for client " .. clientNum .. "\n")
    else
        et.G_Print("[RocketMode] applyMode: Set NORMAL mode for client " .. clientNum .. "\n")
    end

    -- Verify the values were set
    local freezeVal = et.gentity_get(clientNum, "rickrollPanzerFreeze")
    local homingVal = et.gentity_get(clientNum, "rickrollHomingRockets")
    et.G_Print("[RocketMode] applyMode: Verify - freeze=" .. tostring(freezeVal) .. ", homing=" .. tostring(homingVal) .. "\n")
end

-- Cycle to next rocket mode
function rocketMode.cycleMode(clientNum)
    et.G_Print("[RocketMode] cycleMode called for client " .. clientNum .. "\n")

    local state = rocketMode.playerState[clientNum]
    if not state then
        et.G_Print("[RocketMode] No state, initializing player\n")
        rocketMode.initPlayer(clientNum)
        state = rocketMode.playerState[clientNum]
    end

    et.G_Print("[RocketMode] Current mode: " .. state.mode .. "\n")

    -- Cycle: NORMAL -> FREEZE -> HOMING -> FREEZE_HOMING -> NORMAL
    local newMode = state.mode + 1
    if newMode > rocketMode.MODE.FREEZE_HOMING then
        newMode = rocketMode.MODE.NORMAL
    end

    et.G_Print("[RocketMode] New mode: " .. newMode .. "\n")

    state.mode = newMode
    rocketMode.applyMode(clientNum)

    -- Notify player
    local info = rocketMode.modeInfo[newMode]
    local name = et.gentity_get(clientNum, "pers.netname") or "Player"

    -- Send rocket mode to client for HUD display
    -- Mode values: 0=normal (subtract 1 since our Lua uses 1-based), 1=freeze, 2=homing
    local cmd = string.format('rocketmode %d', newMode - 1)
    et.G_Print("[RocketMode] Sending command: " .. cmd .. "\n")
    et.trap_SendServerCommand(clientNum, cmd)

    et.G_Print("[RocketMode] " .. name .. " switched to " .. info.name .. " rockets\n")
end

-- Get current mode for a player
function rocketMode.getMode(clientNum)
    local state = rocketMode.playerState[clientNum]
    if state then
        return state.mode
    end
    return rocketMode.MODE.NORMAL
end

-- Get mode name
function rocketMode.getModeName(clientNum)
    local mode = rocketMode.getMode(clientNum)
    return rocketMode.modeInfo[mode].name
end

--=============================================================================
-- COMMAND-BASED CYCLING
--=============================================================================

-- Handle rocket cycling command from client
-- Called from et_ClientCommand when player types /rocket or /rocketmode
-- Returns true if handled
function rocketMode.handleCommand(clientNum, cmd)
    -- Commands: /rocket, /rockets, /rocketmode, /cyclerocket, /r
    if cmd == "rocket" or cmd == "rockets" or cmd == "rocketmode" or cmd == "cyclerocket" or cmd == "r" then
        rocketMode.cycleMode(clientNum)
        return true
    end
    return false
end

-- Legacy function for compatibility (not used since weapon switching is client-side)
function rocketMode.handleWeaponCommand(clientNum, weaponNum)
    return false  -- Weapon switching is client-side, can't intercept
end

--=============================================================================
-- SPAWN HANDLING
--=============================================================================

-- Re-apply mode on spawn (effects reset on death)
function rocketMode.onSpawn(clientNum)
    local state = rocketMode.playerState[clientNum]
    if state then
        rocketMode.applyMode(clientNum)
        debug("Re-applied mode on spawn for player " .. clientNum)
    end
end

--=============================================================================
-- WELCOME MESSAGE
--=============================================================================

function rocketMode.showWelcomeMessage(clientNum)
    -- Delayed message so it shows after other connect messages
    -- We'll use a simple approach: queue it and show in runFrame
    if not rocketMode.pendingWelcome then
        rocketMode.pendingWelcome = {}
    end

    rocketMode.pendingWelcome[clientNum] = et.trap_Milliseconds() + 3000  -- 3 second delay
end

function rocketMode.checkPendingWelcome(levelTime)
    if not rocketMode.pendingWelcome then return end

    local now = et.trap_Milliseconds()
    for clientNum, showTime in pairs(rocketMode.pendingWelcome) do
        if now >= showTime then
            -- Check player is still valid
            if et.gentity_get(clientNum, "inuse") == 1 then
                et.trap_SendServerCommand(clientNum,
                    'cp "^3ROCKET MODE ENABLED!\n^7Type ^2/rocket ^7to cycle between:\n^7NORMAL ^4-> FREEZE ^2-> HOMING"')

                -- Also send to console
                et.trap_SendServerCommand(clientNum,
                    'print "^3=== ROCKET MODE ===\n^7Type /rocket (or /r) to cycle between:\n  ^7NORMAL ^7- Standard rockets\n  ^4FREEZE ^7- Rockets freeze enemies for 5s\n  ^2HOMING ^7- Rockets track enemies\n^3Tip: Bind a key! Example: /bind x rocket\n^3==================\n"')
            end
            rocketMode.pendingWelcome[clientNum] = nil
        end
    end
end

--=============================================================================
-- PUBLIC API
--=============================================================================

-- Initialize the module
function rocketMode.init()
    log("^2Rocket Mode initialized - All players can cycle between Normal/Freeze/Homing rockets")
    rocketMode.playerState = {}
    rocketMode.pendingWelcome = {}
end

-- Shutdown
function rocketMode.shutdown()
    -- Clear all player effects
    for clientNum, _ in pairs(rocketMode.playerState) do
        et.gentity_set(clientNum, "rickrollPanzerFreeze", 0)
        et.gentity_set(clientNum, "rickrollHomingRockets", 0)
    end
    rocketMode.playerState = {}
    rocketMode.pendingWelcome = {}
    log("Rocket Mode shutdown")
end

-- Run frame update (for pending welcome messages)
function rocketMode.runFrame(levelTime)
    rocketMode.checkPendingWelcome(levelTime)
end

return rocketMode
