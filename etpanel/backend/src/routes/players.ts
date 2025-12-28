import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { desc, sql, eq, like, or, and } from 'drizzle-orm';
import { getPlayers, sendRcon } from '../services/rcon.js';
import { authenticate, requireModerator, requireAdmin } from '../middleware/auth.js';

const kickSchema = z.object({
  reason: z.string().max(200).optional(),
});

const banSchema = z.object({
  guid: z.string().length(32),
  reason: z.string().max(200).optional(),
  duration: z.number().int().positive().optional(), // minutes, 0 = permanent
});

export const playerRoutes: FastifyPluginAsync = async (fastify) => {
  // Get current players (public)
  fastify.get('/', async () => {
    return await getPlayers();
  });

  // Get player stats from database with optional search and sorting (public)
  fastify.get('/stats', async (request) => {
    const { limit = 50, offset = 0, search = '', sortBy = 'lastSeen', sortOrder = 'desc' } = request.query as {
      limit?: number;
      offset?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    };

    const searchTerm = search?.trim() ? `%${search.trim()}%` : null;
    const whereCondition = searchTerm
      ? or(
          like(schema.playerStats.name, searchTerm),
          like(schema.playerStats.guid, searchTerm)
        )
      : undefined;

    // Build order clause based on sortBy and sortOrder
    const getOrderBy = () => {
      const dir = sortOrder === 'asc' ? sql`ASC` : sql`DESC`;
      switch (sortBy) {
        case 'name':
          return sql`${schema.playerStats.name} ${dir}`;
        case 'kills':
          return sql`${schema.playerStats.kills} ${dir}`;
        case 'deaths':
          return sql`${schema.playerStats.deaths} ${dir}`;
        case 'botKills':
          return sql`${schema.playerStats.botKills} ${dir}`;
        case 'botDeaths':
          return sql`${schema.playerStats.botDeaths} ${dir}`;
        case 'suicides':
          return sql`${schema.playerStats.suicides} ${dir}`;
        case 'playtimeSeconds':
          return sql`${schema.playerStats.playtimeSeconds} ${dir}`;
        case 'lastSeen':
        default:
          return sql`${schema.playerStats.lastSeen} ${dir}`;
      }
    };

    const orderFn = getOrderBy();

    // Execute query with optional search and sorting
    const stats = await db
      .select()
      .from(schema.playerStats)
      .where(whereCondition)
      .orderBy(orderFn)
      .limit(Math.min(limit, 100))
      .offset(offset);

    // Get total count
    const [{ count: totalCount }] = searchTerm
      ? await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.playerStats)
          .where(whereCondition)
      : await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.playerStats);

    return {
      players: stats,
      total: Number(totalCount),
      limit,
      offset,
    };
  });

  // Get individual player by GUID (public)
  fastify.get('/:guid', async (request, reply) => {
    const { guid } = request.params as { guid: string };

    const [player] = await db
      .select()
      .from(schema.playerStats)
      .where(eq(schema.playerStats.guid, guid))
      .limit(1);

    if (!player) {
      return reply.status(404).send({ error: 'Player not found' });
    }

    return player;
  });

  // Get player matchups - who they've killed/been killed by (public)
  fastify.get('/:guid/matchups', async (request, reply) => {
    const { guid } = request.params as { guid: string };
    const { opponent, weapon, limit = 100 } = request.query as {
      opponent?: string;  // Filter by specific opponent GUID
      weapon?: string;    // Filter by weapon
      limit?: number;
    };

    // Build matchup query
    let conditions = [eq(schema.playerMatchups.playerGuid, guid)];

    if (opponent) {
      conditions.push(eq(schema.playerMatchups.opponentGuid, opponent));
    }
    if (weapon) {
      conditions.push(eq(schema.playerMatchups.weapon, weapon));
    }

    const matchups = await db
      .select()
      .from(schema.playerMatchups)
      .where(and(...conditions))
      .orderBy(
        desc(sql`${schema.playerMatchups.kills} + ${schema.playerMatchups.deaths}`)
      )
      .limit(Math.min(limit, 500));

    // Aggregate stats by opponent (sum across all weapons)
    const opponentStats = new Map<string, {
      opponentGuid: string;
      opponentName: string;
      opponentIsBot: boolean;
      totalKills: number;
      totalDeaths: number;
      totalTeamKills: number;
      totalTeamDeaths: number;
      weapons: Array<{
        weapon: string;
        kills: number;
        deaths: number;
        teamKills: number;
        teamDeaths: number;
      }>;
    }>();

    for (const m of matchups) {
      if (!opponentStats.has(m.opponentGuid)) {
        opponentStats.set(m.opponentGuid, {
          opponentGuid: m.opponentGuid,
          opponentName: m.opponentName,
          opponentIsBot: m.opponentIsBot,
          totalKills: 0,
          totalDeaths: 0,
          totalTeamKills: 0,
          totalTeamDeaths: 0,
          weapons: [],
        });
      }
      const opp = opponentStats.get(m.opponentGuid)!;
      opp.totalKills += m.kills;
      opp.totalDeaths += m.deaths;
      opp.totalTeamKills += m.teamKills;
      opp.totalTeamDeaths += m.teamDeaths;
      opp.weapons.push({
        weapon: m.weapon,
        kills: m.kills,
        deaths: m.deaths,
        teamKills: m.teamKills,
        teamDeaths: m.teamDeaths,
      });
    }

    // Convert to array sorted by total interactions
    const aggregated = Array.from(opponentStats.values())
      .sort((a, b) =>
        (b.totalKills + b.totalDeaths) - (a.totalKills + a.totalDeaths)
      );

    return {
      guid,
      matchups: aggregated,
      rawMatchups: matchups,  // Also include raw data for detailed views
    };
  });

  // Get player's weapon stats (aggregated kills/deaths by weapon) (public)
  fastify.get('/:guid/weapons', async (request) => {
    const { guid } = request.params as { guid: string };

    const matchups = await db
      .select()
      .from(schema.playerMatchups)
      .where(eq(schema.playerMatchups.playerGuid, guid));

    // Aggregate by weapon
    const weaponStats = new Map<string, {
      weapon: string;
      kills: number;
      deaths: number;
      teamKills: number;
      teamDeaths: number;
    }>();

    for (const m of matchups) {
      if (!weaponStats.has(m.weapon)) {
        weaponStats.set(m.weapon, {
          weapon: m.weapon,
          kills: 0,
          deaths: 0,
          teamKills: 0,
          teamDeaths: 0,
        });
      }
      const w = weaponStats.get(m.weapon)!;
      w.kills += m.kills;
      w.deaths += m.deaths;
      w.teamKills += m.teamKills;
      w.teamDeaths += m.teamDeaths;
    }

    return Array.from(weaponStats.values())
      .sort((a, b) => (b.kills + b.deaths) - (a.kills + a.deaths));
  });

  // Get recent kills
  fastify.get('/kills', async (request) => {
    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const kills = await db
      .select()
      .from(schema.killLog)
      .orderBy(desc(schema.killLog.timestamp))
      .limit(Math.min(limit, 100))
      .offset(offset);

    return kills;
  });

  // Kick player (moderator+)
  fastify.post('/:slot/kick', { preHandler: requireModerator }, async (request, reply) => {
    const { slot } = request.params as { slot: string };
    const body = kickSchema.safeParse(request.body);

    const slotNum = parseInt(slot);
    if (isNaN(slotNum) || slotNum < 0 || slotNum > 63) {
      return reply.status(400).send({ error: 'Invalid slot number' });
    }

    const reason = body.success && body.data.reason ? body.data.reason : 'Kicked by admin';
    const result = await sendRcon(`kick ${slotNum} "${reason}"`);

    fastify.log.info({ user: request.user.email, slot: slotNum, reason }, 'Player kicked');

    return {
      success: result.success,
      message: `Player in slot ${slotNum} kicked`,
      rconResponse: result.response,
    };
  });

  // Ban player (admin only)
  fastify.post('/ban', { preHandler: requireAdmin }, async (request, reply) => {
    const body = banSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid ban request' });
    }

    const { guid, reason, duration } = body.data;
    const banReason = reason || 'Banned by admin';

    // ET:Legacy uses !ban command via WolfAdmin or similar
    // This is a simplified version - actual implementation depends on your admin mod
    const result = await sendRcon(`banGUID ${guid} ${duration || 0} "${banReason}"`);

    fastify.log.info({ user: request.user.email, guid, reason: banReason, duration }, 'Player banned');

    return {
      success: result.success,
      message: `Player ${guid} banned${duration ? ` for ${duration} minutes` : ' permanently'}`,
      rconResponse: result.response,
    };
  });
};
