import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { config, isDev } from './config.js';
import { db, closeDb } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/server.js';
import { serverAdminRoutes } from './routes/server-admin.js';
import { playerRoutes } from './routes/players.js';
import { configRoutes } from './routes/config.js';
import { scheduleRoutes } from './routes/schedule.js';
import { gameRoutes } from './routes/game.js';
import { consoleRoutes } from './routes/console.js';
import { userRoutes } from './routes/users.js';
import { logsRoutes } from './routes/logs.js';
import { browserRoutes } from './routes/browser.js';
import { soundsRoutes } from './routes/sounds.js';
import { adminRoutes } from './routes/admin.js';
import { settingsRoutes } from './routes/settings.js';
import { setupWebSocket } from './websocket/index.js';

const fastify = Fastify({
  logger: {
    level: isDev ? 'debug' : 'info',
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  },
});

async function start() {
  try {
    // Register plugins
    await fastify.register(cors, {
      origin: isDev ? true : ['https://etpanel.etman.dev', 'https://etpanel.coolip.me'],
      credentials: true,
    });

    await fastify.register(jwt, {
      secret: config.JWT_SECRET,
    });

    await fastify.register(websocket);

    await fastify.register(multipart, {
      limits: {
        fileSize: 20 * 1024 * 1024, // 20MB max (for clip editor - final clips are limited to 30 seconds)
      },
    });

    // Disable browser caching for all API responses
    fastify.addHook('onSend', async (request, reply) => {
      // Only add no-cache headers for API routes
      if (request.url.startsWith('/api/')) {
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        reply.header('Pragma', 'no-cache');
        reply.header('Expires', '0');
      }
    });

    // Health check
    fastify.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    // Register routes
    await fastify.register(authRoutes, { prefix: '/api/auth' });
    await fastify.register(serverRoutes, { prefix: '/api/server' });
    await fastify.register(serverAdminRoutes, { prefix: '/api/server-admin' });
    await fastify.register(playerRoutes, { prefix: '/api/players' });
    await fastify.register(configRoutes, { prefix: '/api/config' });
    await fastify.register(scheduleRoutes, { prefix: '/api/schedule' });
    await fastify.register(gameRoutes, { prefix: '/api/game' });
    await fastify.register(consoleRoutes, { prefix: '/api/console' });
    await fastify.register(userRoutes, { prefix: '/api/users' });
    await fastify.register(logsRoutes, { prefix: '/api/logs' });
    await fastify.register(browserRoutes, { prefix: '/api/browser' });
    await fastify.register(soundsRoutes, { prefix: '/api/sounds' });
    await fastify.register(adminRoutes, { prefix: '/api/admin' });
    await fastify.register(settingsRoutes, { prefix: '/api/settings' });

    // WebSocket setup
    setupWebSocket(fastify);

    // Graceful shutdown
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        fastify.log.info(`Received ${signal}, shutting down...`);
        await fastify.close();
        await closeDb();
        process.exit(0);
      });
    });

    // Start server
    await fastify.listen({
      port: config.PORT,
      host: config.HOST,
    });

    fastify.log.info(`🚀 ET Panel API running on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

export { fastify };
