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
et.RegisterModname("ETMan Server v1.3.0")

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

    -- Notifications
    ntfy_enabled = true,
    ntfy_topic = "etman-server-player-connected",
    ntfy_url = "https://ntfy.sh",

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

-- Strip ET color codes from player names (^0 through ^9, ^a-^z)
local function stripColors(str)
    if not str then return "" end
    return str:gsub("%^[0-9a-zA-Z]", "")
end

-- Get count of human players currently on server
local function getHumanPlayerCount()
    local count = 0
    for i = 0, tonumber(et.trap_Cvar_Get("sv_maxclients")) - 1 do
        if et.gentity_get(i, "inuse") == 1 then
            local pers_connected = et.gentity_get(i, "pers.connected")
            if pers_connected == 2 then  -- CON_CONNECTED
                local name = et.gentity_get(i, "pers.netname") or ""
                if not name:find("%[BOT%]") then
                    count = count + 1
                end
            end
        end
    end
    return count
end

-- Get list of other human players (excluding the one who just joined)
local function getOtherHumanPlayers(excludeClientNum)
    local players = {}
    for i = 0, tonumber(et.trap_Cvar_Get("sv_maxclients")) - 1 do
        if i ~= excludeClientNum and et.gentity_get(i, "inuse") == 1 then
            local pers_connected = et.gentity_get(i, "pers.connected")
            if pers_connected == 2 then  -- CON_CONNECTED
                local name = et.gentity_get(i, "pers.netname") or ""
                if not name:find("%[BOT%]") then
                    table.insert(players, stripColors(name))
                end
            end
        end
    end
    return players
end

-- Send notification via ntfy (non-blocking using shell background)
local function sendNtfyNotification(title, message, priority)
    if not config.ntfy_enabled then return end

    priority = priority or "default"

    -- Escape quotes in message for shell
    local safeTitle = title:gsub('"', '\\"'):gsub("'", "'\\''")
    local safeMessage = message:gsub('"', '\\"'):gsub("'", "'\\''")

    -- Build curl command - run in background with &
    local cmd = string.format(
        "curl -s -o /dev/null -H 'Title: %s' -H 'Priority: %s' -H 'Tags: video_game' -d '%s' '%s/%s' &",
        safeTitle, priority, safeMessage, config.ntfy_url, config.ntfy_topic
    )

    -- Execute via shell (os.execute runs synchronously but the & backgrounds it)
    os.execute(cmd)

    debug("NTFY: " .. title .. " - " .. message)
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
    local name = et.gentity_get(clientNum, "pers.netname") or ""

    -- Skip bots
    if name:find("%[BOT%]") then
        return
    end

    -- Skip empty names
    if name == "" then
        return
    end

    local cleanName = stripColors(name)
    local mapname = et.trap_Cvar_Get("mapname") or "unknown"

    -- Get other players for context
    local otherPlayers = getOtherHumanPlayers(clientNum)
    local message

    if #otherPlayers > 0 then
        message = mapname .. " | Also online: " .. table.concat(otherPlayers, ", ")
    else
        message = mapname .. " | First player on the server!"
    end

    -- Send notification
    sendNtfyNotification("Player Joined: " .. cleanName, message, "default")
    log("^2Player joined: ^7" .. cleanName .. " - " .. message)
end

function et_ClientDisconnect(clientNum)
    local name = et.gentity_get(clientNum, "pers.netname") or "Unknown"

    -- Skip bots
    if name:find("%[BOT%]") then
        return
    end

    local cleanName = stripColors(name)

    -- Get remaining players
    local remainingPlayers = getHumanPlayerCount() - 1  -- -1 because this player is still counted

    local message
    if remainingPlayers > 0 then
        message = remainingPlayers .. " player(s) remaining"
    else
        message = "Server is now empty"
    end

    -- Send notification (low priority for disconnects)
    sendNtfyNotification("Player Left: " .. cleanName, message, "low")
    debug("Player disconnected: " .. cleanName .. " - " .. message)
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

-- Track level time for ETPanel (updated every second, not every frame)
local lastLevelTimeUpdate = 0

function et_RunFrame(levelTime)
    -- Called every server frame (~50ms)
    -- Keep this lightweight!

    -- Update etpanel_leveltime CVAR once per second for panel to read
    if levelTime - lastLevelTimeUpdate >= 1000 then
        et.trap_Cvar_Set("etpanel_leveltime", tostring(levelTime))
        lastLevelTimeUpdate = levelTime
    end
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
