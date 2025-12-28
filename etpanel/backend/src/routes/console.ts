import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sendRcon, getPlayers } from '../services/rcon.js';
import { requireModerator, requireAdmin, authenticate } from '../middleware/auth.js';
import { consoleTail, ConsoleLine } from '../services/consoleTail.js';
import { panelMessageTail } from '../services/panelMessageTail.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

// Helper to get fresh display name from database
async function getDisplayName(userId: number): Promise<string> {
  const [user] = await db
    .select({ displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user?.displayName || 'Unknown';
}

const chatSchema = z.object({
  message: z.string().min(1).max(200),
});

const directMessageSchema = z.object({
  slot: z.number().int().min(0).max(63),
  message: z.string().min(1).max(200),
});

const commandSchema = z.object({
  command: z.string().min(1).max(500),
});

export const consoleRoutes: FastifyPluginAsync = async (fastify) => {
  // Get recent console output (authenticated)
  fastify.get('/recent', { preHandler: authenticate }, async (request, reply) => {
    const count = Math.min(parseInt((request.query as any)?.count || '100'), 200);
    return {
      lines: consoleTail.getRecentLines(count),
      logPath: consoleTail.getLogPath(),
    };
  });

  // Get recent direct messages from players (authenticated)
  fastify.get('/messages', { preHandler: authenticate }, async (request, reply) => {
    const count = Math.min(parseInt((request.query as any)?.count || '50'), 100);
    return {
      messages: panelMessageTail.getRecentMessages(count),
    };
  });

  // Send chat message to server (all authenticated users)
  fastify.post('/say', { preHandler: authenticate }, async (request, reply) => {
    const body = chatSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid message' });
    }

    // Sanitize message - remove special characters that could break RCON
    const sanitized = body.data.message
      .replace(/"/g, "'")
      .replace(/\\/g, '')
      .replace(/;/g, '');

    // Get fresh display name from database
    const displayName = await getDisplayName(request.user.userId);

    // Use "qsay" command via RCON - broadcasts to all players without sender prefix
    // Format: PlayerName: message
    const result = await sendRcon(`qsay "^7${displayName}^7: ${sanitized}"`);

    fastify.log.info(
      { user: request.user.email, message: sanitized },
      'Chat message sent to server'
    );

    return {
      success: result.success,
      message: sanitized,
      error: result.error,
    };
  });

  // Send direct message to specific player (moderator+)
  fastify.post('/dm', { preHandler: requireModerator }, async (request, reply) => {
    const body = directMessageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request', details: body.error.errors });
    }

    // Verify player is online
    const players = await getPlayers();
    const targetPlayer = players.find((p) => p.slot === body.data.slot);

    if (!targetPlayer) {
      return reply.status(404).send({ error: 'Player not found or not online' });
    }

    // Sanitize message
    const sanitized = body.data.message
      .replace(/"/g, "'")
      .replace(/\\/g, '')
      .replace(/;/g, '');

    // Get fresh display name from database
    const displayName = await getDisplayName(request.user.userId);

    // Send private message to player using ET's "m" (private message) command
    // Format: m <slot> <message> - sends a private message only visible to that player
    // The message appears as: [msg]: YourName: message
    // Use the "m" command for private messaging (ET:Legacy built-in)
    // This sends: "[msg]: fromName: message" to the target player only
    await sendRcon(`m ${body.data.slot} "^3${displayName}^7: ${sanitized}"`);

    // Also send a subtle center print so they notice
    await sendRcon(`cpmsay ${body.data.slot} "^3Private message from ${displayName}"`);

    fastify.log.info(
      {
        user: request.user.email,
        displayName,
        targetSlot: body.data.slot,
        targetName: targetPlayer.name,
        message: sanitized,
      },
      'Direct message sent to player'
    );

    return {
      success: true,
      targetSlot: body.data.slot,
      targetName: targetPlayer.name,
      message: sanitized,
      fromName: displayName,
      hint: 'Player can reply with: /pm <message> or /r <message>',
    };
  });

  // Get current players with slot info for DM (authenticated)
  fastify.get('/players', { preHandler: authenticate }, async () => {
    const players = await getPlayers();
    return {
      players: players.map((p) => ({
        slot: p.slot,
        name: p.name,
        score: p.score,
        ping: p.ping,
        isBot: p.ping === 0,
      })),
    };
  });

  // Execute RCON command (admin only)
  fastify.post('/command', { preHandler: requireModerator }, async (request, reply) => {
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
      'RCON command executed via console'
    );

    return result;
  });
};
