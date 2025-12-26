/**
 * @file cg_voice.c
 * @brief Built-in voice chat implementation for ET:Legacy
 *
 * Cross-platform voice chat using PortAudio and Opus.
 * Supports Windows (WASAPI) and Linux (PulseAudio/PipeWire/ALSA).
 */

#include "cg_voice.h"

#ifdef FEATURE_VOICE

#include <portaudio.h>
#include <opus/opus.h>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    typedef int socklen_t;
    #define VOICE_SOCKET SOCKET
    #define VOICE_INVALID_SOCKET INVALID_SOCKET
    #define VOICE_SOCKET_ERROR SOCKET_ERROR
    #define voice_closesocket closesocket
    #define VOICE_WOULD_BLOCK (WSAGetLastError() == WSAEWOULDBLOCK)
#else
    #include <unistd.h>
    #include <sys/socket.h>
    #include <sys/time.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <netdb.h>
    #include <fcntl.h>
    #include <errno.h>
    #define VOICE_SOCKET int
    #define VOICE_INVALID_SOCKET -1
    #define VOICE_SOCKET_ERROR -1
    #define voice_closesocket close
    #define VOICE_WOULD_BLOCK (errno == EWOULDBLOCK || errno == EAGAIN)
#endif

/*
 * Audio configuration (matches Opus requirements)
 */
#define VOICE_SAMPLE_RATE     48000
#define VOICE_CHANNELS_IN     1
#define VOICE_CHANNELS_OUT    2
#define VOICE_FRAME_MS        20
#define VOICE_FRAME_SIZE      (VOICE_SAMPLE_RATE * VOICE_FRAME_MS / 1000) // 960 samples
#define VOICE_OPUS_BITRATE    24000  // 24 kbps
#define VOICE_MAX_PACKET      512

/*
 * Jitter buffer for smooth playback
 */
#define VOICE_JITTER_FRAMES   5

/*
 * Network packet types
 */
#define VOICE_PKT_AUDIO       0x01
#define VOICE_PKT_AUTH        0x02
#define VOICE_PKT_PING        0x03
#define VOICE_PKT_TEAM_UPDATE 0x04
#define VOICE_PKT_DEBUG       0x05

/*
 * Voice packet header (network byte order)
 */
#pragma pack(push, 1)
typedef struct
{
	uint8_t  type;
	uint32_t clientId;
	uint32_t sequence;
	uint8_t  channel;
	uint16_t opusLen;
	// opus data follows
} voicePacketHeader_t;

/*
 * Auth packet (sent on connect to register with voice server)
 */
typedef struct
{
	uint8_t  type;      // VOICE_PKT_AUTH
	uint32_t clientId;  // ET client slot
	uint8_t  team;      // Current team (TEAM_AXIS, TEAM_ALLIES, etc)
	char     guid[33];  // ET GUID (optional, for verification)
} voiceAuthPacket_t;

/*
 * Team update packet (sent when team changes)
 */
typedef struct
{
	uint8_t  type;      // VOICE_PKT_TEAM_UPDATE
	uint32_t clientId;
	uint8_t  team;
} voiceTeamUpdatePacket_t;

/*
 * Relay packet header (received from voice server)
 * Different from voicePacketHeader_t - server uses smaller format
 */
typedef struct
{
	uint8_t  type;        // VOICE_PKT_AUDIO
	uint8_t  fromClient;  // Who is speaking (ET client slot)
	uint32_t sequence;
	uint16_t opusLen;
	// opus data follows
} voiceRelayHeader_t;
#pragma pack(pop)

/*
 * Per-client decoder and jitter buffer
 */
typedef struct
{
	OpusDecoder *decoder;
	int16_t      jitterBuffer[VOICE_JITTER_FRAMES][VOICE_FRAME_SIZE * VOICE_CHANNELS_OUT];
	int          jitterWrite;
	int          jitterRead;
	int          jitterCount;
	uint32_t     lastSequence;
	int          lastPacketTime;
	qboolean     active;
} voiceClientDecoder_t;

/*
 * CVars (defined in cg_cvars.c, declared extern in cg_voice.h)
 */

/*
 * Module state
 */
static struct
{
	qboolean           initialized;
	voiceState_t       state;

	// PortAudio
	PaStream          *inputStream;
	PaStream          *outputStream;

	// Opus encoder
	OpusEncoder       *encoder;

	// Per-client decoders
	voiceClientDecoder_t clients[MAX_CLIENTS];
	voiceClientInfo_t    clientInfo[MAX_CLIENTS];

	// Network
	VOICE_SOCKET       socket;
	struct sockaddr_in serverAddr;
	qboolean           connected;

	// Transmission state
	voiceChannel_t     transmitChannel;
	qboolean           transmitting;
	uint32_t           sequence;
	int                inputLevel;  // For meter display (0-100)

	// Statistics
	int                packetsSent;
	int                packetsReceived;

	// Team tracking (for sending updates when team changes)
	int                lastTeamSent;  // -1 = not sent yet

	// Keepalive
	int                lastKeepaliveTime;  // cg.time of last keepalive sent

} voice;

/*
 * Forward declarations
 */
static int  Voice_InputCallback(const void *input, void *output,
                                unsigned long frameCount,
                                const PaStreamCallbackTimeInfo *timeInfo,
                                PaStreamCallbackFlags statusFlags,
                                void *userData);
static int  Voice_OutputCallback(const void *input, void *output,
                                 unsigned long frameCount,
                                 const PaStreamCallbackTimeInfo *timeInfo,
                                 PaStreamCallbackFlags statusFlags,
                                 void *userData);
static void Voice_ProcessIncoming(void);
static void Voice_UpdateClientState(void);
static void Voice_SendDebug(const char *msg);
static void Voice_SendAuth(void);
static void Voice_SendTeamUpdate(int team);
static void Voice_SendKeepalive(void);

/*
 * Send debug message to voice server (for server-side logging)
 */
static void Voice_SendDebug(const char *msg)
{
	uint8_t packet[256];
	int len;

	if (voice.socket == VOICE_INVALID_SOCKET || !voice.connected)
	{
		return;
	}

	packet[0] = VOICE_PKT_DEBUG;
	packet[1] = (uint8_t)cg.clientNum;
	len = 2;

	/* Copy message (max 253 chars) */
	Q_strncpyz((char *)&packet[2], msg, sizeof(packet) - 2);
	len += strlen((char *)&packet[2]) + 1;

	sendto(voice.socket, (char *)packet, len, 0,
	       (struct sockaddr *)&voice.serverAddr, sizeof(voice.serverAddr));
}

/*
 * Send auth packet to voice server (registers client with team info)
 */
static void Voice_SendAuth(void)
{
	voiceAuthPacket_t packet;
	int team;

	if (voice.socket == VOICE_INVALID_SOCKET || !voice.connected)
	{
		return;
	}

	/* Get current team from client info */
	team = cgs.clientinfo[cg.clientNum].team;

	Com_Memset(&packet, 0, sizeof(packet));
	packet.type = VOICE_PKT_AUTH;
	packet.clientId = htonl((uint32_t)cg.clientNum);
	packet.team = (uint8_t)team;

	/* Get GUID if available */
	trap_Cvar_VariableStringBuffer("cl_guid", packet.guid, sizeof(packet.guid));

	sendto(voice.socket, (char *)&packet, sizeof(packet), 0,
	       (struct sockaddr *)&voice.serverAddr, sizeof(voice.serverAddr));

	voice.lastTeamSent = team;
	CG_Printf("^2Voice: Sent auth (team=%d)\n", team);
}

/*
 * Send team update packet when team changes
 */
static void Voice_SendTeamUpdate(int team)
{
	voiceTeamUpdatePacket_t packet;

	if (voice.socket == VOICE_INVALID_SOCKET || !voice.connected)
	{
		return;
	}

	packet.type = VOICE_PKT_TEAM_UPDATE;
	packet.clientId = htonl((uint32_t)cg.clientNum);
	packet.team = (uint8_t)team;

	sendto(voice.socket, (char *)&packet, sizeof(packet), 0,
	       (struct sockaddr *)&voice.serverAddr, sizeof(voice.serverAddr));

	voice.lastTeamSent = team;
	CG_Printf("^2Voice: Team update sent (team=%d)\n", team);
}

/*
 * Send keepalive ping to voice server (keeps connection alive)
 */
static void Voice_SendKeepalive(void)
{
	uint8_t packet[8];

	if (voice.socket == VOICE_INVALID_SOCKET || !voice.connected)
	{
		return;
	}

	packet[0] = VOICE_PKT_PING;
	packet[1] = (uint8_t)cg.clientNum;

	sendto(voice.socket, (char *)packet, 2, 0,
	       (struct sockaddr *)&voice.serverAddr, sizeof(voice.serverAddr));

	voice.lastKeepaliveTime = cg.time;
}

/*
 * Initialize network (Windows needs WSAStartup)
 */
static qboolean Voice_InitNetwork(void)
{
#ifdef _WIN32
	WSADATA wsaData;
	if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
	{
		CG_Printf("^1Voice: WSAStartup failed\n");
		return qfalse;
	}
#endif
	return qtrue;
}

/*
 * Cleanup network
 */
static void Voice_ShutdownNetwork(void)
{
	if (voice.socket != VOICE_INVALID_SOCKET)
	{
		voice_closesocket(voice.socket);
		voice.socket = VOICE_INVALID_SOCKET;
	}
#ifdef _WIN32
	WSACleanup();
#endif
}

/*
 * Initialize PortAudio
 */
static qboolean Voice_InitAudio(void)
{
	PaError err;
	PaStreamParameters inputParams, outputParams;
	const PaDeviceInfo *inputInfo, *outputInfo;
	PaDeviceIndex inputDevice, outputDevice;
	int numDevices, i;

	CG_Printf("Voice: [Audio] Calling Pa_Initialize()...\n");
	err = Pa_Initialize();
	if (err != paNoError)
	{
		CG_Printf("^1Voice: [Audio] Pa_Initialize FAILED: %s\n", Pa_GetErrorText(err));
		return qfalse;
	}
	CG_Printf("Voice: [Audio] Pa_Initialize OK, version: %s\n", Pa_GetVersionText());

	// List all available devices for debugging
	numDevices = Pa_GetDeviceCount();
	CG_Printf("Voice: [Audio] Found %d audio devices:\n", numDevices);
	for (i = 0; i < numDevices; i++)
	{
		const PaDeviceInfo *info = Pa_GetDeviceInfo(i);
		if (info)
		{
			CG_Printf("Voice: [Audio]   [%d] %s (in:%d out:%d)\n",
			          i, info->name, info->maxInputChannels, info->maxOutputChannels);
		}
	}

	// Get default devices
	inputDevice = Pa_GetDefaultInputDevice();
	outputDevice = Pa_GetDefaultOutputDevice();
	CG_Printf("Voice: [Audio] Default input device: %d, output device: %d\n",
	          inputDevice, outputDevice);

	if (outputDevice == paNoDevice)
	{
		CG_Printf("^1Voice: [Audio] No audio output device found! Voice disabled.\n");
		Pa_Terminate();
		return qfalse;
	}

	outputInfo = Pa_GetDeviceInfo(outputDevice);
	CG_Printf("Voice: [Audio] Using output: %s\n", outputInfo->name);

	// Setup output stream (speakers) - REQUIRED
	Com_Memset(&outputParams, 0, sizeof(outputParams));
	outputParams.device = outputDevice;
	outputParams.channelCount = VOICE_CHANNELS_OUT;
	outputParams.sampleFormat = paInt16;
	outputParams.suggestedLatency = outputInfo->defaultLowOutputLatency;
	outputParams.hostApiSpecificStreamInfo = NULL;

	err = Pa_OpenStream(&voice.outputStream,
	                    NULL,
	                    &outputParams,
	                    VOICE_SAMPLE_RATE,
	                    VOICE_FRAME_SIZE,
	                    paClipOff,
	                    Voice_OutputCallback,
	                    NULL);
	if (err != paNoError)
	{
		CG_Printf("^1Voice: Failed to open output stream: %s\n", Pa_GetErrorText(err));
		Pa_Terminate();
		return qfalse;
	}

	err = Pa_StartStream(voice.outputStream);
	if (err != paNoError)
	{
		CG_Printf("^1Voice: Failed to start output: %s\n", Pa_GetErrorText(err));
		Pa_CloseStream(voice.outputStream);
		Pa_Terminate();
		return qfalse;
	}

	// Setup input stream (microphone) - OPTIONAL (listen-only mode if no mic)
	if (inputDevice == paNoDevice)
	{
		CG_Printf("^3Voice: No microphone found, listen-only mode\n");
		voice.inputStream = NULL;
	}
	else
	{
		inputInfo = Pa_GetDeviceInfo(inputDevice);
		CG_Printf("Voice: Input device: %s\n", inputInfo->name);

		Com_Memset(&inputParams, 0, sizeof(inputParams));
		inputParams.device = inputDevice;
		inputParams.channelCount = VOICE_CHANNELS_IN;
		inputParams.sampleFormat = paInt16;
		inputParams.suggestedLatency = inputInfo->defaultLowInputLatency;
		inputParams.hostApiSpecificStreamInfo = NULL;

		err = Pa_OpenStream(&voice.inputStream,
		                    &inputParams,
		                    NULL,
		                    VOICE_SAMPLE_RATE,
		                    VOICE_FRAME_SIZE,
		                    paClipOff,
		                    Voice_InputCallback,
		                    NULL);
		if (err != paNoError)
		{
			CG_Printf("^3Voice: Failed to open input stream: %s (listen-only mode)\n", Pa_GetErrorText(err));
			voice.inputStream = NULL;
		}
		else
		{
			err = Pa_StartStream(voice.inputStream);
			if (err != paNoError)
			{
				CG_Printf("^3Voice: Failed to start input: %s (listen-only mode)\n", Pa_GetErrorText(err));
				Pa_CloseStream(voice.inputStream);
				voice.inputStream = NULL;
			}
		}
	}

	CG_Printf("Voice: Audio streams started (%d Hz, %d ms frames)%s\n",
	          VOICE_SAMPLE_RATE, VOICE_FRAME_MS,
	          voice.inputStream ? "" : " [LISTEN-ONLY]");
	return qtrue;
}

/*
 * Shutdown PortAudio
 */
static void Voice_ShutdownAudio(void)
{
	if (voice.inputStream)
	{
		Pa_StopStream(voice.inputStream);
		Pa_CloseStream(voice.inputStream);
		voice.inputStream = NULL;
	}
	if (voice.outputStream)
	{
		Pa_StopStream(voice.outputStream);
		Pa_CloseStream(voice.outputStream);
		voice.outputStream = NULL;
	}
	Pa_Terminate();
}

/*
 * Initialize Opus codec
 */
static qboolean Voice_InitOpus(void)
{
	int error;

	// Create encoder
	voice.encoder = opus_encoder_create(VOICE_SAMPLE_RATE, VOICE_CHANNELS_IN,
	                                    OPUS_APPLICATION_VOIP, &error);
	if (error != OPUS_OK)
	{
		CG_Printf("^1Voice: Opus encoder init failed: %s\n", opus_strerror(error));
		return qfalse;
	}

	opus_encoder_ctl(voice.encoder, OPUS_SET_BITRATE(VOICE_OPUS_BITRATE));
	opus_encoder_ctl(voice.encoder, OPUS_SET_COMPLEXITY(5));
	opus_encoder_ctl(voice.encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
	opus_encoder_ctl(voice.encoder, OPUS_SET_DTX(1));

	CG_Printf("Voice: Opus encoder initialized (%d kbps)\n", VOICE_OPUS_BITRATE / 1000);
	return qtrue;
}

/*
 * Create decoder for a client
 */
static qboolean Voice_CreateDecoder(int clientNum)
{
	int error;
	voiceClientDecoder_t *dec;

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return qfalse;
	}

	dec = &voice.clients[clientNum];

	if (dec->decoder)
	{
		return qtrue;  // Already exists
	}

	dec->decoder = opus_decoder_create(VOICE_SAMPLE_RATE, VOICE_CHANNELS_OUT, &error);
	if (error != OPUS_OK)
	{
		CG_Printf("^1Voice: Failed to create decoder for client %d: %s\n",
		          clientNum, opus_strerror(error));
		return qfalse;
	}

	dec->jitterWrite = 0;
	dec->jitterRead = 0;
	dec->jitterCount = 0;
	dec->lastSequence = 0;
	dec->active = qfalse;

	return qtrue;
}

/*
 * Destroy decoder for a client
 */
static void Voice_DestroyDecoder(int clientNum)
{
	voiceClientDecoder_t *dec;

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return;
	}

	dec = &voice.clients[clientNum];

	if (dec->decoder)
	{
		opus_decoder_destroy(dec->decoder);
		dec->decoder = NULL;
	}

	dec->active = qfalse;
}

/*
 * Shutdown Opus
 */
static void Voice_ShutdownOpus(void)
{
	int i;

	if (voice.encoder)
	{
		opus_encoder_destroy(voice.encoder);
		voice.encoder = NULL;
	}

	for (i = 0; i < MAX_CLIENTS; i++)
	{
		Voice_DestroyDecoder(i);
	}
}

/*
 * PortAudio input callback (microphone capture)
 */
static int Voice_InputCallback(const void *input, void *output,
                               unsigned long frameCount,
                               const PaStreamCallbackTimeInfo *timeInfo,
                               PaStreamCallbackFlags statusFlags,
                               void *userData)
{
	const int16_t *samples = (const int16_t *)input;
	uint8_t opusData[VOICE_MAX_PACKET];
	uint8_t packet[VOICE_MAX_PACKET];
	int opusLen, packetLen;
	int i, sum = 0;
	voicePacketHeader_t *header;

	(void)output;
	(void)timeInfo;
	(void)statusFlags;
	(void)userData;

	if (!voice.transmitting || !samples || !voice.connected)
	{
		voice.inputLevel = 0;
		return paContinue;
	}

	// Calculate input level for meter
	// Find peak amplitude in this frame (more responsive than average)
	for (i = 0; i < (int)frameCount; i++)
	{
		int s = samples[i];
		int absVal = (s < 0) ? -s : s;
		if (absVal > sum)
		{
			sum = absVal;
		}
	}
	// Scale to 0-100 using ~5000 as reference
	voice.inputLevel = (sum * 100) / 5000;
	if (voice.inputLevel > 100)
	{
		voice.inputLevel = 100;
	}

	// Apply input gain
	// Note: We could modify samples here, but Opus handles gain internally

	// Encode to Opus
	opusLen = opus_encode(voice.encoder, samples, (int)frameCount,
	                      opusData, sizeof(opusData));
	if (opusLen < 0)
	{
		return paContinue;
	}

	// Build packet
	header = (voicePacketHeader_t *)packet;
	header->type = VOICE_PKT_AUDIO;
	header->clientId = htonl((uint32_t)cg.clientNum);
	header->sequence = htonl(voice.sequence++);
	header->channel = (uint8_t)voice.transmitChannel;
	header->opusLen = htons((uint16_t)opusLen);

	Com_Memcpy(packet + sizeof(voicePacketHeader_t), opusData, opusLen);
	packetLen = sizeof(voicePacketHeader_t) + opusLen;

	// Send packet
	if (sendto(voice.socket, (char *)packet, packetLen, 0,
	           (struct sockaddr *)&voice.serverAddr,
	           sizeof(voice.serverAddr)) > 0)
	{
		voice.packetsSent++;
	}

	return paContinue;
}

/*
 * PortAudio output callback (speaker playback)
 * Mixes audio from all non-muted, active clients
 */
static int Voice_OutputCallback(const void *input, void *output,
                                unsigned long frameCount,
                                const PaStreamCallbackTimeInfo *timeInfo,
                                PaStreamCallbackFlags statusFlags,
                                void *userData)
{
	int16_t *out = (int16_t *)output;
	int32_t mixBuffer[VOICE_FRAME_SIZE * VOICE_CHANNELS_OUT];
	int i, j, numSources = 0;
	voiceClientDecoder_t *dec;

	(void)input;
	(void)timeInfo;
	(void)statusFlags;
	(void)userData;

	Com_Memset(mixBuffer, 0, sizeof(mixBuffer));

	// Mix all active clients
	for (i = 0; i < MAX_CLIENTS; i++)
	{
		// Skip self
		if (i == cg.clientNum)
		{
			continue;
		}

		// Skip muted
		if (voice.clientInfo[i].muted)
		{
			continue;
		}

		dec = &voice.clients[i];
		if (!dec->active || dec->jitterCount <= 0)
		{
			continue;
		}

		// Add to mix buffer
		for (j = 0; j < (int)(frameCount * VOICE_CHANNELS_OUT); j++)
		{
			mixBuffer[j] += dec->jitterBuffer[dec->jitterRead][j];
		}

		dec->jitterRead = (dec->jitterRead + 1) % VOICE_JITTER_FRAMES;
		dec->jitterCount--;
		numSources++;
	}

	// Apply volume and clamp
	if (numSources > 0)
	{
		// 10x amplification - loud enough to hear over game but not distorted
		float vol = 10.0f;

		for (j = 0; j < (int)(frameCount * VOICE_CHANNELS_OUT); j++)
		{
			int32_t sample = (int32_t)(mixBuffer[j] * vol);
			if (sample > 32767) sample = 32767;
			if (sample < -32768) sample = -32768;
			out[j] = (int16_t)sample;
		}
	}
	else
	{
		// Silence
		Com_Memset(out, 0, frameCount * VOICE_CHANNELS_OUT * sizeof(int16_t));
	}

	return paContinue;
}

/*
 * Process incoming network packets
 */
static void Voice_ProcessIncoming(void)
{
	uint8_t buffer[VOICE_MAX_PACKET];
	struct sockaddr_in fromAddr;
	socklen_t fromLen;
	int received;
	voiceRelayHeader_t *relay;
	voiceClientDecoder_t *dec;
	int clientNum;
	uint16_t opusLen;
	int decodedSamples;

	if (voice.socket == VOICE_INVALID_SOCKET)
	{
		return;
	}

	// Process all available packets
	while (1)
	{
		fromLen = sizeof(fromAddr);
		received = recvfrom(voice.socket, (char *)buffer, sizeof(buffer), 0,
		                    (struct sockaddr *)&fromAddr, &fromLen);

		if (received <= 0)
		{
			break;
		}

		// Relay packets from server use voiceRelayHeader_t (8 bytes)
		if (received < (int)sizeof(voiceRelayHeader_t))
		{
			continue;
		}

		relay = (voiceRelayHeader_t *)buffer;

		if (relay->type != VOICE_PKT_AUDIO)
		{
			continue;
		}

		// Server sends fromClient as uint8_t (no byte swap needed)
		clientNum = (int)relay->fromClient;
		opusLen = ntohs(relay->opusLen);

		if (clientNum < 0 || clientNum >= MAX_CLIENTS)
		{
			continue;
		}

		if (received < (int)(sizeof(voiceRelayHeader_t) + opusLen))
		{
			continue;
		}

		voice.packetsReceived++;

		// Create decoder if needed
		if (!voice.clients[clientNum].decoder)
		{
			if (!Voice_CreateDecoder(clientNum))
			{
				continue;
			}
		}

		dec = &voice.clients[clientNum];

		// Skip if muted
		if (voice.clientInfo[clientNum].muted)
		{
			continue;
		}

		// Decode Opus to PCM (opus data starts after relay header)
		decodedSamples = opus_decode(dec->decoder,
		                             buffer + sizeof(voiceRelayHeader_t),
		                             opusLen,
		                             dec->jitterBuffer[dec->jitterWrite],
		                             VOICE_FRAME_SIZE,
		                             0);

		if (decodedSamples > 0 && dec->jitterCount < VOICE_JITTER_FRAMES)
		{
			dec->jitterWrite = (dec->jitterWrite + 1) % VOICE_JITTER_FRAMES;
			dec->jitterCount++;
			dec->active = qtrue;
			dec->lastPacketTime = cg.time;

			// Update client info for HUD
			voice.clientInfo[clientNum].talking = qtrue;
			voice.clientInfo[clientNum].lastPacketTime = cg.time;
			if (!voice.clientInfo[clientNum].talkingTime)
			{
				voice.clientInfo[clientNum].talkingTime = cg.time;
			}
		}
	}
}

/*
 * Update client talking state (expire old talkers)
 */
static void Voice_UpdateClientState(void)
{
	int i;
	int expireTime = cg.time - 500;  // 500ms timeout

	for (i = 0; i < MAX_CLIENTS; i++)
	{
		if (voice.clientInfo[i].talking)
		{
			if (voice.clientInfo[i].lastPacketTime < expireTime)
			{
				voice.clientInfo[i].talking = qfalse;
				voice.clientInfo[i].talkingTime = 0;
				voice.clients[i].active = qfalse;
			}
		}
	}
}

/*
 * Get the current game server address for auto-connect
 */
static qboolean Voice_GetServerAddress(char *buffer, int bufsize)
{
	char serverAddr[MAX_STRING_CHARS];

	/* Try cl_currentServerAddress first (set when connecting) */
	trap_Cvar_VariableStringBuffer("cl_currentServerAddress", serverAddr, sizeof(serverAddr));

	if (serverAddr[0] == '\0')
	{
		/* Fallback: try to get from cl_currentServerIP (IP only, no port) */
		trap_Cvar_VariableStringBuffer("cl_currentServerIP", serverAddr, sizeof(serverAddr));
	}

	if (serverAddr[0] == '\0')
	{
		return qfalse;
	}

	Q_strncpyz(buffer, serverAddr, bufsize);
	return qtrue;
}

/*
 * Auto-connect to voice server based on game server address
 */
static void Voice_AutoConnect(void)
{
	char serverAddr[MAX_STRING_CHARS];

	if (!voice.initialized)
	{
		return;
	}

	if (voice.connected)
	{
		return;  /* Already connected */
	}

	if (!Voice_GetServerAddress(serverAddr, sizeof(serverAddr)))
	{
		CG_Printf("Voice: Could not determine server address for auto-connect\n");
		return;
	}

	CG_Printf("Voice: Auto-connecting to %s\n", serverAddr);
	Voice_Connect(serverAddr);
}

/*
 * Public API implementations
 */

qboolean Voice_Init(void)
{
	CG_Printf("^3Voice: [1/5] Starting initialization...\n");

	Com_Memset(&voice, 0, sizeof(voice));
	voice.socket = VOICE_INVALID_SOCKET;
	voice.state = VOICE_STATE_DISABLED;
	voice.lastTeamSent = -1;  // Force auth on first connect

	/* Voice is always enabled - no cvar check */
	CG_Printf("^3Voice: [2/5] Initializing network...\n");
	if (!Voice_InitNetwork())
	{
		CG_Printf("^1Voice: [FAIL] Network initialization failed!\n");
		return qfalse;
	}
	CG_Printf("^2Voice: [2/5] Network OK\n");

	CG_Printf("^3Voice: [3/5] Initializing Opus codec...\n");
	if (!Voice_InitOpus())
	{
		CG_Printf("^1Voice: [FAIL] Opus initialization failed!\n");
		Voice_ShutdownNetwork();
		return qfalse;
	}
	CG_Printf("^2Voice: [3/5] Opus OK\n");

	CG_Printf("^3Voice: [4/5] Initializing audio (PortAudio)...\n");
	if (!Voice_InitAudio())
	{
		CG_Printf("^1Voice: [FAIL] Audio initialization failed!\n");
		Voice_ShutdownOpus();
		Voice_ShutdownNetwork();
		return qfalse;
	}
	CG_Printf("^2Voice: [4/5] Audio OK\n");

	voice.initialized = qtrue;
	voice.state = VOICE_STATE_IDLE;

	CG_Printf("^3Voice: [5/5] Auto-connecting to voice server...\n");
	/* Auto-connect to voice server */
	Voice_AutoConnect();

	CG_Printf("^2Voice: Initialized successfully\n");
	return qtrue;
}

void Voice_Shutdown(void)
{
	if (!voice.initialized)
	{
		return;
	}

	Voice_Disconnect();
	Voice_ShutdownAudio();
	Voice_ShutdownOpus();
	Voice_ShutdownNetwork();

	Com_Memset(&voice, 0, sizeof(voice));
	voice.socket = VOICE_INVALID_SOCKET;

	CG_Printf("Voice: Shutdown complete\n");
}

void Voice_Frame(void)
{
	int currentTeam;

	if (!voice.initialized || voice.state == VOICE_STATE_DISABLED)
	{
		return;
	}

	// Check if team changed and send update to voice server
	if (voice.connected)
	{
		currentTeam = cgs.clientinfo[cg.clientNum].team;
		if (voice.lastTeamSent != currentTeam)
		{
			Voice_SendTeamUpdate(currentTeam);
		}

		// Send keepalive every 10 seconds to prevent timeout
		if (cg.time - voice.lastKeepaliveTime > 10000)
		{
			Voice_SendKeepalive();
		}
	}

	// Process incoming voice packets
	Voice_ProcessIncoming();

	// Update client talking states
	Voice_UpdateClientState();
}

void Voice_StartTransmit(voiceChannel_t channel)
{
	if (!voice.initialized || !voice.connected)
	{
		return;
	}

	if (channel == VOICE_CHAN_NONE)
	{
		return;
	}

	// Can't transmit without a microphone (listen-only mode)
	if (!voice.inputStream)
	{
		return;
	}

	voice.transmitChannel = channel;
	voice.transmitting = qtrue;
	voice.state = VOICE_STATE_TRANSMITTING;
}

void Voice_StopTransmit(void)
{
	voice.transmitting = qfalse;
	voice.transmitChannel = VOICE_CHAN_NONE;
	voice.inputLevel = 0;

	if (voice.state == VOICE_STATE_TRANSMITTING)
	{
		voice.state = VOICE_STATE_IDLE;
	}
}

qboolean Voice_IsTransmitting(void)
{
	return voice.transmitting;
}

voiceChannel_t Voice_GetTransmitChannel(void)
{
	return voice.transmitChannel;
}

qboolean Voice_IsClientTalking(int clientNum)
{
	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return qfalse;
	}
	return voice.clientInfo[clientNum].talking;
}

voiceClientInfo_t *Voice_GetClientInfo(int clientNum)
{
	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return NULL;
	}
	return &voice.clientInfo[clientNum];
}

void Voice_ToggleMute(int clientNum)
{
	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return;
	}
	voice.clientInfo[clientNum].muted = !voice.clientInfo[clientNum].muted;
}

qboolean Voice_IsClientMuted(int clientNum)
{
	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return qfalse;
	}
	return voice.clientInfo[clientNum].muted;
}

voiceState_t Voice_GetState(void)
{
	return voice.state;
}

qboolean Voice_Connect(const char *serverAddress)
{
	char ipStr[64];
	int port;
	char *colon;

	if (!voice.initialized)
	{
		return qfalse;
	}

	// Parse server address (ip:port)
	Q_strncpyz(ipStr, serverAddress, sizeof(ipStr));
	colon = strchr(ipStr, ':');
	if (colon)
	{
		*colon = '\0';
		port = atoi(colon + 1);
	}
	else
	{
		port = 27960;  // Default ET port
	}

	// Voice server is on port + offset (default: port + 1)
	port += voice_serverPort.integer;

	// Create socket
	voice.socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	if (voice.socket == VOICE_INVALID_SOCKET)
	{
		CG_Printf("^1Voice: Failed to create socket\n");
		return qfalse;
	}

	// Set non-blocking
#ifdef _WIN32
	{
		u_long mode = 1;
		ioctlsocket(voice.socket, FIONBIO, &mode);
	}
#else
	{
		int flags = fcntl(voice.socket, F_GETFL, 0);
		fcntl(voice.socket, F_SETFL, flags | O_NONBLOCK);
	}
#endif

	// Setup server address
	Com_Memset(&voice.serverAddr, 0, sizeof(voice.serverAddr));
	voice.serverAddr.sin_family = AF_INET;
	voice.serverAddr.sin_port = htons(port);

	if (inet_pton(AF_INET, ipStr, &voice.serverAddr.sin_addr) <= 0)
	{
		// Try hostname resolution
		struct hostent *host = gethostbyname(ipStr);
		if (host)
		{
			Com_Memcpy(&voice.serverAddr.sin_addr, host->h_addr_list[0], host->h_length);
		}
		else
		{
			CG_Printf("^1Voice: Invalid server address: %s\n", ipStr);
			voice_closesocket(voice.socket);
			voice.socket = VOICE_INVALID_SOCKET;
			return qfalse;
		}
	}

	voice.connected = qtrue;
	voice.state = VOICE_STATE_IDLE;

	CG_Printf("Voice: Connected to %s:%d\n", ipStr, port);

	/* Send debug info to voice server for server-side logging */
	{
		char debugMsg[128];
#ifdef _WIN32
		Com_sprintf(debugMsg, sizeof(debugMsg), "WIN client connected, hasInput=%d",
		            voice.inputStream ? 1 : 0);
#else
		Com_sprintf(debugMsg, sizeof(debugMsg), "LINUX client connected, hasInput=%d",
		            voice.inputStream ? 1 : 0);
#endif
		Voice_SendDebug(debugMsg);
	}

	/* Send auth packet with team info so voice server knows our team */
	Voice_SendAuth();

	return qtrue;
}

void Voice_Disconnect(void)
{
	if (voice.socket != VOICE_INVALID_SOCKET)
	{
		voice_closesocket(voice.socket);
		voice.socket = VOICE_INVALID_SOCKET;
	}

	voice.connected = qfalse;
	voice.transmitting = qfalse;
	voice.transmitChannel = VOICE_CHAN_NONE;

	if (voice.state != VOICE_STATE_DISABLED)
	{
		voice.state = VOICE_STATE_IDLE;
	}
}

/*
 * Console commands
 */

void Voice_Cmd_VoiceTeam_f(void)
{
	const char *cmd = CG_Argv(0);

	if (cmd[0] == '+')
	{
		Voice_StartTransmit(VOICE_CHAN_TEAM);
	}
	else
	{
		Voice_StopTransmit();
	}
}

void Voice_Cmd_VoiceAll_f(void)
{
	const char *cmd = CG_Argv(0);

	if (cmd[0] == '+')
	{
		Voice_StartTransmit(VOICE_CHAN_ALL);
	}
	else
	{
		Voice_StopTransmit();
	}
}

void Voice_Cmd_VoiceMute_f(void)
{
	const char *name;
	int i;

	if (trap_Argc() < 2)
	{
		CG_Printf("Usage: voicemute <playername>\n");
		return;
	}

	name = CG_Argv(1);

	for (i = 0; i < MAX_CLIENTS; i++)
	{
		if (cgs.clientinfo[i].infoValid &&
		    Q_stricmp(cgs.clientinfo[i].name, name) == 0)
		{
			voice.clientInfo[i].muted = qtrue;
			CG_Printf("Muted voice from %s\n", name);
			return;
		}
	}

	CG_Printf("Player not found: %s\n", name);
}

void Voice_Cmd_VoiceUnmute_f(void)
{
	const char *name;
	int i;

	if (trap_Argc() < 2)
	{
		CG_Printf("Usage: voiceunmute <playername>\n");
		return;
	}

	name = CG_Argv(1);

	for (i = 0; i < MAX_CLIENTS; i++)
	{
		if (cgs.clientinfo[i].infoValid &&
		    Q_stricmp(cgs.clientinfo[i].name, name) == 0)
		{
			voice.clientInfo[i].muted = qfalse;
			CG_Printf("Unmuted voice from %s\n", name);
			return;
		}
	}

	CG_Printf("Player not found: %s\n", name);
}

void Voice_Cmd_VoiceStatus_f(void)
{
	int i, numTalking = 0;

	CG_Printf("Voice Status:\n");
	CG_Printf("  State: %s\n",
	          voice.state == VOICE_STATE_DISABLED ? "Disabled" :
	          voice.state == VOICE_STATE_IDLE ? "Idle" :
	          voice.state == VOICE_STATE_TRANSMITTING ? "Transmitting" :
	          voice.state == VOICE_STATE_CONNECTING ? "Connecting" : "Error");
	CG_Printf("  Connected: %s\n", voice.connected ? "Yes" : "No");
	CG_Printf("  Packets sent: %d\n", voice.packetsSent);
	CG_Printf("  Packets received: %d\n", voice.packetsReceived);

	CG_Printf("  Currently talking:\n");
	for (i = 0; i < MAX_CLIENTS; i++)
	{
		if (voice.clientInfo[i].talking && cgs.clientinfo[i].infoValid)
		{
			CG_Printf("    - %s%s\n", cgs.clientinfo[i].name,
			          voice.clientInfo[i].muted ? " (muted)" : "");
			numTalking++;
		}
	}
	if (numTalking == 0)
	{
		CG_Printf("    (none)\n");
	}

	CG_Printf("  Muted players:\n");
	for (i = 0; i < MAX_CLIENTS; i++)
	{
		if (voice.clientInfo[i].muted && cgs.clientinfo[i].infoValid)
		{
			CG_Printf("    - %s\n", cgs.clientinfo[i].name);
		}
	}
}

/*
 * HUD Drawing
 *
 * Position: Right side of screen, below the compass
 * Shows who is talking with team-colored names
 */

/* HUD positioning constants */
#define VOICE_HUD_X          (SCREEN_WIDTH - 120)
#define VOICE_HUD_Y          180
#define VOICE_HUD_LINE_H     14
#define VOICE_HUD_MAX_SHOW   5
#define VOICE_HUD_FONT_W     7
#define VOICE_HUD_FONT_H     10

/* Transmit indicator position (bottom left, near chat) */
#define VOICE_TX_X           8
#define VOICE_TX_Y           (SCREEN_HEIGHT - 100)

/*
 * Get team color for a client
 */
static vec4_t *Voice_GetTeamColor(int clientNum)
{
	static vec4_t axisColor   = { 1.0f, 0.2f, 0.2f, 1.0f };   /* Red */
	static vec4_t alliesColor = { 0.2f, 0.4f, 1.0f, 1.0f };   /* Blue */
	static vec4_t specColor   = { 0.7f, 0.7f, 0.7f, 1.0f };   /* Gray */

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return &specColor;
	}

	switch (cgs.clientinfo[clientNum].team)
	{
	case TEAM_AXIS:
		return &axisColor;
	case TEAM_ALLIES:
		return &alliesColor;
	default:
		return &specColor;
	}
}

void Voice_DrawTalkingHUD(void)
{
	int   i, y;
	int   numTalking = 0;
	float x;
	float textScale = 0.2f;

	if (!voice.initialized || !voice_showTalking.integer)
	{
		return;
	}

	x = VOICE_HUD_X;
	y = VOICE_HUD_Y;

	for (i = 0; i < MAX_CLIENTS; i++)
	{
		if (voice.clientInfo[i].talking && cgs.clientinfo[i].infoValid)
		{
			vec4_t *teamColor = Voice_GetTeamColor(i);
			char    nameStr[64];

			/* Build the display string: speaker icon + name */
			Com_sprintf(nameStr, sizeof(nameStr), ">> %s",
			           cgs.clientinfo[i].name);

			/* Draw team-colored background bar */
			{
				vec4_t bgColor;
				Vector4Copy(*teamColor, bgColor);
				bgColor[3] = 0.3f;  /* Semi-transparent */
				CG_FillRect(x - 2, y - 1, 115, VOICE_HUD_LINE_H - 2, bgColor);
			}

			/* Draw the name with team color using proper cgame function */
			CG_Text_Paint_Ext(x, y + VOICE_HUD_FONT_H, textScale, textScale,
			                  *teamColor, nameStr, 0, 16, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

			y += VOICE_HUD_LINE_H;
			numTalking++;

			if (numTalking >= VOICE_HUD_MAX_SHOW)
			{
				break;
			}
		}
	}
}

void Voice_DrawTransmitIndicator(void)
{
	vec4_t txColor;
	const char *chanStr;
	const char *displayStr;
	float pulseAlpha;
	int   strWidth;
	float textScale = 0.2f;

	if (!voice.initialized)
	{
		return;
	}

	if (!voice.transmitting)
	{
		return;
	}

	/* Create pulsing effect */
	pulseAlpha = 0.7f + 0.3f * (float)sin(cg.time * 0.01f);

	/* Set color based on channel */
	if (voice.transmitChannel == VOICE_CHAN_TEAM)
	{
		/* Team channel: use your team color */
		if (cgs.clientinfo[cg.clientNum].team == TEAM_AXIS)
		{
			Vector4Set(txColor, 1.0f, 0.3f, 0.3f, pulseAlpha);
		}
		else
		{
			Vector4Set(txColor, 0.3f, 0.5f, 1.0f, pulseAlpha);
		}
		chanStr = "TEAM";
	}
	else
	{
		/* All channel: yellow/gold */
		Vector4Set(txColor, 1.0f, 0.8f, 0.2f, pulseAlpha);
		chanStr = "ALL";
	}

	displayStr = va("[MIC: %s]", chanStr);
	strWidth = CG_Text_Width_Ext(displayStr, textScale, 0, &cgs.media.limboFont2);

	/* Draw background */
	{
		vec4_t bgColor = { 0.0f, 0.0f, 0.0f, 0.5f };
		CG_FillRect(VOICE_TX_X - 2, VOICE_TX_Y - 1, strWidth + 4, VOICE_HUD_FONT_H + 2, bgColor);
	}

	/* Draw the transmit indicator */
	CG_Text_Paint_Ext(VOICE_TX_X, VOICE_TX_Y + VOICE_HUD_FONT_H, textScale, textScale,
	                  txColor, displayStr, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

void Voice_DrawInputMeter(void)
{
	float meterX, meterY, meterW, meterH;
	float fillW;
	vec4_t bgColor = { 0.2f, 0.2f, 0.2f, 0.8f };
	vec4_t fillColor;

	if (!voice.initialized || !voice_showMeter.integer || !voice.transmitting)
	{
		return;
	}

	meterX = VOICE_TX_X;
	meterY = VOICE_TX_Y + VOICE_HUD_FONT_H + 4;
	meterW = 80;
	meterH = 6;

	/* Draw background */
	CG_FillRect(meterX, meterY, meterW, meterH, bgColor);

	/* Color based on level: green -> yellow -> red */
	if (voice.inputLevel < 50)
	{
		Vector4Set(fillColor, 0.2f, 0.8f, 0.2f, 1.0f);  /* Green */
	}
	else if (voice.inputLevel < 80)
	{
		Vector4Set(fillColor, 0.8f, 0.8f, 0.2f, 1.0f);  /* Yellow */
	}
	else
	{
		Vector4Set(fillColor, 1.0f, 0.2f, 0.2f, 1.0f);  /* Red */
	}

	/* Draw level fill */
	fillW = (meterW * voice.inputLevel) / 100.0f;
	if (fillW > 0)
	{
		CG_FillRect(meterX, meterY, fillW, meterH, fillColor);
	}

	/* Draw border */
	{
		vec4_t borderColor = { 0.5f, 0.5f, 0.5f, 1.0f };
		CG_DrawRect_FixedBorder(meterX, meterY, meterW, meterH, 1, borderColor);
	}
}

#else /* !FEATURE_VOICE */

/*
 * Stub implementations when voice is disabled at compile time
 */

qboolean Voice_Init(void) { return qfalse; }
void Voice_Shutdown(void) {}
void Voice_Frame(void) {}
void Voice_StartTransmit(voiceChannel_t channel) { (void)channel; }
void Voice_StopTransmit(void) {}
qboolean Voice_IsTransmitting(void) { return qfalse; }
voiceChannel_t Voice_GetTransmitChannel(void) { return VOICE_CHAN_NONE; }
qboolean Voice_IsClientTalking(int clientNum) { (void)clientNum; return qfalse; }
voiceClientInfo_t *Voice_GetClientInfo(int clientNum) { (void)clientNum; return NULL; }
void Voice_ToggleMute(int clientNum) { (void)clientNum; }
qboolean Voice_IsClientMuted(int clientNum) { (void)clientNum; return qfalse; }
voiceState_t Voice_GetState(void) { return VOICE_STATE_DISABLED; }
qboolean Voice_Connect(const char *serverAddress) { (void)serverAddress; return qfalse; }
void Voice_Disconnect(void) {}
void Voice_Cmd_VoiceTeam_f(void) { CG_Printf("Voice chat not compiled in\n"); }
void Voice_Cmd_VoiceAll_f(void) { CG_Printf("Voice chat not compiled in\n"); }
void Voice_Cmd_VoiceMute_f(void) { CG_Printf("Voice chat not compiled in\n"); }
void Voice_Cmd_VoiceUnmute_f(void) { CG_Printf("Voice chat not compiled in\n"); }
void Voice_Cmd_VoiceStatus_f(void) { CG_Printf("Voice chat not compiled in\n"); }
void Voice_DrawTalkingHUD(void) {}
void Voice_DrawTransmitIndicator(void) {}
void Voice_DrawInputMeter(void) {}

#endif /* FEATURE_VOICE */
