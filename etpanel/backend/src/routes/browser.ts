import { FastifyInstance } from 'fastify';
import * as dgram from 'dgram';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';

// Types
interface Player {
  name: string;
  score: number;
  ping: number;
}

interface ServerInfo {
  address: string;
  name: string;
  hostname: string;
  map: string;
  gametype: string;
  mod: string;
  maxPlayers: number;
  players: Player[];
  humans: number;
  bots: number;
  ping: number;
  online: boolean;
  protocol: number;
}

// ET Protocol constants
const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const GET_STATUS = Buffer.concat([PREFIX, Buffer.from('getstatus\n')]);
const TIMEOUT = 1500; // 1.5 seconds

/**
 * Query an ET server for status information
 */
async function queryServer(ip: string, port: number): Promise<ServerInfo | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const startTime = Date.now();

    const timeout = setTimeout(() => {
      socket.close();
      resolve(null);
    }, TIMEOUT);

    socket.on('error', () => {
      clearTimeout(timeout);
      socket.close();
      resolve(null);
    });

    socket.on('message', (data) => {
      clearTimeout(timeout);
      const ping = Date.now() - startTime;
      socket.close();

      try {
        const response = data.toString('latin1');

        if (!response.includes('statusResponse')) {
          resolve(null);
          return;
        }

        const parts = response.split('\n');
        if (parts.length < 2) {
          resolve(null);
          return;
        }

        // Parse server variables
        const header = parts[1];
        const serverVars = parseServerVars(header);

        // Parse players
        const players: Player[] = [];
        for (let i = 2; i < parts.length; i++) {
          const line = parts[i].trim();
          if (!line) continue;

          const match = line.match(/^(-?\d+)\s+(-?\d+)\s+"([^"]*)"/);
          if (match) {
            players.push({
              score: parseInt(match[1], 10),
              ping: parseInt(match[2], 10),
              name: cleanPlayerName(match[3]),
            });
          }
        }

        const humans = players.filter(p => p.ping > 0).length;
        const bots = players.filter(p => p.ping === 0).length;

        // Get mod name
        let mod = serverVars.gamename || serverVars.fs_game || 'etmain';
        if (mod.includes(' ')) {
          mod = mod.split(' ')[0];
        }

        resolve({
          address: `${ip}:${port}`,
          name: cleanServerName(serverVars.sv_hostname || 'Unknown Server'),
          hostname: serverVars.sv_hostname || 'Unknown Server',
          map: serverVars.mapname || 'unknown',
          gametype: serverVars.gametype || 'unknown',
          mod,
          maxPlayers: parseInt(serverVars.sv_maxclients || '0', 10),
          players,
          humans,
          bots,
          ping,
          online: true,
          protocol: parseInt(serverVars.protocol || '84', 10),
        });
      } catch {
        resolve(null);
      }
    });

    socket.send(GET_STATUS, port, ip);
  });
}

/**
 * Parse server variables from header
 */
function parseServerVars(header: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const parts = header.split('\\');

  for (let i = 1; i < parts.length - 1; i += 2) {
    vars[parts[i]] = parts[i + 1] || '';
  }

  return vars;
}

/**
 * Remove ET color codes from names
 */
function cleanPlayerName(name: string): string {
  return name.replace(/\^[0-9a-zA-Z]/g, '').trim();
}

function cleanServerName(name: string): string {
  return cleanPlayerName(name);
}

export async function browserRoutes(fastify: FastifyInstance) {
  // Get list of favorite servers with their current status (requires auth)
  fastify.get('/servers', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user.userId;

    // Get user's favorites from database
    const favorites = await db
      .select()
      .from(schema.favoriteServers)
      .where(eq(schema.favoriteServers.userId, userId));

    if (favorites.length === 0) {
      return { servers: [], total: 0, onlineCount: 0, totalHumans: 0 };
    }

    // Query all servers in parallel
    const queries = favorites.map(async (fav) => {
      const [ip, portStr] = fav.address.split(':');
      const port = parseInt(portStr, 10) || 27960;

      const info = await queryServer(ip, port);

      if (info) {
        return {
          ...info,
          favoriteName: fav.name,
        };
      }

      return {
        address: fav.address,
        name: fav.name,
        favoriteName: fav.name,
        hostname: fav.name,
        map: '',
        gametype: '',
        mod: '',
        maxPlayers: 0,
        players: [],
        humans: 0,
        bots: 0,
        ping: 0,
        online: false,
        protocol: 0,
      };
    });

    const results = await Promise.all(queries);

    // Sort by human players (descending), then by online status
    results.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.humans - a.humans;
    });

    return {
      servers: results,
      total: results.length,
      onlineCount: results.filter(s => s.online).length,
      totalHumans: results.reduce((sum, s) => sum + s.humans, 0),
    };
  });

  // Get favorites list (without querying) - requires auth
  fastify.get('/favorites', { preHandler: authenticate }, async (request) => {
    const userId = request.user.userId;
    const favorites = await db
      .select()
      .from(schema.favoriteServers)
      .where(eq(schema.favoriteServers.userId, userId));
    return { favorites };
  });

  // Add a new favorite server - requires auth
  fastify.post<{ Body: { address: string; name?: string } }>('/favorites', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const { address, name } = request.body;

    if (!address || !address.includes(':')) {
      return reply.status(400).send({ error: 'Invalid address format. Use ip:port' });
    }

    // Check if already exists for this user
    const [existing] = await db
      .select()
      .from(schema.favoriteServers)
      .where(and(
        eq(schema.favoriteServers.userId, userId),
        eq(schema.favoriteServers.address, address)
      ))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: 'Server already in favorites' });
    }

    // Try to query the server to get its name if not provided
    let serverName = name;
    if (!serverName) {
      const [ip, portStr] = address.split(':');
      const port = parseInt(portStr, 10) || 27960;
      const info = await queryServer(ip, port);
      serverName = info?.name || address;
    }

    const [favorite] = await db
      .insert(schema.favoriteServers)
      .values({
        userId,
        address,
        name: serverName,
      })
      .returning();

    return { success: true, favorite };
  });

  // Update a favorite server - requires auth
  fastify.put<{ Params: { address: string }; Body: { name: string } }>('/favorites/:address', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const address = decodeURIComponent(request.params.address);
    const { name } = request.body;

    const result = await db
      .update(schema.favoriteServers)
      .set({ name })
      .where(and(
        eq(schema.favoriteServers.userId, userId),
        eq(schema.favoriteServers.address, address)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Server not found in favorites' });
    }

    return { success: true, favorite: result[0] };
  });

  // Delete a favorite server - requires auth
  fastify.delete<{ Params: { address: string } }>('/favorites/:address', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const address = decodeURIComponent(request.params.address);

    const result = await db
      .delete(schema.favoriteServers)
      .where(and(
        eq(schema.favoriteServers.userId, userId),
        eq(schema.favoriteServers.address, address)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Server not found in favorites' });
    }

    return { success: true };
  });

  // Query a single server (for testing before adding) - requires auth
  fastify.get<{ Querystring: { address: string } }>('/query', { preHandler: authenticate }, async (request, reply) => {
    const { address } = request.query;

    if (!address || !address.includes(':')) {
      return reply.status(400).send({ error: 'Invalid address format. Use ip:port' });
    }

    const [ip, portStr] = address.split(':');
    const port = parseInt(portStr, 10) || 27960;

    const info = await queryServer(ip, port);

    if (!info) {
      return { online: false, address };
    }

    return { ...info, online: true };
  });
}
