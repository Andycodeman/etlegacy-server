--[[
    ET:Legacy Server - Main Lua Script
    ETMan's Modded Server

    This is the entry point for all custom server functionality.
    Modules are loaded and callbacks are routed from here.

    IMPORTANT NOTES:
    - In Lua, 0 is TRUTHY! Only nil and false are falsy.
    - ET:Legacy writes files to fs_homepath (~/.etlegacy/), not the server basepath.
    - Player names may be empty at et_ClientConnect; use et_ClientBegin for reliable names.
]]--

-- Module registration
et.RegisterModname("ETMan Server v1.2.0")

--[[
    MODULE LOADING
]]--

-- ETPanel stats are now handled natively in C (g_etpanel.c)
-- No Lua module needed - events go directly to the API via fork+curl

--[[
    CONFIGURATION
]]--

local config = {
    -- Feature toggles
    crazy_mode = true,
    panzerfest_enabled = false,  -- TODO: implement
    survival_bonus_enabled = false,  -- TODO: implement
    killstreak_enabled = false,  -- TODO: implement

    -- Debug (set to false for production)
    debug = false
}

--[[
    UTILITY FUNCTIONS
]]--

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

    log("^2Initialization complete!")
end

function et_ShutdownGame(restart)
    log("^1Server shutting down...")
end

--[[
    PLAYER EVENTS
]]--

function et_ClientConnect(clientNum, firstTime, isBot)
    -- IMPORTANT: In Lua, 0 is truthy! Must compare explicitly.
    -- isBot is 0 for humans, 1 for bots

    -- Welcome message for new human players
    -- Note: firstTime in Lua can be 0 or 1, not boolean
    if firstTime == 1 and isBot == 0 then
        local name = et.gentity_get(clientNum, "pers.netname") or "Player"
        log("^7Player connected: ^3" .. name)

        -- Welcome message
        et.trap_SendServerCommand(clientNum,
            'cp "^3Welcome to ETMan\'s Server!\n^7Crazy mode is ^2ON"')
    end

    return nil  -- Allow connection
end

function et_ClientBegin(clientNum)
    -- Player fully spawned into game - name is now reliably set
end

function et_ClientDisconnect(clientNum)
    local name = et.gentity_get(clientNum, "pers.netname") or "Unknown"
    debug("Player disconnected: " .. name)
end

function et_ClientSpawn(clientNum, revived, teamChange, restoreHealth)
    -- Player spawned (after death or team change)
end

--[[
    GAME EVENTS
]]--

function et_Obituary(victim, killer, meansOfDeath)
    -- Stats are now tracked in C (g_etpanel.c)

    -- Additional logging for debugging
    if config.debug and killer >= 0 and killer ~= victim and killer ~= 1022 then
        local killerName = et.gentity_get(killer, "pers.netname") or "Unknown"
        local victimName = et.gentity_get(victim, "pers.netname") or "Unknown"
        debug(killerName .. " killed " .. victimName .. " (MOD: " .. meansOfDeath .. ")")
    end
end

function et_Print(text, level)
    -- Server console output
    -- Could intercept and log to ETPanel if needed
end

--[[
    INTERMISSION / ROUND END
]]--

function et_IntermissionReady()
    -- Called when intermission starts
    debug("Intermission ready")
end

function et_RunFrame(levelTime)
    -- Called every server frame (~50ms)
    -- Keep this lightweight!
end

--[[
    CHAT HANDLING
]]--

-- Helper to send message to ETPanel via HTTP POST
local function sendToPanel(eventType, data)
    local apiUrl = et.trap_Cvar_Get("etpanel_api_url")
    local apiKey = et.trap_Cvar_Get("etpanel_api_key")

    if apiUrl == "" or apiKey == "" then
        return false
    end

    -- Build JSON payload
    local json = string.format(
        '{"type":"%s","data":%s}',
        eventType,
        data
    )

    -- Use curl via console command (non-blocking)
    -- This writes to a file that the panel can read
    local logFile = "etpanel_messages.log"
    local timestamp = os.time()
    local logLine = string.format('[%d] %s: %s\n', timestamp, eventType, data)

    -- Append to log file (panel will tail this)
    local f = io.open("/home/andy/.etlegacy/legacy/" .. logFile, "a")
    if f then
        f:write(logLine)
        f:close()
    end

    return true
end

-- Handle say commands (all chat)
function et_ClientCommand(clientNum, command)
    local cmd = et.trap_Argv(0):lower()
    local name = et.gentity_get(clientNum, "pers.netname") or "Unknown"

    -- Custom commands
    if cmd == "crazymode" then
        local status = config.crazy_mode and "^2ON" or "^1OFF"
        et.trap_SendServerCommand(clientNum,
            'chat "^3Crazy Mode: ' .. status .. '"')
        return 1  -- Command handled
    end

    if cmd == "etpanel" then
        local enabled = et.trap_Cvar_Get("etpanel_enabled") == "1"
        local status = enabled and "^2ENABLED" or "^1DISABLED"
        et.trap_SendServerCommand(clientNum,
            'chat "^3ETPanel Integration: ' .. status .. '"')
        return 1
    end

    -- Handle /pm command for direct messaging to panel
    -- Usage: /pm <message> - sends a DM to panel admins
    if cmd == "pm" or cmd == "panel" then
        local argc = et.trap_Argc()
        if argc < 2 then
            et.trap_SendServerCommand(clientNum,
                'chat "^3Usage: /pm <message> - Send message to panel admins"')
            return 1
        end

        -- Get the full message (all args after command)
        local msg = ""
        for i = 1, argc - 1 do
            if i > 1 then msg = msg .. " " end
            msg = msg .. et.trap_Argv(i)
        end

        -- Log to panel message file
        local data = string.format(
            '{"slot":%d,"name":"%s","message":"%s"}',
            clientNum,
            name:gsub('"', '\\"'),
            msg:gsub('"', '\\"')
        )
        sendToPanel("player_dm", data)

        -- Confirm to player
        et.trap_SendServerCommand(clientNum,
            'chat "^3Message sent to panel admins."')
        log("^3[Panel DM] ^7" .. name .. ": " .. msg)

        return 1
    end

    -- Handle /r command to reply to last panel DM
    if cmd == "r" or cmd == "reply" then
        local argc = et.trap_Argc()
        if argc < 2 then
            et.trap_SendServerCommand(clientNum,
                'chat "^3Usage: /r <message> - Reply to panel"')
            return 1
        end

        local msg = ""
        for i = 1, argc - 1 do
            if i > 1 then msg = msg .. " " end
            msg = msg .. et.trap_Argv(i)
        end

        local data = string.format(
            '{"slot":%d,"name":"%s","message":"%s","isReply":true}',
            clientNum,
            name:gsub('"', '\\"'),
            msg:gsub('"', '\\"')
        )
        sendToPanel("player_dm", data)

        et.trap_SendServerCommand(clientNum,
            'chat "^3Reply sent to panel."')
        log("^3[Panel Reply] ^7" .. name .. ": " .. msg)

        return 1
    end

    return 0  -- Let engine handle
end

--[[
    CONSOLE COMMANDS
]]--

function et_ConsoleCommand()
    local cmd = et.trap_Argv(0):lower()

    if cmd == "lua_reload" then
        log("^3Reloading Lua scripts on next map...")
        return 1
    end

    return 0
end

--[[
    WIN CONDITIONS / ROUND END
]]--

-- Called when a team wins the round (objective mode)
function et_WinSide(side)
    -- side: 0 = draw, 1 = axis, 2 = allies
    -- Stats tracked in C (g_etpanel.c)
    debug("Round ended, winner: " .. side)
end

log("^2Main Lua module loaded!")
