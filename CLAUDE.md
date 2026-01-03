# ⚠️⚠️⚠️ STOP! READ THIS FIRST! ⚠️⚠️⚠️

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🧠 MANDATORY: QUERY MEMORY BEFORE STARTING ANY TASK!                       ║
║                                                                              ║
║   BEFORE doing ANYTHING, run:                                                ║
║   cd ~/projects/et/etlegacy && export FORCE_TRANSFORMERS=1 && \              ║
║   npx claude-flow memory query "<relevant search terms>" \                   ║
║   --namespace <namespace>                                                    ║
║                                                                              ║
║   AFTER completing ANY task, run:                                            ║
║   cd ~/projects/et/etlegacy && export FORCE_TRANSFORMERS=1 && \              ║
║   npx claude-flow memory store "<key>" "<what was done>" \                   ║
║   --namespace <namespace>                                                    ║
║                                                                              ║
║   Namespaces: build, server, etpanel, bugs, decisions, lessons               ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

# ET:Legacy Server Project

Custom ET:Legacy server with voice chat, custom rockets, survival mode. Uses 64-bit architecture with Lua scripting.

---

## ⚠️ IMPORTANT: Current Year is 2026
When storing memory entries or referencing dates, use 2026 (not 2024 or 2025).

---

## 🎮 Project Status (Jan 2026)

| Component | Status | URL |
|-----------|--------|-----|
| **ETPanel** | ✅ Deployed | https://etpanel.etman.dev |
| **ET:Legacy Server** | ✅ Running | et.etman.dev:27960 |
| **HTTP Downloads** | ✅ Fast | https://etdl.etman.dev |

**VPS:** 5.78.83.59 (Hetzner), service: `etserver`

## Quick Reference

| Item | Value |
|------|-------|
| **VPS** | `andy@5.78.83.59` |
| **Connect** | `/connect et.etman.dev:27960` |
| **HTTP Downloads** | `https://etdl.etman.dev` |
| **Voice Port** | 27961 (game port + 1) |

---

## 📁 Directory Structure

```
~/projects/et/etlegacy/
├── src/                    # ET:Legacy source (forked)
│   ├── src/cgame/          # Client game (cg_voice.c, cg_draw.c)
│   ├── src/ui/             # UI code (ui_shared.c bind table)
│   ├── etmain/ui/          # Custom menu overrides
│   └── libs/voice/         # PortAudio + Opus static libs
├── configs/                # Server configs (SINGLE SOURCE OF TRUTH)
├── lua/                    # Lua scripts (main.lua entry point)
├── maps/                   # Map pk3 files
├── waypoints/              # Omni-bot .way/.gm files
├── mapscripts/             # Custom mapscripts
├── scripts/                # build-all.sh, publish.sh, deploy.sh
├── dist/                   # Built pk3 output
└── etpanel/                # Web control panel
    ├── backend/            # Fastify API
    ├── frontend/           # React UI
    └── deploy.sh           # Deploy to VPS
```

---

## 🔧 Commands

```bash
# Build EVERYTHING (client mods + etman server) - USE THIS!
./scripts/build-all.sh

# Build client mods only (NO etman server)
./scripts/build-all.sh mod

# Deploy to VPS + restart all services
./scripts/publish.sh

# Check server status
ssh andy@5.78.83.59 "sudo systemctl status etserver"

# View logs
ssh andy@5.78.83.59 "journalctl -u etserver -f"

# Deploy web panel
cd etpanel && ./deploy.sh
```

---

## Key Files

| File | Purpose |
|------|---------|
| `configs/server.cfg` | Main server config |
| `lua/main.lua` | Lua entry point |
| `src/src/cgame/cg_voice.c` | Voice chat implementation |
| `src/src/cgame/cg_draw.c` | HUD drawing (voice indicators) |
| `src/etmain/ui/options_controls.menu` | Controls menu with voice binds |
| `src/etmain/ui/ingame_serverinfo.menu` | Custom server info panel |

---

## Server Features

### Voice Chat
- **Keys**: `,` = team, `.` = all (rebindable in Controls > Chat)
- **CVars**: `voice_enable`, `voice_volume`, `voice_inputGain`, `voice_showMeter`

### Rocket Modes
- Normal, Homing, Freeze, Freeze+Homing
- Cycle by selecting Panzer again

### Survival/Panzerfest
- +5 kills = faster firing rate
- +30 sec alive = faster movement
- 30 kills = PANZERFEST (you vs everyone, panzer only)
- Die = lose all power-ups

### Gameplay
- Double jump, low gravity, high knockback, fast weapon switch

---

## Build System

The `build-all.sh` script:
1. Builds cgame/ui modules for Linux 32/64 + Windows 32/64
2. Packages into `zzz_etman_etlegacy.pk3`
3. Includes: modules, lua/, ui/ menus, rickroll assets

**pk3 naming matters for sv_pure:**
- Linux: `cgame.mp.x86_64.so` (dots)
- Windows: `cgame_mp_x64.dll` (underscores)

---

## Deployment

`publish.sh` does:
1. Build locally
2. Deploy to `~/etlegacy/`
3. Sync to VPS via rsync
4. Restart etserver + etman-server + et-monitor
5. Remove local client pk3 (forces re-download for testing)

**Never edit files directly on VPS** - they get overwritten.

---

## 🚨 Critical Rules

### 1. NEVER edit files directly on servers
Files in `~/etlegacy/` (local) and on VPS get **overwritten** by deploy scripts.
Edit only in `~/projects/et/etlegacy/` - it's the single source of truth.

### 2. 🔴 NEVER OVERWRITE THE OFFICIAL legacy_v2.83.2.pk3
**THIS BREAKS sv_pure AND CLIENTS CANNOT CONNECT!**
- The official `legacy_v2.83.2.pk3` comes from Flatpak install and MUST match client versions
- Location on VPS: `/home/andy/etlegacy/legacy/legacy_v2.83.2.pk3`
- Source: `/var/lib/flatpak/app/com.etlegacy.ETLegacy/.../legacy_v2.83.2.pk3`
- Building from source creates `legacy_*_dirty.pk3` - **NEVER deploy this!**
- The deploy scripts have been fixed to NOT copy built legacy pk3s

### 3. pk3 Strategy
- **Official `legacy_v2.83.2.pk3`** - NEVER TOUCH, must match client (30.9 MB)
- **Custom Lua** → `etman_YYYYMMDD.pk3` (separate, versioned by date)
- **C mods** → `zzz_etman.pk3` (loads after base, overrides)

### 4. HTTP Downloads
- nginx serves files directly: `sv_dlRate 0` (unlimited)
- URL: https://etdl.etman.dev

### 5. Lua dofile() Paths
- ET:Legacy runs from `/home/andy/etlegacy/`
- Lua files are in `/home/andy/etlegacy/legacy/lua/`
- Use `dofile("legacy/lua/module.lua")` NOT `dofile("lua/module.lua")`
- The `lua_modules` cvar uses `"lua/main"` format (relative to mod dir)

---

## Services (VPS)

| Service | Purpose |
|---------|---------|
| `etserver` | Game server (systemd) |
| `etman-server` | ETMan sidecar on port 27961 (voice + sounds + admin) |
| `et-monitor` | Health check + auto-restart |

---

## Troubleshooting

### Players kicked (sv_pure mismatch)
```bash
unzip -l dist/zzz_etman_etlegacy.pk3 | grep -E '\.(dll|so)'
# Check Windows uses underscores, Linux uses dots
./scripts/build-all.sh mod && ./scripts/publish.sh
```

### HTTP download fails
- Client-side: try `/cl_wwwDownload 0` then `/reconnect`
- Verify: `curl -I https://etdl.etman.dev/legacy/zzz_etman_etlegacy.pk3`

### Build fails
```bash
./scripts/build-all.sh --clean
./src/easybuild.sh -h  # Check dependencies
```

---

## Custom Sound System (ETMan)

The etman-server includes a custom sound management system allowing players to add, play, and share sounds.

### Key Files
| File | Purpose |
|------|---------|
| `etman-server/sound_manager.c` | Server-side sound CRUD, playback, sharing |
| `etman-server/sound_manager.h` | Command definitions (0x10-0x30) |
| `etman-server/db_manager.c` | PostgreSQL integration for sounds |
| `src/src/cgame/cg_etman.c` | Client-side /etman command handler |

### Quick Sound Commands
Type `@alias` in chat to trigger sounds (prefix configurable via ETPanel).
- With chat_text set: plays sound + shows replacement text
- Without chat_text: plays sound only (no chat)
See `docs/FEATURE_QUICK_SOUND_COMMANDS.md` for details.

### In-Game Commands
```
/etman add <url> <name>       - Download MP3 from URL
/etman playsnd <name>         - Play your sound to all
/etman listsnd                - List your sounds
/etman delete <name>          - Delete a sound
/etman rename <old> <new>     - Rename a sound
/etman visibility <name> <private|shared|public>

# Playlists
/etman createplaylist <name>  - Create playlist
/etman playlist <name> add <sound>
/etman playlist <name> [#]    - List or play by position
/etman playnext <playlist>    - Play next (cycles through)
/etman playrandom <playlist>  - Play random from playlist

# Public playlists
/etman publicplaylists        - List public playlists
/etman publicplaylist <name> [#]
/etman publicplaynext <name>
/etman publicplayrandom <name>

# Sharing
/etman share <sound> <player> - Share with player
/etman pending                - List pending shares
/etman accept <#> [alias]     - Accept share
/etman reject <#>             - Reject share

# Account linking
/etman register               - Get code to link with etpanel
```

### Database Tables (PostgreSQL)
- `sound_files` - Actual MP3 files on disk
- `user_sounds` - User aliases pointing to files
- `sound_playlists` - User playlists
- `sound_playlist_items` - Playlist contents
- `sound_shares` - Pending/accepted shares
- `verification_codes` - For account linking

---

## ETPanel Web Application

The etpanel web UI at https://etpanel.etman.dev connects to the same PostgreSQL database.

### Structure
```
etpanel/
├── backend/                # Fastify API (TypeScript)
│   └── src/routes/         # API routes (sounds.ts, auth.ts, etc.)
├── frontend/               # React UI (TypeScript + Vite)
│   └── src/pages/          # Page components
└── deploy.sh               # Deploy to VPS
```

### Features
- Sound library management (upload, organize, play)
- Playlist creation and sharing
- Public sound library
- Player statistics
- Server monitoring (Server Scout)
- Admin console access

### Deploy
```bash
cd etpanel && ./deploy.sh
```

---

## CRITICAL: Build & Deploy

**ALWAYS use `./scripts/build-all.sh` (no arguments) when modifying etman-server code!**

The `mod` argument only builds client modules (cgame/ui). ETMan server changes require:
```bash
./scripts/build-all.sh && ./scripts/publish.sh
```

---

## Resources

- ET:Legacy: https://github.com/etlegacy/etlegacy
- Lua API: https://etlegacy-lua-docs.readthedocs.io/
- Lua Examples: https://github.com/etlegacy/etlegacy-lua-scripts
