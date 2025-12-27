/**
 * @file cg_voice.h
 * @brief Built-in voice chat for ET:Legacy
 *
 * Provides push-to-talk voice communication using PortAudio for
 * cross-platform audio I/O and Opus for efficient voice compression.
 *
 * Supports:
 * - Team voice chat (only teammates hear)
 * - All voice chat (everyone hears)
 * - Configurable PTT keybinds
 * - Per-player muting
 * - HUD indicators for who's talking
 */

#ifndef CG_VOICE_H
#define CG_VOICE_H

#include "cg_local.h"

/*
 * Voice channel types
 */
typedef enum
{
	VOICE_CHAN_NONE  = 0,
	VOICE_CHAN_TEAM  = 1,   // Team-only voice
	VOICE_CHAN_ALL   = 2,   // Global voice
	VOICE_CHAN_SOUND = 3,   // Custom sound playback (sent to all, like VOICE_CHAN_ALL)
	VOICE_CHAN_MAX
} voiceChannel_t;

/*
 * Voice module state
 */
typedef enum
{
	VOICE_STATE_DISABLED = 0,   // Voice disabled or failed to init
	VOICE_STATE_IDLE,           // Ready but not transmitting
	VOICE_STATE_TRANSMITTING,   // PTT active, sending voice
	VOICE_STATE_CONNECTING,     // Connecting to voice server
	VOICE_STATE_ERROR           // Error state
} voiceState_t;

/*
 * Per-client voice info (for HUD display)
 */
typedef struct
{
	qboolean       talking;           // Currently transmitting
	int            talkingTime;       // When they started talking (cg.time)
	int            lastPacketTime;    // Last packet received
	qboolean       muted;             // Locally muted by user
	voiceChannel_t channel;           // Channel they're speaking on (team/all)
} voiceClientInfo_t;

/*
 * Main voice module API
 */

/**
 * Initialize the voice chat system.
 * Called from CG_Init(). Safe to call if voice is disabled.
 * @return qtrue on success, qfalse on failure
 */
qboolean Voice_Init(void);

/**
 * Shutdown the voice chat system.
 * Called from CG_Shutdown(). Safe to call multiple times.
 */
void Voice_Shutdown(void);

/**
 * Per-frame voice processing.
 * Called from CG_DrawActiveFrame(). Handles:
 * - Audio capture when PTT active
 * - Encoding and sending voice packets
 * - Receiving and decoding incoming voice
 * - Playing received audio
 */
void Voice_Frame(void);

/**
 * Start transmitting on a channel (PTT pressed).
 * @param channel VOICE_CHAN_TEAM or VOICE_CHAN_ALL
 */
void Voice_StartTransmit(voiceChannel_t channel);

/**
 * Stop transmitting (PTT released).
 */
void Voice_StopTransmit(void);

/**
 * Check if we are currently transmitting.
 * @return qtrue if transmitting
 */
qboolean Voice_IsTransmitting(void);

/**
 * Get the current voice channel we're transmitting on.
 * @return VOICE_CHAN_NONE if not transmitting
 */
voiceChannel_t Voice_GetTransmitChannel(void);

/**
 * Check if a specific client is currently talking.
 * @param clientNum Client number (0-63)
 * @return qtrue if the client is transmitting voice
 */
qboolean Voice_IsClientTalking(int clientNum);

/**
 * Get voice info for a client (for HUD).
 * @param clientNum Client number
 * @return Pointer to voice info, or NULL if invalid
 */
voiceClientInfo_t *Voice_GetClientInfo(int clientNum);

/**
 * Toggle mute for a specific client.
 * @param clientNum Client to mute/unmute
 */
void Voice_ToggleMute(int clientNum);

/**
 * Check if a client is muted.
 * @param clientNum Client number
 * @return qtrue if muted
 */
qboolean Voice_IsClientMuted(int clientNum);

/**
 * Get the current voice state.
 * @return Current state of the voice module
 */
voiceState_t Voice_GetState(void);

/**
 * Connect to voice server.
 * Called automatically when joining a game server.
 * @param serverAddress IP:port of the game server (voice uses port+1)
 * @return qtrue if connection initiated
 */
qboolean Voice_Connect(const char *serverAddress);

/**
 * Disconnect from voice server.
 * Called automatically when leaving a game server.
 */
void Voice_Disconnect(void);

/**
 * Console command handlers
 */
void Voice_Cmd_VoiceTeam_f(void);   // +voiceteam / -voiceteam
void Voice_Cmd_VoiceAll_f(void);    // +voiceall / -voiceall
void Voice_Cmd_VoiceMute_f(void);   // voicemute <player>
void Voice_Cmd_VoiceUnmute_f(void); // voiceunmute <player>
void Voice_Cmd_VoiceStatus_f(void); // voicestatus

/*
 * CVars (defined in cg_voice.c, registered in CG_RegisterCvars)
 */
extern vmCvar_t voice_enable;       // Master enable (0/1)
extern vmCvar_t voice_volume;       // Incoming voice volume (0.0-2.0)
extern vmCvar_t voice_inputGain;    // Microphone gain (0.0-2.0)
extern vmCvar_t voice_showTalking;  // Show who's talking HUD (0/1)
extern vmCvar_t voice_showMeter;    // Show input level meter (0/1)
extern vmCvar_t voice_serverPort;   // Voice server port offset (default: 1)

/*
 * HUD drawing (called from cg_draw.c)
 */

/**
 * Draw the "who's talking" HUD element.
 * Shows icons/names of players currently transmitting.
 */
void Voice_DrawTalkingHUD(void);

/**
 * Draw the "transmitting" indicator when local player is talking.
 */
void Voice_DrawTransmitIndicator(void);

/**
 * Draw optional voice input level meter.
 */
void Voice_DrawInputMeter(void);

#endif /* CG_VOICE_H */
