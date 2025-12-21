--[[
    Rick Roll Mode - Trigger System
    Handles when Rick Roll events occur
]]--

rickroll = rickroll or {}
rickroll.trigger = {}

-- Initialize trigger system
function rickroll.trigger.init(levelTime)
    rickroll.state.mapStartTime = levelTime
    rickroll.trigger.scheduleNext(levelTime)

    if rickroll.config.debug then
        et.G_Print("[RickRoll] ^3Trigger system initialized\n")
    end
end

-- Schedule next trigger
function rickroll.trigger.scheduleNext(currentTime)
    local cfg = rickroll.config
    local interval = cfg.interval

    -- Random delay between min and max
    local delay = math.random(interval.min, interval.max)

    rickroll.state.nextTriggerTime = currentTime + delay

    if rickroll.config.debug then
        et.G_Print(string.format("[RickRoll] ^3Next trigger in %.1f seconds\n", delay / 1000))
    end
end

-- Check if any effect is currently active
function rickroll.trigger.hasActiveEffect()
    -- Check player effects
    for clientNum, data in pairs(rickroll.state.activeEffects) do
        if data then
            return true
        end
    end
    -- Check global effects
    for effectId, data in pairs(rickroll.state.globalEffects) do
        if data then
            return true
        end
    end
    return false
end

-- Check if should trigger (called every frame)
function rickroll.trigger.check(levelTime)
    -- Skip if disabled
    if not rickroll.config.enabled then
        return false
    end

    -- Skip if auto-trigger is disabled (manual mode only)
    if not rickroll.config.autoTrigger then
        return false
    end

    -- Skip if currently rolling
    if rickroll.state.isRolling then
        return false
    end

    -- Skip if any effect is currently active (wait for it to expire)
    if rickroll.trigger.hasActiveEffect() then
        -- Postpone next trigger until effects expire
        rickroll.state.nextTriggerTime = levelTime + 5000  -- Check again in 5 seconds
        return false
    end

    -- Skip during warmup
    local mapTime = levelTime - rickroll.state.mapStartTime
    if mapTime < rickroll.config.warmupDelay then
        return false
    end

    -- Check if it's time
    if levelTime >= rickroll.state.nextTriggerTime then
        rickroll.trigger.fire(levelTime)
        return true
    end

    return false
end

-- Fire the Rick Roll!
function rickroll.trigger.fire(levelTime)
    -- Generate seed for deterministic random (same on server and all clients)
    local seed = levelTime + math.random(100000)

    -- Select player (may be ALL PLAYERS)
    local player = rickroll.selection.pickPlayer(seed)
    if not player then
        -- No eligible players, try again later
        rickroll.trigger.scheduleNext(levelTime)
        return
    end

    local isAllPlayers = player.isAllPlayers or false

    -- Select effect (filtered if ALL PLAYERS selected)
    local effect, category = rickroll.selection.pickEffect(seed, isAllPlayers)
    if not effect then
        rickroll.trigger.scheduleNext(levelTime)
        return
    end

    -- Select power level (full object with multiplier and interval)
    local powerLevel = rickroll.selection.pickPowerLevel(seed)

    -- Store selections in state
    rickroll.state.isRolling = true
    rickroll.state.rollStartTime = levelTime
    rickroll.state.rollSeed = seed
    rickroll.state.selectedPlayer = player.clientNum
    rickroll.state.selectedPlayerName = player.name
    rickroll.state.isAllPlayers = isAllPlayers
    rickroll.state.selectedEffect = effect
    rickroll.state.selectedEffectCategory = category
    rickroll.state.selectedPowerLevel = powerLevel
    rickroll.state.selectedIntensity = powerLevel.multiplier  -- For backward compatibility

    -- Build wheel lists
    rickroll.state.playerList = rickroll.selection.buildPlayerList()
    rickroll.state.effectList = rickroll.selection.buildEffectList(isAllPlayers)
    rickroll.state.intensityList = rickroll.selection.buildIntensityList()

    -- Start the show!
    et.G_Print(string.format("[RickRoll] ^5Calling startRoll with levelTime=%d\n", levelTime))
    rickroll.ui.startRoll(levelTime, seed)

    -- Log with power meaning
    local powerDisplay = rickroll.getPowerDisplay(effect.id, powerLevel)
    local targetName = isAllPlayers and "^6ALL PLAYERS" or player.name

    et.G_Print(string.format("[RickRoll] ^5RICK ROLL TRIGGERED! ^7Target: %s, Effect: %s%s\n",
        targetName, effect.name, powerDisplay ~= "" and " (" .. powerDisplay .. ")" or ""))

    -- Record this player for cooldown (only if single player)
    if not isAllPlayers then
        rickroll.state.addRecentPlayer(player.clientNum)
    end

    -- Schedule next trigger
    rickroll.trigger.scheduleNext(levelTime + rickroll.config.animationDuration)
end

-- Force trigger (for testing via rcon)
function rickroll.trigger.force(levelTime)
    et.G_Print(string.format("[RickRoll] ^5trigger.force called with levelTime=%d\n", levelTime))

    -- SAFETY: Unfreeze any frozen players from previous roll
    rickroll.ui.freezeAll(false, levelTime)
    et.trap_SendServerCommand(-1, 'rickroll_frozen 0')

    -- Reset cooldowns for testing
    rickroll.state.recentPlayers = {}
    rickroll.state.isRolling = false

    et.G_Print("[RickRoll] ^5Calling trigger.fire...\n")
    rickroll.trigger.fire(levelTime)
    et.G_Print("[RickRoll] ^5trigger.fire completed\n")
end

return rickroll.trigger
