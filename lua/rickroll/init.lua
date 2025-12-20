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
    Console Command Handler
]]--
function rickroll.consoleCommand(command)
    local cmd = command:lower()

    if cmd == "rickroll_trigger" then
        -- Force trigger for testing
        local levelTime = et.trap_Milliseconds()
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
    end

    return false
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
