/**
 * Voice Chat Routing Server - ET:Legacy
 *
 * UDP server that routes voice packets between game clients.
 * Supports team channels (forward only to same team) and all channel.
 *
 * Protocol:
 *   Client -> Server: VoicePacket with clientId, team, channel, opus data
 *   Server -> Client: RelayPacket with fromClient, opus data
 *
 * The server tracks client connections and their team assignments.
 * Teams can be updated via a simple control protocol or trusted from client.
 *
 * Usage: ./voice_server [port] [game_server_port]
 *        Default: port 27961, game_server 27960
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <signal.h>
#include <time.h>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
    typedef int socklen_t;
    #define SOCKET_ERROR_CODE WSAGetLastError()
#else
    #include <unistd.h>
    #include <sys/socket.h>
    #include <sys/time.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <errno.h>
    #define SOCKET int
    #define INVALID_SOCKET -1
    #define SOCKET_ERROR -1
    #define closesocket close
    #define SOCKET_ERROR_CODE errno
#endif

#define DEFAULT_PORT        27961
#define DEFAULT_GAME_PORT   27960
#define MAX_PACKET_SIZE     512
#define MAX_CLIENTS         64
#define CLIENT_TIMEOUT_SEC  30

/*
 * Voice Channels (must match cgame)
 */
#define VOICE_CHAN_NONE     0
#define VOICE_CHAN_TEAM     1
#define VOICE_CHAN_ALL      2
#define VOICE_CHAN_SOUND    3

/*
 * Packet Types (must match cgame)
 */
#define VOICE_PKT_AUDIO     0x01
#define VOICE_PKT_AUTH      0x02
#define VOICE_PKT_PING      0x03
#define VOICE_PKT_TEAM_UPDATE 0x04
#define VOICE_PKT_DEBUG     0x05

/*
 * Teams (ET uses these values)
 */
#define TEAM_FREE           0
#define TEAM_AXIS           1
#define TEAM_ALLIES         2
#define TEAM_SPECTATOR      3

/*
 * Incoming Voice Packet Header (from client)
 */
#pragma pack(push, 1)
typedef struct {
    uint8_t  type;
    uint32_t clientId;      // ET client slot number
    uint32_t sequence;
    uint8_t  channel;       // VOICE_CHAN_*
    uint16_t opusLen;
    // opus data follows
} VoicePacketHeader;

/*
 * Outgoing Relay Packet Header (to clients)
 */
typedef struct {
    uint8_t  type;
    uint8_t  fromClient;    // Who is speaking (ET client slot)
    uint8_t  channel;       // Voice channel (VOICE_CHAN_TEAM or VOICE_CHAN_ALL)
    uint32_t sequence;
    uint16_t opusLen;
    // opus data follows
} RelayPacketHeader;

/*
 * Auth Packet (client -> server on connect)
 */
typedef struct {
    uint8_t  type;          // VOICE_PKT_AUTH
    uint32_t clientId;      // ET client slot
    uint8_t  team;          // Current team
    char     guid[33];      // ET GUID (optional for verification)
} AuthPacket;

/*
 * Team Update Packet (for updating client team)
 */
typedef struct {
    uint8_t  type;          // VOICE_PKT_TEAM_UPDATE
    uint32_t clientId;
    uint8_t  team;
} TeamUpdatePacket;
#pragma pack(pop)

/*
 * Transmission rate limiting
 * Each client can transmit max 30 seconds per minute.
 * Tracking resets at the start of each minute.
 */
#define VOICE_MAX_TX_MS_PER_MINUTE  30000   /* 30 seconds max per minute */
#define VOICE_FRAME_MS              20      /* Each packet = 20ms of audio */

/*
 * Connected Client Info
 */
typedef struct {
    struct sockaddr_in addr;
    uint32_t clientId;          // ET client slot (0-63)
    uint8_t  team;              // Current team
    time_t   lastSeen;
    uint32_t packetsReceived;
    uint32_t packetsSent;
    bool     authenticated;
    /* Rate limiting */
    time_t   txLimitMinute;     // Which minute we're tracking (time / 60)
    uint32_t txMsThisMinute;    // Milliseconds transmitted this minute
    bool     txLimitWarned;     // Have we warned them this minute?
} ClientInfo;

/*
 * Global State
 */
static volatile bool g_running = true;
static SOCKET g_socket = INVALID_SOCKET;
static ClientInfo g_clients[MAX_CLIENTS];
static int g_numClients = 0;
static int g_gameServerPort = DEFAULT_GAME_PORT;

/* Statistics */
static uint64_t g_totalPacketsReceived = 0;
static uint64_t g_totalPacketsRouted = 0;
static uint64_t g_totalBytesReceived = 0;

/*
 * Signal handler
 */
static void signalHandler(int sig) {
    (void)sig;
    printf("\nShutdown signal received...\n");
    g_running = false;
}

/*
 * Find client by address
 */
static ClientInfo* findClientByAddr(struct sockaddr_in *addr) {
    for (int i = 0; i < g_numClients; i++) {
        if (g_clients[i].addr.sin_addr.s_addr == addr->sin_addr.s_addr &&
            g_clients[i].addr.sin_port == addr->sin_port) {
            return &g_clients[i];
        }
    }
    return NULL;
}

/*
 * Find client by ET client ID
 */
static ClientInfo* findClientById(uint32_t clientId) {
    for (int i = 0; i < g_numClients; i++) {
        if (g_clients[i].clientId == clientId) {
            return &g_clients[i];
        }
    }
    return NULL;
}

/*
 * Find or create client entry
 */
static ClientInfo* findOrCreateClient(struct sockaddr_in *addr, uint32_t clientId) {
    time_t now = time(NULL);

    /* Look for existing client by ID first */
    ClientInfo *existing = findClientById(clientId);
    if (existing) {
        /* Update address (client may have reconnected from different port) */
        existing->addr = *addr;
        existing->lastSeen = now;
        return existing;
    }

    /* Clean up stale clients */
    for (int i = 0; i < g_numClients; i++) {
        if (now - g_clients[i].lastSeen > CLIENT_TIMEOUT_SEC) {
            printf("Client %u timed out (was %s:%d)\n",
                   g_clients[i].clientId,
                   inet_ntoa(g_clients[i].addr.sin_addr),
                   ntohs(g_clients[i].addr.sin_port));

            /* Remove by swapping with last */
            g_clients[i] = g_clients[g_numClients - 1];
            g_numClients--;
            i--;
        }
    }

    /* Add new client */
    if (g_numClients < MAX_CLIENTS) {
        ClientInfo *client = &g_clients[g_numClients++];
        memset(client, 0, sizeof(*client));
        client->addr = *addr;
        client->clientId = clientId;
        client->lastSeen = now;
        client->team = TEAM_FREE;  /* Will be updated by auth or voice packet */
        client->authenticated = false;

        printf("New client %u connected from %s:%d\n",
               clientId,
               inet_ntoa(addr->sin_addr),
               ntohs(addr->sin_port));

        return client;
    }

    printf("Warning: Server full, rejecting client %u\n", clientId);
    return NULL;
}

/*
 * Route voice packet to appropriate recipients
 */
static void routeVoicePacket(ClientInfo *sender, uint8_t *packet, int packetLen,
                             uint8_t channel, uint32_t sequence, uint16_t opusLen) {
    uint8_t relayBuffer[MAX_PACKET_SIZE];
    RelayPacketHeader *relay = (RelayPacketHeader *)relayBuffer;
    int relayLen;

    /* Build relay packet */
    relay->type = VOICE_PKT_AUDIO;
    relay->fromClient = (uint8_t)sender->clientId;
    relay->channel = channel;  /* Include channel so clients know team vs all */
    relay->sequence = htonl(sequence);
    relay->opusLen = htons(opusLen);

    /* Copy opus data after header */
    memcpy(relayBuffer + sizeof(RelayPacketHeader),
           packet + sizeof(VoicePacketHeader),
           opusLen);

    relayLen = sizeof(RelayPacketHeader) + opusLen;

    /* Route based on channel */
    for (int i = 0; i < g_numClients; i++) {
        ClientInfo *recipient = &g_clients[i];

        /* Don't send back to sender */
        if (recipient->clientId == sender->clientId) {
            continue;
        }

        /* Skip stale clients */
        if (time(NULL) - recipient->lastSeen > CLIENT_TIMEOUT_SEC) {
            continue;
        }

        bool shouldSend = false;

        switch (channel) {
            case VOICE_CHAN_ALL:
            case VOICE_CHAN_SOUND:
                /* Send to everyone (except spectators) */
                shouldSend = (recipient->team != TEAM_SPECTATOR);
                break;

            case VOICE_CHAN_TEAM:
                /* Send only to same team */
                shouldSend = (recipient->team == sender->team &&
                             sender->team != TEAM_FREE &&
                             sender->team != TEAM_SPECTATOR);
                break;

            default:
                break;
        }

        if (shouldSend) {
            int sent = sendto(g_socket, (char *)relayBuffer, relayLen, 0,
                             (struct sockaddr *)&recipient->addr,
                             sizeof(recipient->addr));

            if (sent > 0) {
                recipient->packetsSent++;
                g_totalPacketsRouted++;
            }
        }
    }
}

/* Debug helper to print routing decision */
static void debugRouting(uint32_t senderId, uint8_t senderTeam, uint8_t channel) {
    static time_t lastDebug = 0;
    time_t now = time(NULL);

    /* Only log once per second to avoid spam */
    if (now - lastDebug < 1) return;
    lastDebug = now;

    printf("[ROUTE DEBUG] Sender %u (team %d) on channel %d:\n",
           senderId, senderTeam, channel);

    for (int i = 0; i < g_numClients; i++) {
        if (g_clients[i].clientId == senderId) continue;

        const char *status = "SKIP";
        if (channel == VOICE_CHAN_ALL) {
            if (g_clients[i].team != TEAM_SPECTATOR) status = "SEND";
        } else if (channel == VOICE_CHAN_TEAM) {
            if (g_clients[i].team == senderTeam &&
                senderTeam != TEAM_FREE &&
                senderTeam != TEAM_SPECTATOR) {
                status = "SEND";
            }
        }
        printf("  -> Client %u (team %d): %s\n",
               g_clients[i].clientId, g_clients[i].team, status);
    }
}

/*
 * Handle auth packet
 */
static void handleAuthPacket(struct sockaddr_in *addr, uint8_t *buffer, int received) {
    if (received < (int)sizeof(AuthPacket)) {
        return;
    }

    AuthPacket *auth = (AuthPacket *)buffer;
    uint32_t clientId = ntohl(auth->clientId);

    if (clientId >= MAX_CLIENTS) {
        printf("Invalid client ID in auth: %u\n", clientId);
        return;
    }

    ClientInfo *client = findOrCreateClient(addr, clientId);
    if (client) {
        client->team = auth->team;
        client->authenticated = true;
        printf("Client %u authenticated (team %d) from %s:%d\n",
               clientId, auth->team,
               inet_ntoa(addr->sin_addr),
               ntohs(addr->sin_port));
    }
}

/*
 * Handle team update packet
 */
static void handleTeamUpdate(struct sockaddr_in *addr, uint8_t *buffer, int received) {
    if (received < (int)sizeof(TeamUpdatePacket)) {
        return;
    }

    TeamUpdatePacket *update = (TeamUpdatePacket *)buffer;
    uint32_t clientId = ntohl(update->clientId);

    ClientInfo *client = findClientById(clientId);
    if (client) {
        uint8_t oldTeam = client->team;
        client->team = update->team;
        if (oldTeam != update->team) {
            printf("Client %u changed team: %d -> %d\n",
                   clientId, oldTeam, update->team);
        }
    }
}

/*
 * Check and update transmission rate limit for a client.
 * Returns true if client is allowed to transmit, false if rate limited.
 */
static bool checkTransmitLimit(ClientInfo *client) {
    time_t now = time(NULL);
    time_t currentMinute = now / 60;

    /* Reset tracking if we're in a new minute */
    if (client->txLimitMinute != currentMinute) {
        client->txLimitMinute = currentMinute;
        client->txMsThisMinute = 0;
        client->txLimitWarned = false;
    }

    /* Check if they've exceeded the limit */
    if (client->txMsThisMinute >= VOICE_MAX_TX_MS_PER_MINUTE) {
        /* Log warning once per minute */
        if (!client->txLimitWarned) {
            printf("Client %u rate limited (used %u ms of %d ms this minute)\n",
                   client->clientId, client->txMsThisMinute, VOICE_MAX_TX_MS_PER_MINUTE);
            client->txLimitWarned = true;
        }
        return false;
    }

    /* Add this packet's audio duration */
    client->txMsThisMinute += VOICE_FRAME_MS;

    return true;
}

/*
 * Handle voice audio packet
 */
static void handleAudioPacket(struct sockaddr_in *addr, uint8_t *buffer, int received) {
    if (received < (int)sizeof(VoicePacketHeader)) {
        return;
    }

    VoicePacketHeader *header = (VoicePacketHeader *)buffer;
    uint32_t clientId = ntohl(header->clientId);
    uint32_t sequence = ntohl(header->sequence);
    uint16_t opusLen = ntohs(header->opusLen);

    if (clientId >= MAX_CLIENTS) {
        return;
    }

    if (received < (int)(sizeof(VoicePacketHeader) + opusLen)) {
        return;  /* Truncated packet */
    }

    /* Find or create client */
    ClientInfo *client = findOrCreateClient(addr, clientId);
    if (!client) {
        return;
    }

    client->packetsReceived++;

    /* Check rate limit - drop packet if exceeded */
    if (!checkTransmitLimit(client)) {
        return;  /* Rate limited, don't route this packet */
    }

    /* Debug routing decisions periodically */
    debugRouting(clientId, client->team, header->channel);

    /* Route the packet */
    routeVoicePacket(client, buffer, received, header->channel, sequence, opusLen);

    /* Log periodically */
    if (client->packetsReceived % 100 == 1) {
        printf("Client %u: seq=%u, opus=%u bytes, team=%d, channel=%d, txMs=%u/%d\n",
               clientId, sequence, opusLen, client->team, header->channel,
               client->txMsThisMinute, VOICE_MAX_TX_MS_PER_MINUTE);
    }
}

/*
 * Initialize server socket
 */
static bool initServer(int port) {
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

    /* Allow address reuse */
    int opt = 1;
#ifdef _WIN32
    setsockopt(g_socket, SOL_SOCKET, SO_REUSEADDR, (char*)&opt, sizeof(opt));
#else
    setsockopt(g_socket, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#endif

    /* Set receive timeout */
#ifdef _WIN32
    DWORD timeout = 100;
    setsockopt(g_socket, SOL_SOCKET, SO_RCVTIMEO, (char*)&timeout, sizeof(timeout));
#else
    struct timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = 100000;  /* 100ms */
    setsockopt(g_socket, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif

    /* Bind to port */
    struct sockaddr_in serverAddr;
    memset(&serverAddr, 0, sizeof(serverAddr));
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_addr.s_addr = INADDR_ANY;
    serverAddr.sin_port = htons(port);

    if (bind(g_socket, (struct sockaddr*)&serverAddr, sizeof(serverAddr)) == SOCKET_ERROR) {
        fprintf(stderr, "Failed to bind to port %d: %d\n", port, SOCKET_ERROR_CODE);
        closesocket(g_socket);
        g_socket = INVALID_SOCKET;
        return false;
    }

    printf("Voice server listening on UDP port %d\n", port);
    printf("Associated game server port: %d\n", g_gameServerPort);
    return true;
}

/*
 * Cleanup server
 */
static void cleanupServer(void) {
    if (g_socket != INVALID_SOCKET) {
        closesocket(g_socket);
        g_socket = INVALID_SOCKET;
    }
#ifdef _WIN32
    WSACleanup();
#endif
}

/*
 * Print server statistics
 */
static void printStats(void) {
    printf("\n=== Voice Server Statistics ===\n");
    printf("Active clients:    %d\n", g_numClients);
    printf("Total received:    %lu packets (%lu bytes)\n",
           (unsigned long)g_totalPacketsReceived,
           (unsigned long)g_totalBytesReceived);
    printf("Total routed:      %lu packets\n",
           (unsigned long)g_totalPacketsRouted);

    if (g_numClients > 0) {
        printf("\nConnected clients:\n");
        for (int i = 0; i < g_numClients; i++) {
            const char *teamName;
            switch (g_clients[i].team) {
                case TEAM_AXIS:    teamName = "Axis";    break;
                case TEAM_ALLIES:  teamName = "Allies";  break;
                case TEAM_SPECTATOR: teamName = "Spec";  break;
                default:           teamName = "Unknown"; break;
            }
            printf("  [%u] %s:%d - %s (recv=%u sent=%u)\n",
                   g_clients[i].clientId,
                   inet_ntoa(g_clients[i].addr.sin_addr),
                   ntohs(g_clients[i].addr.sin_port),
                   teamName,
                   g_clients[i].packetsReceived,
                   g_clients[i].packetsSent);
        }
    }
    printf("\n");
}

/*
 * Main server loop
 */
static void serverLoop(void) {
    uint8_t buffer[MAX_PACKET_SIZE];
    struct sockaddr_in clientAddr;
    socklen_t clientLen;
    time_t lastStatTime = time(NULL);

    printf("\nVoice server running. Press Ctrl+C to stop.\n");
    printf("Routing modes: TEAM (same team only), ALL (everyone)\n\n");

    while (g_running) {
        clientLen = sizeof(clientAddr);

        int received = recvfrom(g_socket, (char*)buffer, sizeof(buffer), 0,
                                (struct sockaddr*)&clientAddr, &clientLen);

        if (received > 0) {
            g_totalPacketsReceived++;
            g_totalBytesReceived += received;

            /* Dispatch based on packet type */
            if (received >= 1) {
                uint8_t type = buffer[0];

                switch (type) {
                    case VOICE_PKT_AUDIO:
                        handleAudioPacket(&clientAddr, buffer, received);
                        break;

                    case VOICE_PKT_AUTH:
                        handleAuthPacket(&clientAddr, buffer, received);
                        break;

                    case VOICE_PKT_TEAM_UPDATE:
                        handleTeamUpdate(&clientAddr, buffer, received);
                        break;

                    case VOICE_PKT_PING:
                        /* Keepalive ping - update client lastSeen */
                        if (received >= 2) {
                            uint8_t clientId = buffer[1];
                            for (int i = 0; i < g_numClients; i++) {
                                if (g_clients[i].clientId == clientId) {
                                    g_clients[i].lastSeen = time(NULL);
                                    break;
                                }
                            }
                        }
                        break;

                    case VOICE_PKT_DEBUG:
                        /* Debug message from client - log it */
                        if (received >= 3) {
                            uint8_t clientId = buffer[1];
                            char *msg = (char*)&buffer[2];
                            /* Ensure null terminated */
                            buffer[received] = '\0';
                            printf("[DEBUG] Client %u from %s:%d: %s\n",
                                   clientId,
                                   inet_ntoa(clientAddr.sin_addr),
                                   ntohs(clientAddr.sin_port),
                                   msg);
                            fflush(stdout);
                        }
                        break;

                    default:
                        /* Unknown packet type */
                        break;
                }
            }
        }

        /* Print stats every 30 seconds */
        time_t now = time(NULL);
        if (now - lastStatTime >= 30) {
            printf("--- Clients: %d, Received: %lu, Routed: %lu ---\n",
                   g_numClients,
                   (unsigned long)g_totalPacketsReceived,
                   (unsigned long)g_totalPacketsRouted);
            lastStatTime = now;
        }
    }
}

/*
 * Print usage
 */
static void printUsage(const char *progName) {
    printf("ET:Legacy Voice Routing Server\n");
    printf("Usage: %s [port] [game_server_port]\n", progName);
    printf("  Default voice port: %d\n", DEFAULT_PORT);
    printf("  Default game port:  %d\n", DEFAULT_GAME_PORT);
    printf("\nThe voice server runs alongside the ET:Legacy game server.\n");
    printf("Clients connect to voice_port (game_port + 1 by default).\n");
}

/*
 * Main function
 */
int main(int argc, char *argv[]) {
    int port = DEFAULT_PORT;

    /* Parse arguments */
    if (argc >= 2) {
        if (strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0) {
            printUsage(argv[0]);
            return 0;
        }
        port = atoi(argv[1]);
        if (port <= 0 || port > 65535) {
            fprintf(stderr, "Invalid port number: %s\n", argv[1]);
            return 1;
        }
    }
    if (argc >= 3) {
        g_gameServerPort = atoi(argv[2]);
    }

    printf("===========================================\n");
    printf("  ET:Legacy Voice Routing Server v1.0\n");
    printf("===========================================\n\n");

    /* Setup signal handler */
    signal(SIGINT, signalHandler);
#ifndef _WIN32
    signal(SIGTERM, signalHandler);
#endif

    /* Initialize server */
    if (!initServer(port)) {
        fprintf(stderr, "Failed to initialize server\n");
        return 1;
    }

    /* Initialize client tracking */
    memset(g_clients, 0, sizeof(g_clients));

    /* Run server */
    serverLoop();

    /* Print final stats */
    printStats();

    /* Cleanup */
    cleanupServer();

    printf("Voice server stopped.\n");
    return 0;
}
