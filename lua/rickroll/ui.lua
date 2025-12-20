--[[
    Rick Roll Mode - UI/Communication System
    Handles server->client communication and announcements
]]--

rickroll = rickroll or {}
rickroll.ui = {}

-- Start the Rick Roll animation
function rickroll.ui.startRoll(levelTime, seed)
    -- Play music globally
    et.G_globalSound(rickroll.config.sounds.music)

    -- Send start command to all clients
    -- Format: rickroll_start <startTime> <seed> <playerCount> <effectCount>
    local playerCount = #rickroll.state.playerList
    local effectCount = #rickroll.state.effectList
    local intensityCount = #rickroll.state.intensityList

    -- Build player name list (pipe-separated)
    local playerNames = table.concat(rickroll.state.playerList, "|")

    -- Build effect name list
    local effectNames = {}
    for _, e in ipairs(rickroll.state.effectList) do
        table.insert(effectNames, e.name)
    end
    local effectStr = table.concat(effectNames, "|")

    -- Build intensity list
    local intensityStr = table.concat(rickroll.state.intensityList, "|")

    -- Send command to start animation on clients
    et.trap_SendServerCommand(-1, string.format(
        'rickroll_start %d %d %d %d %d "%s" "%s" "%s"',
        levelTime,
        seed,
        playerCount,
        effectCount,
        intensityCount,
        playerNames,
        effectStr,
        intensityStr
    ))

    -- Also send banner message for clients without cgame support
    et.trap_SendServerCommand(-1, 'bp "^1♪ ^5RICK ROLL MODE ACTIVATED ^1♪"')

    -- Freeze players if configured
    if rickroll.config.freezePlayers then
        rickroll.ui.freezeAll(true)
    end

    -- Protect selected player
    if rickroll.config.protectSelected and rickroll.state.selectedPlayer >= 0 then
        -- Give temporary god mode
        -- Note: This requires qagame modification for proper implementation
    end

    if rickroll.config.debug then
        et.G_Print("[RickRoll] ^3Animation started\n")
    end
end

-- Update rolling animation (called from RunFrame)
function rickroll.ui.updateRoll(levelTime)
    if not rickroll.state.isRolling then
        return
    end

    local elapsed = levelTime - rickroll.state.rollStartTime
    local cfg = rickroll.config

    -- Send wheel position updates to clients
    -- (Clients calculate their own positions from seed, but we send sync points)

    -- Wheel 1 stops (player)
    if elapsed >= cfg.wheel1StopTime and elapsed < cfg.wheel1StopTime + 100 then
        local playerName = rickroll.state.selectedPlayerName:gsub("%^[0-9a-zA-Z]", "")
        et.trap_SendServerCommand(-1, string.format(
            'rickroll_wheel1 "%s"',
            playerName
        ))
        et.trap_SendServerCommand(-1, string.format(
            'cpm "^5PLAYER: ^7%s"',
            playerName
        ))
    end

    -- Wheel 2 stops (effect)
    if elapsed >= cfg.wheel2StopTime and elapsed < cfg.wheel2StopTime + 100 then
        local effect = rickroll.state.selectedEffect
        et.trap_SendServerCommand(-1, string.format(
            'rickroll_wheel2 "%s"',
            effect.name
        ))
        local colorCode = rickroll.state.selectedEffectCategory == "blessed" and "^2" or
                          rickroll.state.selectedEffectCategory == "cursed" and "^1" or "^3"
        et.trap_SendServerCommand(-1, string.format(
            'cpm "^5EFFECT: %s%s"',
            colorCode,
            effect.name
        ))
    end

    -- Wheel 3 stops (intensity)
    if elapsed >= cfg.wheel3StopTime and elapsed < cfg.wheel3StopTime + 100 then
        local intensity = rickroll.state.selectedIntensity
        et.trap_SendServerCommand(-1, string.format(
            'rickroll_wheel3 "%.2fx"',
            intensity
        ))
        et.trap_SendServerCommand(-1, string.format(
            'cpm "^5INTENSITY: ^7%.2fx"',
            intensity
        ))
    end

    -- Show final result
    if elapsed >= cfg.resultShowTime and elapsed < cfg.resultShowTime + 100 then
        rickroll.ui.showResult()
    end

    -- End animation
    if elapsed >= cfg.animationDuration then
        rickroll.ui.endRoll(levelTime)
    end
end

-- Show the final result
function rickroll.ui.showResult()
    local state = rickroll.state
    local playerName = state.selectedPlayerName
    local effect = state.selectedEffect
    local intensity = state.selectedIntensity
    local category = state.selectedEffectCategory

    -- Color based on category
    local colorCode = category == "blessed" and "^2" or
                      category == "cursed" and "^1" or "^3"

    -- Big announcement
    et.trap_SendServerCommand(-1, string.format(
        'bp "%s ^7HAS BEEN ^5RICK ROLLED!\n%s%s ^7(%.2fx) FOR %d SECONDS!"',
        playerName,
        colorCode,
        effect.name,
        intensity,
        rickroll.config.effectDuration / 1000
    ))

    -- Chat message
    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7%s ^5got: %s%s ^7(%.2fx) for %d seconds!"',
        playerName,
        colorCode,
        effect.name,
        intensity,
        rickroll.config.effectDuration / 1000
    ))

    -- Special messages for bad effects
    if category == "cursed" then
        -- Taunt message
        local taunts = {
            "^1LOL GET REKT",
            "^1NEVER GONNA GIVE YOU UP!",
            "^1YOU JUST GOT RICK ROLLED!",
            "^1F IN CHAT",
            "^1RIP BOZO"
        }
        local taunt = taunts[math.random(#taunts)]
        et.trap_SendServerCommand(-1, string.format('cpm "%s"', taunt))
    elseif category == "blessed" then
        et.trap_SendServerCommand(-1, 'cpm "^2LUCKY!"')
    else
        et.trap_SendServerCommand(-1, 'cpm "^3CHAOS REIGNS!"')
    end

    -- Send result command to clients
    et.trap_SendServerCommand(-1, string.format(
        'rickroll_result %d "%s" %.2f',
        state.selectedPlayer,
        effect.id,
        intensity
    ))
end

-- End the roll animation and apply effect
function rickroll.ui.endRoll(levelTime)
    local state = rickroll.state

    -- Unfreeze players
    if rickroll.config.freezePlayers then
        rickroll.ui.freezeAll(false)
    end

    -- Apply the effect
    if state.selectedPlayer >= 0 and state.selectedEffect then
        rickroll.effectSystem.apply(
            state.selectedPlayer,
            state.selectedEffect,
            state.selectedEffectCategory,
            state.selectedIntensity,
            rickroll.config.effectDuration
        )
    end

    -- Send end command to clients
    et.trap_SendServerCommand(-1, 'rickroll_end')

    -- Reset rolling state
    state.isRolling = false
    state.rollStartTime = 0

    if rickroll.config.debug then
        et.G_Print("[RickRoll] ^3Animation ended, effect applied\n")
    end
end

-- Make all players invincible (god mode) during animation
function rickroll.ui.setAllInvincible(invincible)
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    for clientNum = 0, maxClients - 1 do
        if et.gentity_get(clientNum, "inuse") == 1 then
            local team = et.gentity_get(clientNum, "sess.sessionTeam")
            -- Only affect players on Axis (1) or Allies (2)
            if team == 1 or team == 2 then
                if invincible then
                    -- Store original health and make invincible
                    local currentHealth = et.gentity_get(clientNum, "health")
                    rickroll.state.originalHealth[clientNum] = currentHealth
                    -- Set health very high to simulate invincibility
                    et.gentity_set(clientNum, "health", 9999)
                    -- Also set GODMODE flag (FL_GODMODE = 16)
                    local flags = et.gentity_get(clientNum, "flags") or 0
                    rickroll.state.originalFlags[clientNum] = flags
                    et.gentity_set(clientNum, "flags", bit.bor(flags, 16))
                else
                    -- Restore original health and flags
                    if rickroll.state.originalHealth[clientNum] then
                        -- Don't restore if they died (health went negative)
                        local currentHealth = et.gentity_get(clientNum, "health")
                        if currentHealth > 0 then
                            et.gentity_set(clientNum, "health", rickroll.state.originalHealth[clientNum])
                        end
                        rickroll.state.originalHealth[clientNum] = nil
                    end
                    if rickroll.state.originalFlags[clientNum] then
                        -- Remove GODMODE flag
                        local flags = et.gentity_get(clientNum, "flags") or 0
                        et.gentity_set(clientNum, "flags", bit.band(flags, bit.bnot(16)))
                        rickroll.state.originalFlags[clientNum] = nil
                    end
                end
            end
        end
    end

    if rickroll.config.debug then
        et.G_Print(string.format("[RickRoll] ^3All players %s\n", invincible and "INVINCIBLE" or "VULNERABLE"))
    end
end

-- Legacy freeze function (calls invincibility now)
function rickroll.ui.freezeAll(freeze)
    rickroll.ui.setAllInvincible(freeze)
end

-- Announce effect application
function rickroll.ui.announceEffect(clientNum, effect, intensity)
    local name = et.gentity_get(clientNum, "pers.netname") or "Player"

    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7%s ^7now has: ^3%s ^7(%.2fx)"',
        name,
        effect.name,
        intensity
    ))
end

-- Announce effect expiry
function rickroll.ui.announceExpiry(clientNum)
    local name = et.gentity_get(clientNum, "pers.netname") or "Player"

    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7%s^7\'s effect has worn off."',
        name
    ))
end

return rickroll.ui
