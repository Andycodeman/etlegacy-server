import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { desc, sql, eq, like, or, and, isNull, gt, asc } from 'drizzle-orm';
import { authenticate, requireModerator, requireAdmin } from '../middleware/auth.js';
import { sendRcon, sendRconMultiple } from '../services/rcon.js';

// Validation schemas
const setLevelSchema = z.object({
  level: z.number().int().min(0).max(5),
});

const banSchema = z.object({
  reason: z.string().max(500).optional(),
  duration: z.number().int().positive().optional(), // minutes, null = permanent
});

const unbanSchema = z.object({
  banId: z.number().int().positive(),
});

const searchSchema = z.object({
  search: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// Helper: Strip ET color codes from name
function stripColors(name: string): string {
  return name.replace(/\^[0-9a-zA-Z]/g, '');
}

// Helper: Format duration nicely
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // ============================================================================
  // LEVELS
  // ============================================================================

  // Get all admin levels
  fastify.get('/levels', { preHandler: authenticate }, async () => {
    const levels = await db
      .select()
      .from(schema.adminLevels)
      .orderBy(asc(schema.adminLevels.level));

    return { levels };
  });

  // ============================================================================
  // PLAYERS
  // ============================================================================

  // Get admin players list with search
  fastify.get('/players', { preHandler: requireModerator }, async (request) => {
    const { search = '', limit = 50, offset = 0 } = request.query as {
      search?: string;
      limit?: number;
      offset?: number;
    };

    const searchTerm = search?.trim() ? `%${search.trim().toLowerCase()}%` : null;

    // Get players with their level and latest alias
    const players = await db
      .select({
        id: schema.adminPlayers.id,
        guid: schema.adminPlayers.guid,
        levelId: schema.adminPlayers.levelId,
        levelName: schema.adminLevels.name,
        levelNum: schema.adminLevels.level,
        createdAt: schema.adminPlayers.createdAt,
        lastSeen: schema.adminPlayers.lastSeen,
        timesSeen: schema.adminPlayers.timesSeen,
      })
      .from(schema.adminPlayers)
      .leftJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
      .orderBy(desc(schema.adminPlayers.lastSeen))
      .limit(Math.min(limit, 100))
      .offset(offset);

    // For each player, get their latest alias
    const playersWithAliases = await Promise.all(
      players.map(async (player) => {
        const [latestAlias] = await db
          .select({ alias: schema.adminAliases.alias })
          .from(schema.adminAliases)
          .where(eq(schema.adminAliases.playerId, player.id))
          .orderBy(desc(schema.adminAliases.lastUsed))
          .limit(1);

        return {
          ...player,
          name: latestAlias?.alias || 'Unknown',
          cleanName: latestAlias ? stripColors(latestAlias.alias) : 'Unknown',
        };
      })
    );

    // Filter by search if provided
    const filtered = searchTerm
      ? playersWithAliases.filter(
          (p) =>
            p.cleanName.toLowerCase().includes(search.toLowerCase()) ||
            p.guid.toLowerCase().includes(search.toLowerCase())
        )
      : playersWithAliases;

    // Get total count
    const [{ count: totalCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.adminPlayers);

    return {
      players: filtered,
      total: Number(totalCount),
      limit,
      offset,
    };
  });

  // Get single player details with aliases, warnings, bans
  fastify.get('/players/:guid', { preHandler: requireModerator }, async (request, reply) => {
    const { guid } = request.params as { guid: string };

    // Get player
    const [player] = await db
      .select({
        id: schema.adminPlayers.id,
        guid: schema.adminPlayers.guid,
        levelId: schema.adminPlayers.levelId,
        levelName: schema.adminLevels.name,
        levelNum: schema.adminLevels.level,
        createdAt: schema.adminPlayers.createdAt,
        lastSeen: schema.adminPlayers.lastSeen,
        timesSeen: schema.adminPlayers.timesSeen,
      })
      .from(schema.adminPlayers)
      .leftJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
      .where(eq(schema.adminPlayers.guid, guid))
      .limit(1);

    if (!player) {
      return reply.status(404).send({ error: 'Player not found' });
    }

    // Get aliases
    const aliases = await db
      .select()
      .from(schema.adminAliases)
      .where(eq(schema.adminAliases.playerId, player.id))
      .orderBy(desc(schema.adminAliases.lastUsed));

    // Get warnings
    const warnings = await db
      .select({
        id: schema.adminWarnings.id,
        reason: schema.adminWarnings.reason,
        issuedAt: schema.adminWarnings.issuedAt,
        warnedBy: schema.adminWarnings.warnedBy,
      })
      .from(schema.adminWarnings)
      .where(eq(schema.adminWarnings.playerId, player.id))
      .orderBy(desc(schema.adminWarnings.issuedAt));

    // Get ban history
    const bans = await db
      .select()
      .from(schema.adminBans)
      .where(eq(schema.adminBans.playerId, player.id))
      .orderBy(desc(schema.adminBans.issuedAt));

    // Get mute history
    const mutes = await db
      .select()
      .from(schema.adminMutes)
      .where(eq(schema.adminMutes.playerId, player.id))
      .orderBy(desc(schema.adminMutes.issuedAt));

    // Get recent command logs for this player
    const commandLogs = await db
      .select()
      .from(schema.adminCommandLog)
      .where(eq(schema.adminCommandLog.playerId, player.id))
      .orderBy(desc(schema.adminCommandLog.executedAt))
      .limit(50);

    return {
      player,
      aliases: aliases.map((a) => ({
        ...a,
        cleanAlias: stripColors(a.alias),
      })),
      warnings,
      bans,
      mutes,
      commandLogs,
    };
  });

  // Set player admin level
  fastify.put('/players/:guid/level', { preHandler: requireAdmin }, async (request, reply) => {
    const { guid } = request.params as { guid: string };
    const body = setLevelSchema.safeParse(request.body);

    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid level', details: body.error.flatten() });
    }

    const { level } = body.data;

    // Get level ID
    const [levelRow] = await db
      .select()
      .from(schema.adminLevels)
      .where(eq(schema.adminLevels.level, level))
      .limit(1);

    if (!levelRow) {
      return reply.status(400).send({ error: `Level ${level} not found` });
    }

    // Get player
    const [player] = await db
      .select()
      .from(schema.adminPlayers)
      .where(eq(schema.adminPlayers.guid, guid))
      .limit(1);

    if (!player) {
      return reply.status(404).send({ error: 'Player not found' });
    }

    // Update level
    await db
      .update(schema.adminPlayers)
      .set({ levelId: levelRow.id })
      .where(eq(schema.adminPlayers.id, player.id));

    // Log the action
    await db.insert(schema.adminCommandLog).values({
      playerId: player.id,
      command: 'setlevel',
      args: `${level}`,
      targetPlayerId: player.id,
      success: true,
      source: 'etpanel',
    });

    fastify.log.info({ adminUser: request.user.email, guid, newLevel: level }, 'Admin level changed');

    return {
      success: true,
      message: `Set ${guid} to level ${level} (${levelRow.name})`,
    };
  });

  // ============================================================================
  // BANS
  // ============================================================================

  // Get active bans
  fastify.get('/bans', { preHandler: requireModerator }, async (request) => {
    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const now = new Date();

    // Get active bans (not expired and still active)
    const bans = await db
      .select({
        id: schema.adminBans.id,
        playerId: schema.adminBans.playerId,
        playerGuid: schema.adminPlayers.guid,
        reason: schema.adminBans.reason,
        issuedAt: schema.adminBans.issuedAt,
        expiresAt: schema.adminBans.expiresAt,
        active: schema.adminBans.active,
        bannedBy: schema.adminBans.bannedBy,
      })
      .from(schema.adminBans)
      .innerJoin(schema.adminPlayers, eq(schema.adminBans.playerId, schema.adminPlayers.id))
      .where(
        and(
          eq(schema.adminBans.active, true),
          or(isNull(schema.adminBans.expiresAt), gt(schema.adminBans.expiresAt, now))
        )
      )
      .orderBy(desc(schema.adminBans.issuedAt))
      .limit(Math.min(limit, 100))
      .offset(offset);

    // Get player names for each ban
    const bansWithNames = await Promise.all(
      bans.map(async (ban) => {
        const [latestAlias] = await db
          .select({ alias: schema.adminAliases.alias })
          .from(schema.adminAliases)
          .where(eq(schema.adminAliases.playerId, ban.playerId))
          .orderBy(desc(schema.adminAliases.lastUsed))
          .limit(1);

        return {
          ...ban,
          playerName: latestAlias?.alias || 'Unknown',
          playerCleanName: latestAlias ? stripColors(latestAlias.alias) : 'Unknown',
          isPermanent: ban.expiresAt === null,
        };
      })
    );

    // Get total count of active bans
    const [{ count: totalCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.adminBans)
      .where(
        and(
          eq(schema.adminBans.active, true),
          or(isNull(schema.adminBans.expiresAt), gt(schema.adminBans.expiresAt, now))
        )
      );

    return {
      bans: bansWithNames,
      total: Number(totalCount),
      limit,
      offset,
    };
  });

  // Get ban history (all bans, including expired/inactive)
  fastify.get('/bans/history', { preHandler: requireAdmin }, async (request) => {
    const { limit = 100, offset = 0 } = request.query as { limit?: number; offset?: number };

    const bans = await db
      .select({
        id: schema.adminBans.id,
        playerId: schema.adminBans.playerId,
        playerGuid: schema.adminPlayers.guid,
        reason: schema.adminBans.reason,
        issuedAt: schema.adminBans.issuedAt,
        expiresAt: schema.adminBans.expiresAt,
        active: schema.adminBans.active,
        bannedBy: schema.adminBans.bannedBy,
      })
      .from(schema.adminBans)
      .innerJoin(schema.adminPlayers, eq(schema.adminBans.playerId, schema.adminPlayers.id))
      .orderBy(desc(schema.adminBans.issuedAt))
      .limit(Math.min(limit, 200))
      .offset(offset);

    // Get player names
    const bansWithNames = await Promise.all(
      bans.map(async (ban) => {
        const [latestAlias] = await db
          .select({ alias: schema.adminAliases.alias })
          .from(schema.adminAliases)
          .where(eq(schema.adminAliases.playerId, ban.playerId))
          .orderBy(desc(schema.adminAliases.lastUsed))
          .limit(1);

        return {
          ...ban,
          playerName: latestAlias?.alias || 'Unknown',
          playerCleanName: latestAlias ? stripColors(latestAlias.alias) : 'Unknown',
          isPermanent: ban.expiresAt === null,
        };
      })
    );

    return { bans: bansWithNames };
  });

  // Create ban (from ETPanel)
  fastify.post('/bans/:guid', { preHandler: requireAdmin }, async (request, reply) => {
    const { guid } = request.params as { guid: string };
    const body = banSchema.safeParse(request.body);

    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid ban request', details: body.error.flatten() });
    }

    const { reason, duration } = body.data;

    // Get player
    const [player] = await db
      .select()
      .from(schema.adminPlayers)
      .where(eq(schema.adminPlayers.guid, guid))
      .limit(1);

    if (!player) {
      return reply.status(404).send({ error: 'Player not found' });
    }

    // Calculate expiry
    const expiresAt = duration ? new Date(Date.now() + duration * 60 * 1000) : null;

    // Create ban
    const [ban] = await db
      .insert(schema.adminBans)
      .values({
        playerId: player.id,
        reason: reason || 'Banned via ETPanel',
        expiresAt,
        active: true,
      })
      .returning();

    // Log the action
    await db.insert(schema.adminCommandLog).values({
      command: 'ban',
      args: `${duration || 'permanent'} ${reason || ''}`.trim(),
      targetPlayerId: player.id,
      success: true,
      source: 'etpanel',
    });

    fastify.log.info(
      { adminUser: request.user.email, guid, duration, reason },
      'Player banned via ETPanel'
    );

    return {
      success: true,
      message: `Banned ${guid}${duration ? ` for ${formatDuration(duration)}` : ' permanently'}`,
      ban,
    };
  });

  // Unban (remove active ban)
  fastify.delete('/bans/:banId', { preHandler: requireAdmin }, async (request, reply) => {
    const { banId } = request.params as { banId: string };
    const id = parseInt(banId);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ban ID' });
    }

    // Get ban
    const [ban] = await db
      .select()
      .from(schema.adminBans)
      .where(eq(schema.adminBans.id, id))
      .limit(1);

    if (!ban) {
      return reply.status(404).send({ error: 'Ban not found' });
    }

    // Deactivate ban
    await db
      .update(schema.adminBans)
      .set({ active: false })
      .where(eq(schema.adminBans.id, id));

    // Log the action
    await db.insert(schema.adminCommandLog).values({
      command: 'unban',
      args: `ban_id:${id}`,
      targetPlayerId: ban.playerId,
      success: true,
      source: 'etpanel',
    });

    fastify.log.info({ adminUser: request.user.email, banId: id }, 'Ban removed via ETPanel');

    return {
      success: true,
      message: 'Ban removed',
    };
  });

  // ============================================================================
  // COMMAND LOGS
  // ============================================================================

  // Get command logs with filtering
  fastify.get('/logs', { preHandler: requireModerator }, async (request) => {
    const { limit = 100, offset = 0, command, source } = request.query as {
      limit?: number;
      offset?: number;
      command?: string;
      source?: string;
    };

    let query = db
      .select({
        id: schema.adminCommandLog.id,
        playerId: schema.adminCommandLog.playerId,
        command: schema.adminCommandLog.command,
        args: schema.adminCommandLog.args,
        targetPlayerId: schema.adminCommandLog.targetPlayerId,
        success: schema.adminCommandLog.success,
        executedAt: schema.adminCommandLog.executedAt,
        source: schema.adminCommandLog.source,
      })
      .from(schema.adminCommandLog)
      .orderBy(desc(schema.adminCommandLog.executedAt))
      .limit(Math.min(limit, 500))
      .offset(offset);

    // Apply filters using where conditions
    const conditions = [];
    if (command) {
      conditions.push(eq(schema.adminCommandLog.command, command));
    }
    if (source) {
      conditions.push(eq(schema.adminCommandLog.source, source));
    }

    const logs =
      conditions.length > 0
        ? await db
            .select({
              id: schema.adminCommandLog.id,
              playerId: schema.adminCommandLog.playerId,
              command: schema.adminCommandLog.command,
              args: schema.adminCommandLog.args,
              targetPlayerId: schema.adminCommandLog.targetPlayerId,
              success: schema.adminCommandLog.success,
              executedAt: schema.adminCommandLog.executedAt,
              source: schema.adminCommandLog.source,
            })
            .from(schema.adminCommandLog)
            .where(and(...conditions))
            .orderBy(desc(schema.adminCommandLog.executedAt))
            .limit(Math.min(limit, 500))
            .offset(offset)
        : await query;

    // Enrich with player names
    const logsWithNames = await Promise.all(
      logs.map(async (log) => {
        let playerName = null;
        let targetPlayerName = null;

        if (log.playerId) {
          const [alias] = await db
            .select({ alias: schema.adminAliases.alias })
            .from(schema.adminAliases)
            .where(eq(schema.adminAliases.playerId, log.playerId))
            .orderBy(desc(schema.adminAliases.lastUsed))
            .limit(1);
          playerName = alias?.alias || null;
        }

        if (log.targetPlayerId) {
          const [alias] = await db
            .select({ alias: schema.adminAliases.alias })
            .from(schema.adminAliases)
            .where(eq(schema.adminAliases.playerId, log.targetPlayerId))
            .orderBy(desc(schema.adminAliases.lastUsed))
            .limit(1);
          targetPlayerName = alias?.alias || null;
        }

        return {
          ...log,
          playerName: playerName ? stripColors(playerName) : null,
          targetPlayerName: targetPlayerName ? stripColors(targetPlayerName) : null,
        };
      })
    );

    return { logs: logsWithNames };
  });

  // Get command stats (for dashboard)
  fastify.get('/logs/stats', { preHandler: requireModerator }, async () => {
    // Get command counts for last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const commandCounts = await db
      .select({
        command: schema.adminCommandLog.command,
        count: sql<number>`count(*)`,
      })
      .from(schema.adminCommandLog)
      .where(gt(schema.adminCommandLog.executedAt, oneDayAgo))
      .groupBy(schema.adminCommandLog.command)
      .orderBy(desc(sql`count(*)`));

    const sourceCounts = await db
      .select({
        source: schema.adminCommandLog.source,
        count: sql<number>`count(*)`,
      })
      .from(schema.adminCommandLog)
      .where(gt(schema.adminCommandLog.executedAt, oneDayAgo))
      .groupBy(schema.adminCommandLog.source);

    return {
      commandCounts: commandCounts.map((c) => ({ command: c.command, count: Number(c.count) })),
      sourceCounts: sourceCounts.map((s) => ({ source: s.source, count: Number(s.count) })),
    };
  });

  // ============================================================================
  // COMMANDS
  // ============================================================================

  // Get all admin commands with their required levels
  fastify.get('/commands', { preHandler: authenticate }, async () => {
    const commands = await db
      .select()
      .from(schema.adminCommands)
      .orderBy(asc(schema.adminCommands.defaultLevel), asc(schema.adminCommands.name));

    return { commands };
  });

  // Update command level (admin only)
  fastify.put('/commands/:commandId/level', { preHandler: requireAdmin }, async (request, reply) => {
    const { commandId } = request.params as { commandId: string };
    const id = parseInt(commandId);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid command ID' });
    }

    const body = z.object({ level: z.number().int().min(0).max(5) }).safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid level', details: body.error.flatten() });
    }

    const { level } = body.data;

    // Check command exists
    const [command] = await db
      .select()
      .from(schema.adminCommands)
      .where(eq(schema.adminCommands.id, id))
      .limit(1);

    if (!command) {
      return reply.status(404).send({ error: 'Command not found' });
    }

    // Update the default level
    await db
      .update(schema.adminCommands)
      .set({ defaultLevel: level })
      .where(eq(schema.adminCommands.id, id));

    fastify.log.info(
      { adminUser: request.user.email, command: command.name, oldLevel: command.defaultLevel, newLevel: level },
      'Command level changed via ETPanel'
    );

    return {
      success: true,
      message: `Set !${command.name} to level ${level}`,
    };
  });

  // Toggle command enabled/disabled (admin only)
  fastify.put('/commands/:commandId/enabled', { preHandler: requireAdmin }, async (request, reply) => {
    const { commandId } = request.params as { commandId: string };
    const id = parseInt(commandId);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid command ID' });
    }

    const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid enabled value' });
    }

    const { enabled } = body.data;

    // Check command exists
    const [command] = await db
      .select()
      .from(schema.adminCommands)
      .where(eq(schema.adminCommands.id, id))
      .limit(1);

    if (!command) {
      return reply.status(404).send({ error: 'Command not found' });
    }

    await db
      .update(schema.adminCommands)
      .set({ enabled })
      .where(eq(schema.adminCommands.id, id));

    fastify.log.info(
      { adminUser: request.user.email, command: command.name, enabled },
      'Command enabled/disabled via ETPanel'
    );

    return {
      success: true,
      message: `!${command.name} ${enabled ? 'enabled' : 'disabled'}`,
    };
  });

  // ============================================================================
  // COMMAND EXECUTION (ETPanel -> etman-server)
  // ============================================================================

  // Get commands available to current user based on their admin level
  fastify.get('/commands/available', { preHandler: authenticate }, async (request) => {
    // Get user's GUID
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, request.user.userId))
      .limit(1);

    let userLevel = 0;

    if (user?.guid) {
      const [adminPlayer] = await db
        .select({ levelNum: schema.adminLevels.level })
        .from(schema.adminPlayers)
        .leftJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
        .where(eq(schema.adminPlayers.guid, user.guid))
        .limit(1);

      userLevel = adminPlayer?.levelNum ?? 0;
    }

    // Get commands at or below user's level
    const commands = await db
      .select()
      .from(schema.adminCommands)
      .where(
        and(
          eq(schema.adminCommands.enabled, true),
          sql`${schema.adminCommands.defaultLevel} <= ${userLevel}`
        )
      )
      .orderBy(asc(schema.adminCommands.defaultLevel), asc(schema.adminCommands.name));

    return {
      commands,
      userLevel,
      userGuid: user?.guid || null,
    };
  });

  // Execute a command via ETPanel (sends to etman-server)
  fastify.post('/commands/execute', { preHandler: authenticate }, async (request, reply) => {
    const body = z.object({
      command: z.string().min(1).max(50),
      args: z.string().max(200).optional(),
    }).safeParse(request.body);

    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid command', details: body.error.flatten() });
    }

    const { command, args } = body.data;
    const commandName = command.replace(/^!/, ''); // Strip leading ! if present

    // Get user's GUID and level
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, request.user.userId))
      .limit(1);

    if (!user?.guid) {
      return reply.status(403).send({
        error: 'No game account linked',
        message: 'You must link your game account using /etman register in-game to execute commands',
      });
    }

    // Get user's admin level
    const [adminPlayer] = await db
      .select({ levelNum: schema.adminLevels.level })
      .from(schema.adminPlayers)
      .leftJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
      .where(eq(schema.adminPlayers.guid, user.guid))
      .limit(1);

    const userLevel = adminPlayer?.levelNum ?? 0;

    // Check if command exists and user has permission
    const [cmd] = await db
      .select()
      .from(schema.adminCommands)
      .where(eq(schema.adminCommands.name, commandName))
      .limit(1);

    if (!cmd) {
      return reply.status(404).send({ error: `Command !${commandName} not found` });
    }

    if (!cmd.enabled) {
      return reply.status(403).send({ error: `Command !${commandName} is disabled` });
    }

    if (cmd.defaultLevel > userLevel) {
      return reply.status(403).send({
        error: `Insufficient permissions`,
        message: `!${commandName} requires level ${cmd.defaultLevel}, you have level ${userLevel}`,
      });
    }

    // Helper to get player list with slot info
    async function getPlayerList(): Promise<Array<{ slot: number; name: string; score: number; ping: number }>> {
      const result = await sendRcon('status');
      if (!result.success) return [];

      const lines = result.response.split('\n');
      const players: Array<{ slot: number; name: string; score: number; ping: number }> = [];

      // Skip header lines, parse player lines
      // Format: "num score ping guid           name"
      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+(-?\d+)\s+(\d+)\s+\S+\s+(.+)$/);
        if (match) {
          players.push({
            slot: parseInt(match[1]),
            score: parseInt(match[2]),
            ping: parseInt(match[3]),
            name: match[4].trim(),
          });
        }
      }
      return players;
    }

    // Helper to find player slot by name (fuzzy match)
    async function findPlayerSlot(search: string): Promise<{ slot: number; name: string } | null> {
      const players = await getPlayerList();
      const searchLower = search.toLowerCase();

      // Exact match first
      const exact = players.find(p => p.name.toLowerCase() === searchLower);
      if (exact) return { slot: exact.slot, name: exact.name };

      // Partial match
      const partial = players.filter(p => p.name.toLowerCase().includes(searchLower));
      if (partial.length === 1) return { slot: partial[0].slot, name: partial[0].name };

      // If multiple matches, return null (ambiguous)
      return null;
    }

    let rconResponse = '';
    let rconSuccess = false;
    let needsInGame = false;

    // Handle commands based on type
    switch (commandName) {
      case 'map': {
        if (!args) {
          rconResponse = 'Usage: !map <mapname>';
          rconSuccess = false;
        } else {
          const result = await sendRcon(`map ${args}`);
          rconResponse = result.success ? `Changing map to ${args}...` : (result.error || 'Failed to change map');
          rconSuccess = result.success;
        }
        break;
      }

      case 'nextmap': {
        // Just show what the next map is, don't rotate
        const result = await sendRcon('nextmap');
        rconResponse = result.response || 'Could not get next map';
        rconSuccess = result.success;
        break;
      }

      case 'restart': {
        const result = await sendRcon('map_restart');
        rconResponse = result.success ? 'Map restarted' : (result.error || 'Failed to restart');
        rconSuccess = result.success;
        break;
      }

      case 'rotate': {
        const result = await sendRcon('vstr nextmap');
        rconResponse = result.success ? 'Rotating to next map...' : (result.error || 'Failed to rotate');
        rconSuccess = result.success;
        break;
      }

      case 'time': {
        const now = new Date();
        rconResponse = `Server time: ${now.toISOString().replace('T', ' ').split('.')[0]} UTC`;
        rconSuccess = true;
        break;
      }

      case 'maplist': {
        const result = await sendRcon('dir maps bsp');
        if (result.success) {
          const maps = result.response
            .split('\n')
            .filter(line => line.trim().endsWith('.bsp'))
            .map(line => line.trim().replace('.bsp', ''))
            .sort();
          rconResponse = maps.length > 0 ? `Available maps:\n${maps.join('\n')}` : 'No maps found';
        } else {
          rconResponse = result.error || 'Failed to get map list';
        }
        rconSuccess = result.success;
        break;
      }

      case 'players': {
        const players = await getPlayerList();
        if (players.length === 0) {
          rconResponse = 'No players online';
        } else {
          const lines = players.map(p => `[${p.slot}] ${p.name} (Score: ${p.score}, Ping: ${p.ping})`);
          rconResponse = `Players online (${players.length}):\n${lines.join('\n')}`;
        }
        rconSuccess = true;
        break;
      }

      case 'kickbots': {
        // Must set maxbots -1 and minbots 0 BEFORE kickall, otherwise bots respawn immediately
        // Send as separate commands since RCON doesn't handle semicolons well
        const result = await sendRconMultiple([
          'bot maxbots -1',
          'bot minbots 0',
          'bot kickall'
        ]);
        rconResponse = result.success ? 'All bots kicked (auto-fill disabled)' : (result.error || 'Failed to kick bots');
        rconSuccess = result.success;
        break;
      }

      case 'putbots': {
        // Match in-game: default 12, minbots = count, maxbots = count (maintains exactly that many)
        let count = 12; // default
        if (args && args.trim()) {
          const parsed = parseInt(args.trim());
          if (parsed >= 1 && parsed <= 20) count = parsed;
        }
        // Send as separate commands
        const result = await sendRconMultiple([
          `bot minbots ${count}`,
          `bot maxbots ${count}`
        ]);
        rconResponse = result.success ? `Bot count set to ${count}` : (result.error || 'Failed to set bot count');
        rconSuccess = result.success;
        break;
      }

      case 'kick': {
        if (!args) {
          rconResponse = 'Usage: !kick <player> [reason]';
          rconSuccess = false;
        } else {
          const parts = args.split(' ');
          const playerSearch = parts[0];
          const reason = parts.slice(1).join(' ') || 'Kicked by admin';

          const player = await findPlayerSlot(playerSearch);
          if (player) {
            const result = await sendRcon(`clientkick ${player.slot} "${reason}"`);
            rconResponse = result.success ? `Kicked ${player.name}: ${reason}` : (result.error || 'Failed to kick');
            rconSuccess = result.success;
          } else {
            rconResponse = `Player "${playerSearch}" not found or multiple matches. Use !players to see slots.`;
            rconSuccess = false;
          }
        }
        break;
      }

      case 'slap': {
        if (!args) {
          rconResponse = 'Usage: !slap <player>';
          rconSuccess = false;
        } else {
          const player = await findPlayerSlot(args.split(' ')[0]);
          if (player) {
            const result = await sendRcon(`slap ${player.slot}`);
            rconResponse = result.success ? `Slapped ${player.name}` : (result.error || 'Failed to slap');
            rconSuccess = result.success;
          } else {
            rconResponse = `Player "${args}" not found or multiple matches`;
            rconSuccess = false;
          }
        }
        break;
      }

      // Commands that need the full admin system (DB access, complex logic)
      case 'stats':
      case 'finger':
      case 'aliases':
      case 'listadmins':
      case 'ban':
      case 'unban':
      case 'mute':
      case 'unmute':
      case 'warn':
      case 'setlevel':
      case 'put':
      case 'gib':
      case 'fling':
      case 'up':
        needsInGame = true;
        rconResponse = `!${commandName} requires the in-game admin system for full functionality`;
        rconSuccess = true; // Command is valid, just needs in-game
        break;

      default:
        needsInGame = true;
        rconResponse = `Command !${commandName} not recognized for ETPanel execution`;
        rconSuccess = false;
    }

    // Log the command execution
    const [adminPlayerRecord] = await db
      .select()
      .from(schema.adminPlayers)
      .where(eq(schema.adminPlayers.guid, user.guid))
      .limit(1);

    await db.insert(schema.adminCommandLog).values({
      playerId: adminPlayerRecord?.id || null,
      command: commandName,
      args: args || null,
      success: rconSuccess,
      source: 'etpanel',
    });

    fastify.log.info(
      { user: user.email, guid: user.guid, command: commandName, args, rconSuccess, needsInGame },
      'Command executed via ETPanel'
    );

    return {
      success: rconSuccess,
      message: `!${commandName}${args ? ' ' + args : ''}`,
      response: rconResponse || undefined,
      needsInGame,
      note: needsInGame
        ? 'This command requires the in-game admin system (database queries, permission checks).'
        : undefined,
    };
  });

  // ============================================================================
  // SYNC (ETPanel user -> admin_players)
  // ============================================================================

  // Get admin status for current user (by GUID)
  fastify.get('/me', { preHandler: authenticate }, async (request, reply) => {
    // Get user's GUID from users table
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, request.user.userId))
      .limit(1);

    if (!user?.guid) {
      return {
        linked: false,
        adminLevel: null,
        message: 'No game account linked. Use /etman register in-game to link your account.',
      };
    }

    // Get admin player record
    const [adminPlayer] = await db
      .select({
        id: schema.adminPlayers.id,
        guid: schema.adminPlayers.guid,
        levelId: schema.adminPlayers.levelId,
        levelName: schema.adminLevels.name,
        levelNum: schema.adminLevels.level,
        lastSeen: schema.adminPlayers.lastSeen,
      })
      .from(schema.adminPlayers)
      .leftJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
      .where(eq(schema.adminPlayers.guid, user.guid))
      .limit(1);

    if (!adminPlayer) {
      return {
        linked: true,
        guid: user.guid,
        adminLevel: null,
        message: 'Game account linked, but not yet seen in-game by admin system.',
      };
    }

    return {
      linked: true,
      guid: user.guid,
      adminLevel: adminPlayer.levelNum,
      adminLevelName: adminPlayer.levelName,
      lastSeen: adminPlayer.lastSeen,
    };
  });

  // ============================================================================
  // DASHBOARD STATS
  // ============================================================================

  fastify.get('/stats', { preHandler: requireModerator }, async () => {
    const now = new Date();

    // Total players
    const [{ totalPlayers }] = await db
      .select({ totalPlayers: sql<number>`count(*)` })
      .from(schema.adminPlayers);

    // Active bans
    const [{ activeBans }] = await db
      .select({ activeBans: sql<number>`count(*)` })
      .from(schema.adminBans)
      .where(
        and(
          eq(schema.adminBans.active, true),
          or(isNull(schema.adminBans.expiresAt), gt(schema.adminBans.expiresAt, now))
        )
      );

    // Admins (level >= 3)
    const [{ adminCount }] = await db
      .select({ adminCount: sql<number>`count(*)` })
      .from(schema.adminPlayers)
      .innerJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
      .where(gt(schema.adminLevels.level, 2));

    // Commands last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ recentCommands }] = await db
      .select({ recentCommands: sql<number>`count(*)` })
      .from(schema.adminCommandLog)
      .where(gt(schema.adminCommandLog.executedAt, oneDayAgo));

    return {
      totalPlayers: Number(totalPlayers),
      activeBans: Number(activeBans),
      adminCount: Number(adminCount),
      recentCommands: Number(recentCommands),
    };
  });
};
