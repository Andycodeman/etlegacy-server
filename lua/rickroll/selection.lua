--[[
    Rick Roll Mode - Player and Effect Selection
    Handles random selection of players and effects

    WHEEL CONTENTS:
    - Wheel 1 (PLAYER): List of eligible player names + "ALL PLAYERS" option
    - Wheel 2 (EFFECT): Effects from blessed/cursed/chaotic (filtered if ALL selected)
    - Wheel 3 (POWER): MILD / MODERATE / STRONG / EXTREME / LEGENDARY
]]--

rickroll = rickroll or {}
rickroll.selection = {}

-- Get list of eligible players (humans on Axis or Allies)
function rickroll.selection.getEligiblePlayers()
    local players = {}
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    for clientNum = 0, maxClients - 1 do
        if et.gentity_get(clientNum, "inuse") == 1 then
            local connected = et.gentity_get(clientNum, "pers.connected")
            if connected == 2 then  -- CON_CONNECTED
                local team = et.gentity_get(clientNum, "sess.sessionTeam")
                -- team 1 = Axis, 2 = Allies, 3 = Spectator
                if team == 1 or team == 2 then
                    local name = et.gentity_get(clientNum, "pers.netname") or ""
                    -- Skip bots
                    if not name:find("%[BOT%]") then
                        -- Check cooldown (don't select same player repeatedly)
                        if not rickroll.state.wasRecentlySelected(clientNum) or #players == 0 then
                            table.insert(players, {
                                clientNum = clientNum,
                                name = name
                            })
                        end
                    end
                end
            end
        end
    end

    return players
end

-- Get all human players (for applying effects to everyone)
function rickroll.selection.getAllHumanPlayers()
    local players = {}
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    for clientNum = 0, maxClients - 1 do
        if et.gentity_get(clientNum, "inuse") == 1 then
            local connected = et.gentity_get(clientNum, "pers.connected")
            if connected == 2 then  -- CON_CONNECTED
                local team = et.gentity_get(clientNum, "sess.sessionTeam")
                if team == 1 or team == 2 then
                    local name = et.gentity_get(clientNum, "pers.netname") or ""
                    -- Skip bots
                    if not name:find("%[BOT%]") then
                        table.insert(players, {
                            clientNum = clientNum,
                            name = name
                        })
                    end
                end
            end
        end
    end

    return players
end

-- Get ALL players including bots (for ALL PLAYERS effects)
function rickroll.selection.getAllPlayersIncludingBots()
    local players = {}
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    for clientNum = 0, maxClients - 1 do
        if et.gentity_get(clientNum, "inuse") == 1 then
            local connected = et.gentity_get(clientNum, "pers.connected")
            if connected == 2 then  -- CON_CONNECTED
                local team = et.gentity_get(clientNum, "sess.sessionTeam")
                if team == 1 or team == 2 then
                    local name = et.gentity_get(clientNum, "pers.netname") or ""
                    table.insert(players, {
                        clientNum = clientNum,
                        name = name
                    })
                end
            end
        end
    end

    return players
end

-- Select a random player (or ALL PLAYERS)
function rickroll.selection.pickPlayer(seed)
    local players = rickroll.selection.getEligiblePlayers()

    if #players == 0 then
        return nil
    end

    -- Use seed for deterministic selection
    math.randomseed(seed)

    -- Check if we should select ALL PLAYERS
    local allPlayersRoll = math.random(1, 100)
    if allPlayersRoll <= rickroll.config.allPlayersWeight then
        -- ALL PLAYERS selected!
        return {
            clientNum = rickroll.ALL_PLAYERS,
            name = "ALL PLAYERS",
            isAllPlayers = true
        }
    end

    -- Select individual player
    local idx = math.random(1, #players)
    local selected = players[idx]
    selected.isAllPlayers = false

    return selected
end

-- Select a random effect based on category weights
-- Now takes isAllPlayers to filter out single-player-only effects
function rickroll.selection.pickEffect(seed, isAllPlayers)
    local cfg = rickroll.config
    local weights = cfg.weights

    -- Get available effects (filters out singlePlayerOnly when ALL selected)
    local availableEffects = rickroll.getAvailableEffects(isAllPlayers)

    -- Calculate total weight
    local total = weights.blessed + weights.cursed + weights.chaotic

    -- Use seed for deterministic selection
    math.randomseed(seed + 1000)
    local roll = math.random(1, total)

    -- Determine category
    local category
    if roll <= weights.blessed then
        category = "blessed"
    elseif roll <= weights.blessed + weights.cursed then
        category = "cursed"
    else
        category = "chaotic"
    end

    -- Get effects for this category
    local effects = availableEffects[category]
    if not effects or #effects == 0 then
        -- Fallback to blessed if category is empty
        category = "blessed"
        effects = availableEffects.blessed
    end

    -- Still no effects? Use all effects
    if not effects or #effects == 0 then
        effects = rickroll.effects.blessed
        category = "blessed"
    end

    math.randomseed(seed + 2000)
    local effectIdx = math.random(1, #effects)

    return effects[effectIdx], category
end

-- Select a random power level
function rickroll.selection.pickPowerLevel(seed)
    local powerLevels = rickroll.config.powerLevels

    math.randomseed(seed + 3000)
    local idx = math.random(1, #powerLevels)

    -- Return the full power level object
    return powerLevels[idx]
end

-- Legacy function for backward compatibility
function rickroll.selection.pickIntensity(seed)
    local powerLevel = rickroll.selection.pickPowerLevel(seed)
    return powerLevel.multiplier
end

-- Get power level info for a given multiplier
function rickroll.selection.getPowerLevelInfo(multiplier)
    for _, level in ipairs(rickroll.config.powerLevels) do
        if level.multiplier == multiplier then
            return level
        end
    end
    -- Fallback
    return { label = string.format("%.2fx", multiplier), multiplier = multiplier, interval = 10000, color = "^7" }
end

-- Build player list for wheel display (includes ALL PLAYERS option)
function rickroll.selection.buildPlayerList()
    local players = rickroll.selection.getEligiblePlayers()
    local names = {}

    -- Build base list with ALL PLAYERS interspersed
    -- Add player names first
    for _, p in ipairs(players) do
        local cleanName = p.name:gsub("%^[0-9a-zA-Z]", "")
        table.insert(names, cleanName)
    end

    -- Insert ALL PLAYERS in the middle-ish (will appear in spinning wheel)
    local insertPos = math.max(1, math.floor(#names / 2) + 1)
    table.insert(names, insertPos, "ALL PLAYERS")

    -- Pad list if too short (need at least 8 for smooth scrolling)
    -- Repeat the list but keep only 1 ALL PLAYERS entry visible
    local baseNames = {}
    for _, n in ipairs(names) do
        table.insert(baseNames, n)
    end

    while #names < 8 do
        for _, n in ipairs(baseNames) do
            if n ~= "ALL PLAYERS" then  -- Don't duplicate ALL PLAYERS
                table.insert(names, n)
            end
            if #names >= 8 then break end
        end
        -- If still not enough, add placeholder
        if #names < 8 then
            table.insert(names, "???")
        end
    end

    return names
end

-- Build effect list for wheel display
-- Can be filtered based on whether ALL PLAYERS is selected
function rickroll.selection.buildEffectList(isAllPlayers)
    local effects = {}
    local availableEffects = rickroll.getAvailableEffects(isAllPlayers or false)

    -- Add blessed effects (green)
    for _, effect in ipairs(availableEffects.blessed) do
        table.insert(effects, {
            name = effect.name,
            color = "^2",  -- Green for blessed
            id = effect.id,
            category = "blessed"
        })
    end

    -- Add cursed effects (red)
    for _, effect in ipairs(availableEffects.cursed) do
        table.insert(effects, {
            name = effect.name,
            color = "^1",  -- Red for cursed
            id = effect.id,
            category = "cursed"
        })
    end

    -- Add chaotic effects (yellow)
    for _, effect in ipairs(availableEffects.chaotic) do
        table.insert(effects, {
            name = effect.name,
            color = "^3",  -- Yellow for chaotic
            id = effect.id,
            category = "chaotic"
        })
    end

    return effects
end

-- Build power level list for wheel display (Wheel 3)
function rickroll.selection.buildIntensityList()
    local list = {}

    for _, level in ipairs(rickroll.config.powerLevels) do
        -- Format: "^2MILD" or "^1EXTREME" with color codes
        table.insert(list, level.color .. level.label)
    end

    -- Duplicate to have enough for smooth scrolling animation
    local base = #list
    while #list < 8 do
        for i = 1, base do
            table.insert(list, list[i])
            if #list >= 8 then break end
        end
    end

    return list
end

-- Legacy function for backward compatibility
function rickroll.selection.buildPowerList()
    return rickroll.selection.buildIntensityList()
end

-- Get the index of a specific intensity value in the power levels
function rickroll.selection.getIntensityIndex(intensity)
    for i, level in ipairs(rickroll.config.powerLevels) do
        if level.multiplier == intensity then
            return i
        end
    end
    return 1  -- Default to first
end

-- Get total effect count for wheel sizing
function rickroll.selection.getEffectCount(isAllPlayers)
    local availableEffects = rickroll.getAvailableEffects(isAllPlayers or false)
    local count = 0
    count = count + #availableEffects.blessed
    count = count + #availableEffects.cursed
    count = count + #availableEffects.chaotic
    return count
end

return rickroll.selection
