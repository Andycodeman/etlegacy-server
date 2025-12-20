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

-- Check if should trigger (called every frame)
function rickroll.trigger.check(levelTime)
    -- Skip if disabled
    if not rickroll.config.enabled then
        return false
    end

    -- Skip if currently rolling
    if rickroll.state.isRolling then
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

    -- Select player
    local player = rickroll.selection.pickPlayer(seed)
    if not player then
        -- No eligible players, try again later
        rickroll.trigger.scheduleNext(levelTime)
        return
    end

    -- Select effect
    local effect, category = rickroll.selection.pickEffect(seed)
    if not effect then
        rickroll.trigger.scheduleNext(levelTime)
        return
    end

    -- Select intensity
    local intensity = rickroll.selection.pickIntensity(seed)

    -- Store selections
    rickroll.state.isRolling = true
    rickroll.state.rollStartTime = levelTime
    rickroll.state.rollSeed = seed
    rickroll.state.selectedPlayer = player.clientNum
    rickroll.state.selectedPlayerName = player.name
    rickroll.state.selectedEffect = effect
    rickroll.state.selectedEffectCategory = category
    rickroll.state.selectedIntensity = intensity

    -- Build wheel lists
    rickroll.state.playerList = rickroll.selection.buildPlayerList()
    rickroll.state.effectList = rickroll.selection.buildEffectList()
    rickroll.state.intensityList = rickroll.selection.buildIntensityList()

    -- Start the show!
    rickroll.ui.startRoll(levelTime, seed)

    et.G_Print(string.format("[RickRoll] ^5RICK ROLL TRIGGERED! ^7Player: %s, Effect: %s (%.2fx)\n",
        player.name, effect.name, intensity))

    -- Record this player for cooldown
    rickroll.state.addRecentPlayer(player.clientNum)

    -- Schedule next trigger
    rickroll.trigger.scheduleNext(levelTime + rickroll.config.animationDuration)
end

-- Force trigger (for testing via rcon)
function rickroll.trigger.force(levelTime)
    -- Reset cooldowns for testing
    rickroll.state.recentPlayers = {}
    rickroll.state.isRolling = false

    rickroll.trigger.fire(levelTime)
end

return rickroll.trigger
