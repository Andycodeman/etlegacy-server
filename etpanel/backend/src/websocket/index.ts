import { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import { consoleTail, ConsoleLine } from '../services/consoleTail.js';
import { panelMessageTail, PlayerMessage } from '../services/panelMessageTail.js';

const clients = new Set<WebSocket>();

// Track which clients want console output
const consoleSubscribers = new Set<WebSocket>();

export function setupWebSocket(fastify: FastifyInstance) {
  // Start tailing services
  consoleTail.start();
  panelMessageTail.start();

  // Forward console lines to subscribed WebSocket clients
  consoleTail.on('line', (line: ConsoleLine) => {
    const message = JSON.stringify({ type: 'console_line', data: line });
    for (const client of consoleSubscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  // Forward player DMs to all subscribed WebSocket clients
  panelMessageTail.on('message', (msg: PlayerMessage) => {
    const message = JSON.stringify({ type: 'player_dm', data: msg });
    for (const client of consoleSubscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  fastify.get('/ws', { websocket: true }, (socket, req) => {
    clients.add(socket);

    fastify.log.info(`WebSocket client connected (${clients.size} total)`);

    socket.on('message', (message: RawData) => {
      try {
        const data = JSON.parse(message.toString());
        fastify.log.debug({ msg: 'WebSocket message', data });

        // Handle console subscription requests
        if (data.type === 'subscribe_console') {
          consoleSubscribers.add(socket);
          fastify.log.info(`Client subscribed to console (${consoleSubscribers.size} subscribers)`);

          // Send recent lines immediately
          const recentLines = consoleTail.getRecentLines(50);
          socket.send(
            JSON.stringify({
              type: 'console_history',
              data: recentLines,
            })
          );
        }

        if (data.type === 'unsubscribe_console') {
          consoleSubscribers.delete(socket);
          fastify.log.info(`Client unsubscribed from console (${consoleSubscribers.size} subscribers)`);
        }
      } catch (err) {
        fastify.log.error({ msg: 'Invalid WebSocket message', error: err });
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      consoleSubscribers.delete(socket);
      fastify.log.info(`WebSocket client disconnected (${clients.size} remaining)`);
    });

    socket.on('error', (err: Error) => {
      fastify.log.error({ msg: 'WebSocket error', error: err });
      clients.delete(socket);
      consoleSubscribers.delete(socket);
    });

    // Send initial connection confirmation
    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });
}

export function broadcast(message: unknown) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function getClientCount() {
  return clients.size;
}
