/**
 * @file cg_customsound.h
 * @brief Custom sound playback through voice chat system
 *
 * Allows players to play custom MP3/WAV files through the voice chat system.
 * Sounds are stored locally and transmitted via the voice server.
 *
 * Usage: /customsound filename.mp3
 * Sound folder: ~/.etlegacy/legacy/customsounds/
 */

#ifndef CG_CUSTOMSOUND_H
#define CG_CUSTOMSOUND_H

#include "cg_local.h"

#ifdef FEATURE_VOICE

/*
 * Constants
 */
#define CUSTOMSOUND_MAX_DURATION_SEC  10                    // Max 10 seconds per sound
#define CUSTOMSOUND_MAX_FILESIZE      (2 * 1024 * 1024)     // 2MB max file size
#define CUSTOMSOUND_SAMPLE_RATE       48000                 // Must match voice system
#define CUSTOMSOUND_CHANNELS          1                     // Mono
#define CUSTOMSOUND_FRAME_SAMPLES     960                   // 20ms at 48kHz (matches Opus)

/*
 * Sound playback state
 */
typedef enum
{
	SOUND_STATE_IDLE = 0,       // Not playing anything
	SOUND_STATE_LOADING,        // Loading/decoding file
	SOUND_STATE_PLAYING,        // Transmitting sound
	SOUND_STATE_ERROR           // Error occurred
} customSoundState_t;

/*
 * Sound buffer for transmission
 */
typedef struct
{
	int16_t            *pcmBuffer;      // Decoded PCM data (48kHz mono)
	int                 pcmSamples;     // Total samples in buffer
	int                 pcmPosition;    // Current playback position (sample index)
	customSoundState_t  state;          // Current state
	int                 startTime;      // cg.time when transmission started
	char                filename[256];  // Current filename (for display)
} customSoundBuffer_t;

/*
 * API
 */

/**
 * Initialize the custom sound system.
 * Called from Voice_Init().
 */
void CustomSound_Init(void);

/**
 * Shutdown the custom sound system.
 * Called from Voice_Shutdown().
 */
void CustomSound_Shutdown(void);

/**
 * Start playing a custom sound file.
 * @param filename Sound file name (relative to customsounds folder)
 * @return qtrue on success, qfalse on error
 */
qboolean CustomSound_Play(const char *filename);

/**
 * Stop any currently playing custom sound.
 */
void CustomSound_Stop(void);

/**
 * Check if a custom sound is currently playing.
 * @return qtrue if playing
 */
qboolean CustomSound_IsPlaying(void);

/**
 * Get the next frame of audio for transmission.
 * @param outBuffer Buffer to fill with CUSTOMSOUND_FRAME_SAMPLES samples
 * @return qtrue if data was written, qfalse if no more data
 */
qboolean CustomSound_GetNextFrame(int16_t *outBuffer);

/**
 * Get current sound state for display.
 * @return Current state
 */
customSoundState_t CustomSound_GetState(void);

/**
 * Console command handler for /customsound.
 */
void CustomSound_Cmd_f(void);

#endif /* FEATURE_VOICE */

#endif /* CG_CUSTOMSOUND_H */
