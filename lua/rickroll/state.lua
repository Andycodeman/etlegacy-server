--[[
    Rick Roll Mode - State Management
    Tracks active rolls, effects, and timing
]]--

rickroll = rickroll or {}

rickroll.state = {
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
    selectedEffect = nil,
    selectedEffectCategory = "",
    selectedIntensity = 1.0,

    -- Wheel display data (for clients)
    playerList = {},
    effectList = {},
    intensityList = {},

    -- Active effects on players
    activeEffects = {},  -- {clientNum = {effectId, endTime, intensity, originalValues}}

    -- Global effects state
    globalEffects = {},  -- {effectId = {endTime, originalValue}}

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
