/**
 * Voice Chat Echo Server - Standalone Test
 *
 * Simple UDP server that echoes voice packets back to sender.
 * Used for testing the voice chat client before full integration.
 *
 * In a real implementation, this would be replaced by a routing
 * server that forwards voice to appropriate recipients based on
 * team/channel/proximity.
 *
 * Usage: ./voice_server [port]
 *        Default port: 27961
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

#define DEFAULT_PORT    27961
#define MAX_PACKET_SIZE 512
#define MAX_CLIENTS     64

/*
 * Packet Types (must match client)
 */
#define VOICE_PACKET_AUDIO  0x01
#define VOICE_PACKET_PING   0x02

/*
 * Voice Packet Header (must match client)
 */
#pragma pack(push, 1)
typedef struct {
    uint8_t  type;
    uint32_t clientId;
    uint32_t sequence;
    uint8_t  channel;
    uint16_t opusLen;
} VoicePacketHeader;
#pragma pack(pop)

/*
 * Client tracking
 */
typedef struct {
    struct sockaddr_in addr;
    uint32_t clientId;
    time_t lastSeen;
    uint32_t packetsReceived;
    uint32_t packetsSent;
} ClientInfo;

/*
 * Global state
 */
static volatile bool g_running = true;
static SOCKET g_socket = INVALID_SOCKET;
static ClientInfo g_clients[MAX_CLIENTS];
static int g_numClients = 0;

/* Statistics */
static uint64_t g_totalPacketsReceived = 0;
static uint64_t g_totalPacketsSent = 0;
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
 * Find or create client entry
 */
static ClientInfo* findOrCreateClient(struct sockaddr_in *addr, uint32_t clientId) {
    time_t now = time(NULL);

    /* Look for existing client */
    for (int i = 0; i < g_numClients; i++) {
        if (g_clients[i].clientId == clientId) {
            g_clients[i].lastSeen = now;
            return &g_clients[i];
        }
    }

    /* Clean up stale clients (not seen in 30 seconds) */
    for (int i = 0; i < g_numClients; i++) {
        if (now - g_clients[i].lastSeen > 30) {
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
        client->addr = *addr;
        client->clientId = clientId;
        client->lastSeen = now;
        client->packetsReceived = 0;
        client->packetsSent = 0;

        printf("New client %u connected from %s:%d\n",
               clientId,
               inet_ntoa(addr->sin_addr),
               ntohs(addr->sin_port));

        return client;
    }

    return NULL;  /* Server full */
}

/*
 * Get client by address (for responses)
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

    /* Set receive timeout so we can check g_running periodically */
#ifdef _WIN32
    DWORD timeout = 100;  /* 100ms */
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

    printf("Server listening on UDP port %d\n", port);
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
    printf("\n=== Server Statistics ===\n");
    printf("Active clients:    %d\n", g_numClients);
    printf("Total received:    %lu packets (%lu bytes)\n",
           (unsigned long)g_totalPacketsReceived,
           (unsigned long)g_totalBytesReceived);
    printf("Total sent:        %lu packets\n",
           (unsigned long)g_totalPacketsSent);

    if (g_numClients > 0) {
        printf("\nPer-client stats:\n");
        for (int i = 0; i < g_numClients; i++) {
            printf("  Client %u (%s:%d): recv=%u sent=%u\n",
                   g_clients[i].clientId,
                   inet_ntoa(g_clients[i].addr.sin_addr),
                   ntohs(g_clients[i].addr.sin_port),
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

    printf("\nServer running. Press Ctrl+C to stop.\n\n");

    while (g_running) {
        clientLen = sizeof(clientAddr);

        /* Receive packet (blocking with timeout would be better) */
        int received = recvfrom(g_socket, (char*)buffer, sizeof(buffer), 0,
                                (struct sockaddr*)&clientAddr, &clientLen);

        if (received > 0) {
            g_totalPacketsReceived++;
            g_totalBytesReceived += received;

            /* Parse packet header */
            if (received >= (int)sizeof(VoicePacketHeader)) {
                VoicePacketHeader *header = (VoicePacketHeader*)buffer;

                if (header->type == VOICE_PACKET_AUDIO) {
                    uint32_t clientId = ntohl(header->clientId);
                    uint32_t sequence = ntohl(header->sequence);
                    uint16_t opusLen = ntohs(header->opusLen);

                    /* Track client */
                    ClientInfo *client = findOrCreateClient(&clientAddr, clientId);
                    if (client) {
                        client->packetsReceived++;

                        /* Echo back to sender (for testing) */
                        int sent = sendto(g_socket, (char*)buffer, received, 0,
                                         (struct sockaddr*)&clientAddr, clientLen);

                        if (sent > 0) {
                            client->packetsSent++;
                            g_totalPacketsSent++;
                        }

                        /* Log every 100th packet to avoid spam */
                        if (client->packetsReceived % 100 == 1) {
                            printf("Client %u: seq=%u, opus=%u bytes\n",
                                   clientId, sequence, opusLen);
                        }
                    }
                }
            }
        }

        /* Print stats every 10 seconds */
        time_t now = time(NULL);
        if (now - lastStatTime >= 10) {
            printf("--- Active: %d clients, Packets: recv=%lu sent=%lu ---\n",
                   g_numClients,
                   (unsigned long)g_totalPacketsReceived,
                   (unsigned long)g_totalPacketsSent);
            lastStatTime = now;
        }

        /* No explicit sleep needed - SO_RCVTIMEO handles pacing */
    }
}

/*
 * Print usage
 */
static void printUsage(const char *progName) {
    printf("Voice Chat Echo Server - ET:Legacy PoC\n");
    printf("Usage: %s [port]\n", progName);
    printf("  Default port: %d\n", DEFAULT_PORT);
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

    printf("=== Voice Chat Echo Server ===\n");

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

    printf("Server stopped.\n");
    return 0;
}
