# ET:Legacy Server Project

## Project Overview

Custom ET:Legacy server build with Lua scripting for gameplay modifications. Successor to the JayMod-based server, using modern 64-bit architecture and Lua for extensibility.

## Recent Fixes (Dec 2024)

### Windows Client pk3 Checksum Fix
**Problem:** Windows clients couldn't connect - got kicked with sv_pure checksum mismatch.

**Root Cause:** The build script was naming Windows DLLs incorrectly:
- Wrong: `cgame.mp.i386.dll`, `cgame.mp.x86_64.dll` (Linux-style naming)
- Correct: `cgame_mp_x86.dll`, `cgame_mp_x64.dll` (Windows convention)

Windows clients couldn't find the custom modules in the pk3 (wrong filename), so they fell back to official `legacy_v2.83.2.pk3` modules which had different checksums → sv_pure mismatch → kicked.

**Fix:** Updated `scripts/build-all.sh` to use correct Windows naming convention.

**Key insight:** ET:Legacy uses different naming conventions per platform:
- Linux: `cgame.mp.i386.so`, `cgame.mp.x86_64.so` (dots)
- Windows: `cgame_mp_x86.dll`, `cgame_mp_x64.dll` (underscores)

### Monitoring System Split
**Problem:** Bash script for player notifications was unreliable due to subshell variable issues.

**Solution:** Split responsibilities:
- `server-monitor.sh` (Bash) - Health check & auto-restart only (must run externally to detect crashes)
- `lua/main.lua` (Lua) - Player connect/disconnect ntfy notifications (runs inside game, instant detection)

## Directory Structure

```
~/projects/et/etlegacy/
├── src/                    # ET:Legacy source (directly tracked, forked from etlegacy/etlegacy)
│   ├── easybuild.sh        # Official build script
│   ├── src/                # C/C++ source code (includes custom jaymod-like modifications)
│   └── ...
│
├── build/                  # CMake build output (gitignored)
│
├── configs/                # Server configuration files
│   ├── server.cfg          # Main server config
│   ├── crazymode.cfg       # Crazy mode settings
│   └── mapconfigs/         # Per-map overrides
│
├── lua/                    # Custom Lua scripts
│   └── main.lua            # Entry point (loaded via lua_modules)
│
├── maps/                   # Custom map pk3 files
├── waypoints/              # Omni-bot waypoint files (.way, .gm)
├── mapscripts/             # Custom mapscripts (.script)
│
├── scripts/                # Build and deploy scripts
│   ├── build.sh            # Build ET:Legacy from source
│   ├── deploy.sh           # Deploy to local server
│   └── publish.sh          # Deploy + sync to remote VM
│
└── docs/                   # Documentation
```

## Quick Start

```bash
# Build
./scripts/build.sh

# Deploy locally
./scripts/deploy.sh

# Build + deploy + sync to VM + restart
./scripts/publish.sh
```

## Build System

Uses CMake via the `scripts/build.sh` wrapper:

```bash
# 64-bit release build (default)
./scripts/build.sh

# 32-bit build
./scripts/build.sh --32

# Debug build
./scripts/build.sh --debug

# Clean rebuild
./scripts/build.sh --clean
```

Output goes to `build/` directory.

## Server Locations

| Location | Path | Purpose |
|----------|------|---------|
| Project (source) | `~/projects/et/etlegacy/` | Development, git tracked |
| Local server | `~/etlegacy/` | Runtime, deployed binaries |
| Remote VM | `andy@5.78.83.59:~/etlegacy/` | Production server |

## Configuration

### Single Source of Truth

All configs live in `configs/` and are deployed by scripts:

```
~/projects/et/etlegacy/configs/    # Edit HERE (git tracked)
        │
        ├── deploy.sh copies to ──→ ~/etlegacy/legacy/
        │
        └── publish.sh syncs to ──→ 5.78.83.59:~/etlegacy/legacy/
```

**Never edit configs directly on servers** - they get overwritten on deploy.

### Key Config Files

- `configs/server.cfg` - Main server settings
- `configs/crazymode.cfg` - Crazy mode gameplay tweaks
- `configs/mapconfigs/<mapname>.cfg` - Per-map overrides

## Lua Scripting

### Entry Point

`lua/main.lua` is loaded via `lua_modules "main"` in server.cfg.

### Adding Modules

Create new .lua files and load them from main.lua:

```lua
-- lua/main.lua
dofile("lua/panzerfest.lua")
dofile("lua/webapi.lua")
```

### Lua API Documentation

- https://etlegacy-lua-docs.readthedocs.io/
- https://github.com/etlegacy/etlegacy-lua-scripts (examples)

### Key Lua Functions

```lua
-- CVARs
et.trap_Cvar_Get("g_gravity")
et.trap_Cvar_Set("g_gravity", "350")

-- Commands
et.trap_SendConsoleCommand(et.EXEC_APPEND, "map oasis\n")
et.trap_SendServerCommand(clientNum, 'cp "Message"')

-- Player info
et.gentity_get(clientNum, "pers.netname")
et.Info_ValueForKey(et.trap_GetUserinfo(clientNum), "cl_guid")

-- HTTP (for web integration)
et.HTTPGet(url, callback)
et.HTTPPost(url, data, contentType, callback)
```

## Adding Maps

1. Copy pk3 to `maps/`
2. Copy waypoints to `waypoints/`
3. Add to rotation in `configs/server.cfg`
4. Run `./scripts/publish.sh`

## Remote Server

### Connection

```bash
ssh andy@5.78.83.59
```

### Service Management

```bash
sudo systemctl status etserver
sudo systemctl restart etserver
journalctl -u etserver -f
```

### Connect to Play

```
/connect et.coolip.me:27960
```

## Differences from JayMod

| Aspect | JayMod | ET:Legacy |
|--------|--------|-----------|
| Build | Separate Makefiles | Single CMake |
| Architecture | 32-bit (ABI issues) | 64-bit native |
| Customization | C++ recompile | Lua scripts |
| pk3 versioning | Manual bump | Automatic |
| HTTP support | None | Built-in |
| Maintenance | Abandoned (2013) | Active (2024) |

## Key CVARs

### Gameplay

| CVAR | Default | Description |
|------|---------|-------------|
| g_gravity | 800 | World gravity |
| g_speed | 320 | Player speed |
| g_knockback | 1000 | Knockback multiplier |
| g_misc | 0 | Gameplay flags (bitmask) |

### g_misc Flags

| Value | Effect |
|-------|--------|
| 1 | Double jump |
| 2 | No fall damage |
| 4 | No self damage |
| 8 | No team damage |
| 16 | Adrenaline |
| 32 | No stamina drain |
| 64 | Unlimited sprint |

Example: `g_misc "97"` = 1+32+64 = double jump + no stamina + unlimited sprint

### Lua

| CVAR | Description |
|------|-------------|
| lua_modules | Space-separated list of modules to load |
| lua_allowedModules | SHA1 whitelist (empty = allow all) |

## Troubleshooting

### Build fails

```bash
# Check dependencies
./src/easybuild.sh -h

# Clean rebuild
./scripts/build.sh --clean
```

### Lua script errors

Check server console or log:
```bash
tail -f ~/etlegacy/legacy/server.log
```

### Players can't connect

- Check `sv_pure "1"` in server.cfg
- Verify pk3 checksums match
- Check firewall: `sudo ufw status`

### sv_pure Checksum Mismatch (nChkSum1 errors)

If you see `nChkSum1 XXXX == YYYY` in logs and clients get kicked:

1. **Check pk3 DLL naming:** Windows uses `_mp_x86.dll`/`_mp_x64.dll`, Linux uses `.mp.i386.so`/`.mp.x86_64.so`
2. **Verify pk3 contents:** `unzip -l zzz_etman_etlegacy.pk3 | grep -E '\.(dll|so)'`
3. **Rebuild if needed:** `./scripts/build-all.sh mod` then `./scripts/publish.sh`

### HTTP Download Failures

If clients get "Client download failed" immediately:
- This is usually client-side (firewall, antivirus)
- Have player try `/cl_wwwDownload 0` then `/reconnect` to use in-game download
- Verify HTTP server works: `curl -I http://etdl.coolip.me/legacy/zzz_etman_etlegacy.pk3`

## ETPanel Integration

Events flow: Lua → `~/.etlegacy/legacy/legacy/etpanel_events.json` → `etpanel-relay.sh` → API

## Monitoring & Notifications

**Two-part system (both needed):**

| Service | Purpose | Location |
|---------|---------|----------|
| `etserver` | Game server | systemd service |
| `et-monitor` | Health check & auto-restart | Bash script (external) |
| Lua notifications | Player connect/disconnect ntfy | Inside game (main.lua) |

**Why split?** Lua runs inside the game - if server crashes, Lua dies too. Bash script runs externally so it can detect crashes and restart.

**ntfy topics:**
- `etman-server` - Server health alerts (down/restart)
- `etman-server-player-connected` - Player join/leave notifications

## 🚨 Lua Gotchas

1. **0 is TRUTHY** - Use `if isBot == 1 then` NOT `if isBot then`
2. **Files write to fs_homepath** - `~/.etlegacy/legacy/`, not server basepath
3. **Player name empty at connect** - Use `et_ClientBegin` or userinfo fallback
4. **pk3 overrides loose files** - Delete old pk3s when updating Lua
5. **dofile() from CWD** - Use `dofile("legacy/lua/file.lua")`
6. **Lua can't monitor server crashes** - It dies with the game process. Use external bash script for health monitoring.
7. **os.execute() for notifications** - Use `os.execute("curl ... &")` with `&` for non-blocking HTTP calls

## Git Repository

- **Remote**: `Andycodeman/etlegacy-server.git` (private)
- **src/**: Directly tracked (was submodule, converted Dec 2024)
- **Custom C code**: `src/src/game/g_etpanel.c/h`, modifications to `bg_pmove.c`, etc.

## Resources

- ET:Legacy GitHub: https://github.com/etlegacy/etlegacy
- Lua API Docs: https://etlegacy-lua-docs.readthedocs.io/
- Example Scripts: https://github.com/etlegacy/etlegacy-lua-scripts
- WolfAdmin: https://dev.timosmit.com/wolfadmin/
