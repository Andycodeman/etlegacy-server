--[[
    Rick Roll Mode - UI/Communication System
    Handles server->client communication and announcements
]]--

rickroll = rickroll or {}
rickroll.ui = {}

-- Start the Rick Roll animation
function rickroll.ui.startRoll(levelTime, seed)
    et.G_Print(string.format("[RickRoll] ^6startRoll ENTERED with levelTime=%d, seed=%d\n", levelTime, seed))

    -- SAFETY: Ensure any previous freeze is cleared before starting new roll
    -- This handles the case where a previous roll didn't properly unfreeze
    et.G_Print("[RickRoll] ^6Calling safety unfreeze...\n")
    rickroll.ui.freezeAll(false, levelTime)
    et.trap_SendServerCommand(-1, 'rickroll_frozen 0')

    -- Play music globally
    et.G_Print("[RickRoll] ^6Playing music...\n")
    et.G_globalSound(rickroll.config.sounds.music)

    -- Send start command to all clients
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
    et.G_Print(string.format("[RickRoll] ^6freezePlayers config = %s\n", tostring(rickroll.config.freezePlayers)))
    if rickroll.config.freezePlayers then
        et.G_Print("[RickRoll] ^6Calling FREEZE all...\n")
        rickroll.ui.freezeAll(true, levelTime)
        -- Send frozen notification to clients
        et.trap_SendServerCommand(-1, 'rickroll_frozen 1')
        et.G_Print("[RickRoll] ^6FREEZE complete\n")
    end

    -- Add time to map to compensate for rickroll duration (20 seconds)
    local currentTimeLimit = tonumber(et.trap_Cvar_Get("timelimit")) or 0
    if currentTimeLimit > 0 then
        -- Store original timelimit to restore if needed
        rickroll.state.originalTimelimit = currentTimeLimit
        -- Add ~20 seconds (converted to minutes for timelimit)
        -- Actually, timelimit is in minutes, so we need to extend level.time instead
        -- Use g_gamestate extension or just accept the time loss
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

    -- Wheel 1 stops (player)
    if elapsed >= cfg.wheel1StopTime and elapsed < cfg.wheel1StopTime + 100 then
        local playerName = rickroll.state.selectedPlayerName
        local displayName = rickroll.state.isAllPlayers and "^6ALL PLAYERS" or playerName:gsub("%^[0-9a-zA-Z]", "")

        et.trap_SendServerCommand(-1, string.format(
            'rickroll_wheel1 "%s"',
            displayName
        ))
        et.trap_SendServerCommand(-1, string.format(
            'cpm "^5TARGET: %s"',
            displayName
        ))
    end

    -- Wheel 2 stops (effect)
    if elapsed >= cfg.wheel2StopTime and elapsed < cfg.wheel2StopTime + 100 then
        local effect = rickroll.state.selectedEffect
        local colorCode = rickroll.state.selectedEffectCategory == "blessed" and "^2" or
                          rickroll.state.selectedEffectCategory == "cursed" and "^1" or "^3"
        et.trap_SendServerCommand(-1, string.format(
            'rickroll_wheel2 "%s"',
            effect.name
        ))
        et.trap_SendServerCommand(-1, string.format(
            'cpm "^5EFFECT: %s%s"',
            colorCode,
            effect.name
        ))
    end

    -- Wheel 3 stops (power level)
    if elapsed >= cfg.wheel3StopTime and elapsed < cfg.wheel3StopTime + 100 then
        local powerLevel = rickroll.state.selectedPowerLevel
        local effect = rickroll.state.selectedEffect

        -- Get display string based on effect type
        local powerDisplay = rickroll.getPowerDisplay(effect.id, powerLevel)

        et.trap_SendServerCommand(-1, string.format(
            'rickroll_wheel3 "%s"',
            powerLevel.label
        ))

        -- Show power level with context
        if powerDisplay ~= "" then
            et.trap_SendServerCommand(-1, string.format(
                'cpm "^5POWER: %s%s ^7(%s)"',
                powerLevel.color,
                powerLevel.label,
                powerDisplay
            ))
        else
            -- Fixed effect - just show the label
            et.trap_SendServerCommand(-1, string.format(
                'cpm "^5POWER: %s%s"',
                powerLevel.color,
                powerLevel.label
            ))
        end
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
    local powerLevel = state.selectedPowerLevel
    local category = state.selectedEffectCategory
    local isAllPlayers = state.isAllPlayers

    -- Display name for target
    local targetDisplay = isAllPlayers and "^6ALL PLAYERS" or playerName

    -- Color based on category
    local colorCode = category == "blessed" and "^2" or
                      category == "cursed" and "^1" or "^3"

    -- Get power display string
    local powerDisplay = rickroll.getPowerDisplay(effect.id, powerLevel)
    local powerStr = powerDisplay ~= "" and string.format(" [%s%s^7: %s]", powerLevel.color, powerLevel.label, powerDisplay) or ""

    -- Big announcement
    if isAllPlayers then
        et.trap_SendServerCommand(-1, string.format(
            'bp "^6ALL PLAYERS ^7HAVE BEEN ^5RICK ROLLED!\n%s%s%s ^7FOR %d SECONDS!"',
            colorCode,
            effect.name,
            powerStr,
            rickroll.config.effectDuration / 1000
        ))
    else
        et.trap_SendServerCommand(-1, string.format(
            'bp "%s ^7HAS BEEN ^5RICK ROLLED!\n%s%s%s ^7FOR %d SECONDS!"',
            playerName,
            colorCode,
            effect.name,
            powerStr,
            rickroll.config.effectDuration / 1000
        ))
    end

    -- Chat message
    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7%s ^5got: %s%s%s ^7for %d seconds!"',
        targetDisplay,
        colorCode,
        effect.name,
        powerStr,
        rickroll.config.effectDuration / 1000
    ))

    -- Special messages based on category
    if category == "cursed" then
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
        if isAllPlayers then
            et.trap_SendServerCommand(-1, 'cpm "^2EVERYONE WINS!"')
        else
            et.trap_SendServerCommand(-1, 'cpm "^2LUCKY!"')
        end
    else
        et.trap_SendServerCommand(-1, 'cpm "^3CHAOS REIGNS!"')
    end

    -- Send result command to clients
    et.trap_SendServerCommand(-1, string.format(
        'rickroll_result %d "%s" "%s" %d',
        isAllPlayers and -999 or state.selectedPlayer,
        effect.id,
        powerLevel.label,
        isAllPlayers and 1 or 0
    ))
end

-- End the roll animation and apply effect
function rickroll.ui.endRoll(levelTime)
    local state = rickroll.state

    -- Unfreeze players
    if rickroll.config.freezePlayers then
        rickroll.ui.freezeAll(false, levelTime)
        -- Send unfreeze notification to clients
        et.trap_SendServerCommand(-1, 'rickroll_frozen 0')
    end

    -- Apply the effect
    if state.selectedEffect then
        rickroll.effectSystem.apply(
            state.selectedPlayer,
            state.selectedEffect,
            state.selectedEffectCategory,
            state.selectedPowerLevel,
            rickroll.config.effectDuration,
            state.isAllPlayers
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

-- NOTE: setAllInvincible removed - god mode was getting stuck on players
-- Freeze alone is sufficient protection during rickroll animation

-- Actually freeze all players (including bots) in place during rickroll animation
-- Uses rickrollFreezeUntil mechanism for real movement freeze + visual effect
-- IMPORTANT: levelTime must be the game's level.time, NOT trap_Milliseconds()!
function rickroll.ui.freezeAll(freeze, levelTime)
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
    local frozenCount = 0

    et.G_Print(string.format("[RickRoll] ^5freezeAll called: freeze=%s, levelTime=%d\n",
        tostring(freeze), levelTime or -1))

    if not levelTime or levelTime == 0 then
        et.G_Print("[RickRoll] ^1ERROR: levelTime is nil or 0!\n")
        return
    end

    for clientNum = 0, maxClients - 1 do
        -- Check if entity is in use (works for both humans and bots)
        local inuse = et.gentity_get(clientNum, "inuse")
        if inuse == 1 then
            local team = et.gentity_get(clientNum, "sess.sessionTeam")
            local name = et.gentity_get(clientNum, "pers.netname") or "unknown"
            -- Freeze anyone on Axis (1) or Allies (2)
            if team == 1 or team == 2 then
                local health = et.gentity_get(clientNum, "health") or 0
                -- Only freeze living players
                if health > 0 then
                    if freeze then
                        -- Freeze for animation duration + buffer (25 seconds max)
                        -- Use levelTime (game time) NOT trap_Milliseconds (system time)!
                        local freezeUntil = levelTime + 25000
                        et.gentity_set(clientNum, "rickrollFreezeUntil", freezeUntil)

                        -- Verify it was set
                        local verify = et.gentity_get(clientNum, "rickrollFreezeUntil") or 0
                        et.G_Print(string.format("[RickRoll] ^2Froze %s (client %d): freezeUntil=%d, verify=%d, levelTime=%d\n",
                            name, clientNum, freezeUntil, verify, levelTime))
                        -- NOTE: No god mode - freeze is enough protection, and god mode can get stuck
                        frozenCount = frozenCount + 1
                    else
                        -- Unfreeze
                        et.gentity_set(clientNum, "rickrollFreezeUntil", 0)
                        et.G_Print(string.format("[RickRoll] ^3Unfroze %s (client %d)\n", name, clientNum))
                        frozenCount = frozenCount + 1
                    end
                end
            end
        end
    end

    et.G_Print(string.format("[RickRoll] ^3%s %d players total\n", freeze and "FROZE" or "UNFROZE", frozenCount))
end

-- Announce effect application
function rickroll.ui.announceEffect(clientNum, effect, powerLevel)
    local name = et.gentity_get(clientNum, "pers.netname") or "Player"
    local powerDisplay = rickroll.getPowerDisplay(effect.id, powerLevel)

    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7%s ^7now has: ^3%s%s"',
        name,
        effect.name,
        powerDisplay ~= "" and " (" .. powerDisplay .. ")" or ""
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
