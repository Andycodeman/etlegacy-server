/**
 * @file cg_customsound.c
 * @brief Custom sound playback through voice chat system
 *
 * Allows players to play custom MP3/WAV files through the voice chat system.
 * Uses minimp3 for MP3 decoding and standard WAV parsing.
 */

#include "cg_customsound.h"

#ifdef FEATURE_VOICE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Include minimp3 implementation */
#define MINIMP3_IMPLEMENTATION
#include "../../libs/minimp3/minimp3.h"

/*
 * WAV file header structure
 */
#pragma pack(push, 1)
typedef struct
{
	char     riff[4];           // "RIFF"
	uint32_t fileSize;
	char     wave[4];           // "WAVE"
} wavRiffHeader_t;

typedef struct
{
	char     chunkId[4];        // "fmt " or "data"
	uint32_t chunkSize;
} wavChunkHeader_t;

typedef struct
{
	uint16_t audioFormat;       // 1 = PCM
	uint16_t numChannels;
	uint32_t sampleRate;
	uint32_t byteRate;
	uint16_t blockAlign;
	uint16_t bitsPerSample;
} wavFmtChunk_t;
#pragma pack(pop)

/*
 * Module state
 */
static customSoundBuffer_t soundBuffer;
static mp3dec_t            mp3Decoder;

/*
 * Get the full path to the customsounds folder
 */
static void CustomSound_GetPath(const char *filename, char *outPath, int outSize)
{
	char homePath[MAX_OSPATH];
	char modName[64];

	/* Get home path from ET:Legacy */
	trap_Cvar_VariableStringBuffer("fs_homepath", homePath, sizeof(homePath));

	/* Get mod name (usually "legacy") */
	trap_Cvar_VariableStringBuffer("fs_game", modName, sizeof(modName));
	if (modName[0] == '\0')
	{
		Q_strncpyz(modName, "legacy", sizeof(modName));
	}

	if (homePath[0] == '\0')
	{
		/* Fallback based on platform */
#ifdef _WIN32
		const char *appdata = getenv("APPDATA");
		if (appdata)
		{
			Com_sprintf(homePath, sizeof(homePath), "%s\\ETLegacy", appdata);
		}
		else
		{
			Q_strncpyz(homePath, ".", sizeof(homePath));
		}
#else
		const char *home = getenv("HOME");
		if (home)
		{
			Com_sprintf(homePath, sizeof(homePath), "%s/.etlegacy", home);
		}
		else
		{
			Q_strncpyz(homePath, ".", sizeof(homePath));
		}
#endif
	}

	Com_sprintf(outPath, outSize, "%s/%s/customsounds/%s", homePath, modName, filename);
}

/*
 * Read entire file into buffer using standard C (not trap_FS)
 * Returns allocated buffer, caller must free. Sets *size to file size.
 */
static uint8_t *CustomSound_ReadFile(const char *fullPath, int *size)
{
	FILE    *f;
	uint8_t *buffer;
	long     fileSize;

	f = fopen(fullPath, "rb");
	if (!f)
	{
		CG_Printf("^1CustomSound: Cannot open file: %s\n", fullPath);
		return NULL;
	}

	/* Get file size */
	fseek(f, 0, SEEK_END);
	fileSize = ftell(f);
	fseek(f, 0, SEEK_SET);

	if (fileSize <= 0)
	{
		CG_Printf("^1CustomSound: Empty file: %s\n", fullPath);
		fclose(f);
		return NULL;
	}

	if (fileSize > CUSTOMSOUND_MAX_FILESIZE)
	{
		CG_Printf("^1CustomSound: File too large (max %d KB): %s\n",
		          CUSTOMSOUND_MAX_FILESIZE / 1024, fullPath);
		fclose(f);
		return NULL;
	}

	/* Allocate and read */
	buffer = (uint8_t *)malloc(fileSize);
	if (!buffer)
	{
		CG_Printf("^1CustomSound: Out of memory\n");
		fclose(f);
		return NULL;
	}

	if (fread(buffer, 1, fileSize, f) != (size_t)fileSize)
	{
		CG_Printf("^1CustomSound: Failed to read file: %s\n", fullPath);
		free(buffer);
		fclose(f);
		return NULL;
	}

	fclose(f);
	*size = (int)fileSize;
	return buffer;
}

/*
 * Decode MP3 file to PCM buffer (48kHz mono)
 */
static qboolean CustomSound_DecodeMP3(uint8_t *mp3Data, int mp3Size)
{
	mp3dec_frame_info_t frameInfo;
	int16_t             frameBuffer[MINIMP3_MAX_SAMPLES_PER_FRAME];
	int                 offset     = 0;
	int                 totalSamples = 0;
	int                 maxSamples = CUSTOMSOUND_SAMPLE_RATE * CUSTOMSOUND_MAX_DURATION_SEC;
	int16_t            *pcmBuffer;
	int                 pcmCapacity;

	/* Initial allocation - will grow as needed */
	pcmCapacity = CUSTOMSOUND_SAMPLE_RATE * 5; /* Start with 5 seconds */
	pcmBuffer = (int16_t *)malloc(pcmCapacity * sizeof(int16_t));
	if (!pcmBuffer)
	{
		CG_Printf("^1CustomSound: Out of memory for PCM buffer\n");
		return qfalse;
	}

	/* Decode frame by frame */
	while (offset < mp3Size && totalSamples < maxSamples)
	{
		int samples = mp3dec_decode_frame(&mp3Decoder,
		                                   mp3Data + offset,
		                                   mp3Size - offset,
		                                   frameBuffer,
		                                   &frameInfo);

		if (samples <= 0)
		{
			if (frameInfo.frame_bytes <= 0)
			{
				break; /* End of file or error */
			}
			offset += frameInfo.frame_bytes;
			continue;
		}

		offset += frameInfo.frame_bytes;

		/* Grow buffer if needed */
		if (totalSamples + samples > pcmCapacity)
		{
			pcmCapacity = (totalSamples + samples) * 2;
			if (pcmCapacity > maxSamples)
			{
				pcmCapacity = maxSamples;
			}
			pcmBuffer = (int16_t *)realloc(pcmBuffer, pcmCapacity * sizeof(int16_t));
			if (!pcmBuffer)
			{
				CG_Printf("^1CustomSound: Out of memory (realloc)\n");
				return qfalse;
			}
		}

		/* Convert to mono if stereo */
		if (frameInfo.channels == 2)
		{
			int i;
			for (i = 0; i < samples; i++)
			{
				/* Average L+R channels */
				pcmBuffer[totalSamples + i] = (frameBuffer[i * 2] + frameBuffer[i * 2 + 1]) / 2;
			}
		}
		else
		{
			/* Already mono, copy directly */
			memcpy(pcmBuffer + totalSamples, frameBuffer, samples * sizeof(int16_t));
		}

		totalSamples += samples;

		/* Check if we need to resample */
		/* For now, assume MP3s are close to 48kHz - proper resampling TODO */
	}

	if (totalSamples == 0)
	{
		CG_Printf("^1CustomSound: No audio data decoded from MP3\n");
		free(pcmBuffer);
		return qfalse;
	}

	/* Store in sound buffer */
	if (soundBuffer.pcmBuffer)
	{
		free(soundBuffer.pcmBuffer);
	}

	soundBuffer.pcmBuffer = pcmBuffer;
	soundBuffer.pcmSamples = totalSamples;
	soundBuffer.pcmPosition = 0;

	CG_Printf("^2CustomSound: Decoded MP3: %d samples (%.1f sec)\n",
	          totalSamples, (float)totalSamples / CUSTOMSOUND_SAMPLE_RATE);

	return qtrue;
}

/*
 * Decode WAV file to PCM buffer (48kHz mono)
 */
static qboolean CustomSound_DecodeWAV(uint8_t *wavData, int wavSize)
{
	wavRiffHeader_t  *riff;
	wavChunkHeader_t *chunk;
	wavFmtChunk_t    *fmt = NULL;
	uint8_t          *dataPtr = NULL;
	uint32_t          dataSize = 0;
	int               offset;
	int               totalSamples;
	int               maxSamples = CUSTOMSOUND_SAMPLE_RATE * CUSTOMSOUND_MAX_DURATION_SEC;
	int16_t          *pcmBuffer;

	/* Validate RIFF header */
	if (wavSize < (int)sizeof(wavRiffHeader_t))
	{
		CG_Printf("^1CustomSound: WAV file too small\n");
		return qfalse;
	}

	riff = (wavRiffHeader_t *)wavData;
	if (memcmp(riff->riff, "RIFF", 4) != 0 || memcmp(riff->wave, "WAVE", 4) != 0)
	{
		CG_Printf("^1CustomSound: Not a valid WAV file\n");
		return qfalse;
	}

	/* Parse chunks */
	offset = sizeof(wavRiffHeader_t);
	while (offset < wavSize - (int)sizeof(wavChunkHeader_t))
	{
		chunk = (wavChunkHeader_t *)(wavData + offset);
		offset += sizeof(wavChunkHeader_t);

		if (memcmp(chunk->chunkId, "fmt ", 4) == 0)
		{
			fmt = (wavFmtChunk_t *)(wavData + offset);
		}
		else if (memcmp(chunk->chunkId, "data", 4) == 0)
		{
			dataPtr = wavData + offset;
			dataSize = chunk->chunkSize;
		}

		offset += chunk->chunkSize;
	}

	if (!fmt || !dataPtr || dataSize == 0)
	{
		CG_Printf("^1CustomSound: WAV missing fmt or data chunk\n");
		return qfalse;
	}

	/* Validate format */
	if (fmt->audioFormat != 1)
	{
		CG_Printf("^1CustomSound: WAV must be PCM format (not compressed)\n");
		return qfalse;
	}

	if (fmt->bitsPerSample != 16)
	{
		CG_Printf("^1CustomSound: WAV must be 16-bit (got %d-bit)\n", fmt->bitsPerSample);
		return qfalse;
	}

	/* Calculate samples */
	totalSamples = dataSize / (fmt->numChannels * 2); /* 2 bytes per sample */

	if (totalSamples > maxSamples)
	{
		CG_Printf("^3CustomSound: WAV too long, truncating to %d seconds\n",
		          CUSTOMSOUND_MAX_DURATION_SEC);
		totalSamples = maxSamples;
	}

	/* Allocate PCM buffer */
	pcmBuffer = (int16_t *)malloc(totalSamples * sizeof(int16_t));
	if (!pcmBuffer)
	{
		CG_Printf("^1CustomSound: Out of memory for PCM buffer\n");
		return qfalse;
	}

	/* Convert to mono if needed */
	if (fmt->numChannels == 2)
	{
		int16_t *src = (int16_t *)dataPtr;
		int i;
		for (i = 0; i < totalSamples; i++)
		{
			pcmBuffer[i] = (src[i * 2] + src[i * 2 + 1]) / 2;
		}
	}
	else
	{
		memcpy(pcmBuffer, dataPtr, totalSamples * sizeof(int16_t));
	}

	/* TODO: Resample if not 48kHz */
	if (fmt->sampleRate != CUSTOMSOUND_SAMPLE_RATE)
	{
		CG_Printf("^3CustomSound: Warning - WAV is %d Hz, should be %d Hz (may sound wrong)\n",
		          fmt->sampleRate, CUSTOMSOUND_SAMPLE_RATE);
	}

	/* Store in sound buffer */
	if (soundBuffer.pcmBuffer)
	{
		free(soundBuffer.pcmBuffer);
	}

	soundBuffer.pcmBuffer = pcmBuffer;
	soundBuffer.pcmSamples = totalSamples;
	soundBuffer.pcmPosition = 0;

	CG_Printf("^2CustomSound: Decoded WAV: %d samples (%.1f sec), %d Hz, %d ch\n",
	          totalSamples, (float)totalSamples / CUSTOMSOUND_SAMPLE_RATE,
	          fmt->sampleRate, fmt->numChannels);

	return qtrue;
}

/*
 * Public API implementation
 */

void CustomSound_Init(void)
{
	Com_Memset(&soundBuffer, 0, sizeof(soundBuffer));
	mp3dec_init(&mp3Decoder);
	CG_Printf("^2CustomSound: Initialized\n");
}

void CustomSound_Shutdown(void)
{
	if (soundBuffer.pcmBuffer)
	{
		free(soundBuffer.pcmBuffer);
		soundBuffer.pcmBuffer = NULL;
	}
	Com_Memset(&soundBuffer, 0, sizeof(soundBuffer));
}

qboolean CustomSound_Play(const char *filename)
{
	char     fullPath[MAX_OSPATH];
	uint8_t *fileData;
	int      fileSize;
	qboolean isMP3;
	qboolean success;

	if (!filename || filename[0] == '\0')
	{
		CG_Printf("^1CustomSound: No filename specified\n");
		return qfalse;
	}

	/* Stop any currently playing sound */
	CustomSound_Stop();

	/* Build full path */
	CustomSound_GetPath(filename, fullPath, sizeof(fullPath));

	CG_Printf("^3CustomSound: Loading %s\n", fullPath);

	/* Read file */
	fileData = CustomSound_ReadFile(fullPath, &fileSize);
	if (!fileData)
	{
		soundBuffer.state = SOUND_STATE_ERROR;
		return qfalse;
	}

	/* Determine format and decode */
	soundBuffer.state = SOUND_STATE_LOADING;

	/* Check file extension */
	isMP3 = (Q_stricmpn(filename + strlen(filename) - 4, ".mp3", 4) == 0);

	if (isMP3)
	{
		success = CustomSound_DecodeMP3(fileData, fileSize);
	}
	else
	{
		success = CustomSound_DecodeWAV(fileData, fileSize);
	}

	free(fileData);

	if (!success)
	{
		soundBuffer.state = SOUND_STATE_ERROR;
		return qfalse;
	}

	/* Store filename for display */
	Q_strncpyz(soundBuffer.filename, filename, sizeof(soundBuffer.filename));

	/* Start playing */
	soundBuffer.state = SOUND_STATE_PLAYING;
	soundBuffer.startTime = cg.time;

	CG_Printf("^2CustomSound: Playing %s\n", filename);

	return qtrue;
}

void CustomSound_Stop(void)
{
	if (soundBuffer.state == SOUND_STATE_PLAYING)
	{
		CG_Printf("^3CustomSound: Stopped\n");
	}

	soundBuffer.state = SOUND_STATE_IDLE;
	soundBuffer.pcmPosition = 0;
}

qboolean CustomSound_IsPlaying(void)
{
	return soundBuffer.state == SOUND_STATE_PLAYING &&
	       soundBuffer.pcmPosition < soundBuffer.pcmSamples;
}

qboolean CustomSound_GetNextFrame(int16_t *outBuffer)
{
	int samplesToRead;
	int samplesRemaining;

	if (!CustomSound_IsPlaying() || !soundBuffer.pcmBuffer || !outBuffer)
	{
		return qfalse;
	}

	samplesRemaining = soundBuffer.pcmSamples - soundBuffer.pcmPosition;

	if (samplesRemaining <= 0)
	{
		soundBuffer.state = SOUND_STATE_IDLE;
		CG_Printf("^2CustomSound: Finished playing %s\n", soundBuffer.filename);
		return qfalse;
	}

	samplesToRead = CUSTOMSOUND_FRAME_SAMPLES;
	if (samplesToRead > samplesRemaining)
	{
		samplesToRead = samplesRemaining;
		/* Zero-pad the rest */
		Com_Memset(outBuffer + samplesToRead, 0,
		           (CUSTOMSOUND_FRAME_SAMPLES - samplesToRead) * sizeof(int16_t));
	}

	memcpy(outBuffer, soundBuffer.pcmBuffer + soundBuffer.pcmPosition,
	       samplesToRead * sizeof(int16_t));

	soundBuffer.pcmPosition += samplesToRead;

	return qtrue;
}

customSoundState_t CustomSound_GetState(void)
{
	return soundBuffer.state;
}

void CustomSound_Cmd_f(void)
{
	char filename[256];

	if (trap_Argc() < 2)
	{
		CG_Printf("Usage: customsound <filename>\n");
		CG_Printf("  Plays a sound file from ~/.etlegacy/legacy/customsounds/\n");
		CG_Printf("  Supported formats: MP3, WAV (16-bit PCM)\n");
		CG_Printf("  Max duration: %d seconds\n", CUSTOMSOUND_MAX_DURATION_SEC);
		return;
	}

	trap_Argv(1, filename, sizeof(filename));
	CustomSound_Play(filename);
}

#endif /* FEATURE_VOICE */
