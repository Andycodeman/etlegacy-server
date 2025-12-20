--[[
    Rick Roll Mode - Player and Effect Selection
    Handles random selection of players and effects
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

-- Select a random player
function rickroll.selection.pickPlayer(seed)
    local players = rickroll.selection.getEligiblePlayers()

    if #players == 0 then
        return nil
    end

    -- Use seed for deterministic selection (same result on server and all clients)
    math.randomseed(seed)
    local idx = math.random(1, #players)

    return players[idx]
end

-- Select a random effect based on category weights
function rickroll.selection.pickEffect(seed)
    local cfg = rickroll.config
    local weights = cfg.weights

    -- Calculate total weight
    local total = weights.blessed + weights.cursed + weights.chaotic

    -- Use seed for deterministic selection
    math.randomseed(seed + 1000)  -- Offset seed for different result
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

    -- Pick random effect from category
    local effects = rickroll.effects[category]
    if not effects or #effects == 0 then
        -- Fallback to blessed if category is empty
        category = "blessed"
        effects = rickroll.effects.blessed
    end

    math.randomseed(seed + 2000)
    local effectIdx = math.random(1, #effects)

    return effects[effectIdx], category
end

-- Select a random intensity
function rickroll.selection.pickIntensity(seed)
    local intensities = rickroll.config.intensities

    math.randomseed(seed + 3000)
    local idx = math.random(1, #intensities)

    return intensities[idx]
end

-- Build player list for wheel display
function rickroll.selection.buildPlayerList()
    local players = rickroll.selection.getEligiblePlayers()
    local names = {}

    for _, p in ipairs(players) do
        -- Strip color codes for cleaner display
        local cleanName = p.name:gsub("%^[0-9a-zA-Z]", "")
        table.insert(names, cleanName)
    end

    -- Pad list if too short (need at least 8 for smooth scrolling)
    while #names < 8 do
        for _, p in ipairs(players) do
            local cleanName = p.name:gsub("%^[0-9a-zA-Z]", "")
            table.insert(names, cleanName)
            if #names >= 8 then break end
        end
        if #players == 0 then
            table.insert(names, "???")
        end
    end

    return names
end

-- Build effect list for wheel display
function rickroll.selection.buildEffectList()
    local effects = {}

    for _, effect in ipairs(rickroll.effects.blessed) do
        table.insert(effects, {name = effect.name, color = "^2"})  -- Green
    end
    for _, effect in ipairs(rickroll.effects.cursed) do
        table.insert(effects, {name = effect.name, color = "^1"})  -- Red
    end
    for _, effect in ipairs(rickroll.effects.chaotic) do
        table.insert(effects, {name = effect.name, color = "^3"})  -- Yellow
    end

    return effects
end

-- Build intensity list for wheel display
function rickroll.selection.buildIntensityList()
    local list = {}
    for _, intensity in ipairs(rickroll.config.intensities) do
        table.insert(list, string.format("%.2fx", intensity))
    end
    -- Duplicate to have enough for scrolling
    local base = #list
    for i = 1, 8 - base do
        table.insert(list, list[((i - 1) % base) + 1])
    end
    return list
end

return rickroll.selection
