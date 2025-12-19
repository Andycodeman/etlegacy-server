--[[
    ET:Legacy Server - Main Lua Script
    ETMan's Modded Server

    This is the entry point for all custom server functionality.
    All modules are loaded from here.
]]--

-- Module registration
et.RegisterModname("ETMan Server v1.0.0")

-- Configuration
local config = {
    -- Web API (for future web control panel)
    api_enabled = false,
    api_url = "https://et.coolip.me/api",
    api_key = "",
    api_poll_interval = 30000,  -- 30 seconds

    -- Feature toggles
    crazy_mode = true,
    panzerfest_enabled = false,  -- TODO: implement
    survival_bonus_enabled = false,  -- TODO: implement
    killstreak_enabled = false,  -- TODO: implement

    -- Debug
    debug = true
}

-- Utility functions
local function log(msg)
    et.G_Print("[ETMan] " .. msg .. "\n")
end

local function debug(msg)
    if config.debug then
        et.G_Print("[ETMan Debug] " .. msg .. "\n")
    end
end

--[[
    INITIALIZATION
]]--

function et_InitGame(levelTime, randomSeed, restart)
    log("^2Server initializing...")
    log("^3ET:Legacy with Lua scripting")

    -- Load crazy mode if enabled
    if config.crazy_mode then
        et.trap_SendConsoleCommand(et.EXEC_APPEND, "exec crazymode.cfg\n")
        log("^3Crazy mode enabled")
    end

    -- Future: Start web API polling
    if config.api_enabled then
        log("^3Web API enabled - polling " .. config.api_url)
    end

    log("^2Initialization complete!")
end

--[[
    PLAYER EVENTS
]]--

function et_ClientConnect(clientNum, firstTime, isBot)
    local name = et.gentity_get(clientNum, "pers.netname")

    if firstTime and not isBot then
        log("^7Player connected: ^3" .. name)

        -- Welcome message
        et.trap_SendServerCommand(clientNum,
            'cp "^3Welcome to ETMan\'s Server!\n^7Crazy mode is ^2ON"')
    end

    return nil  -- Allow connection
end

function et_ClientDisconnect(clientNum)
    local name = et.gentity_get(clientNum, "pers.netname")
    debug("Player disconnected: " .. name)
end

function et_ClientBegin(clientNum)
    -- Player fully spawned into game
end

function et_ClientSpawn(clientNum, revived, teamChange, restoreHealth)
    -- Player spawned (after death or team change)
end

--[[
    GAME EVENTS
]]--

function et_Obituary(victim, killer, meansOfDeath)
    -- Player killed
    -- meansOfDeath is the weapon/method ID

    if killer >= 0 and killer ~= victim and killer ~= 1022 then
        -- Valid kill (not suicide, not world)
        local killerName = et.gentity_get(killer, "pers.netname")
        local victimName = et.gentity_get(victim, "pers.netname")

        debug(killerName .. " killed " .. victimName .. " (MOD: " .. meansOfDeath .. ")")

        -- Future: Track kills for panzerfest/killstreak
        -- Future: POST to web API for stats
    end
end

function et_Print(text, level)
    -- Server console output
    -- Can intercept and log to web
end

--[[
    FRAME PROCESSING
]]--

local lastApiPoll = 0

function et_RunFrame(levelTime)
    -- Called every server frame (~50ms)

    -- Future: Poll web API for commands
    if config.api_enabled then
        if levelTime - lastApiPoll > config.api_poll_interval then
            lastApiPoll = levelTime
            -- pollWebApi()
        end
    end

    -- Future: Update panzerfest timers
    -- Future: Update survival bonus timers
end

--[[
    COMMANDS
]]--

function et_ClientCommand(clientNum, command)
    -- Intercept player commands
    local cmd = et.trap_Argv(0)

    if cmd == "crazymode" then
        -- Show crazy mode status
        local status = config.crazy_mode and "^2ON" or "^1OFF"
        et.trap_SendServerCommand(clientNum,
            'chat "^3Crazy Mode: ' .. status .. '"')
        return 1  -- Command handled
    end

    return 0  -- Let engine handle
end

function et_ConsoleCommand()
    -- Intercept server console commands
    local cmd = et.trap_Argv(0)

    if cmd == "lua_reload" then
        log("^3Reloading Lua scripts on next map...")
        return 1
    end

    return 0
end

--[[
    WEB API FUNCTIONS (Future)
]]--

--[[
local function pollWebApi()
    if not config.api_enabled then return end

    et.HTTPGet(config.api_url .. "/commands?key=" .. config.api_key,
        function(response)
            -- Parse JSON response and execute commands
            -- local cmds = json.decode(response)
            -- for _, cmd in ipairs(cmds) do
            --     executeCommand(cmd)
            -- end
        end
    )
end

local function reportStats(data)
    if not config.api_enabled then return end

    et.HTTPPost(config.api_url .. "/stats?key=" .. config.api_key,
        json.encode(data),
        "application/json",
        function(response)
            debug("Stats reported: " .. response)
        end
    )
end
]]--

log("^2Main Lua module loaded!")
