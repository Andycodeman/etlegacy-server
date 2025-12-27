# ETMan Server-Side Custom Sounds Implementation Plan

## Overview

Server-side custom sound system where users upload sounds via URL to the voice server, which stores them and plays them back through the voice chat channel. Works on all platforms (Windows, Linux, Mac) without local file access issues.

## Architecture

```
┌─────────────────┐     UDP Commands      ┌──────────────────┐
│   Game Client   │ ◄──────────────────► │   Voice Server    │
│                 │     Opus Audio        │                  │
│  /etman add     │                       │  - Sound storage │
│  /etman play    │                       │  - MP3 decoding  │
│  /etman list    │                       │  - Opus encoding │
└─────────────────┘                       │  - User mgmt     │
                                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  Worker Process  │
                                          │  (downloads)     │
                                          └──────────────────┘
```

## Commands

All commands use `/etman <subcommand>` format:

| Command | Description |
|---------|-------------|
| `/etman add <url> <name>` | Download sound from URL and save as `<name>` |
| `/etman play <name>` | Play sound to all players (via voice channel) |
| `/etman list` | List all your sounds |
| `/etman delete <name>` | Delete a sound |
| `/etman rename <old> <new>` | Rename a sound |
| `/etman share <name> <player>` | Share sound with another player (requires approval) |

## Protocol

### Client → Voice Server

New packet types (add to existing voice protocol):

```c
#define VOICE_CMD_SOUND_ADD     10  // Add sound: <uuid><url><name>
#define VOICE_CMD_SOUND_PLAY    11  // Play sound: <uuid><name>
#define VOICE_CMD_SOUND_LIST    12  // List sounds: <uuid>
#define VOICE_CMD_SOUND_DELETE  13  // Delete sound: <uuid><name>
#define VOICE_CMD_SOUND_RENAME  14  // Rename: <uuid><oldname><newname>
#define VOICE_CMD_SOUND_SHARE   15  // Share: <uuid><name><target_uuid>
#define VOICE_CMD_SOUND_ACCEPT  16  // Accept share: <uuid><from_uuid><name>
#define VOICE_CMD_SOUND_REJECT  17  // Reject share: <uuid><from_uuid><name>
```

### Voice Server → Client

```c
#define VOICE_RESP_SUCCESS      20  // Operation succeeded: <message>
#define VOICE_RESP_ERROR        21  // Operation failed: <error_message>
#define VOICE_RESP_LIST         22  // Sound list: <count><name1><name2>...
#define VOICE_RESP_SHARE_REQ    23  // Incoming share request: <from_name><sound_name>
```

## Storage Structure

```
voice-server/
├── sounds/
│   ├── <uuid1>/
│   │   ├── yell.mp3
│   │   ├── laugh.mp3
│   │   └── ...
│   ├── <uuid2>/
│   │   └── ...
│   └── pending_shares/
│       └── <target_uuid>_<from_uuid>_<name>.json
```

## Implementation Tasks

### Phase 1: Voice Server Sound Storage
- [ ] 1.1 Create sounds directory structure
- [ ] 1.2 Add UUID-based folder management
- [ ] 1.3 Implement sound file CRUD operations
- [ ] 1.4 Add limits (100 files per user, 2MB per file)

### Phase 2: Download Worker
- [ ] 2.1 Create worker process for downloads
- [ ] 2.2 Implement URL validation (HTTP/HTTPS only, no local IPs)
- [ ] 2.3 HEAD request to check Content-Length and Content-Type
- [ ] 2.4 Download with timeout (2 minutes)
- [ ] 2.5 Save to user's sound folder

### Phase 3: Voice Server Protocol
- [ ] 3.1 Add new packet type definitions
- [ ] 3.2 Implement SOUND_ADD handler (spawn worker)
- [ ] 3.3 Implement SOUND_LIST handler
- [ ] 3.4 Implement SOUND_DELETE handler
- [ ] 3.5 Implement SOUND_RENAME handler
- [ ] 3.6 Implement response packet sending

### Phase 4: Sound Playback
- [ ] 4.1 Integrate minimp3 into voice server
- [ ] 4.2 MP3 to PCM decoding
- [ ] 4.3 PCM to Opus encoding (reuse existing encoder)
- [ ] 4.4 Implement SOUND_PLAY handler
- [ ] 4.5 Stream Opus packets to all clients via VOICE_CHAN_SOUND

### Phase 5: Client Commands
- [ ] 5.1 Add `/etman` command with subcommand parsing
- [ ] 5.2 Implement add/play/list/delete/rename subcommands
- [ ] 5.3 Send command packets to voice server
- [ ] 5.4 Handle response packets and display messages

### Phase 6: Sound Sharing
- [ ] 6.1 Implement SOUND_SHARE handler (create pending share)
- [ ] 6.2 Send share request notification to target
- [ ] 6.3 Display F1/F2 prompt on client
- [ ] 6.4 Implement SOUND_ACCEPT/REJECT handlers
- [ ] 6.5 Copy file on accept, handle name conflicts

### Phase 7: Cleanup
- [ ] 7.1 Remove old cg_customsound.c local file loading code
- [ ] 7.2 Update options_voice.menu (remove folder path display)
- [ ] 7.3 Add server-side sounds section to menu

## Security Considerations

1. **URL Validation**
   - Only allow http:// and https:// schemes
   - Block localhost, 127.0.0.1, 192.168.x.x, 10.x.x.x, etc.
   - Validate Content-Type header (audio/mpeg, audio/mp3)

2. **File Validation**
   - Check file size before download (Content-Length header)
   - Verify MP3 magic bytes after download
   - Sanitize filenames (alphanumeric + underscore only)

3. **Rate Limiting**
   - Max 1 download at a time per user
   - Cooldown between add requests (10 seconds?)
   - Max 100 sounds per user

4. **Resource Limits**
   - 2MB max file size
   - 2 minute download timeout
   - Max 10 second sound duration (check after decode)

## Dependencies

### Voice Server (C)
- minimp3 (already in libs, needs to be linked to voice server)
- libcurl (for HTTP downloads) - OR use raw sockets
- opus (already linked for voice encoding)

### Client (C)
- No new dependencies - reuses existing voice protocol

## Testing

1. Add sound from valid URL
2. Add sound from invalid URL (404, wrong content-type)
3. Add sound exceeding size limit
4. Play sound (verify all clients hear it)
5. List sounds
6. Delete sound
7. Rename sound
8. Share sound (accept)
9. Share sound (reject)
10. Share sound with name conflict
11. Hit 100 sound limit
12. Concurrent downloads from multiple users

## Notes

- Player UUID: Use `cl_guid` cvar which is unique per installation
- Sound playback uses VOICE_CHAN_SOUND (channel 3) - already implemented
- Existing voice receive/decode path handles playback automatically
- Consider adding `/etman stop` to cancel currently playing sound
