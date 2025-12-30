import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sendRcon, getPlayers } from '../services/rcon.js';
import { requireAdmin } from '../middleware/auth.js';

const kickSchema = z.object({
  reason: z.string().max(200).optional(),
});

const banSchema = z.object({
  reason: z.string().max(200).optional(),
  duration: z.number().min(0).optional(), // 0 = permanent, else minutes
});

const commandSchema = z.object({
  command: z.string().min(1).max(500),
});

export const serverAdminRoutes: FastifyPluginAsync = async (fastify) => {
  // Kick a player by slot (admin only)
  fastify.post<{ Params: { slot: string } }>(
    '/kick/:slot',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const slot = parseInt(request.params.slot);
      if (isNaN(slot) || slot < 0 || slot > 63) {
        return reply.status(400).send({ error: 'Invalid slot number' });
      }

      const body = kickSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      // Get player name for logging
      const players = await getPlayers();
      const player = players.find((p) => p.slot === slot);

      if (!player) {
        return reply.status(404).send({ error: 'Player not found in slot' });
      }

      // Execute kick command
      const reason = body.data.reason ? ` "${body.data.reason}"` : '';
      const result = await sendRcon(`kick ${slot}${reason}`);

      fastify.log.info(
        {
          user: request.user.email,
          action: 'kick',
          playerSlot: slot,
          playerName: player.name,
          reason: body.data.reason,
        },
        'Player kicked by admin'
      );

      return {
        success: result.success,
        message: `Kicked ${player.name}`,
        playerName: player.name,
        reason: body.data.reason,
      };
    }
  );

  // Ban a player by slot (admin only)
  fastify.post<{ Params: { slot: string } }>(
    '/ban/:slot',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const slot = parseInt(request.params.slot);
      if (isNaN(slot) || slot < 0 || slot > 63) {
        return reply.status(400).send({ error: 'Invalid slot number' });
      }

      const body = banSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      // Get player name for logging
      const players = await getPlayers();
      const player = players.find((p) => p.slot === slot);

      if (!player) {
        return reply.status(404).send({ error: 'Player not found in slot' });
      }

      // ET:Legacy uses "ban" command for IP bans
      // Format: ban <slot> [duration_in_seconds] [reason]
      const duration = body.data.duration ? body.data.duration * 60 : 0; // Convert minutes to seconds
      const reason = body.data.reason || 'Banned by admin';

      // First kick the player, then add to ban list
      await sendRcon(`kick ${slot}`);

      // Add IP ban using clientkick with ban
      // ET:Legacy's ban command format varies by mod, using pb_sv_ban or similar
      // For vanilla ET:Legacy, we use the ban command
      const banResult = await sendRcon(`ban ${slot} ${duration} "${reason}"`);

      fastify.log.info(
        {
          user: request.user.email,
          action: 'ban',
          playerSlot: slot,
          playerName: player.name,
          reason: body.data.reason,
          duration: body.data.duration,
        },
        'Player banned by admin'
      );

      return {
        success: true,
        message: `Banned ${player.name}`,
        playerName: player.name,
        reason: body.data.reason,
        duration: body.data.duration || 'permanent',
      };
    }
  );

  // Execute RCON command (admin only)
  fastify.post('/command', { preHandler: requireAdmin }, async (request, reply) => {
    const body = commandSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid command' });
    }

    // Block dangerous commands
    const dangerous = ['quit', 'exec', 'writeconfig', 'killserver'];
    const cmdLower = body.data.command.toLowerCase().trim();
    if (dangerous.some((d) => cmdLower.startsWith(d))) {
      return reply.status(403).send({ error: 'Command not allowed via API' });
    }

    const result = await sendRcon(body.data.command);

    fastify.log.info(
      { user: request.user.email, command: body.data.command },
      'Admin RCON command executed'
    );

    return {
      success: result.success,
      response: result.response,
      error: result.error,
    };
  });

  // Get extended game info (admin only)
  fastify.get('/game-info', { preHandler: requireAdmin }, async () => {
    // Get various game state CVARs
    const cvars = ['timelimit', 'g_gamestate', 'g_currentRound', 'g_axisscore', 'g_alliedscore', 'etpanel_leveltime'];
    const results: Record<string, string> = {};

    for (const cvar of cvars) {
      const result = await sendRcon(cvar);
      if (result.success) {
        // Parse response like: "timelimit" is: "30"^7 default: "0"
        // or just: "timelimit" is:"30"
        const match = result.response.match(/"([^"]+)" is:\s*"([^"]*)"/);
        if (match) {
          // Strip ET color codes (^0-^9, ^a-^z) from values
          results[match[1]] = match[2].replace(/\^[0-9a-zA-Z]/g, '');
        }
      }
    }

    // Get level time from our Lua-set CVAR (in milliseconds)
    const levelTimeStr = results['etpanel_leveltime'];
    let levelTime = levelTimeStr ? parseInt(levelTimeStr) : undefined;

    // If Lua CVAR not set, try to get server time from "status" command output
    // The status command shows: "server time           : 123456"
    if (levelTime === undefined || levelTime === 0) {
      const statusResult = await sendRcon('status');
      if (statusResult.success) {
        // Parse: "server time           : 123456"
        const serverTimeMatch = statusResult.response.match(/server time\s*:\s*(\d+)/i);
        if (serverTimeMatch) {
          levelTime = parseInt(serverTimeMatch[1]);
        }
      }
    }

    let timeRemaining: number | undefined;
    const timelimit = parseInt(results['timelimit']) || 0;

    if (timelimit > 0 && levelTime !== undefined && levelTime > 0) {
      // timelimit is in minutes, levelTime is in milliseconds
      const timelimitMs = timelimit * 60 * 1000;
      const remainingMs = timelimitMs - levelTime;
      timeRemaining = Math.max(0, Math.floor(remainingMs / 1000));
    }

    return {
      timelimit: results['timelimit'],
      gameState: results['g_gamestate'],
      currentRound: results['g_currentRound'],
      axisScore: results['g_axisscore'] ? parseInt(results['g_axisscore']) : undefined,
      alliesScore: results['g_alliedscore'] ? parseInt(results['g_alliedscore']) : undefined,
      timeRemaining,
      serverTime: levelTime ? Math.floor(levelTime / 1000) : undefined, // Elapsed time in seconds
    };
  });

  // List available maps (admin only)
  fastify.get('/maps', { preHandler: requireAdmin }, async () => {
    // Get map list from server
    const result = await sendRcon('dir maps bsp');

    if (!result.success) {
      return { maps: [] };
    }

    // Parse map names from directory listing
    const maps = result.response
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.bsp'))
      .map((line) => line.replace('.bsp', ''))
      .sort();

    return { maps };
  });
};
