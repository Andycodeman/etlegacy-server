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
et.RegisterModname("ETMan Server v1.5.0 - Rocket Mode Edition")

--[[
    RICK ROLL MODE - The ultimate lottery system
    Randomly triggers "Never Gonna Give You Up" with spinning wheels!
    Controlled by g_rickrollEnabled cvar (0 = disabled, 1 = enabled)
]]--
local rickrollEnabled = false  -- Will be set from cvar in et_InitGame
local rickroll = nil

--[[
    ROCKET MODE - Cycling between Normal, Freeze, and Homing rockets
    All players can cycle by pressing panzer key while holding panzer
]]--
local rocketModeEnabled = true
local rocketMode = nil

-- Load Rocket Mode (wrapped in pcall for safety)
if rocketModeEnabled then
    local success, err = pcall(function()
        rocketMode = dofile("legacy/lua/rocket_mode.lua")
    end)
    if not success then
        et.G_Print("^1[ERROR] ^7Failed to load Rocket Mode: " .. tostring(err) .. "\n")
        rocketModeEnabled = false
    end
end

--[[
    PANZERFEST & SURVIVAL MODE
    Kill streak = faster fire rate
    Survival = faster movement
    Panzerfest = everyone vs you at 30 kills!
    Uses CVARs: g_killstreakEnabled, g_survivalEnabled, g_panzerfestEnabled
]]--
local panzerfestEnabled = true
local panzerfest = nil

-- Load Panzerfest/Survival Mode (wrapped in pcall for safety)
if panzerfestEnabled then
    local success, err = pcall(function()
        panzerfest = dofile("legacy/lua/panzerfest_survival.lua")
    end)
    if not success then
        et.G_Print("^1[ERROR] ^7Failed to load Panzerfest/Survival: " .. tostring(err) .. "\n")
        panzerfestEnabled = false
    end
end

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
    crazy_mode = true,  -- Must exec crazymode.cfg on each map load (CVARs reset between maps)

    -- Notifications
    ntfy_enabled = true,
    ntfy_topic = "etman-server-player-connected",
    ntfy_url = "https://ntfy.sh",

    -- Debug (set to false for production)
    debug = false
}

--[[
    SESSION TRACKING
    Track players who have already been notified this session.
    Uses GUID (cl_guid) to persist across map changes.
    State is saved to a file so it survives map changes.
    File includes the server PID to detect new server sessions.
]]--
local notifiedPlayers = {}  -- { [guid] = true, ... }
local NOTIFIED_PLAYERS_FILE = "/home/andy/.etlegacy/legacy/notified_players.txt"

-- Get current server process ID
local function getServerPid()
    local handle = io.popen("echo $PPID")
    if handle then
        local pid = handle:read("*a"):match("^%s*(%d+)")
        handle:close()
        return pid
    end
    return nil
end

local currentPid = getServerPid()

-- Load notified players from file (called on map load)
-- Returns true if loaded successfully, false if PID mismatch (new server session)
local function loadNotifiedPlayers()
    notifiedPlayers = {}

    local file = io.open(NOTIFIED_PLAYERS_FILE, "r")
    if not file then
        return false
    end

    local firstLine = file:read("*line")
    if not firstLine then
        file:close()
        return false
    end

    -- First line is PID
    local filePid = firstLine:match("^%s*(%d+)")
    if not filePid then
        file:close()
        return false
    end

    -- Check if PID matches current server
    if filePid ~= currentPid then
        file:close()
        return false  -- Different server process, start fresh
    end

    -- Load the rest of the lines as GUIDs
    for line in file:lines() do
        local guid = line:match("^%s*(.-)%s*$")  -- trim whitespace
        if guid and guid ~= "" then
            notifiedPlayers[guid] = true
        end
    end

    file:close()
    return true
end

-- Save notified players to file (called when player joins/leaves)
local function saveNotifiedPlayers()
    local file = io.open(NOTIFIED_PLAYERS_FILE, "w")
    if file then
        -- Write PID first
        file:write(tostring(currentPid) .. "\n")
        -- Then GUIDs
        for guid, _ in pairs(notifiedPlayers) do
            file:write(guid .. "\n")
        end
        file:close()
    end
end

-- Clear notified players (reset in memory)
local function clearNotifiedPlayers()
    notifiedPlayers = {}
end

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

-- Get player's GUID from userinfo
local function getPlayerGuid(clientNum)
    local userinfo = et.trap_GetUserinfo(clientNum)
    if userinfo then
        local guid = et.Info_ValueForKey(userinfo, "cl_guid")
        if guid and guid ~= "" then
            return guid
        end
    end
    -- Fallback: use IP address if no GUID
    local ip = et.Info_ValueForKey(et.trap_GetUserinfo(clientNum), "ip") or ""
    return "ip_" .. ip
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

    -- Handle notification tracking persistence
    -- Uses server PID to detect new sessions (server restart)
    local loaded = loadNotifiedPlayers()
    local count = 0
    for _ in pairs(notifiedPlayers) do count = count + 1 end

    if loaded and count > 0 then
        log("^3Continuing session (PID " .. tostring(currentPid) .. ") - loaded " .. count .. " notified player(s)")
    else
        log("^3New session (PID " .. tostring(currentPid) .. ") - starting fresh notification tracking")
    end

    -- Load crazy mode if enabled
    -- Order: crazymode.cfg first (defaults), then map config (overrides)
    if config.crazy_mode then
        et.trap_SendConsoleCommand(et.EXEC_APPEND, "exec crazymode.cfg\n")
        log("^3Crazy mode enabled")
    end

    -- Now exec the map-specific config to override defaults
    -- g_mapConfigs handles this automatically, but it runs BEFORE Lua
    -- So we need to re-exec it here AFTER crazymode.cfg
    local mapname = et.trap_Cvar_Get("mapname")
    if mapname and mapname ~= "" then
        et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("exec mapconfigs/%s.cfg\n", mapname))
        log("^3Map config: mapconfigs/" .. mapname .. ".cfg")
    end

    -- Initialize Rick Roll Mode (check cvar)
    local rickrollCvar = et.trap_Cvar_Get("g_rickrollEnabled")
    rickrollEnabled = (rickrollCvar == "1")

    if rickrollEnabled then
        -- Load rickroll module if enabled
        local success, err = pcall(function()
            rickroll = dofile("legacy/lua/rickroll/init.lua")
        end)
        if success and rickroll then
            rickroll.init(levelTime, randomSeed)
            log("^2Rick Roll Mode ^3ENABLED")
        else
            et.G_Print("^1[ERROR] ^7Failed to load Rick Roll Mode: " .. tostring(err) .. "\n")
            rickrollEnabled = false
        end
    else
        log("^7Rick Roll Mode ^1DISABLED ^7(set g_rickrollEnabled 1 to enable)")
    end

    -- Initialize Rocket Mode
    if rocketModeEnabled and rocketMode then
        rocketMode.init()
    end

    -- Initialize Panzerfest/Survival Mode
    if panzerfestEnabled and panzerfest then
        panzerfest.onInit(levelTime)
    end

    log("^2Initialization complete!")
end

function et_ShutdownGame(restart)
    log("^1Server shutting down...")

    -- Don't clear notification tracking here - the timestamp mechanism handles stale sessions
    -- restart parameter is unreliable for detecting true server shutdown vs map change

    -- Shutdown Rick Roll Mode
    if rickrollEnabled and rickroll then
        rickroll.shutdown()
    end

    -- Shutdown Rocket Mode
    if rocketModeEnabled and rocketMode then
        rocketMode.shutdown()
    end

    -- Shutdown Panzerfest/Survival Mode
    if panzerfestEnabled and panzerfest then
        panzerfest.onShutdown()
    end
end

--[[
    PLAYER EVENTS
]]--

function et_ClientConnect(clientNum, firstTime, isBot)
    -- IMPORTANT: In Lua, 0 is truthy! Must compare explicitly.
    -- isBot is 0 for humans, 1 for bots

    -- Initialize rocket mode for this player (humans only)
    if isBot == 0 and rocketModeEnabled and rocketMode then
        rocketMode.initPlayer(clientNum)
    end

    -- Initialize panzerfest/survival for this player
    if panzerfestEnabled and panzerfest then
        panzerfest.onPlayerConnect(clientNum, isBot)
    end

    -- Welcome message for new human players
    -- Note: firstTime in Lua can be 0 or 1, not boolean
    if firstTime == 1 and isBot == 0 then
        local name = et.gentity_get(clientNum, "pers.netname") or "Player"
        log("^7Player connected: ^3" .. name)

        -- Welcome message
        et.trap_SendServerCommand(clientNum,
            'cp "^3Welcome to ETMan\'s Server!\n^5Experimental RickRoll mode enabled\n^7Check back often as changes are daily. Enjoy!"')

        -- Schedule rocket mode welcome message
        if rocketModeEnabled and rocketMode then
            rocketMode.showWelcomeMessage(clientNum)
        end
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

    -- Check if player is using vanilla ET (not ET:Legacy) and warn about voice chat
    local userinfo = et.trap_GetUserinfo(clientNum)
    local etVersion = et.Info_ValueForKey(userinfo, "cg_etVersion") or ""
    if etVersion:find("ET 2%.60") and not etVersion:find("Legacy") then
        -- Vanilla ET client detected - send them a private message
        et.trap_SendServerCommand(clientNum, "chat \"^3[SERVER] ^7Voice chat requires ^2ET:Legacy ^7- free at ^5etlegacy.com\"")
    end

    -- Check if we've already notified for this player this session
    -- Uses GUID to track across map changes
    local guid = getPlayerGuid(clientNum)
    if notifiedPlayers[guid] then
        -- Already notified for this player, skip (map change)
        debug("Skipping notification for " .. name .. " (already notified, GUID: " .. guid .. ")")
        return
    end

    -- Mark as notified for this session and save to file
    notifiedPlayers[guid] = true
    saveNotifiedPlayers()

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

    -- Clean up rocket mode state
    if rocketModeEnabled and rocketMode then
        rocketMode.cleanupPlayer(clientNum)
    end

    -- Clean up panzerfest/survival state
    if panzerfestEnabled and panzerfest then
        panzerfest.onPlayerDisconnect(clientNum)
    end

    -- Skip bots
    if name:find("%[BOT%]") then
        return
    end

    -- Clear from notified list so they get notified again if they rejoin
    local guid = getPlayerGuid(clientNum)
    if guid then
        notifiedPlayers[guid] = nil
        saveNotifiedPlayers()
        debug("Cleared notification tracking for " .. name .. " (GUID: " .. guid .. ")")
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

    -- Re-apply Rick Roll effects after respawn
    if rickrollEnabled and rickroll then
        rickroll.onPlayerSpawn(clientNum, revived)
    end

    -- Re-apply Rocket Mode effects after respawn
    if rocketModeEnabled and rocketMode then
        rocketMode.onSpawn(clientNum)
    end

    -- Handle panzerfest/survival spawn
    if panzerfestEnabled and panzerfest then
        panzerfest.onPlayerSpawn(clientNum, revived)
    end
end

--[[
    GAME EVENTS
]]--

function et_Obituary(victim, killer, meansOfDeath)
    -- Stats are now tracked in C (g_etpanel.c)

    -- Track kills and deaths for panzerfest/survival
    if panzerfestEnabled and panzerfest then
        -- Track the kill for the killer
        if killer >= 0 and killer ~= victim and killer ~= 1022 then
            panzerfest.onPlayerKill(killer, victim)
        end
        -- Track death for the victim
        panzerfest.onPlayerDeath(victim)
    end

    -- Additional logging for debugging
    if config.debug and killer >= 0 and killer ~= victim and killer ~= 1022 then
        local killerName = et.gentity_get(killer, "pers.netname") or "Unknown"
        local victimName = et.gentity_get(victim, "pers.netname") or "Unknown"
        debug(killerName .. " killed " .. victimName .. " (MOD: " .. meansOfDeath .. ")")
    end
end

--[[
    DAMAGE HOOK
    Called when a player takes damage
    Return modified damage value or nil to use original
]]--
function et_Damage(target, attacker, damage, damageFlags, meansOfDeath)
    -- Only process if rickroll effects are active
    if not rickroll or not rickroll.effectSystem then
        return nil
    end

    local modifiedDamage = damage

    -- Check if attacker has damage boost
    if attacker >= 0 and rickroll.effectSystem.damageBoost and rickroll.effectSystem.damageBoost[attacker] then
        local boost = rickroll.effectSystem.damageBoost[attacker]
        modifiedDamage = math.floor(modifiedDamage * boost)
    end

    -- Check if attacker has weak hits
    if attacker >= 0 and rickroll.effectSystem.weakHits and rickroll.effectSystem.weakHits[attacker] then
        local reduction = rickroll.effectSystem.weakHits[attacker]
        modifiedDamage = math.floor(modifiedDamage * reduction)
    end

    -- Return modified damage if changed, nil otherwise
    if modifiedDamage ~= damage then
        return modifiedDamage
    end
    return nil
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

    -- Update Rick Roll Mode
    if rickrollEnabled and rickroll then
        rickroll.runFrame(levelTime)
    end

    -- Update Rocket Mode (for pending welcome messages)
    if rocketModeEnabled and rocketMode then
        rocketMode.runFrame(levelTime)
    end

    -- Update Panzerfest/Survival Mode
    if panzerfestEnabled and panzerfest then
        panzerfest.onRunFrame(levelTime)
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

    -- DEBUG: Log all client commands
    et.G_Print("[DEBUG] et_ClientCommand: client=" .. clientNum .. " cmd='" .. cmd .. "'\n")

    -- Handle rocket mode cycling commands: /rocket, /r, /rockets, /rocketmode, /cyclerocket
    if rocketModeEnabled and rocketMode then
        et.G_Print("[DEBUG] rocketMode enabled, checking command...\n")
        if rocketMode.handleCommand(clientNum, cmd) then
            et.G_Print("[DEBUG] rocketMode.handleCommand returned true\n")
            return 1  -- Command handled
        end
    end

    -- Custom commands
    if cmd == "crazymode" then
        local status = config.crazy_mode and "^2ON" or "^1OFF"
        et.trap_SendServerCommand(clientNum,
            'chat "^3Crazy Mode: ' .. status .. '"')
        return 1  -- Command handled
    end

    -- Rick Roll trigger command (for testing)
    if cmd == "rickroll" then
        if rickrollEnabled and rickroll then
            local levelTime = et.trap_Milliseconds()
            rickroll.trigger.force(levelTime)
            et.trap_SendServerCommand(clientNum, 'chat "^5Rick Roll triggered!"')
        else
            et.trap_SendServerCommand(clientNum, 'chat "^1Rick Roll mode is disabled"')
        end
        return 1
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

    -- Debug: log what command we received
    et.G_Print(string.format("[DEBUG] et_ConsoleCommand: cmd='%s'\n", cmd))

    if cmd == "lua_reload" then
        log("^3Reloading Lua scripts on next map...")
        return 1
    end

    -- Rick Roll Mode console commands
    if rickrollEnabled and rickroll then
        et.G_Print(string.format("[DEBUG] Calling rickroll.consoleCommand with '%s'\n", cmd))
        if rickroll.consoleCommand(cmd) then
            return 1
        end
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
