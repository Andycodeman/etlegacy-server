import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sendRcon, getServerStatus, getPlayers } from '../services/rcon.js';
import { requireAdmin, requireModerator, authenticate } from '../middleware/auth.js';
import { getClientCount } from '../websocket/index.js';

const commandSchema = z.object({
  command: z.string().min(1).max(500),
});

const mapSchema = z.object({
  map: z.string().min(1).max(100),
});

export const serverRoutes: FastifyPluginAsync = async (fastify) => {
  // Get server status (public)
  fastify.get('/status', async () => {
    const status = await getServerStatus();
    const players = status.online ? await getPlayers() : [];

    return {
      ...status,
      players,
      wsClients: getClientCount(),
    };
  });

  // Restart server (admin only)
  fastify.post('/restart', { preHandler: requireAdmin }, async (request, reply) => {
    const result = await sendRcon('quit');
    // Note: Server should auto-restart via systemd

    fastify.log.info({ user: request.user.email }, 'Server restart requested');

    return {
      success: true,
      message: 'Server restart initiated',
      rconResponse: result.response,
    };
  });

  // Execute RCON command (admin only)
  fastify.post('/command', { preHandler: requireAdmin }, async (request, reply) => {
    const body = commandSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid command' });
    }

    // Block dangerous commands
    const dangerous = ['quit', 'exec', 'writeconfig', 'killserver'];
    const cmdLower = body.data.command.toLowerCase();
    if (dangerous.some((d) => cmdLower.startsWith(d))) {
      return reply.status(403).send({ error: 'Command not allowed via API' });
    }

    const result = await sendRcon(body.data.command);

    fastify.log.info(
      { user: request.user.email, command: body.data.command },
      'RCON command executed'
    );

    return result;
  });

  // Change map (moderator+)
  fastify.post('/map', { preHandler: requireModerator }, async (request, reply) => {
    const body = mapSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid map name' });
    }

    const result = await sendRcon(`map ${body.data.map}`);

    fastify.log.info({ user: request.user.email, map: body.data.map }, 'Map change requested');

    return {
      success: result.success,
      message: `Changing map to ${body.data.map}`,
      rconResponse: result.response,
    };
  });

  // Get current CVARs (authenticated)
  fastify.get('/cvars', { preHandler: authenticate }, async () => {
    // Get commonly used CVARs
    const cvars = [
      'g_gravity',
      'g_speed',
      'g_knockback',
      'sv_maxclients',
      'g_warmup',
      'timelimit',
      'g_soldierAllWeapons',
      'g_panzerFireRate',
      'g_panzerfestEnabled',
      'mapname',
    ];

    const results: Record<string, string> = {};

    for (const cvar of cvars) {
      const result = await sendRcon(cvar);
      if (result.success) {
        // Parse response like: "g_gravity" is: "350"^7 default: "800"
        const match = result.response.match(/"([^"]+)" is:\s*"([^"]*)"/);
        if (match) {
          results[match[1]] = match[2];
        }
      }
    }

    return results;
  });
};
