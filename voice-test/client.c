/**
 * Voice Chat Client - Standalone Test
 *
 * Proof-of-concept for ET:Legacy voice chat integration.
 * - Captures audio from microphone using PortAudio
 * - Encodes with Opus codec
 * - Sends over UDP to echo server
 * - Receives echoed packets
 * - Decodes and plays through speakers
 *
 * Usage: ./voice_client [server_ip] [server_port]
 *        Default: localhost:27961
 *
 * Controls:
 *   SPACE (hold) - Push-to-talk
 *   Q            - Quit
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <signal.h>
#include <errno.h>
#include <time.h>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #include <conio.h>
    #pragma comment(lib, "ws2_32.lib")
    typedef int socklen_t;
    #define SOCKET_ERROR_CODE WSAGetLastError()
#else
    #include <unistd.h>
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <fcntl.h>
    #include <termios.h>
    #define SOCKET int
    #define INVALID_SOCKET -1
    #define SOCKET_ERROR -1
    #define closesocket close
    #define SOCKET_ERROR_CODE errno
#endif

#include <portaudio.h>
#include <opus/opus.h>

/*
 * Audio Configuration
 * Using Opus-native parameters for optimal voice quality
 */
#define SAMPLE_RATE     48000   /* Opus native rate */
#define CHANNELS_IN     1       /* Mono capture */
#define CHANNELS_OUT    2       /* Stereo playback */
#define FRAME_MS        20      /* 20ms frames (standard for VoIP) */
#define FRAME_SIZE      (SAMPLE_RATE * FRAME_MS / 1000)  /* 960 samples */
#define OPUS_BITRATE    24000   /* 24 kbps - good quality for voice */
#define MAX_PACKET_SIZE 512     /* Max UDP payload */

/*
 * Network Configuration
 */
#define DEFAULT_SERVER  "127.0.0.1"
#define DEFAULT_PORT    27961

/*
 * Packet Types
 */
#define VOICE_PACKET_AUDIO  0x01
#define VOICE_PACKET_PING   0x02

/*
 * Voice Packet Header (Client -> Server)
 * Packed structure for network transmission
 */
#pragma pack(push, 1)
typedef struct {
    uint8_t  type;          /* Packet type */
    uint32_t clientId;      /* Client identifier */
    uint32_t sequence;      /* Sequence number */
    uint8_t  channel;       /* Voice channel (team/all/proximity) */
    uint16_t opusLen;       /* Length of opus data */
    /* opus data follows */
} VoicePacketHeader;
#pragma pack(pop)

/*
 * Circular buffer for jitter handling
 */
#define JITTER_BUFFER_FRAMES 5
typedef struct {
    int16_t samples[JITTER_BUFFER_FRAMES][FRAME_SIZE * CHANNELS_OUT];
    int writeIndex;
    int readIndex;
    int count;
} JitterBuffer;

/*
 * Global State
 */
static volatile bool g_running = true;
static volatile bool g_pttActive = false;
static SOCKET g_socket = INVALID_SOCKET;
static struct sockaddr_in g_serverAddr;

/* PortAudio streams */
static PaStream *g_inputStream = NULL;
static PaStream *g_outputStream = NULL;

/* Opus codec */
static OpusEncoder *g_encoder = NULL;
static OpusDecoder *g_decoder = NULL;

/* Sequence counter */
static uint32_t g_sequence = 0;
static uint32_t g_clientId = 0;

/* Jitter buffer */
static JitterBuffer g_jitterBuffer = {0};

/* Statistics */
static int g_packetsSent = 0;
static int g_packetsReceived = 0;
static int g_bytesEncoded = 0;

/*
 * Platform-specific keyboard handling
 */
#ifndef _WIN32
#include <sys/select.h>

static struct termios g_originalTermios;
static bool g_termiosModified = false;

static void enableRawMode(void) {
    struct termios raw;
    tcgetattr(STDIN_FILENO, &g_originalTermios);
    g_termiosModified = true;
    raw = g_originalTermios;
    raw.c_lflag &= ~(ICANON | ECHO);
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw);

    /* Also set stdin to non-blocking */
    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
}

static void disableRawMode(void) {
    if (g_termiosModified) {
        /* Restore blocking mode */
        int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
        fcntl(STDIN_FILENO, F_SETFL, flags & ~O_NONBLOCK);

        tcsetattr(STDIN_FILENO, TCSAFLUSH, &g_originalTermios);
        g_termiosModified = false;
    }
}

static int kbhit(void) {
    fd_set fds;
    struct timeval tv = {0, 0};  /* No wait */

    FD_ZERO(&fds);
    FD_SET(STDIN_FILENO, &fds);

    return select(STDIN_FILENO + 1, &fds, NULL, NULL, &tv) > 0;
}

static int getch(void) {
    unsigned char c;
    if (read(STDIN_FILENO, &c, 1) == 1) {
        return c;
    }
    return -1;
}
#endif

/*
 * Signal handler for clean shutdown
 */
static void signalHandler(int sig) {
    (void)sig;
    printf("\nShutting down...\n");
    g_running = false;
}

/*
 * Initialize network socket
 */
static bool initNetwork(const char *serverIp, int serverPort) {
#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        fprintf(stderr, "WSAStartup failed\n");
        return false;
    }
#endif

    g_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (g_socket == INVALID_SOCKET) {
        fprintf(stderr, "Failed to create socket: %d\n", SOCKET_ERROR_CODE);
        return false;
    }

    /* Set non-blocking mode */
#ifdef _WIN32
    u_long mode = 1;
    ioctlsocket(g_socket, FIONBIO, &mode);
#else
    int flags = fcntl(g_socket, F_GETFL, 0);
    fcntl(g_socket, F_SETFL, flags | O_NONBLOCK);
#endif

    /* Setup server address */
    memset(&g_serverAddr, 0, sizeof(g_serverAddr));
    g_serverAddr.sin_family = AF_INET;
    g_serverAddr.sin_port = htons(serverPort);

    if (inet_pton(AF_INET, serverIp, &g_serverAddr.sin_addr) <= 0) {
        fprintf(stderr, "Invalid server address: %s\n", serverIp);
        closesocket(g_socket);
        g_socket = INVALID_SOCKET;
        return false;
    }

    /* Generate random client ID */
    srand((unsigned int)time(NULL));
    g_clientId = (uint32_t)rand();

    printf("Network initialized: %s:%d (client ID: %u)\n", serverIp, serverPort, g_clientId);
    return true;
}

/*
 * Cleanup network
 */
static void cleanupNetwork(void) {
    if (g_socket != INVALID_SOCKET) {
        closesocket(g_socket);
        g_socket = INVALID_SOCKET;
    }
#ifdef _WIN32
    WSACleanup();
#endif
}

/*
 * Initialize Opus encoder/decoder
 */
static bool initOpus(void) {
    int error;

    /* Create encoder */
    g_encoder = opus_encoder_create(SAMPLE_RATE, CHANNELS_IN, OPUS_APPLICATION_VOIP, &error);
    if (error != OPUS_OK) {
        fprintf(stderr, "Failed to create Opus encoder: %s\n", opus_strerror(error));
        return false;
    }

    /* Configure encoder for voice */
    opus_encoder_ctl(g_encoder, OPUS_SET_BITRATE(OPUS_BITRATE));
    opus_encoder_ctl(g_encoder, OPUS_SET_COMPLEXITY(5));  /* Medium complexity */
    opus_encoder_ctl(g_encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    opus_encoder_ctl(g_encoder, OPUS_SET_DTX(1));  /* Discontinuous transmission */

    /* Create decoder */
    g_decoder = opus_decoder_create(SAMPLE_RATE, CHANNELS_OUT, &error);
    if (error != OPUS_OK) {
        fprintf(stderr, "Failed to create Opus decoder: %s\n", opus_strerror(error));
        opus_encoder_destroy(g_encoder);
        g_encoder = NULL;
        return false;
    }

    printf("Opus initialized: %d Hz, encode %d ch, decode %d ch, %d kbps\n",
           SAMPLE_RATE, CHANNELS_IN, CHANNELS_OUT, OPUS_BITRATE / 1000);
    return true;
}

/*
 * Cleanup Opus
 */
static void cleanupOpus(void) {
    if (g_encoder) {
        opus_encoder_destroy(g_encoder);
        g_encoder = NULL;
    }
    if (g_decoder) {
        opus_decoder_destroy(g_decoder);
        g_decoder = NULL;
    }
}

/*
 * PortAudio input callback (microphone capture)
 */
static int inputCallback(const void *inputBuffer, void *outputBuffer,
                         unsigned long framesPerBuffer,
                         const PaStreamCallbackTimeInfo *timeInfo,
                         PaStreamCallbackFlags statusFlags,
                         void *userData) {
    (void)outputBuffer;
    (void)timeInfo;
    (void)statusFlags;
    (void)userData;

    if (!g_pttActive || inputBuffer == NULL) {
        return paContinue;
    }

    const int16_t *input = (const int16_t *)inputBuffer;
    uint8_t opusData[MAX_PACKET_SIZE];
    uint8_t packet[MAX_PACKET_SIZE];

    /* Encode audio to Opus */
    int opusLen = opus_encode(g_encoder, input, (int)framesPerBuffer,
                              opusData, sizeof(opusData));
    if (opusLen < 0) {
        fprintf(stderr, "Opus encode error: %s\n", opus_strerror(opusLen));
        return paContinue;
    }

    g_bytesEncoded += opusLen;

    /* Build packet */
    VoicePacketHeader *header = (VoicePacketHeader *)packet;
    header->type = VOICE_PACKET_AUDIO;
    header->clientId = htonl(g_clientId);
    header->sequence = htonl(g_sequence++);
    header->channel = 0;  /* Team channel */
    header->opusLen = htons((uint16_t)opusLen);

    memcpy(packet + sizeof(VoicePacketHeader), opusData, opusLen);

    /* Send packet */
    int packetLen = sizeof(VoicePacketHeader) + opusLen;
    int sent = sendto(g_socket, (char *)packet, packetLen, 0,
                      (struct sockaddr *)&g_serverAddr, sizeof(g_serverAddr));

    if (sent > 0) {
        g_packetsSent++;
    }

    return paContinue;
}

/*
 * PortAudio output callback (speaker playback)
 */
static int outputCallback(const void *inputBuffer, void *outputBuffer,
                          unsigned long framesPerBuffer,
                          const PaStreamCallbackTimeInfo *timeInfo,
                          PaStreamCallbackFlags statusFlags,
                          void *userData) {
    (void)inputBuffer;
    (void)timeInfo;
    (void)statusFlags;
    (void)userData;

    int16_t *output = (int16_t *)outputBuffer;

    /* Check if we have buffered audio */
    if (g_jitterBuffer.count > 0) {
        memcpy(output, g_jitterBuffer.samples[g_jitterBuffer.readIndex],
               framesPerBuffer * CHANNELS_OUT * sizeof(int16_t));
        g_jitterBuffer.readIndex = (g_jitterBuffer.readIndex + 1) % JITTER_BUFFER_FRAMES;
        g_jitterBuffer.count--;
    } else {
        /* No audio, output silence */
        memset(output, 0, framesPerBuffer * CHANNELS_OUT * sizeof(int16_t));
    }

    return paContinue;
}

/*
 * Initialize PortAudio
 */
static bool initAudio(void) {
    PaError err;

    err = Pa_Initialize();
    if (err != paNoError) {
        fprintf(stderr, "PortAudio init failed: %s\n", Pa_GetErrorText(err));
        return false;
    }

    /* List available devices */
    int numDevices = Pa_GetDeviceCount();
    printf("\nAvailable audio devices:\n");
    for (int i = 0; i < numDevices; i++) {
        const PaDeviceInfo *info = Pa_GetDeviceInfo(i);
        if (info->maxInputChannels > 0) {
            printf("  [%d] INPUT:  %s\n", i, info->name);
        }
        if (info->maxOutputChannels > 0) {
            printf("  [%d] OUTPUT: %s\n", i, info->name);
        }
    }
    printf("\n");

    /* Get default devices */
    PaDeviceIndex inputDevice = Pa_GetDefaultInputDevice();
    PaDeviceIndex outputDevice = Pa_GetDefaultOutputDevice();

    if (inputDevice == paNoDevice) {
        fprintf(stderr, "No default input device found!\n");
        Pa_Terminate();
        return false;
    }

    if (outputDevice == paNoDevice) {
        fprintf(stderr, "No default output device found!\n");
        Pa_Terminate();
        return false;
    }

    const PaDeviceInfo *inputInfo = Pa_GetDeviceInfo(inputDevice);
    const PaDeviceInfo *outputInfo = Pa_GetDeviceInfo(outputDevice);
    printf("Using input:  %s\n", inputInfo->name);
    printf("Using output: %s\n", outputInfo->name);

    /* Open input stream (microphone) */
    PaStreamParameters inputParams;
    inputParams.device = inputDevice;
    inputParams.channelCount = CHANNELS_IN;
    inputParams.sampleFormat = paInt16;
    inputParams.suggestedLatency = inputInfo->defaultLowInputLatency;
    inputParams.hostApiSpecificStreamInfo = NULL;

    err = Pa_OpenStream(&g_inputStream,
                        &inputParams,
                        NULL,  /* No output */
                        SAMPLE_RATE,
                        FRAME_SIZE,
                        paClipOff,
                        inputCallback,
                        NULL);
    if (err != paNoError) {
        fprintf(stderr, "Failed to open input stream: %s\n", Pa_GetErrorText(err));
        Pa_Terminate();
        return false;
    }

    /* Open output stream (speakers) */
    PaStreamParameters outputParams;
    outputParams.device = outputDevice;
    outputParams.channelCount = CHANNELS_OUT;
    outputParams.sampleFormat = paInt16;
    outputParams.suggestedLatency = outputInfo->defaultLowOutputLatency;
    outputParams.hostApiSpecificStreamInfo = NULL;

    err = Pa_OpenStream(&g_outputStream,
                        NULL,  /* No input */
                        &outputParams,
                        SAMPLE_RATE,
                        FRAME_SIZE,
                        paClipOff,
                        outputCallback,
                        NULL);
    if (err != paNoError) {
        fprintf(stderr, "Failed to open output stream: %s\n", Pa_GetErrorText(err));
        Pa_CloseStream(g_inputStream);
        Pa_Terminate();
        return false;
    }

    /* Start streams */
    err = Pa_StartStream(g_inputStream);
    if (err != paNoError) {
        fprintf(stderr, "Failed to start input stream: %s\n", Pa_GetErrorText(err));
        Pa_CloseStream(g_inputStream);
        Pa_CloseStream(g_outputStream);
        Pa_Terminate();
        return false;
    }

    err = Pa_StartStream(g_outputStream);
    if (err != paNoError) {
        fprintf(stderr, "Failed to start output stream: %s\n", Pa_GetErrorText(err));
        Pa_StopStream(g_inputStream);
        Pa_CloseStream(g_inputStream);
        Pa_CloseStream(g_outputStream);
        Pa_Terminate();
        return false;
    }

    printf("Audio streams started: %d Hz, %d ms frames\n", SAMPLE_RATE, FRAME_MS);
    return true;
}

/*
 * Cleanup PortAudio
 */
static void cleanupAudio(void) {
    if (g_inputStream) {
        Pa_StopStream(g_inputStream);
        Pa_CloseStream(g_inputStream);
        g_inputStream = NULL;
    }
    if (g_outputStream) {
        Pa_StopStream(g_outputStream);
        Pa_CloseStream(g_outputStream);
        g_outputStream = NULL;
    }
    Pa_Terminate();
}

/*
 * Process incoming network packets
 */
static void processIncomingPackets(void) {
    uint8_t buffer[MAX_PACKET_SIZE];
    struct sockaddr_in fromAddr;
    socklen_t fromLen = sizeof(fromAddr);

    while (1) {
        int received = recvfrom(g_socket, (char *)buffer, sizeof(buffer), 0,
                                (struct sockaddr *)&fromAddr, &fromLen);

        if (received <= 0) {
            break;  /* No more packets */
        }

        if (received < (int)sizeof(VoicePacketHeader)) {
            continue;  /* Invalid packet */
        }

        VoicePacketHeader *header = (VoicePacketHeader *)buffer;

        if (header->type != VOICE_PACKET_AUDIO) {
            continue;  /* Not an audio packet */
        }

        uint16_t opusLen = ntohs(header->opusLen);
        if (received < (int)(sizeof(VoicePacketHeader) + opusLen)) {
            continue;  /* Truncated packet */
        }

        g_packetsReceived++;

        /* Decode Opus to PCM */
        int16_t pcmBuffer[FRAME_SIZE * CHANNELS_OUT];
        uint8_t *opusData = buffer + sizeof(VoicePacketHeader);

        int decodedSamples = opus_decode(g_decoder, opusData, opusLen,
                                         pcmBuffer, FRAME_SIZE, 0);
        if (decodedSamples < 0) {
            fprintf(stderr, "Opus decode error: %s\n", opus_strerror(decodedSamples));
            continue;
        }

        /* Add to jitter buffer */
        if (g_jitterBuffer.count < JITTER_BUFFER_FRAMES) {
            memcpy(g_jitterBuffer.samples[g_jitterBuffer.writeIndex],
                   pcmBuffer, decodedSamples * CHANNELS_OUT * sizeof(int16_t));
            g_jitterBuffer.writeIndex = (g_jitterBuffer.writeIndex + 1) % JITTER_BUFFER_FRAMES;
            g_jitterBuffer.count++;
        }
        /* else: buffer full, drop packet */
    }
}

/*
 * Print usage
 */
static void printUsage(const char *progName) {
    printf("Voice Chat Client - ET:Legacy PoC\n");
    printf("Usage: %s [server_ip] [server_port]\n", progName);
    printf("  Default: %s %d\n", DEFAULT_SERVER, DEFAULT_PORT);
    printf("\nControls:\n");
    printf("  SPACE (hold) - Push-to-talk\n");
    printf("  Q            - Quit\n");
}

/*
 * Main function
 */
int main(int argc, char *argv[]) {
    const char *serverIp = DEFAULT_SERVER;
    int serverPort = DEFAULT_PORT;

    /* Parse command line */
    if (argc >= 2) {
        if (strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0) {
            printUsage(argv[0]);
            return 0;
        }
        serverIp = argv[1];
    }
    if (argc >= 3) {
        serverPort = atoi(argv[2]);
    }

    printf("=== Voice Chat Client ===\n");
    printf("Connecting to %s:%d\n\n", serverIp, serverPort);

    /* Setup signal handler */
    signal(SIGINT, signalHandler);
#ifndef _WIN32
    signal(SIGTERM, signalHandler);
#endif

    /* Initialize components */
    if (!initNetwork(serverIp, serverPort)) {
        fprintf(stderr, "Network initialization failed\n");
        return 1;
    }

    if (!initOpus()) {
        fprintf(stderr, "Opus initialization failed\n");
        cleanupNetwork();
        return 1;
    }

    if (!initAudio()) {
        fprintf(stderr, "Audio initialization failed\n");
        cleanupOpus();
        cleanupNetwork();
        return 1;
    }

#ifndef _WIN32
    enableRawMode();
#endif

    printf("\n=== Ready ===\n");
    printf("Hold SPACE to talk, press Q to quit\n\n");

    /* Main loop */
    time_t lastStatTime = time(NULL);

    /*
     * PTT timing - terminals don't have key-up events, so we use timing:
     * Keep transmitting for PTT_HOLD_MS after last space key received.
     * Key repeat rate (~30ms) keeps extending this while held.
     */
    #define PTT_HOLD_MS 150  /* Stop transmitting 150ms after last space */
    struct timespec lastSpaceTime = {0, 0};
    bool wasTransmitting = false;

    while (g_running) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);

        /* Process keyboard input - read all available keys */
        while (kbhit()) {
            int ch = getch();
            if (ch == 'q' || ch == 'Q') {
                g_running = false;
            } else if (ch == ' ') {
                lastSpaceTime = now;
                if (!g_pttActive) {
                    g_pttActive = true;
                    printf("\r[TRANSMITTING]                    \r");
                    fflush(stdout);
                    wasTransmitting = true;
                }
            }
        }

        /* Check if PTT should timeout */
        if (g_pttActive && lastSpaceTime.tv_sec > 0) {
            long elapsedMs = (now.tv_sec - lastSpaceTime.tv_sec) * 1000 +
                            (now.tv_nsec - lastSpaceTime.tv_nsec) / 1000000;
            if (elapsedMs > PTT_HOLD_MS) {
                g_pttActive = false;
                if (wasTransmitting) {
                    printf("\r[IDLE]                            \r");
                    fflush(stdout);
                    wasTransmitting = false;
                }
            }
        }

        /* Process incoming packets */
        processIncomingPackets();

        /* Print statistics every 5 seconds */
        time_t nowTime = time(NULL);
        if (nowTime - lastStatTime >= 5) {
            printf("\rStats: Sent=%d Recv=%d Bytes=%d JBuf=%d    \n",
                   g_packetsSent, g_packetsReceived, g_bytesEncoded,
                   g_jitterBuffer.count);
            lastStatTime = nowTime;
        }

        /* Small sleep to prevent CPU spinning */
#ifdef _WIN32
        Sleep(5);
#else
        usleep(5000);
#endif
    }

    /* Cleanup */
#ifndef _WIN32
    disableRawMode();
#endif

    printf("\n\n=== Final Statistics ===\n");
    printf("Packets sent:     %d\n", g_packetsSent);
    printf("Packets received: %d\n", g_packetsReceived);
    printf("Bytes encoded:    %d\n", g_bytesEncoded);

    cleanupAudio();
    cleanupOpus();
    cleanupNetwork();

    printf("Goodbye!\n");
    return 0;
}
