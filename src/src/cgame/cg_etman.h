/**
 * @file cg_etman.h
 * @brief ETMan custom sound commands - client side
 *
 * Handles /etman commands for server-side custom sound management:
 * - /etman add <url> <name> - Add sound from URL
 * - /etman play <name> - Play a sound
 * - /etman list - List your sounds
 * - /etman delete <name> - Delete a sound
 * - /etman rename <old> <new> - Rename a sound
 * - /etman share <name> <player> - Share with another player
 * - /etman stop - Stop currently playing sound
 */

#ifndef CG_ETMAN_H
#define CG_ETMAN_H

#include "cg_local.h"

#ifdef FEATURE_VOICE

/*
 * Sound Command Packet Types (client -> server)
 * Must match voice server definitions
 */
#define VOICE_CMD_SOUND_ADD     0x10
#define VOICE_CMD_SOUND_PLAY    0x11
#define VOICE_CMD_SOUND_LIST    0x12
#define VOICE_CMD_SOUND_DELETE  0x13
#define VOICE_CMD_SOUND_RENAME  0x14
#define VOICE_CMD_SOUND_SHARE   0x15
#define VOICE_CMD_SOUND_ACCEPT  0x16
#define VOICE_CMD_SOUND_REJECT  0x17
#define VOICE_CMD_SOUND_STOP    0x18

/*
 * Sound Response Packet Types (server -> client)
 */
#define VOICE_RESP_SUCCESS      0x20
#define VOICE_RESP_ERROR        0x21
#define VOICE_RESP_LIST         0x22
#define VOICE_RESP_SHARE_REQ    0x23
#define VOICE_RESP_PROGRESS     0x24

/*
 * Limits
 */
#define ETMAN_GUID_LEN          32
#define ETMAN_MAX_NAME_LEN      32

/**
 * Initialize ETMan system.
 * Called from Voice_Init().
 */
void ETMan_Init(void);

/**
 * Shutdown ETMan system.
 * Called from Voice_Shutdown().
 */
void ETMan_Shutdown(void);

/**
 * Process incoming response packets from voice server.
 * Called when a sound response packet is received.
 * @param data Packet data
 * @param dataLen Packet length
 */
void ETMan_HandleResponse(const uint8_t *data, int dataLen);

/**
 * Check for pending share requests and show prompt.
 * Called from Voice_Frame().
 */
void ETMan_Frame(void);

/**
 * Console command handler for /etman.
 */
void ETMan_Cmd_f(void);

/**
 * Draw any active ETMan UI (share prompts, etc).
 */
void ETMan_Draw(void);

#endif /* FEATURE_VOICE */

#endif /* CG_ETMAN_H */
