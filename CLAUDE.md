# ET:Legacy Server Project

Custom ET:Legacy server with voice chat, custom rockets, survival mode. Uses 64-bit architecture with Lua scripting.

## Quick Reference

| Item | Value |
|------|-------|
| **VPS** | `andy@5.78.83.59` |
| **Connect** | `/connect et.etman.dev:27960` |
| **HTTP Downloads** | `https://etdl.etman.dev` |
| **Voice Port** | 27961 (game port + 1) |

## Commands

```bash
# Build EVERYTHING (client mods + voice server) - USE THIS!
./scripts/build-all.sh

# Build client mods only (NO voice server)
./scripts/build-all.sh mod

# Deploy to VPS + restart all services
./scripts/publish.sh

# Check server status
ssh andy@5.78.83.59 "sudo systemctl status etserver"

# View logs
ssh andy@5.78.83.59 "journalctl -u etserver -f"
```

## Directory Structure

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
├── scripts/                # build-all.sh, publish.sh, deploy.sh
└── dist/                   # Built pk3 output
```

## Key Files

| File | Purpose |
|------|---------|
| `configs/server.cfg` | Main server config |
| `lua/main.lua` | Lua entry point |
| `src/src/cgame/cg_voice.c` | Voice chat implementation |
| `src/src/cgame/cg_draw.c` | HUD drawing (voice indicators) |
| `src/etmain/ui/options_controls.menu` | Controls menu with voice binds |
| `src/etmain/ui/ingame_serverinfo.menu` | Custom server info panel |

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

## Build System

The `build-all.sh` script:
1. Builds cgame/ui modules for Linux 32/64 + Windows 32/64
2. Packages into `zzz_etman_etlegacy.pk3`
3. Includes: modules, lua/, ui/ menus, rickroll assets

**pk3 naming matters for sv_pure:**
- Linux: `cgame.mp.x86_64.so` (dots)
- Windows: `cgame_mp_x64.dll` (underscores)

## Deployment

`publish.sh` does:
1. Build locally
2. Deploy to `~/etlegacy/`
3. Sync to VPS via rsync
4. Restart etserver + voice-server + et-monitor
5. Remove local client pk3 (forces re-download for testing)

**Never edit files directly on VPS** - they get overwritten.

## Services (VPS)

| Service | Purpose |
|---------|---------|
| `etserver` | Game server (systemd) |
| `voice-server` | Voice relay on port 27961 |
| `et-monitor` | Health check + auto-restart |

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

## Memory Bank

Detailed implementation notes stored in ReasoningBank. Query with:
```bash
cd ~/projects/et && export FORCE_TRANSFORMERS=1 && npx claude-flow memory query "search terms" --namespace build --reasoningbank
```

**Namespaces**: `build`, `server`, `bugs`, `lessons`, `decisions`

## Custom Sound System (ETMan)

The voice server includes a custom sound management system allowing players to add, play, and share sounds.

### Key Files
| File | Purpose |
|------|---------|
| `voice-server/sound_manager.c` | Server-side sound CRUD, playback, sharing |
| `voice-server/sound_manager.h` | Command definitions (0x10-0x30) |
| `voice-server/db.c` | PostgreSQL integration for sounds |
| `src/src/cgame/cg_etman.c` | Client-side /etman command handler |

### In-Game Commands
```
/etman add <url> <name>       - Download MP3 from URL
/etman play <name>            - Play your sound to all
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

### ETPanel Integration
The etpanel web UI at https://etpanel.etman.dev connects to the same PostgreSQL database. Backend routes in `etpanel/backend/src/routes/sounds.ts` provide REST API for:
- Sound CRUD operations
- Playlist management
- Public library browsing
- Share management
- Account/GUID linking

**Frontend pages needed**: `Sounds.tsx`, `Playlists.tsx`, `PublicLibrary.tsx`

## CRITICAL: Build & Deploy

**ALWAYS use `./scripts/build-all.sh` (no arguments) when modifying voice server code!**

The `mod` argument only builds client modules (cgame/ui). Voice server changes require:
```bash
./scripts/build-all.sh && ./scripts/publish.sh
```

## Resources

- ET:Legacy: https://github.com/etlegacy/etlegacy
- Lua API: https://etlegacy-lua-docs.readthedocs.io/
- Lua Examples: https://github.com/etlegacy/etlegacy-lua-scripts
