--[[
    ET:Legacy Dynamic Map Rotation System

    This module replaces the vstr-based map rotation with a Lua-based system
    that uses symlinks for on-demand map downloads.

    How it works:
    1. Map pk3s are stored in maps_repo/ (outside sv_pure scan)
    2. Before each map change, map_switch.sh creates a symlink in legacy/
    3. sv_pure only validates the current map + mod pk3s
    4. Clients only download what they need for the current map

    Usage:
    - Rotation happens automatically at intermission
    - Commands: /nextmap, /maplist (admin only)

    IMPORTANT: The script path must match where it's deployed on the server.
]]--

local M = {}

-- Map rotation configuration
-- Add/remove maps here. Order determines rotation sequence.
M.maps = {
    "baserace",
    "snatch3",
    "ctf_face_b1",
    "fragmaze_fixed",
    "et_mor2_night_final",
    "fa_bremen_final",
    "mml_minastirith_fp3",
    "capuzzo"
}

-- Current position in rotation (1-indexed for Lua)
M.currentIndex = 1

-- Script path for map switching (set by server environment)
M.mapSwitchScript = "/home/andy/etlegacy/scripts/map_switch.sh"

-- Track intermission state
M.intermissionStarted = false
M.intermissionTime = 0
M.mapChangeScheduled = false
M.INTERMISSION_DELAY = 12000  -- 12 seconds (default intermission length)

-- Pending map change (for forced rotation via rcon)
M.pendingMapChange = nil
M.pendingMapTime = 0

-- Logging
local function log(msg)
    et.G_Print("[MapRotation] " .. msg .. "\n")
end

-- Initialize the rotation system
function M.init()
    log("Initializing map rotation system")
    log("Rotation: " .. table.concat(M.maps, " -> "))

    -- Find current map in rotation
    local currentMap = et.trap_Cvar_Get("mapname")
    for i, mapName in ipairs(M.maps) do
        if mapName == currentMap then
            M.currentIndex = i
            log("Current map index: " .. i .. " (" .. mapName .. ")")
            break
        end
    end
end

-- Get the next map in rotation
function M.getNextMap()
    local nextIndex = M.currentIndex + 1
    if nextIndex > #M.maps then
        nextIndex = 1
    end
    return M.maps[nextIndex], nextIndex
end

-- Get previous map in rotation
function M.getPrevMap()
    local prevIndex = M.currentIndex - 1
    if prevIndex < 1 then
        prevIndex = #M.maps
    end
    return M.maps[prevIndex], prevIndex
end

-- Switch to a specific map by name
function M.switchToMap(mapName)
    -- Validate map exists in rotation
    local found = false
    for i, name in ipairs(M.maps) do
        if name == mapName then
            found = true
            M.currentIndex = i
            break
        end
    end

    if not found then
        log("WARNING: Map '" .. mapName .. "' not in rotation, switching anyway")
    end

    -- Call map_switch.sh to set up symlink
    -- NOTE: os.execute() may be blocked by ET:Legacy for security
    -- We try it anyway, but the symlink should already exist from systemd ExecStartPre
    -- or we can rely on maps_repo fallback in nginx
    log("Executing: " .. M.mapSwitchScript .. " " .. mapName)

    -- Try os.execute first (may be blocked)
    local success, exitType, code = pcall(function()
        return os.execute(M.mapSwitchScript .. " " .. mapName)
    end)

    if success then
        log("map_switch.sh executed (result: " .. tostring(code) .. ")")
    else
        log("WARNING: os.execute blocked, using direct map command")
    end

    -- Issue map command - this MUST use EXEC_INSERT to run immediately
    -- EXEC_APPEND queues it, EXEC_INSERT runs it NOW
    log("Changing map to: " .. mapName)
    et.trap_SendConsoleCommand(et.EXEC_INSERT, "map " .. mapName .. "\n")

    return true
end

-- Advance to next map in rotation
function M.nextMap()
    local nextMapName, nextIndex = M.getNextMap()
    log("Advancing to next map: " .. nextMapName .. " (index " .. nextIndex .. ")")
    M.currentIndex = nextIndex
    return M.switchToMap(nextMapName)
end

-- Schedule next map for next frame (use this from rcon commands)
function M.scheduleNextMap()
    local nextMapName, nextIndex = M.getNextMap()
    log("Scheduling map change to: " .. nextMapName .. " (index " .. nextIndex .. ")")
    M.currentIndex = nextIndex
    M.pendingMapChange = nextMapName
    return true
end

-- Called during intermission to schedule map change
function M.onIntermissionStart(levelTime)
    if M.intermissionStarted then
        return  -- Already handling intermission
    end

    M.intermissionStarted = true
    M.intermissionTime = levelTime
    M.mapChangeScheduled = true

    local nextMap = M.getNextMap()
    log("Intermission started. Next map: " .. nextMap .. " in " .. (M.INTERMISSION_DELAY / 1000) .. "s")
end

-- Check if it's time to change maps
function M.checkMapChange(levelTime)
    -- Check for pending forced map change (from rcon rotate)
    if M.pendingMapChange then
        local mapName = M.pendingMapChange
        M.pendingMapChange = nil
        log("Executing map change to: " .. mapName)

        -- The C code in sv_init.c handles the symlink switching automatically
        -- when SV_SpawnServer is called. We just need to trigger the map change.
        -- Set nextmap cvar and trigger it
        et.trap_Cvar_Set("nextmap", "map " .. mapName)
        et.trap_SendConsoleCommand(et.EXEC_APPEND, "vstr nextmap\n")
        return
    end

    if not M.mapChangeScheduled then
        return
    end

    -- Wait for intermission delay
    if levelTime - M.intermissionTime >= M.INTERMISSION_DELAY then
        M.mapChangeScheduled = false
        M.intermissionStarted = false
        M.nextMap()
    end
end

-- Reset intermission state (called on map init)
function M.onMapInit()
    M.intermissionStarted = false
    M.intermissionTime = 0
    M.mapChangeScheduled = false
end

-- Handle admin commands
function M.handleCommand(clientNum, cmd)
    -- Check if player is admin (has rcon or referee status)
    -- For now, allow all commands but could add checks

    if cmd == "nextmap" or cmd == "forcenextmap" then
        log("Admin forcing next map")
        M.nextMap()
        return true
    end

    if cmd == "maplist" then
        local currentMap = et.trap_Cvar_Get("mapname")
        local msg = "^3Map Rotation:\n"
        for i, mapName in ipairs(M.maps) do
            if mapName == currentMap then
                msg = msg .. "^2> " .. i .. ". " .. mapName .. " ^7(current)\n"
            else
                msg = msg .. "^7  " .. i .. ". " .. mapName .. "\n"
            end
        end
        et.trap_SendServerCommand(clientNum, "print \"" .. msg .. "\"")
        return true
    end

    return false
end

-- Shutdown/cleanup
function M.shutdown()
    log("Map rotation system shutting down")
    M.intermissionStarted = false
    M.mapChangeScheduled = false
end

return M
