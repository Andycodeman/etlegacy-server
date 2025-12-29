# Sound Clip Editor Feature - Implementation Plan

## Overview
Transform the ETPanel sound upload flow to include an interactive clip editor that allows users to select a 30-second (or less) portion of an uploaded MP3 before saving.

## Current State
- **Upload Methods**: Direct file upload or URL import
- **Processing**: No trimming - entire MP3 is saved as-is
- **Storage**: `/home/andy/etlegacy/sounds/` with UUID filenames
- **Limitations**: 2MB max file size, MP3 only

## Target State
1. Upload/download MP3 to **temp storage** (cleared every 24h)
2. Show **clip editor modal** with:
   - Visual timeline with optional waveform
   - Draggable 30-second selection region
   - Resize handles for start/end points
   - Full playback button
   - Selection-only playback button
   - Duration display
3. On save:
   - Server clips MP3 at selected points
   - Converts to ET-compatible format (22050 Hz mono)
   - Saves final clip to permanent storage
   - Creates database records

---

## Implementation Phases

### Phase 1: Backend - Temp Storage & Processing Infrastructure ⬜
**Files to modify:**
- `backend/src/routes/sounds.ts`
- `backend/src/config.ts`

**Tasks:**
- [ ] Add `SOUNDS_TEMP_DIR` config (default: `/home/andy/etlegacy/sounds/temp`)
- [ ] Create temp upload endpoint: `POST /api/sounds/upload-temp`
- [ ] Create temp URL import endpoint: `POST /api/sounds/import-url-temp`
- [ ] Return temp file ID, duration, and stream URL
- [ ] Add cleanup cron job for files older than 24 hours
- [ ] Add temp file streaming endpoint: `GET /api/sounds/temp/:tempId`

### Phase 2: Backend - Audio Processing ⬜
**Dependencies:** FFmpeg must be installed on server

**Files to create/modify:**
- `backend/src/utils/audio.ts` (new)
- `backend/src/routes/sounds.ts`

**Tasks:**
- [ ] Install ffprobe/ffmpeg dependencies
- [ ] Create `getAudioDuration()` using ffprobe for accurate duration
- [ ] Create `generateWaveform()` to return peak data for visualization
- [ ] Create `clipAudio()` function:
  - Input: temp file path, start time, end time
  - Output: clipped MP3 at 22050 Hz mono (ET-compatible)
- [ ] Add clip save endpoint: `POST /api/sounds/save-clip`
  - Accepts: tempId, alias, startTime, endTime, isPublic
  - Clips audio, moves to permanent storage, creates DB records

### Phase 3: Frontend - Upload Modal Refactor ⬜
**Files to modify:**
- `frontend/src/pages/MySounds.tsx`
- `frontend/src/api/client.ts`

**Tasks:**
- [ ] Add `uploadToTemp()` API function
- [ ] Add `importUrlToTemp()` API function
- [ ] Add `saveClip()` API function
- [ ] Add `getTempStream()` API function
- [ ] Modify upload modal to transition to editor mode after temp upload

### Phase 4: Frontend - Clip Editor Component ⬜
**Files to create:**
- `frontend/src/components/SoundClipEditor.tsx`
- `frontend/src/components/WaveformDisplay.tsx` (optional)

**Tasks:**
- [ ] Create timeline component with:
  - Total duration bar
  - Draggable selection region (max 30 sec)
  - Left/right resize handles
  - Time markers and current selection display
- [ ] Implement drag logic:
  - Center drag: move entire selection
  - Edge drag: resize selection (min 1 sec, max 30 sec)
  - Auto-constrain to audio bounds
- [ ] Add playback controls:
  - Play full audio button
  - Play selection only button
  - Stop button
- [ ] Add visual feedback:
  - Current playback position indicator
  - Selection time display (start - end, duration)
- [ ] Add waveform visualization (optional enhancement)

### Phase 5: Frontend - Save Flow ⬜
**Files to modify:**
- `frontend/src/components/SoundClipEditor.tsx`
- `frontend/src/pages/MySounds.tsx`

**Tasks:**
- [ ] Add alias input field in editor
- [ ] Add "Make Public" checkbox
- [ ] Add Save button that calls backend clip endpoint
- [ ] Show processing indicator during clip creation
- [ ] Handle success: close modal, refresh sound list
- [ ] Handle errors: display message, allow retry

### Phase 6: Testing & Polish ⬜
**Tasks:**
- [ ] Test with various MP3 lengths (5 sec, 30 sec, 5 min, 1 hour)
- [ ] Test with different bitrates and sample rates
- [ ] Test mobile/touch interactions
- [ ] Test keyboard accessibility
- [ ] Verify temp file cleanup works
- [ ] Verify clipped audio plays correctly in-game
- [ ] Performance testing for large files

---

## Technical Details

### Audio Processing (FFmpeg)
```bash
# Get accurate duration
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp3

# Generate waveform peaks (for visualization)
ffmpeg -i input.mp3 -filter_complex "aformat=channel_layouts=mono,compand,showwavespic=s=800x100:colors=white" -frames:v 1 waveform.png

# Clip and convert for ET (22050 Hz mono)
ffmpeg -i input.mp3 -ss START -to END -ar 22050 -ac 1 -b:a 128k output.mp3
```

### Temp File Structure
```
/home/andy/etlegacy/sounds/temp/
├── abc123.mp3           # Temp upload (TTL: 24h)
├── def456.mp3
└── .cleanup_marker      # Tracks last cleanup time
```

### API Endpoints (New)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sounds/upload-temp` | POST | Upload MP3 to temp storage |
| `/api/sounds/import-url-temp` | POST | Download URL MP3 to temp storage |
| `/api/sounds/temp/:tempId` | GET | Stream temp file |
| `/api/sounds/temp/:tempId/waveform` | GET | Get waveform data |
| `/api/sounds/save-clip` | POST | Clip temp file and save permanently |

### Database Changes
**No schema changes required** - existing tables work as-is.

### Frontend State Machine
```
[Initial] → [Uploading] → [Editing] → [Saving] → [Complete]
     ↑          ↓            ↓           ↓
     └──────────┴────────────┴───────────┴─→ [Error]
```

---

## Progress Tracking

### Session 1 (Dec 29, 2024)
- [x] Explored codebase and documented current implementation
- [x] Created this implementation plan
- [x] Phase 1: Backend temp storage infrastructure
  - Added SOUNDS_TEMP_DIR config
  - Created temp upload endpoints (upload-temp, import-url-temp)
  - Added temp file streaming endpoint
  - Added temp file cleanup endpoint
- [x] Phase 2: Backend audio processing utilities
  - Created `utils/audio.ts` with FFmpeg integration
  - `getAudioDuration()` - accurate duration via ffprobe
  - `generateWaveformPeaks()` - waveform data for visualization
  - `clipAndConvertAudio()` - clips and converts to ET format (22050Hz mono)
  - `cleanupTempFiles()` - removes files older than 24 hours
- [x] Phase 3: Frontend API client updates
  - Added `uploadFileToTemp()`, `importFromUrlToTemp()`
  - Added `getWaveform()`, `saveClip()`, `deleteTempFile()`
  - Added TypeScript interfaces for new responses
- [x] Phase 4: Clip editor component
  - Created `SoundClipEditor.tsx` with:
    - Visual waveform timeline
    - Draggable selection region (max 30 seconds)
    - Resize handles for start/end
    - Full playback and selection-only playback
    - Alias input and public checkbox
- [x] Phase 5: MySounds page integration
  - Modified upload modal to use new temp upload flow
  - Added clip editor mode after upload
  - Handles save with clipping on backend

### Remaining
- [ ] Phase 6: Testing and polish
  - Test with various MP3 lengths
  - Test mobile/touch interactions
  - Verify in-game playback
  - Deploy and test on VPS

---

## Dependencies to Install

### Backend (Node.js)
```bash
# FFmpeg must be available on system
sudo apt install ffmpeg

# No new npm packages needed - will use child_process to call ffmpeg
```

### Frontend
```bash
# For waveform visualization (optional)
npm install wavesurfer.js
# OR build custom canvas-based waveform
```

---

## Notes & Decisions

1. **Why temp storage?** Allows users to upload large files, preview/edit, without committing to permanent storage. Cleanup prevents disk bloat.

2. **Why 30 seconds max?** Game sound clips should be short. 30 seconds at 22050Hz mono is ~660KB, well under 2MB limit.

3. **Why server-side clipping?** Consistent output format, no client-side ffmpeg needed, can enforce ET-compatible audio settings.

4. **Waveform generation** - Optional but nice UX. Can be skipped initially and added later.

5. **ET Audio Format**: 22050 Hz, mono, 128kbps - this is what the game expects for optimal playback.

---

## Files Reference

### Backend
- `/home/andy/projects/et/etlegacy/etpanel/backend/src/routes/sounds.ts` - Main API routes
- `/home/andy/projects/et/etlegacy/etpanel/backend/src/config.ts` - Environment config
- `/home/andy/projects/et/etlegacy/etpanel/backend/src/db/schema.ts` - Database schema

### Frontend
- `/home/andy/projects/et/etlegacy/etpanel/frontend/src/pages/MySounds.tsx` - Upload modal
- `/home/andy/projects/et/etlegacy/etpanel/frontend/src/api/client.ts` - API client
- `/home/andy/projects/et/etlegacy/etpanel/frontend/src/components/AudioPlayer.tsx` - Existing player

### Server
- Sounds directory: `/home/andy/etlegacy/sounds/`
- Temp directory (new): `/home/andy/etlegacy/sounds/temp/`
