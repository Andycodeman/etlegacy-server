# Voice Chat Implementation - Session Start Prompt

Copy and paste this to start a new Claude Code session:

---

## Prompt

I'm implementing built-in voice chat for my ET:Legacy game server. The implementation plan is in `/home/andy/projects/et/etlegacy/docs/VOICE_CHAT_IMPLEMENTATION.md` - please read it first.

**Key architecture decisions already made:**
- Voice is implemented entirely in cgame.so/.dll (no engine changes)
- Uses PortAudio for mic capture and audio playback (OS handles mixing with game audio)
- Uses libopus for audio compression
- Custom UDP voice server runs on VPS alongside game server (port 27961)
- HUD shows who's talking, settings accessible via game menu

**Project context:**
- ET:Legacy source is in `/home/andy/projects/et/etlegacy/src/`
- We already build cgame/ui modules for Linux x86/x64 and Windows x86/x64
- Build script: `./scripts/build-all.sh`
- Deploy script: `./scripts/publish.sh`
- VPS: 5.78.83.59, game server runs on port 27960

**Current status:** Phase 1 not started. We need to begin with adding PortAudio and libopus to the cgame build system.

Please:
1. Read the implementation plan
2. Check the current cgame CMakeLists.txt to understand the build setup
3. Start with Phase 1: Adding PortAudio and libopus dependencies
4. Update the implementation plan markdown file as we complete tasks (check the boxes)

Let's begin with Phase 1.1 - adding PortAudio to the build system.

---

## Alternative: Start with Standalone Prototype

If you want to validate the approach before modifying the game:

---

I'm implementing built-in voice chat for my ET:Legacy game server. Before integrating into the game, I want to build a standalone proof-of-concept that:

1. Captures audio from mic using PortAudio
2. Encodes with Opus
3. Sends over UDP to a simple echo server
4. Receives back
5. Decodes and plays through speakers

This will validate that PortAudio + Opus + UDP works before we integrate into cgame.

Create this standalone test in `/home/andy/projects/et/etlegacy/voice-test/`:
- `voice-test/client.c` - Capture → Encode → Send/Receive → Decode → Play
- `voice-test/server.c` - Simple UDP echo server
- `voice-test/CMakeLists.txt` - Build both

The full implementation plan is in `/home/andy/projects/et/etlegacy/docs/VOICE_CHAT_IMPLEMENTATION.md` for context.

---

## Quick Reference

**Key files:**
- Implementation plan: `/home/andy/projects/et/etlegacy/docs/VOICE_CHAT_IMPLEMENTATION.md`
- cgame source: `/home/andy/projects/et/etlegacy/src/src/cgame/`
- Main build file: `/home/andy/projects/et/etlegacy/src/CMakeLists.txt`
- cgame build: `/home/andy/projects/et/etlegacy/src/src/cgame/CMakeLists.txt`

**Libraries needed:**
- PortAudio v19.7.0+ (audio I/O)
- libopus v1.3.1+ (audio codec)

**Build targets:**
- `cgame.mp.x86_64.so` (Linux 64-bit)
- `cgame.mp.i386.so` (Linux 32-bit)
- `cgame_mp_x64.dll` (Windows 64-bit)
- `cgame_mp_x86.dll` (Windows 32-bit)
