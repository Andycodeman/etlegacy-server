import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  handlePlayerConnect,
  handlePlayerDisconnect,
  handleKill,
  handleDeath,
  handleChat,
  type PlayerConnectEvent,
  type PlayerDisconnectEvent,
  type KillEvent,
  type DeathEvent,
  type ChatEvent,
} from '../services/gameEvents.js';

const playerConnectSchema = z.object({
  slot: z.number().int().min(0).max(63),
  name: z.string(),
  display_name: z.string().optional(),  // Original name with ET color codes
  guid: z.string().max(32),
  timestamp: z.number(),
});

const playerDisconnectSchema = z.object({
  slot: z.number().int().min(0).max(63),
  name: z.string(),
  guid: z.string().max(32),
  playtime: z.number().int().min(0),
  timestamp: z.number(),
});

const killSchema = z.object({
  killer_slot: z.number().int().min(0).max(63),
  killer_name: z.string(),
  killer_display_name: z.string().optional(),  // With color codes
  killer_guid: z.string().max(32),
  victim_slot: z.number().int().min(0).max(63),
  victim_name: z.string(),
  victim_display_name: z.string().optional(),  // With color codes
  victim_guid: z.string().max(32),  // Now includes BOT_xxx for bots
  victim_is_bot: z.boolean().optional(),
  is_team_kill: z.boolean().optional(),
  kill_type: z.enum(['human', 'bot', 'teamkill']).optional(),
  weapon: z.string(),
  map: z.string(),
  timestamp: z.number(),
});

const deathSchema = z.object({
  slot: z.number().int().min(0).max(63),
  name: z.string(),
  display_name: z.string().optional(),  // With color codes
  guid: z.string().max(32),
  killer_slot: z.number().int().optional(),
  killer_name: z.string().optional(),
  killer_display_name: z.string().optional(),  // With color codes
  killer_guid: z.string().max(32).optional(),  // Now includes BOT_xxx for bots
  killer_is_bot: z.boolean().optional(),
  is_team_kill: z.boolean().optional(),
  death_type: z.enum(['human', 'bot', 'suicide', 'teamkill']),
  cause: z.string(),
  map: z.string().optional(),
  timestamp: z.number(),
});

const chatSchema = z.object({
  slot: z.number().int().min(0).max(63),
  name: z.string(),
  guid: z.string().max(32),
  message: z.string(),
  team: z.boolean(),
  timestamp: z.number(),
});

// Verify API key from game server
function verifyApiKey(request: FastifyRequest): boolean {
  const apiKey = request.headers['x-api-key'];
  return apiKey === config.GAME_API_KEY;
}

export const gameRoutes: FastifyPluginAsync = async (fastify) => {
  // Middleware to verify API key for all game routes
  fastify.addHook('preHandler', async (request, reply) => {
    if (!verifyApiKey(request)) {
      reply.status(401).send({ error: 'Invalid API key' });
    }
  });

  // Player connected
  fastify.post('/player-connect', async (request, reply) => {
    const body = playerConnectSchema.safeParse(request.body);
    if (!body.success) {
      fastify.log.warn({ errors: body.error.errors, body: request.body }, 'Invalid player-connect event');
      return reply.status(400).send({ error: 'Invalid event data' });
    }

    await handlePlayerConnect(body.data as PlayerConnectEvent);
    return { success: true };
  });

  // Player disconnected
  fastify.post('/player-disconnect', async (request, reply) => {
    const body = playerDisconnectSchema.safeParse(request.body);
    if (!body.success) {
      fastify.log.warn({ errors: body.error.errors, body: request.body }, 'Invalid player-disconnect event');
      return reply.status(400).send({ error: 'Invalid event data' });
    }

    await handlePlayerDisconnect(body.data as PlayerDisconnectEvent);
    return { success: true };
  });

  // Kill event (human kills bot or human)
  fastify.post('/kill', async (request, reply) => {
    const body = killSchema.safeParse(request.body);
    if (!body.success) {
      fastify.log.warn({ errors: body.error.errors, body: request.body }, 'Invalid kill event');
      return reply.status(400).send({ error: 'Invalid event data' });
    }

    await handleKill(body.data as KillEvent);
    return { success: true };
  });

  // Death event (human dies to bot, human, or suicide)
  fastify.post('/death', async (request, reply) => {
    const body = deathSchema.safeParse(request.body);
    if (!body.success) {
      fastify.log.warn({ errors: body.error.errors, body: request.body }, 'Invalid death event');
      return reply.status(400).send({ error: 'Invalid event data' });
    }

    await handleDeath(body.data as DeathEvent);
    return { success: true };
  });

  // Chat message
  fastify.post('/chat', async (request, reply) => {
    const body = chatSchema.safeParse(request.body);
    if (!body.success) {
      fastify.log.warn({ errors: body.error.errors, body: request.body }, 'Invalid chat event');
      return reply.status(400).send({ error: 'Invalid event data' });
    }

    await handleChat(body.data as ChatEvent);
    return { success: true };
  });

  // Round end
  fastify.post('/round-end', async (request, reply) => {
    // TODO: Handle round end event
    fastify.log.info({ data: request.body }, 'Round ended');
    return { success: true };
  });
};
