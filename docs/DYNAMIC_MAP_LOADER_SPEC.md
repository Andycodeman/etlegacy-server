# Dynamic Map Loader for ET:Legacy

## Overview

A custom system to enable on-demand map downloads while maintaining `sv_pure 1` security. Instead of requiring clients to download ALL map pk3s upfront (~77MB), they only download the current map (~5-17MB each).

## Problem

With `sv_pure 1`, ET:Legacy validates ALL pk3 files in `legacy/` at client connect time. This means:
- New players must download every map pk3 before playing
- Total download: ~77MB of maps + ~50MB of mod files
- Many players disconnect during long downloads (we observed this in server logs)

## Solution

**Key Discovery**: The sv_pure checksum list is recalculated on EACH map change via `FS_Restart()` in `SV_SpawnServer()`. This means we can:

1. Store map pk3s outside `legacy/` (in `maps_repo/`)
2. Symlink only the CURRENT map into `legacy/` before each map load
3. sv_pure will only validate the current map + mod pk3s
4. Clients only download what they need for the current map

**Source**: https://github.com/etlegacy/etlegacy/blob/master/src/server/sv_init.c

## Architecture

### Directory Structure

```
/home/andy/etlegacy/
├── legacy/                      # sv_pure scans THIS folder
│   ├── legacy_v2.83.2.pk3       # Official ET:Legacy (NEVER MODIFY)
│   ├── zzz_etman_etlegacy.pk3   # Custom mod pk3
│   ├── etman_rickroll.pk3       # Rick roll assets
│   ├── qagame.mp.x86_64.so      # Server game module
│   ├── server.cfg               # Server config
│   ├── crazymode.cfg            # Gameplay settings
│   ├── lua/                     # Lua scripts
│   └── [current_map].pk3        # SYMLINK to maps_repo/
│
├── maps_repo/                   # Map storage (NOT in sv_pure scan)
│   ├── baserace.pk3             # 7.1 MB
│   ├── snatch3.pk3              # 4.6 MB
│   ├── ctf_face_b1.pk3          # 6.4 MB
│   ├── fragmaze_fixed.pk3       # 0.2 MB
│   ├── et_mor2_night_final.pk3  # 8.0 MB
│   ├── fa_bremen_final.pk3      # 5.6 MB
│   ├── mml_minastirith_fp3.pk3  # 8.9 MB
│   └── capuzzo_final.pk3        # 17.0 MB
│
└── etlded.x86_64                # Server binary
```

### HTTP Download Structure

nginx must serve maps from `maps_repo/` at the same URL path clients expect:

```
https://etdl.etman.dev/legacy/baserace.pk3  →  /home/andy/etlegacy/maps_repo/baserace.pk3
https://etdl.etman.dev/legacy/snatch3.pk3   →  /home/andy/etlegacy/maps_repo/snatch3.pk3
```

This can be done with nginx `try_files` or symlinks in the web root.

## Components to Build

### 1. Map Switcher Script (`scripts/map_switch.sh`)

Called before each map change to manage symlinks.

```bash
#!/bin/bash
# Usage: map_switch.sh <mapname>
# Example: map_switch.sh baserace

LEGACY_DIR="/home/andy/etlegacy/legacy"
MAPS_REPO="/home/andy/etlegacy/maps_repo"
MAP_NAME="$1"

# Remove all existing map symlinks (but not mod pk3s)
for link in "$LEGACY_DIR"/*.pk3; do
    if [ -L "$link" ]; then
        rm "$link"
    fi
done

# Create symlink for new map
if [ -f "$MAPS_REPO/${MAP_NAME}.pk3" ]; then
    ln -sf "$MAPS_REPO/${MAP_NAME}.pk3" "$LEGACY_DIR/${MAP_NAME}.pk3"
    echo "Switched to map: $MAP_NAME"
else
    echo "ERROR: Map not found: $MAPS_REPO/${MAP_NAME}.pk3"
    exit 1
fi
```

### 2. Lua Map Rotation System (`lua/map_rotation.lua`)

Replaces the vstr-based rotation with Lua that calls the map switcher.

```lua
-- Map rotation configuration
local maps = {
    "baserace",
    "snatch3",
    "ctf_face_b1",
    "fragmaze_fixed",
    "et_mor2_night_final",
    "fa_bremen_final",
    "mml_minastirith_fp3",
    "capuzzo_final"
}

local currentIndex = 1

-- Called when map ends (from et_RunFrame or intermission detection)
function nextMap()
    currentIndex = currentIndex + 1
    if currentIndex > #maps then
        currentIndex = 1
    end

    local nextMapName = maps[currentIndex]

    -- Call map switcher script
    os.execute("/home/andy/etlegacy/scripts/map_switch.sh " .. nextMapName)

    -- Small delay to ensure symlink is created
    -- Then change map
    et.trap_SendConsoleCommand(et.EXEC_APPEND, "map " .. nextMapName .. "\n")
end

-- Hook into intermission or use timer
function et_RunFrame(levelTime)
    -- Check if intermission started, call nextMap()
end
```

### 3. Server Config Changes (`configs/server.cfg`)

Remove vstr-based rotation:

```diff
- set d1 "map baserace; set nextmap vstr d2"
- set d2 "map snatch3; set nextmap vstr d3"
- ...
- vstr d1

+ // Map rotation handled by Lua (lua/map_rotation.lua)
+ // Initial map set by map_switch.sh + map command
```

### 4. Startup Script Changes

Server startup needs to set up initial map:

```bash
#!/bin/bash
# Run map_switch.sh for initial map before starting server
/home/andy/etlegacy/scripts/map_switch.sh baserace

# Start server
cd /home/andy/etlegacy
./etlded.x86_64 +set fs_game legacy +exec server.cfg +map baserace
```

### 5. nginx Configuration Update

Add fallback to serve maps from `maps_repo/`:

```nginx
location /legacy/ {
    alias /home/andy/etlegacy/legacy/;
    try_files $uri @maps_repo;
}

location @maps_repo {
    alias /home/andy/etlegacy/maps_repo/;
}
```

Or simpler - symlink maps in web root:
```bash
cd /var/www/etdl/legacy
ln -sf /home/andy/etlegacy/maps_repo/*.pk3 .
```

## Deploy Script Changes (`scripts/deploy.sh`)

Update to deploy maps to `maps_repo/` instead of `legacy/`:

```bash
# Deploy maps to maps_repo/ (NOT legacy/)
echo -e "${YELLOW}Deploying maps...${NC}"
if [ -d "$PROJECT_DIR/maps" ]; then
    mkdir -p "$SERVER_DIR/maps_repo"
    cp "$PROJECT_DIR/maps/"*.pk3 "$SERVER_DIR/maps_repo/" 2>/dev/null || true
    echo "  - Map pk3s synced to maps_repo/"
fi
```

## Testing Plan

1. **Setup Phase**
   - Move existing maps from `legacy/` to `maps_repo/`
   - Create `map_switch.sh` script
   - Update nginx config
   - Test HTTP download paths work

2. **Basic Test**
   - Run `map_switch.sh baserace`
   - Verify symlink created in `legacy/`
   - Start server, verify map loads
   - Connect client, verify only baserace.pk3 + mod pk3s required

3. **Rotation Test**
   - Let map end or force `nextmap`
   - Verify old symlink removed, new one created
   - Verify client can connect with only new map

4. **Download Test**
   - Clear client dlcache
   - Connect to server
   - Verify only current map downloads (not all maps)
   - Check download size matches single map

## Success Criteria

- [ ] New player downloads < 60MB (mod pk3s + 1 map) instead of ~130MB
- [ ] sv_pure 1 remains enabled and functional
- [ ] Map rotation works seamlessly
- [ ] No "map not found" errors
- [ ] HTTP downloads work for all maps
- [ ] Existing players with all maps still work fine

## Risks & Mitigations

1. **Risk**: Symlink race condition during map change
   - **Mitigation**: Script runs synchronously before map command

2. **Risk**: HTTP download path mismatch
   - **Mitigation**: Test each map's download URL before deploy

3. **Risk**: Lua os.execute() blocked
   - **Mitigation**: Use et.trap_SendConsoleCommand with rcon, or hook into map end differently

4. **Risk**: Server restart doesn't set up initial map
   - **Mitigation**: systemd ExecStartPre runs map_switch.sh

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `scripts/map_switch.sh` | CREATE | Symlink manager |
| `lua/map_rotation.lua` | CREATE | Lua-based rotation |
| `lua/main.lua` | MODIFY | Load map_rotation module |
| `configs/server.cfg` | MODIFY | Remove vstr rotation |
| `scripts/deploy.sh` | MODIFY | Deploy to maps_repo/ |
| `scripts/publish.sh` | MODIFY | Sync maps_repo/ to VPS |
| nginx config | MODIFY | Serve from maps_repo/ |
| systemd service | MODIFY | ExecStartPre for initial map |

## VPS Details

- **Server**: andy@5.78.83.59
- **Game port**: 27960
- **HTTP downloads**: https://etdl.etman.dev
- **Service**: etserver (systemd)

## Current Map List

| Map | Size | Notes |
|-----|------|-------|
| baserace | 7.1 MB | CTF-style |
| snatch3 | 4.6 MB | Objective |
| ctf_face_b1 | 6.4 MB | CTF classic |
| fragmaze_fixed | 0.2 MB | Tiny deathmatch |
| et_mor2_night_final | 8.0 MB | Night map |
| fa_bremen_final | 5.6 MB | City map |
| mml_minastirith_fp3 | 8.9 MB | LOTR themed |
| capuzzo_final | 17.0 MB | Large objective |

**Total**: ~58 MB (down from 130MB with santa map removed)
