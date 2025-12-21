--[[
    Rick Roll Mode - State Management
    Tracks active rolls, effects, and timing
]]--

rickroll = rickroll or {}

rickroll.state = {
    -- Current level time (updated every frame from et_RunFrame)
    -- Use this instead of trap_Milliseconds() for freeze timing!
    currentLevelTime = 0,

    -- Trigger state
    nextTriggerTime = 0,
    lastTriggerTime = 0,
    mapStartTime = 0,

    -- Active roll state
    isRolling = false,
    rollStartTime = 0,
    rollSeed = 0,

    -- Selection results (determined at start, revealed over time)
    selectedPlayer = -1,
    selectedPlayerName = "",
    isAllPlayers = false,           -- True if ALL PLAYERS was selected
    selectedEffect = nil,
    selectedEffectCategory = "",
    selectedPowerLevel = nil,       -- Full power level object
    selectedIntensity = 1.0,        -- Legacy: just the multiplier

    -- Wheel display data (for clients)
    playerList = {},
    effectList = {},
    intensityList = {},

    -- Active effects on players
    -- For single player: {clientNum = {effectId, endTime, powerLevel, originalValues, ...}}
    -- For ALL PLAYERS: multiple entries, one per player
    activeEffects = {},

    -- Global effects state (affects CVARs like gravity/speed)
    globalEffects = {},  -- {effectId = {endTime, originalValue, triggeredBy}}

    -- Recently selected players (for cooldown)
    recentPlayers = {},

    -- Frozen players during animation
    frozenPlayers = {},

    -- Original health/flags for invincibility restore
    originalHealth = {},
    originalFlags = {}
}

-- Reset state for new map
function rickroll.state.reset()
    rickroll.state.nextTriggerTime = 0
    rickroll.state.lastTriggerTime = 0
    rickroll.state.isRolling = false
    rickroll.state.rollStartTime = 0
    rickroll.state.selectedPlayer = -1
    rickroll.state.isAllPlayers = false
    rickroll.state.selectedPowerLevel = nil
    rickroll.state.activeEffects = {}
    rickroll.state.globalEffects = {}
    rickroll.state.recentPlayers = {}
    rickroll.state.frozenPlayers = {}
    rickroll.state.originalHealth = {}
    rickroll.state.originalFlags = {}
end

-- Add player to recent list
function rickroll.state.addRecentPlayer(clientNum)
    table.insert(rickroll.state.recentPlayers, 1, clientNum)
    -- Keep only last N entries based on cooldown setting
    local maxRecent = rickroll.config.samePlayerCooldown or 2
    while #rickroll.state.recentPlayers > maxRecent do
        table.remove(rickroll.state.recentPlayers)
    end
end

-- Check if player was recently selected
function rickroll.state.wasRecentlySelected(clientNum)
    for _, recent in ipairs(rickroll.state.recentPlayers) do
        if recent == clientNum then
            return true
        end
    end
    return false
end

return rickroll.state
