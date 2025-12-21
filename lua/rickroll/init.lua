--[[
    Rick Roll Mode - Main Entry Point

    A lottery/jackpot style feature for ET:Legacy servers.
    Randomly triggers during gameplay, displaying a slot-machine
    style interface with dancing Rick Astley and "Never Gonna Give You Up".

    Usage:
        Add to main.lua:
        dofile("legacy/lua/rickroll/init.lua")

    Console commands:
        /rcon rickroll_trigger  - Force trigger (for testing)
        /rcon rickroll_enable   - Enable Rick Roll Mode
        /rcon rickroll_disable  - Disable Rick Roll Mode
        /rcon rickroll_status   - Show current status
]]--

-- Initialize namespace
rickroll = rickroll or {}

-- Load modules (order matters!)
dofile("legacy/lua/rickroll/config.lua")
dofile("legacy/lua/rickroll/state.lua")
dofile("legacy/lua/rickroll/selection.lua")
dofile("legacy/lua/rickroll/effects.lua")
dofile("legacy/lua/rickroll/trigger.lua")
dofile("legacy/lua/rickroll/ui.lua")

-- Version info
rickroll.version = "1.0.0"
rickroll.name = "Rick Roll Mode"

--[[
    Initialization
]]--
function rickroll.init(levelTime, randomSeed)
    -- Seed random number generator
    math.randomseed(randomSeed or os.time())

    -- Reset state
    rickroll.state.reset()
    rickroll.state.mapStartTime = levelTime

    -- Initialize trigger system
    rickroll.trigger.init(levelTime)

    et.G_Print(string.format("^5[Rick Roll Mode] ^7v%s initialized\n", rickroll.version))

    if rickroll.config.enabled then
        et.G_Print("^5[Rick Roll Mode] ^2ENABLED ^7- Next roll in " ..
            string.format("%.1f", rickroll.config.interval.min / 1000) .. "-" ..
            string.format("%.1f", rickroll.config.interval.max / 1000) .. " seconds\n")
    else
        et.G_Print("^5[Rick Roll Mode] ^1DISABLED\n")
    end
end

--[[
    Frame Update
]]--
function rickroll.runFrame(levelTime)
    -- Store current level time for use by console commands
    rickroll.state.currentLevelTime = levelTime

    -- Check for manual trigger via CVAR (workaround for rcon not calling et_ConsoleCommand)
    local manualTrigger = tonumber(et.trap_Cvar_Get("rickroll_force")) or 0
    if manualTrigger == 1 then
        et.trap_Cvar_Set("rickroll_force", "0")
        et.G_Print("[RickRoll] ^5CVAR trigger detected! Calling trigger.force...\n")
        rickroll.trigger.force(levelTime)
    end

    -- Check for test effect via CVAR (workaround for rcon)
    -- Format: "effect_id target power" e.g. "butter_fingers all 3" or "god_mode 0 5"
    -- Help: "help" or "help 0" (where 0 is your client number)
    local testCmd = et.trap_Cvar_Get("rickroll_test_cmd") or ""
    if testCmd ~= "" then
        et.trap_Cvar_Set("rickroll_test_cmd", "")
        -- Check for help command
        local helpMatch = testCmd:match("^help%s*(%d*)$") or testCmd:match("^%?%s*(%d*)$")
        if testCmd == "help" or testCmd == "?" then
            rickroll.showTestHelp(0)  -- Default to player 0
        elseif helpMatch then
            local clientNum = tonumber(helpMatch) or 0
            rickroll.showTestHelp(clientNum)
        else
            rickroll.testEffectFromCvar(testCmd)
        end
    end

    -- Check for clear command via CVAR
    local clearCmd = tonumber(et.trap_Cvar_Get("rickroll_clear_cmd")) or 0
    if clearCmd == 1 then
        et.trap_Cvar_Set("rickroll_clear_cmd", "0")
        local count = 0
        for clientNum, _ in pairs(rickroll.state.activeEffects) do
            rickroll.effectSystem.remove(clientNum)
            count = count + 1
        end
        for effectId, _ in pairs(rickroll.state.globalEffects) do
            rickroll.effectSystem.removeGlobal(effectId)
            count = count + 1
        end
        et.G_Print(string.format("^5[RickRoll] ^7Cleared %d active effects\n", count))
    end

    -- Check for auto-trigger toggle via CVAR
    local autoCmd = et.trap_Cvar_Get("rickroll_auto_cmd") or ""
    if autoCmd ~= "" then
        et.trap_Cvar_Set("rickroll_auto_cmd", "")
        if autoCmd == "on" or autoCmd == "1" then
            rickroll.config.autoTrigger = true
            et.G_Print("^5[RickRoll] ^7Auto-trigger: ^2ON\n")
        elseif autoCmd == "off" or autoCmd == "0" then
            rickroll.config.autoTrigger = false
            et.G_Print("^5[RickRoll] ^7Auto-trigger: ^1OFF ^7(manual mode)\n")
        elseif autoCmd == "toggle" then
            rickroll.config.autoTrigger = not rickroll.config.autoTrigger
            local status = rickroll.config.autoTrigger and "^2ON" or "^1OFF"
            et.G_Print("^5[RickRoll] ^7Auto-trigger: " .. status .. "\n")
        end
    end

    -- Check trigger
    rickroll.trigger.check(levelTime)

    -- Update rolling animation
    rickroll.ui.updateRoll(levelTime)

    -- Update active effects
    rickroll.effectSystem.update(levelTime)
end

--[[
    Shutdown
]]--
function rickroll.shutdown()
    -- Clean up any active effects
    for clientNum, _ in pairs(rickroll.state.activeEffects) do
        rickroll.effectSystem.remove(clientNum)
    end

    -- Restore global effects
    for effectId, _ in pairs(rickroll.state.globalEffects) do
        rickroll.effectSystem.removeGlobal(effectId)
    end

    et.G_Print("^5[Rick Roll Mode] ^7Shutdown complete\n")
end

--[[
    Player Spawn/Respawn Handler
    Re-applies active effects when player respawns after death
    Also freezes players who spawn during rickroll animation
]]--
function rickroll.onPlayerSpawn(clientNum, revived)
    -- Check if rickroll animation is active - freeze the spawning player
    if rickroll.state.isRolling and rickroll.config.freezePlayers then
        local levelTime = rickroll.state.currentLevelTime
        if levelTime > 0 then
            -- Calculate remaining freeze time (animation ends at rollStartTime + animationDuration)
            local animEndTime = rickroll.state.rollStartTime + rickroll.config.animationDuration
            local remainingFreeze = animEndTime - levelTime + 2000  -- Add 2 second buffer
            if remainingFreeze > 0 then
                local freezeUntil = levelTime + remainingFreeze
                et.gentity_set(clientNum, "rickrollFreezeUntil", freezeUntil)
                -- NOTE: No god mode - freeze is enough protection, and god mode can get stuck
                et.G_Print(string.format("[RickRoll] Froze spawning player %d until %d\n", clientNum, freezeUntil))
            end
        end
    end

    local data = rickroll.state.activeEffects[clientNum]
    if not data then
        return  -- No active effect for this player
    end

    local now = et.trap_Milliseconds()
    if now >= data.endTime then
        -- Effect has expired, clean it up
        rickroll.effectSystem.remove(clientNum)
        return
    end

    -- Re-apply the effect on respawn
    -- IMPORTANT: Some effects (like team_switch) should NOT call apply() again on respawn
    -- because it would cause an infinite loop (team swap -> respawn -> re-apply -> team swap...)
    local effectsSkipReapply = {
        team_switch = true,  -- Would cause infinite respawn loop
    }

    local handler = rickroll.effectSystem.handlers[data.effectId]
    if handler and handler.apply and not effectsSkipReapply[data.effectId] then
        et.G_Print(string.format("[RickRoll] Re-applying '%s' to client %d after respawn\n",
            data.effectId, clientNum))

        -- Call apply again to restore effect state
        local success, newOriginal = handler.apply(clientNum, data.powerLevel, data.powerValue, data.endTime)
        if success then
            -- Keep the original endTime, just update originalValues if needed
            if newOriginal then
                data.originalValues = newOriginal
            end

            et.trap_SendServerCommand(clientNum, string.format(
                'cpm "^5[RICK ROLL] ^7%s still active for %d seconds!"',
                data.effectName,
                math.ceil((data.endTime - now) / 1000)
            ))
        end
    elseif effectsSkipReapply[data.effectId] then
        -- Effect continues but don't re-call apply (just notify player)
        et.trap_SendServerCommand(clientNum, string.format(
            'cpm "^5[RICK ROLL] ^7%s still active for %d seconds!"',
            data.effectName,
            math.ceil((data.endTime - now) / 1000)
        ))
    end
end

--[[
    Console Command Handler
]]--
function rickroll.consoleCommand(command)
    local cmd = command:lower()

    if cmd == "rickroll_trigger" then
        -- Force trigger for testing
        -- Use stored levelTime from runFrame, NOT trap_Milliseconds()!
        -- trap_Milliseconds is system uptime, level.time is game time since map start
        local levelTime = rickroll.state.currentLevelTime
        if levelTime == 0 then
            et.G_Print("^1[RickRoll] Error: No levelTime available yet. Wait for game to start.\n")
            return true
        end
        rickroll.trigger.force(levelTime)
        return true

    elseif cmd == "rickroll_enable" then
        rickroll.config.enabled = true
        et.G_Print("^5[Rick Roll Mode] ^2ENABLED\n")
        return true

    elseif cmd == "rickroll_disable" then
        rickroll.config.enabled = false
        et.G_Print("^5[Rick Roll Mode] ^1DISABLED\n")
        return true

    elseif cmd == "rickroll_status" then
        local status = rickroll.config.enabled and "^2ENABLED" or "^1DISABLED"
        et.G_Print("^5[Rick Roll Mode] ^7Status: " .. status .. "\n")
        et.G_Print(string.format("  Next trigger: %.1f seconds\n",
            (rickroll.state.nextTriggerTime - et.trap_Milliseconds()) / 1000))
        et.G_Print(string.format("  Active effects: %d\n",
            rickroll.tableCount(rickroll.state.activeEffects)))
        et.G_Print(string.format("  Global effects: %d\n",
            rickroll.tableCount(rickroll.state.globalEffects)))
        return true

    elseif cmd == "rickroll_debug" then
        rickroll.config.debug = not rickroll.config.debug
        local status = rickroll.config.debug and "^2ON" or "^1OFF"
        et.G_Print("^5[Rick Roll Mode] ^7Debug: " .. status .. "\n")
        return true

    elseif cmd == "rickroll_auto" then
        rickroll.config.autoTrigger = not rickroll.config.autoTrigger
        local status = rickroll.config.autoTrigger and "^2ON" or "^1OFF"
        et.G_Print("^5[Rick Roll Mode] ^7Auto-trigger: " .. status .. "\n")
        if rickroll.config.autoTrigger then
            et.G_Print("^7  Rickroll will trigger automatically every " ..
                string.format("%.0f-%.0f", rickroll.config.interval.min/1000, rickroll.config.interval.max/1000) ..
                " seconds\n")
        else
            et.G_Print("^7  Manual mode: use rickroll_test_cmd or rickroll_force to trigger\n")
        end
        return true

    elseif cmd == "rickroll_test" then
        -- Test specific effect: rickroll_test <effect_id> [player|all] [power_level]
        -- Example: rickroll_test butter_fingers all 3
        -- Example: rickroll_test god_mode 0 5
        -- power_level: 1=MILD, 2=MODERATE, 3=STRONG, 4=EXTREME, 5=LEGENDARY
        return rickroll.testEffect()

    elseif cmd == "rickroll_effects" then
        -- List all available effect IDs
        et.G_Print("^5[Rick Roll Mode] ^7Available effects:\n")
        et.G_Print("^2BLESSED: ^7god_mode, caffeine_rush, tank_mode, regeneration, adrenaline, medic_mode, damage_boost\n")
        et.G_Print("^1CURSED: ^7tiny_legs, glass_cannon, disoriented, marked, butter_fingers, pistols_only, bouncy, slippery, weak_hits\n")
        et.G_Print("^3CHAOTIC: ^7knife_fight, moon_mode, russian_roulette, team_switch, telefrag, weapon_roulette, fling, narcolepsy, panzer_freeze, projectile_speed, earthquake\n")
        et.G_Print("\n^5Usage: ^7rickroll_test <effect_id> [player_num|all] [power_level 1-5]\n")
        et.G_Print("^5Example: ^7rickroll_test butter_fingers all 3\n")
        et.G_Print("^5Example: ^7rickroll_test earthquake all 5\n")
        return true

    elseif cmd == "rickroll_clear" then
        -- Clear all active effects
        local count = 0
        for clientNum, _ in pairs(rickroll.state.activeEffects) do
            rickroll.effectSystem.remove(clientNum)
            count = count + 1
        end
        for effectId, _ in pairs(rickroll.state.globalEffects) do
            rickroll.effectSystem.removeGlobal(effectId)
            count = count + 1
        end
        et.G_Print(string.format("^5[Rick Roll Mode] ^7Cleared %d active effects\n", count))
        return true
    end

    return false
end

--[[
    Show help for test command
    Usage: "help" or "help 0" (where 0 is your client number)
]]--
function rickroll.showTestHelp(clientNum)
    clientNum = clientNum or 0  -- Default to player 0

    et.trap_SendServerCommand(clientNum, 'print "^5===== RICKROLL TEST HELP =====\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Test: ^7/rcon set rickroll_test_cmd \\"effect target power\\"\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Target: ^7player number (0-63) or \\"all\\"\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Power: ^71=MILD 2=MOD 3=STRONG 4=EXTREME 5=LEGEND\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Example: ^7rickroll_test_cmd \\"butter_fingers all 3\\"\n"')
    et.trap_SendServerCommand(clientNum, 'print "^5----- OTHER COMMANDS -----\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Clear: ^7/rcon set rickroll_clear_cmd 1\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Auto: ^7/rcon set rickroll_auto_cmd on|off|toggle\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3Full: ^7/rcon set rickroll_force 1\n"')
    et.trap_SendServerCommand(clientNum, 'print "^5----- EFFECTS -----\n"')
    et.trap_SendServerCommand(clientNum, 'print "^2BLESSED: ^7god_mode caffeine_rush tank_mode regeneration adrenaline medic_mode damage_boost\n"')
    et.trap_SendServerCommand(clientNum, 'print "^1CURSED: ^7tiny_legs glass_cannon disoriented marked butter_fingers pistols_only bouncy slippery weak_hits\n"')
    et.trap_SendServerCommand(clientNum, 'print "^3CHAOTIC: ^7knife_fight moon_mode russian_roulette team_switch telefrag weapon_roulette fling narcolepsy panzer_freeze projectile_speed earthquake\n"')
    et.trap_SendServerCommand(clientNum, 'print "^5==============================\n"')
end

--[[
    Test Effect from CVAR (for rcon usage)
    Usage: /rcon set rickroll_test_cmd "effect_id target power"
    Example: /rcon set rickroll_test_cmd "butter_fingers all 3"
]]--
function rickroll.testEffectFromCvar(cmdString)
    -- Parse the command string
    local parts = {}
    for word in cmdString:gmatch("%S+") do
        table.insert(parts, word)
    end

    if #parts < 1 then
        et.G_Print("^1[RickRoll] Invalid test command format\n")
        return
    end

    local effectId = parts[1]:lower()
    local targetArg = parts[2] or "0"
    local powerArg = tonumber(parts[3]) or 3

    -- Find the effect
    local effect, category = rickroll.getEffectById(effectId)
    if not effect then
        et.G_Print(string.format("^1[RickRoll] Unknown effect: %s\n", effectId))
        return
    end

    -- Get power level (1-5 maps to powerLevels array)
    if powerArg < 1 then powerArg = 1 end
    if powerArg > 5 then powerArg = 5 end
    local powerLevel = rickroll.config.powerLevels[powerArg]

    -- Determine target
    local isAllPlayers = (targetArg:lower() == "all")
    local clientNum = 0
    if not isAllPlayers then
        clientNum = tonumber(targetArg) or 0
        if et.gentity_get(clientNum, "inuse") ~= 1 then
            et.G_Print(string.format("^1[RickRoll] Player %d not found\n", clientNum))
            return
        end
    end

    -- Apply the effect
    local duration = rickroll.config.effectDuration
    local success = rickroll.effectSystem.apply(clientNum, effect, category, powerLevel, duration, isAllPlayers)

    if success then
        local targetStr = isAllPlayers and "ALL PLAYERS" or string.format("player %d", clientNum)
        et.G_Print(string.format("^5[RickRoll] ^7Applied ^3%s ^7to %s with power ^3%s\n",
            effect.name, targetStr, powerLevel.label))
    else
        et.G_Print("^1[RickRoll] Failed to apply effect\n")
    end
end

--[[
    Test Effect Command Handler
    Usage: rickroll_test <effect_id> [player_num|all] [power_level]
]]--
function rickroll.testEffect()
    local argc = et.trap_Argc()

    if argc < 2 then
        et.G_Print("^1[RickRoll] Usage: rickroll_test <effect_id> [player_num|all] [power_level 1-5]\n")
        et.G_Print("^7Use 'rickroll_effects' to see available effect IDs\n")
        return true
    end

    -- Get effect ID
    local effectId = et.ConcatArgs(1)
    -- Parse arguments manually since ConcatArgs gives us everything
    local args = {}
    for i = 1, argc - 1 do
        table.insert(args, et.trap_Argv(i))
    end

    effectId = args[1]:lower()
    local targetArg = args[2] or "0"  -- Default to player 0
    local powerArg = tonumber(args[3]) or 3  -- Default to STRONG (3)

    -- Find the effect
    local effect, category = rickroll.getEffectById(effectId)
    if not effect then
        et.G_Print(string.format("^1[RickRoll] Unknown effect: %s\n", effectId))
        et.G_Print("^7Use 'rickroll_effects' to see available effect IDs\n")
        return true
    end

    -- Get power level (1-5 maps to powerLevels array)
    if powerArg < 1 then powerArg = 1 end
    if powerArg > 5 then powerArg = 5 end
    local powerLevel = rickroll.config.powerLevels[powerArg]

    -- Determine target
    local isAllPlayers = (targetArg:lower() == "all")
    local clientNum = 0
    if not isAllPlayers then
        clientNum = tonumber(targetArg) or 0
        -- Verify player exists
        if et.gentity_get(clientNum, "inuse") ~= 1 then
            et.G_Print(string.format("^1[RickRoll] Player %d not found or not in game\n", clientNum))
            return true
        end
    end

    -- Apply the effect
    local duration = rickroll.config.effectDuration  -- Default 60 seconds
    local success = rickroll.effectSystem.apply(clientNum, effect, category, powerLevel, duration, isAllPlayers)

    if success then
        local targetStr = isAllPlayers and "ALL PLAYERS" or string.format("player %d", clientNum)
        et.G_Print(string.format("^5[RickRoll] ^7Applied ^3%s ^7(%s) to %s with power ^3%s\n",
            effect.name, effectId, targetStr, powerLevel.label))
    else
        et.G_Print("^1[RickRoll] Failed to apply effect\n")
    end

    return true
end

--[[
    Utility Functions
]]--
function rickroll.tableCount(tbl)
    local count = 0
    for _ in pairs(tbl) do
        count = count + 1
    end
    return count
end

--[[
    Export for main.lua integration
]]--
return rickroll
