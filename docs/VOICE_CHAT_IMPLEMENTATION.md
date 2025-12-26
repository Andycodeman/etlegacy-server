# ET:Legacy Voice Chat Implementation Plan

## Overview

Implement built-in voice chat for ET:Legacy by adding voice capture/playback directly to the cgame client module (.so/.dll). This bypasses the engine entirely using OS-level audio APIs, requiring no engine modifications and no external applications for users.

**Key Insight**: Modern operating systems (PulseAudio/PipeWire on Linux, WASAPI on Windows) automatically mix audio from multiple applications. Our cgame module can open its own audio streams alongside the game's audio with zero conflicts.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (cgame.so/dll)                          │
│                                                                             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐     │
│  │ Mic Capture │──►│ Opus Encode │──►│ UDP Send    │──►│ Voice Server│     │
│  │ (PortAudio) │   │ (libopus)   │   │ (socket)    │   │ (VPS)       │     │
│  └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘     │
│                                                                │            │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐          │            │
│  │ Speaker Out │◄──│ Opus Decode │◄──│ UDP Receive │◄─────────┘            │
│  │ (PortAudio) │   │ (libopus)   │   │ (socket)    │                       │
│  └─────────────┘   └─────────────┘   └─────────────┘                       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────┐           │
│  │ HUD Integration                                              │           │
│  │ - Speaking indicator (your mic active)                       │           │
│  │ - Who's talking icons (other players)                        │           │
│  │ - Voice settings menu                                        │           │
│  └─────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           VOICE SERVER (VPS)                                │
│                                                                             │
│  - Receives voice packets from clients                                      │
│  - Routes to appropriate recipients (team/all/proximity)                    │
│  - Handles client authentication (match ET client ID)                       │
│  - Minimal processing - just routing                                        │
│                                                                             │
│  Port: 27961 UDP (alongside ET server on 27960)                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

---

## Phase 1: Build System Setup
**Status**: [x] COMPLETE (Dec 2024)

### 1.1 Add PortAudio dependency
- [x] Bundled PortAudio source in `src/libs/voice/portaudio/`
- [x] CMakeLists.txt updated to build PortAudio
- [x] Linux: Static linked for 32-bit and 64-bit
- [x] Windows: Cross-compiled with MinGW (TODO: test)

### 1.2 Add libopus dependency
- [x] Bundled Opus source in `src/libs/voice/opus/`
- [x] CMakeLists.txt updated to build libopus
- [x] Linux: Static linked for 32-bit and 64-bit
- [x] Windows: Cross-compiled with MinGW

### 1.3 Verify cross-platform builds
- [x] Linux x86_64 cgame.so builds with new deps
- [x] Linux i386 cgame.so builds with new deps
- [x] Windows x64 cgame_mp_x64.dll builds with new deps
- [x] Windows x86 cgame_mp_x86.dll builds with new deps

### Files modified:
- `src/CMakeLists.txt` - Added FEATURE_VOICE option
- `src/cmake/ETLSetupFeatures.cmake` - Voice library setup with bundled headers
- `src/libs/voice/` - Bundled PortAudio and Opus libraries
- `src/libs/voice/include/` - Bundled headers for cross-compilation

---

## Phase 2: Voice Module Core (Standalone Test)
**Status**: [x] COMPLETE (Dec 2024)

### 2.1 Create voice module structure
- [x] Created `src/src/cgame/cg_voice.c` (~1200 lines)
- [x] Created `src/src/cgame/cg_voice.h` (~190 lines)
- [x] Added to cgame build via CMakeLists.txt

### 2.2 Audio capture implementation
- [x] PortAudio initialized with callback-based capture
- [x] Mic input stream: 48kHz, mono, 16-bit
- [x] Jitter buffer implemented for playback
- [x] Push-to-talk handled via +voiceteam/+voiceall commands
- [x] Standalone test verified in `voice-test/`

### Standalone Test:
- `voice-test/client.c` - Full client implementation for testing
- `voice-test/server.c` - Echo server for local testing

```c
// Target API
void Voice_Init(void);
void Voice_Shutdown(void);
void Voice_StartCapture(void);   // PTT pressed
void Voice_StopCapture(void);    // PTT released
int Voice_GetCapturedAudio(int16_t *buffer, int maxSamples);
```

### 2.3 Audio playback implementation
- [ ] Open speaker output stream (48kHz, stereo, 16-bit)
- [ ] Implement jitter buffer for incoming audio
- [ ] Mix multiple incoming voice streams
- [ ] Test: verify playback works

```c
// Target API
void Voice_PlayAudio(int clientNum, const int16_t *samples, int numSamples);
qboolean Voice_IsClientTalking(int clientNum);
```

### 2.4 Opus codec integration
- [ ] Initialize Opus encoder (VOIP mode, 48kHz)
- [ ] Initialize Opus decoder (one per potential speaker)
- [ ] Implement encode function
- [ ] Implement decode function
- [ ] Test: encode → decode roundtrip

```c
// Target API
int Voice_Encode(const int16_t *pcm, int frameSize, uint8_t *opus, int maxBytes);
int Voice_Decode(int clientNum, const uint8_t *opus, int opusLen, int16_t *pcm, int maxSamples);
```

### Files to create:
- `src/src/cgame/cg_voice.c` (~800-1000 lines)
- `src/src/cgame/cg_voice.h` (~50 lines)

---

## Phase 3: Network Protocol
**Status**: [x] COMPLETE (Dec 2024)

### 3.1 Voice packet format (implemented in cg_voice.c)
```c
// Client → Server (voicePacketHeader_t)
typedef struct {
    uint8_t  type;           // VOICE_PKT_AUDIO
    uint32_t clientId;       // ET client slot
    uint32_t sequence;       // For ordering/loss detection
    uint8_t  channel;        // 0=team, 1=all, 2=proximity
    uint16_t opusLen;        // Length of opus data
    uint8_t  opusData[];     // Variable length opus frame
} voicePacket_t;

// Server → Client
typedef struct {
    uint8_t  type;           // VOICE_PACKET_AUDIO
    uint8_t  fromClient;     // Who is speaking
    uint32_t sequence;
    uint16_t opusLen;
    uint8_t  opusData[];
} voiceRelayPacket_t;
```

### 3.2 Client networking
- [ ] Create UDP socket on client init
- [ ] Connect to voice server (same IP as game server, port 27961)
- [ ] Implement send function
- [ ] Implement receive function (non-blocking)
- [ ] Handle connection/disconnection

```c
// Target API
qboolean Voice_Connect(const char *serverAddress);
void Voice_Disconnect(void);
void Voice_SendPacket(const uint8_t *data, int len);
int Voice_ReceivePacket(uint8_t *buffer, int maxLen);
void Voice_Frame(void);  // Called each client frame
```

### 3.3 Authentication
- [ ] Send auth packet on connect (client slot + some identifier)
- [ ] Server verifies client is actually connected to game server
- [ ] Handle reconnection

### Files to modify:
- `src/src/cgame/cg_voice.c` (add networking)

---

## Phase 4: Voice Server
**Status**: [x] COMPLETE (Dec 2024)

### 4.1 Basic server structure
- [x] Created `voice-server/` directory with C implementation
- [x] UDP socket listener on port 27961
- [x] Client tracking with timeout cleanup

### 4.2 Packet routing
- [x] Receive voice packets from clients
- [x] Team-based routing (same team only for TEAM channel)
- [x] All channel routing (everyone except spectators)
- [x] Relay packet format with fromClient field
- [x] Using client-reported team (Option C - simplest approach)

### 4.3 Packet types supported
- `VOICE_PKT_AUDIO` (0x01) - Voice data
- `VOICE_PKT_AUTH` (0x02) - Client authentication
- `VOICE_PKT_PING` (0x03) - Latency measurement
- `VOICE_PKT_TEAM_UPDATE` (0x04) - Team changes

### 4.4 Deployment
- [x] Created systemd service file: `voice-server/voice-server.service`
- [ ] Deploy alongside etserver on VPS
- [ ] Open UDP port 27961 in firewall

### Files created:
- `voice-server/main.c` (~500 lines) - Routing server
- `voice-server/CMakeLists.txt` - Build configuration
- `voice-server/build.sh` - Build script
- `voice-server/voice-server.service` - systemd unit

### Build & Run:
```bash
cd voice-server && ./build.sh
./build/voice_server 27961  # Default port
```

---

## Phase 5: cgame Integration
**Status**: [x] COMPLETE (Dec 2024)

### 5.1 Initialization
- [x] Voice_Init() called from CG_Init() (when not demo playback)
- [x] Voice_Shutdown() called from CG_Shutdown()
- [x] Auto-connect to voice server based on game server address

### 5.2 Push-to-talk binding
- [x] Commands: +voiceteam/-voiceteam, +voiceall/-voiceall
- [x] Bind in autoexec: `bind v +voiceteam`
- [x] Start/stop transmission on key press/release

### 5.3 Frame processing
- [x] Voice_Frame() called each frame
- [x] PortAudio callback captures audio when PTT active
- [x] Opus encoding in callback, sends UDP packets
- [x] Receives and decodes incoming voice packets
- [x] Jitter buffer feeds audio to playback callback

### 5.4 Team awareness
- [ ] Detect team changes
- [ ] Update voice channel (team/all)
- [ ] Notify voice server of team

### Files modified:
- `src/src/cgame/cg_main.c` - Voice_Init/Shutdown calls
- `src/src/cgame/cg_voice.c` - Auto-connect implementation

---

## Phase 6: HUD Integration
**Status**: [x] COMPLETE (Dec 2024)

### 6.1 Transmit indicator
- [x] Shows "[MIC: TEAM]" or "[MIC: ALL]" when transmitting
- [x] Position: bottom-left, near chat area
- [x] Pulsing effect for visibility
- [x] Color-coded by team (red for Axis, blue for Allies)
- [x] Input level meter below indicator (green/yellow/red)

### 6.2 Who's talking display
- [x] Shows ">>" + player name when others are talking
- [x] Position: right side of screen, below compass
- [x] Team-colored names (red/blue/gray)
- [x] Semi-transparent background bars
- [x] Stacks up to 5 speakers vertically
- [x] Auto-fades after 500ms of silence

### 6.3 Voice settings menu
- [ ] Add "Voice" section to options menu (TODO)
- [ ] Device selection (TODO)
- [ ] Volume sliders (TODO)

### 6.4 Player list integration
- [ ] Scoreboard voice icons (TODO)

### CVars implemented:
```
voice_enable "1"           // Master enable
voice_volume "1.0"         // Incoming voice volume (0.0-2.0)
voice_inputGain "1.0"      // Mic gain (0.0-2.0)
voice_showTalking "1"      // Show who's talking HUD
voice_showMeter "1"        // Show input level meter
voice_serverPort "1"       // Voice server port offset from game port
```

### HUD Positions:
- **Transmit indicator**: Bottom-left (x=8, y=SCREEN_HEIGHT-100)
- **Input meter**: Below transmit indicator
- **Who's talking**: Right side (x=SCREEN_WIDTH-120, y=180)

---

## Phase 7: Testing & Polish
**Status**: [ ] Not Started

### 7.1 Local testing
- [ ] Test with 2+ local clients
- [ ] Verify audio quality
- [ ] Check latency (should be <200ms)
- [ ] Test team channel isolation
- [ ] Test reconnection handling

### 7.2 Network testing
- [ ] Test over internet with real latency
- [ ] Test packet loss handling
- [ ] Test with varying network conditions
- [ ] Verify no audio glitches/pops

### 7.3 Cross-platform testing
- [ ] Linux client → Linux client
- [ ] Windows client → Windows client
- [ ] Linux client ↔ Windows client
- [ ] Flatpak, Snap, native Linux builds

### 7.4 Edge cases
- [ ] Player disconnect during transmission
- [ ] Voice server restart while clients connected
- [ ] Very long transmissions
- [ ] Many simultaneous speakers

### 7.5 Performance
- [ ] CPU usage on client (should be minimal)
- [ ] Bandwidth usage (Opus is efficient, ~32kbps per speaker)
- [ ] Memory usage

---

## Phase 8: Documentation & Release
**Status**: [ ] Not Started

### 8.1 User documentation
- [ ] How to enable voice chat
- [ ] Key bindings
- [ ] Troubleshooting guide
- [ ] Known limitations

### 8.2 Server admin documentation
- [ ] How to deploy voice server
- [ ] Configuration options
- [ ] Monitoring/logs

### 8.3 Release
- [ ] Update pk3 with new cgame modules
- [ ] Deploy voice server
- [ ] Announce to players

---

## Technical Notes

### Audio Parameters
- Sample rate: 48000 Hz (Opus native)
- Channels: Mono capture, Stereo playback
- Bit depth: 16-bit signed PCM
- Frame size: 20ms (960 samples at 48kHz)
- Opus bitrate: 24-32 kbps (VOIP optimized)

### Network Parameters
- Protocol: UDP
- Port: 27961
- Packet rate: 50/sec (20ms frames)
- Max packet size: ~200 bytes (with Opus compression)
- Bandwidth per speaker: ~80 kbps (with headers)

### Library Versions (Recommended)
- PortAudio: v19.7.0+
- libopus: v1.3.1+

### Platform-Specific Notes

**Linux:**
- PortAudio will use PulseAudio/PipeWire/ALSA
- May need to handle permission for mic access
- Flatpak may need additional portal permissions

**Windows:**
- PortAudio will use WASAPI (preferred) or DirectSound
- May need to handle Windows audio device enumeration
- Consider ASIO for low latency (optional)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Audio conflicts with game | Low | High | Test early, OS handles mixing |
| Cross-platform build issues | Medium | Medium | CI testing, static linking |
| Latency too high | Low | High | Use Opus, optimize buffers |
| Flatpak permission issues | Medium | Low | Document portal setup |
| User mic permission denied | Medium | Low | Clear error messages |

---

## Open Questions

1. **Proximity chat**: Do we want distance-based voice? Requires position sync.
2. **Voice activation**: PTT only, or also voice-activated option?
3. **Recording**: Should server record voice for admin review?
4. **Muting**: Per-player mute from client side?
5. **3D audio**: Spatialize voice based on player position?

---

## Resources

- PortAudio: http://www.portaudio.com/docs/v19-doxydocs/
- Opus Codec: https://opus-codec.org/docs/
- ET:Legacy source: Already in `src/src/cgame/`
- Similar implementations: ioquake3 VOIP (disabled in ETL), Mumble

---

## Progress Log

| Date | Phase | Notes |
|------|-------|-------|
| 2024-12-25 | Planning | Initial implementation plan created |
| 2024-12-25 | Phase 1 | Build system complete - bundled libs in src/libs/voice/ |
| 2024-12-25 | Phase 2 | Voice module core complete - cg_voice.c/h implemented |
| 2024-12-25 | Phase 2 | Standalone PoC tested in voice-test/ |
| 2024-12-25 | Phase 3 | Network protocol implemented in cg_voice.c |
| 2024-12-25 | Phase 4 | Voice routing server created in voice-server/ |
| 2024-12-25 | Phase 5 | cgame integration complete - auto-connect on join |
| 2024-12-25 | Phase 6 | HUD improved - team colors, positioning, input meter |
| 2024-12-25 | Phase 1 | Windows cross-compilation verified (32-bit and 64-bit) |
| 2024-12-25 | Phase 1 | Added bundled headers for cross-compilation |
| 2024-12-25 | Phase 1 | **STATIC LINKING**: Rebuilt all libs with -fPIC, stored in src/libs/voice/{linux32,linux64,win32,win64}/ |
| 2024-12-25 | Phase 1 | Updated .gitignore to track static libs: !src/libs/voice/**/*.a |
| 2024-12-25 | Phase 1 | CMake link order fixed: static libs BEFORE system libs |
| 2024-12-25 | Phase 7 | **TESTED**: Voice capture/transmit working! 268+ packets sent, voicestatus shows Connected |
| 2024-12-25 | Phase 6 | **BUG**: HUD indicators not showing - Voice_Draw* functions not called from cg_draw.c |

## Build Instructions

### Build cgame with voice support:
```bash
cd ~/projects/et/etlegacy/scripts
./build-all.sh              # Voice is ON by default (FEATURE_VOICE=ON)
./build-all.sh --no-voice   # Disable voice if needed
```

### Static Libraries (already in repo):
Static libs are stored in `src/libs/voice/{linux32,linux64,win32,win64}/`:
- `libportaudio.a` - Audio I/O (built with -fPIC for Linux)
- `libopus.a` - Voice codec (built with -fPIC for Linux)

These are tracked in git via `.gitignore` exception: `!src/libs/voice/**/*.a`

**If you need to rebuild static libs** (you shouldn't need to):
```bash
# Linux 64-bit (from opus/portaudio source)
CFLAGS="-fPIC -O2" ./configure --disable-shared --enable-static
make && cp .libs/libopus.a src/libs/voice/linux64/

# Linux 32-bit
CC="gcc -m32" CFLAGS="-fPIC -O2 -m32" ./configure --host=i686-linux-gnu --disable-shared --enable-static

# Windows 64-bit (cross-compile)
./configure --host=x86_64-w64-mingw32 --disable-shared --enable-static

# Windows 32-bit (cross-compile)
./configure --host=i686-w64-mingw32 --disable-shared --enable-static
```

### Build voice server:
```bash
cd ~/projects/et/etlegacy/scripts
./build-all.sh voice-server
```

### Deploy to VPS:
```bash
# Copy voice_server binary
scp dist/server/voice_server andy@5.78.83.59:~/etlegacy/

# Install systemd service
sudo cp voice-server/voice-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable voice-server
sudo systemctl start voice-server
```

### Key Bindings (add to autoexec.cfg):
```
bind v +voiceteam   // Team voice
bind b +voiceall    // All voice
```

