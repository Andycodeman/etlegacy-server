# Custom Sound Playback Feature Plan

## Overview
Allow players to play custom sound files (WAV/MP3) through the voice chat system. Sounds are stored locally on each client and transmitted via the voice server to all connected players.

## User Experience
```
/customsound airhorn.mp3    - Plays airhorn.mp3 to all players
/customsound funny/wow.wav  - Supports subdirectories
```

**Sound folder location:** `~/.etlegacy/legacy/customsounds/`

## Rate Limiting
- **Combined with voice chat**: 30 seconds total per minute (voice + sounds)
- Already tracked on both client and server
- Custom sounds count against the same limit

## Technical Architecture

### Packet Flow
```
1. User: /customsound airhorn.mp3
2. Client: Read file from customsounds folder
3. Client: Decode MP3/WAV → PCM (48kHz mono)
4. Client: Encode PCM → Opus (20ms frames)
5. Client: Send packets with VOICE_CHAN_SOUND channel type
6. Server: Relay to all clients (like VOICE_CHAN_ALL)
7. Clients: Decode Opus → Play through voice system
```

### New Constants
```c
#define VOICE_CHAN_SOUND    3    // New channel type for custom sounds
#define SOUND_MAX_DURATION  10   // Max 10 seconds per sound
#define SOUND_MAX_FILESIZE  (2 * 1024 * 1024)  // 2MB max file size
```

---

## Implementation Tasks

### Phase 1: Client Command & File Reading
- [ ] **1.1** Add `/customsound` command in `cg_consolecmds.c`
- [ ] **1.2** Create `cg_customsound.c` / `cg_customsound.h` files
- [ ] **1.3** Implement file path resolution (`~/.etlegacy/legacy/customsounds/`)
- [ ] **1.4** Implement file reading with standard C `fopen()` (not trap_FS)
- [ ] **1.5** Add file size validation (max 2MB)

### Phase 2: Audio Decoding
- [ ] **2.1** Add minimp3 header library to `src/libs/` or inline
- [ ] **2.2** Implement MP3 decoding → PCM buffer
- [ ] **2.3** Implement WAV parsing → PCM buffer
- [ ] **2.4** Implement resampling to 48kHz mono if needed
- [ ] **2.5** Validate duration (max 10 seconds)

### Phase 3: Encoding & Transmission
- [ ] **3.1** Add VOICE_CHAN_SOUND constant to `cg_voice.h`
- [ ] **3.2** Create sound queue/state in voice module
- [ ] **3.3** Chunk PCM into 20ms frames (960 samples)
- [ ] **3.4** Encode chunks with Opus encoder
- [ ] **3.5** Send via voice socket with VOICE_CHAN_SOUND channel
- [ ] **3.6** Integrate with existing rate limit tracking

### Phase 4: Server Routing
- [ ] **4.1** Add VOICE_CHAN_SOUND handling in `voice-server/main.c`
- [ ] **4.2** Route SOUND packets to all clients (like VOICE_CHAN_ALL)
- [ ] **4.3** Apply same rate limiting as voice

### Phase 5: Polish & Testing
- [ ] **5.1** Add user feedback (console messages for success/errors)
- [ ] **5.2** Handle edge cases (file not found, invalid format, etc.)
- [ ] **5.3** Test with various MP3/WAV files
- [ ] **5.4** Update memory/documentation

---

## File Changes Summary

| File | Changes |
|------|---------|
| `cg_consolecmds.c` | Add `/customsound` command registration |
| `cg_customsound.c` | **NEW** - Main implementation |
| `cg_customsound.h` | **NEW** - Header file |
| `cg_voice.c` | Add sound queue, chunking, transmission |
| `cg_voice.h` | Add VOICE_CHAN_SOUND, sound state |
| `voice-server/main.c` | Handle VOICE_CHAN_SOUND routing |
| `src/libs/minimp3.h` | **NEW** - MP3 decoder (header-only) |
| `CMakeLists.txt` | Add new source files |

---

## Key Code Snippets

### minimp3 Usage (header-only, simple)
```c
#define MINIMP3_IMPLEMENTATION
#include "minimp3.h"

mp3dec_t mp3d;
mp3dec_init(&mp3d);

mp3dec_frame_info_t info;
short pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];
int samples = mp3dec_decode_frame(&mp3d, mp3_data, mp3_size, pcm, &info);
```

### WAV Header Parsing
```c
typedef struct {
    char     riff[4];        // "RIFF"
    uint32_t fileSize;
    char     wave[4];        // "WAVE"
    char     fmt[4];         // "fmt "
    uint32_t fmtSize;
    uint16_t audioFormat;    // 1 = PCM
    uint16_t numChannels;
    uint32_t sampleRate;
    uint32_t byteRate;
    uint16_t blockAlign;
    uint16_t bitsPerSample;
    char     data[4];        // "data"
    uint32_t dataSize;
} WavHeader;
```

### Sound State in Voice Module
```c
typedef struct {
    qboolean  active;           // Currently playing a sound?
    int16_t  *pcmBuffer;        // Decoded audio data
    int       pcmSamples;       // Total samples
    int       pcmPosition;      // Current playback position
    int       startTime;        // When we started sending
} voiceSoundState_t;
```

---

## Progress Log

| Date | Task | Status |
|------|------|--------|
| | | |

---

## Notes
- minimp3: https://github.com/lieff/minimp3 (public domain, header-only)
- Opus already included in ET:Legacy build
- Sound files are NOT synced between players - each plays their own local copy
- If recipient doesn't have the sound file, they just hear the sender's audio
