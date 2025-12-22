--[[
    Rick Roll Mode - Trigger System
    Handles when Rick Roll events occur

    Logic:
    - Wait for human to join a team before first roll
    - 15 seconds after human joins, run first roll (full intro)
    - Then wait 5-10 minutes for subsequent rolls
    - If no humans when timer expires, wait for human to join again
]]--

rickroll = rickroll or {}
rickroll.trigger = {}

-- Check if there's at least one human player on a team
function rickroll.trigger.hasHumanPlayer()
    for i = 0, tonumber(et.trap_Cvar_Get("sv_maxclients")) - 1 do
        if et.gentity_get(i, "inuse") == 1 then
            local isBot = et.gentity_get(i, "r.svFlags")
            -- Check if not a bot (SVF_BOT = 8)
            if isBot and (isBot % 16) < 8 then
                local team = tonumber(et.gentity_get(i, "sess.sessionTeam")) or 0
                -- Team 1 = Axis, Team 2 = Allies (not spectator/0 or unknown/3)
                if team == 1 or team == 2 then
                    return true
                end
            end
        end
    end
    return false
end

-- Initialize trigger system
function rickroll.trigger.init(levelTime)
    rickroll.state.mapStartTime = levelTime
    rickroll.state.hasRunFirstRoll = false
    rickroll.state.waitingForHuman = true
    rickroll.state.humanJoinTime = nil
    rickroll.state.nextTriggerTime = nil

    if rickroll.config.debug then
        et.G_Print("[RickRoll] ^3Trigger system initialized - waiting for human player\n")
    end
end

-- Called when a human joins a team (from et_ClientBegin or team change)
function rickroll.trigger.onHumanJoined(levelTime)
    -- Only trigger the join delay if we're waiting for a human
    if not rickroll.state.waitingForHuman then
        return
    end

    rickroll.state.waitingForHuman = false
    rickroll.state.humanJoinTime = levelTime
    rickroll.state.nextTriggerTime = levelTime + rickroll.config.humanJoinDelay

    et.G_Print(string.format("[RickRoll] ^3Human joined! First roll in %.1f seconds\n",
        rickroll.config.humanJoinDelay / 1000))
end

-- Schedule next trigger (for subsequent rolls)
function rickroll.trigger.scheduleNext(currentTime)
    local cfg = rickroll.config
    local delay = math.random(cfg.interval.min, cfg.interval.max)

    rickroll.state.nextTriggerTime = currentTime + delay

    if rickroll.config.debug then
        et.G_Print(string.format("[RickRoll] ^3Next trigger in %.1f minutes\n", delay / 60000))
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

    -- Skip if any effect is currently active
    if rickroll.trigger.hasActiveEffect() then
        return false
    end

    -- Check if we're waiting for a human
    if rickroll.state.waitingForHuman then
        -- Check if a human has joined
        if rickroll.trigger.hasHumanPlayer() then
            rickroll.trigger.onHumanJoined(levelTime)
        end
        return false
    end

    -- Check if timer has expired but no humans are present
    if rickroll.state.nextTriggerTime and levelTime >= rickroll.state.nextTriggerTime then
        if not rickroll.trigger.hasHumanPlayer() then
            -- No humans - go back to waiting mode
            rickroll.state.waitingForHuman = true
            rickroll.state.nextTriggerTime = nil
            et.G_Print("[RickRoll] ^3No humans present - waiting for player to join\n")
            return false
        end

        -- Humans present and timer expired - fire!
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
        -- No eligible players, go back to waiting
        rickroll.state.waitingForHuman = true
        rickroll.state.nextTriggerTime = nil
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

    local rollType = rickroll.state.hasRunFirstRoll and "SUBSEQUENT" or "FIRST"
    et.G_Print(string.format("[RickRoll] ^5%s RICK ROLL! ^7Target: %s, Effect: %s%s\n",
        rollType, targetName, effect.name, powerDisplay ~= "" and " (" .. powerDisplay .. ")" or ""))

    -- Record this player for cooldown (only if single player)
    if not isAllPlayers then
        rickroll.state.addRecentPlayer(player.clientNum)
    end

    -- Mark first roll as complete
    rickroll.state.hasRunFirstRoll = true

    -- Schedule next trigger after animation + effect duration completes
    local totalDuration = rickroll.config.animationDuration + rickroll.config.effectDuration
    rickroll.trigger.scheduleNext(levelTime + totalDuration)
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
    rickroll.state.waitingForHuman = false

    et.G_Print("[RickRoll] ^5Calling trigger.fire...\n")
    rickroll.trigger.fire(levelTime)
    et.G_Print("[RickRoll] ^5trigger.fire completed\n")
end

return rickroll.trigger
