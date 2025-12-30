import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireModerator } from '../middleware/auth.js';
import { spawn } from 'child_process';
import { isProd } from '../config.js';

// Time range presets
const TIME_PRESETS: Record<string, string> = {
  '1h': '1 hour ago',
  '3h': '3 hours ago',
  '6h': '6 hours ago',
  '12h': '12 hours ago',
  '1d': '1 day ago',
  '3d': '3 days ago',
  '1w': '1 week ago',
  '1m': '1 month ago',
};

const logsQuerySchema = z.object({
  timeRange: z.string().default('1h'),
  category: z.enum(['connections', 'kills', 'chat', 'errors', 'gameplay', 'all']).default('all'),
  playerFilter: z.string().optional(),
  customSince: z.string().optional(), // ISO date string
  customUntil: z.string().optional(), // ISO date string
});

interface ParsedLogEntry {
  timestamp: string;
  raw: string;
  category: 'connection' | 'disconnect' | 'kill' | 'chat' | 'error' | 'system' | 'gameplay' | 'other';
  playerName?: string;
  playerIp?: string;
  clientVersion?: string;
  status?: string;
  details?: Record<string, string>;
}

// Gameplay event types for the gameplay tab
type GameplayEventType =
  | 'kill' | 'death' | 'suicide' | 'teamkill'
  | 'rocket_mode' | 'panzerfest'
  | 'voice' | 'spawn' | 'revive'
  | 'objective' | 'flag';

interface GameplayEvent {
  timestamp: string;
  type: GameplayEventType;
  player: string;
  target?: string;
  weapon?: string;
  rocketMode?: string;
  voiceCommand?: string;
  objective?: string;
  details?: string;
}

interface ConnectionAttempt {
  name: string;
  timestamp: string;
  ip?: string;
  version?: string;
  status: 'joined' | 'downloading' | 'checksum_error' | 'disconnected' | 'pending';
  downloadFile?: string;
  checksumError?: string;
  disconnectTime?: string;
  clientSlot?: string;
}

// Parse ET:Legacy logs and categorize them
function parseLogLine(line: string, includeBotsForGameplay = false): ParsedLogEntry | null {
  // Extract timestamp from journalctl format: "Dec 20 04:15:10"
  const timestampMatch = line.match(/^(\w{3}\s+\d+\s+\d+:\d+:\d+)/);
  if (!timestampMatch) return null;

  const timestamp = timestampMatch[1];
  const raw = line;

  // Check if this is a bot-related line
  const isBot = line.includes('[BOT]');

  // Skip OMNIBOT system messages and localhost always
  if (line.includes('OMNIBOT') || line.includes('localhost')) {
    return null;
  }

  const lower = line.toLowerCase();

  // === GAMEPLAY EVENTS (parsed before general categories) ===

  // Rocket mode changes - [RocketMode] PlayerName switched to MODE rockets
  if (line.includes('[RocketMode]')) {
    const match = line.match(/\[RocketMode\]\s+(.+?)\s+switched to\s+(.+?)\s+rockets/);
    if (match) {
      return {
        timestamp,
        raw,
        category: 'gameplay',
        playerName: match[1],
        details: { eventType: 'rocket_mode', rocketMode: match[2] },
      };
    }
  }

  // PANZERFEST trigger
  if (line.includes('PANZERFEST:')) {
    const match = line.match(/PANZERFEST:\s+(.+?)\s+triggered/);
    if (match) {
      return {
        timestamp,
        raw,
        category: 'gameplay',
        playerName: match[1],
        details: { eventType: 'panzerfest' },
      };
    }
  }

  // Voice commands - voice: PlayerName Command
  if (line.includes('voice:')) {
    const match = line.match(/voice:\s+(.+?)\s+(\w+)$/);
    if (match && !isBot) {
      return {
        timestamp,
        raw,
        category: 'gameplay',
        playerName: match[1],
        details: { eventType: 'voice', voiceCommand: match[2] },
      };
    }
  }

  // Player entered the game (spawn)
  if (line.includes('entered the game')) {
    const match = line.match(/print\s+"(.+?)\s+entered the game/);
    if (match && !isBot) {
      return {
        timestamp,
        raw,
        category: 'gameplay',
        playerName: match[1],
        details: { eventType: 'spawn' },
      };
    }
  }

  // ETMan player joined notification
  if (line.includes('[ETMan] Player joined:')) {
    const match = line.match(/\[ETMan\]\s+Player joined:\s+(.+?)\s+-\s+(.+)/);
    if (match) {
      return {
        timestamp,
        raw,
        category: 'gameplay',
        playerName: match[1],
        details: { eventType: 'spawn', map: match[2] },
      };
    }
  }

  // Kill events - for gameplay, we want more detail
  // Format: Kill: attackerId victimId weaponId: AttackerName killed VictimName by MOD_WEAPON
  if (line.includes('Kill:')) {
    const match = line.match(/Kill:\s+(\d+)\s+(\d+)\s+(\d+):\s+(.+?)\s+killed\s+(.+?)\s+by\s+(\w+)/);
    if (match) {
      const attackerId = match[1];
      const victimId = match[2];
      const attacker = match[4];
      const victim = match[5];
      const weapon = match[6];

      // Skip if both are bots (unless we want bots)
      if (!includeBotsForGameplay && attacker.includes('[BOT]') && victim.includes('[BOT]')) {
        return null;
      }

      // Determine kill type
      let eventType: string = 'kill';
      if (attackerId === victimId || attacker === victim) {
        eventType = 'suicide';
      } else if (attacker === '<world>') {
        eventType = 'death'; // Environmental death
      }

      // For gameplay category, return as gameplay
      return {
        timestamp,
        raw,
        category: 'gameplay',
        playerName: attacker,
        details: {
          eventType,
          target: victim,
          weapon: weapon.replace('MOD_', ''),
        },
      };
    }
  }

  // Skip remaining bot entries for non-gameplay
  if (isBot) {
    return null;
  }

  // === CONNECTION EVENTS ===

  // Connection entries
  if (line.includes('Userinfo:') && line.includes('\\name\\')) {
    const nameMatch = line.match(/\\name\\([^\\]+)/);
    const ipMatch = line.match(/\\ip\\([^\\]+)/);
    const versionMatch = line.match(/\\etVersion\\([^\\]+)/) || line.match(/\\cg_etVersion\\([^\\]+)/);

    return {
      timestamp,
      raw,
      category: 'connection',
      playerName: nameMatch?.[1],
      playerIp: ipMatch?.[1],
      clientVersion: versionMatch?.[1],
    };
  }

  // Disconnections - extract client slot to help match with player
  if (line.includes('ClientDisconnect:')) {
    const slotMatch = line.match(/ClientDisconnect:\s+(\d+)/);
    return {
      timestamp,
      raw,
      category: 'disconnect',
      details: slotMatch ? { clientSlot: slotMatch[1] } : undefined,
    };
  }

  // Team joins (successful connection)
  if (line.includes('ClientUserinfoChanged:') && /\\t\\[123]\\/.test(line)) {
    const nameMatch = line.match(/n\\([^\\]+)\\/);
    return {
      timestamp,
      raw,
      category: 'connection',
      playerName: nameMatch?.[1],
      status: 'joined',
    };
  }

  // Download redirect
  if (line.includes('Redirecting client')) {
    const nameMatch = line.match(/Redirecting client '([^']+)'/);
    const fileMatch = line.match(/to (.+)$/);
    return {
      timestamp,
      raw,
      category: 'connection',
      playerName: nameMatch?.[1],
      status: 'downloading',
      details: fileMatch ? { downloadFile: fileMatch[1] } : undefined,
    };
  }

  // Checksum mismatch
  if (line.includes('nChkSum1') && line.includes('==')) {
    return {
      timestamp,
      raw,
      category: 'error',
      status: 'checksum_error',
    };
  }

  // Chat
  if (lower.includes('say:') || lower.includes('sayteam:')) {
    const chatMatch = line.match(/say(?:team)?:\s*(.+)/i);
    return {
      timestamp,
      raw,
      category: 'chat',
      details: chatMatch ? { message: chatMatch[1] } : undefined,
    };
  }

  // Errors
  if (lower.includes('error') || lower.includes('warning') || lower.includes('failed')) {
    return { timestamp, raw, category: 'error' };
  }

  return { timestamp, raw, category: 'other' };
}

// Group connection-related logs into connection attempts
// Only creates a new "connection" when:
// 1. First time seeing this player in the time range
// 2. Player reconnected after a disconnect
// 3. Player reconnected after a map change (InitGame)
function groupConnectionAttempts(logs: ParsedLogEntry[]): ConnectionAttempt[] {
  const attempts: ConnectionAttempt[] = [];
  // Track active sessions by player name - value is index into attempts array
  const activeSessions: Map<string, number> = new Map();
  // Track client slot to player name mapping for disconnect tracking
  const slotToPlayer: Map<string, string> = new Map();

  for (const log of logs) {
    // Handle disconnects - find player by slot and mark their session
    if (log.category === 'disconnect') {
      const clientSlot = log.details?.clientSlot;
      if (clientSlot) {
        const playerName = slotToPlayer.get(clientSlot);
        if (playerName) {
          const sessionIdx = activeSessions.get(playerName);
          if (sessionIdx !== undefined) {
            attempts[sessionIdx].disconnectTime = log.timestamp;
            attempts[sessionIdx].status = 'disconnected';
          }
          // Clear the slot and session
          slotToPlayer.delete(clientSlot);
          activeSessions.delete(playerName);
        }
      }
      continue;
    }

    if (log.category !== 'connection' && log.category !== 'error') continue;

    if (log.playerName) {
      const existingIdx = activeSessions.get(log.playerName);

      // Check if this is a download redirect - always starts a new connection attempt
      const isDownloadRedirect = log.status === 'downloading';

      // Check if this is the first Userinfo (has protocol field = initial connect)
      const isInitialConnect = log.raw.includes('\\protocol\\');

      // Extract client slot from ClientUserinfoChanged lines
      const slotMatch = log.raw.match(/ClientUserinfoChanged:\s+(\d+)/);
      const clientSlot = slotMatch?.[1];

      if (existingIdx !== undefined && !isInitialConnect) {
        // Update existing session
        const existing = attempts[existingIdx];
        if (log.playerIp && !existing.ip) existing.ip = log.playerIp;
        if (log.clientVersion && !existing.version) existing.version = log.clientVersion;
        if (log.status === 'joined') existing.status = 'joined';
        if (isDownloadRedirect) {
          existing.status = 'downloading';
          existing.downloadFile = log.details?.downloadFile;
        }
        // Update slot mapping
        if (clientSlot) {
          existing.clientSlot = clientSlot;
          slotToPlayer.set(clientSlot, log.playerName);
        }
      } else {
        // New connection attempt - either first time or initial connect packet
        const newAttempt: ConnectionAttempt = {
          name: log.playerName,
          timestamp: log.timestamp,
          ip: log.playerIp,
          version: log.clientVersion,
          status: (log.status as ConnectionAttempt['status']) || 'pending',
          clientSlot,
        };
        if (isDownloadRedirect) {
          newAttempt.downloadFile = log.details?.downloadFile;
        }
        attempts.push(newAttempt);
        activeSessions.set(log.playerName, attempts.length - 1);
        if (clientSlot) {
          slotToPlayer.set(clientSlot, log.playerName);
        }
      }
    }

    // Associate checksum errors with most recent attempt
    if (log.category === 'error' && log.status === 'checksum_error') {
      if (attempts.length > 0) {
        const lastAttempt = attempts[attempts.length - 1];
        if (lastAttempt.status === 'pending' || lastAttempt.status === 'downloading') {
          lastAttempt.status = 'checksum_error';
          lastAttempt.checksumError = log.raw;
        }
      }
    }
  }

  return attempts.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// Execute journalctl command to get logs
// In production (on VPS), run locally. In development, SSH to VPS.
function fetchJournalctlLogs(since: string, until?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    let stdout = '';
    let stderr = '';

    if (isProd) {
      // Production: run journalctl directly on the VPS
      const args = ['-u', 'etserver', '--since', since];
      if (until) {
        args.push('--until', until);
      }
      proc = spawn('journalctl', args);
    } else {
      // Development: SSH to VPS to get logs
      const sinceArg = `--since '${since}'`;
      const untilArg = until ? `--until '${until}'` : '';
      const cmd = `journalctl -u etserver ${sinceArg} ${untilArg} 2>/dev/null`;

      proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        'andy@5.78.83.59',
        cmd,
      ]);
    }

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed: ${stderr || 'Unknown error'}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      proc.kill();
      reject(new Error('Command timed out'));
    }, 30000);
  });
}

export const logsRoutes: FastifyPluginAsync = async (fastify) => {
  // Get server logs from VPS journalctl
  fastify.get('/query', { preHandler: requireModerator }, async (request, reply) => {
    const query = logsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: query.error.errors });
    }

    const { timeRange, category, playerFilter, customSince, customUntil } = query.data;

    // Determine time range
    let since: string;
    let until: string | undefined;

    if (customSince) {
      since = new Date(customSince).toISOString();
      until = customUntil ? new Date(customUntil).toISOString() : undefined;
    } else {
      since = TIME_PRESETS[timeRange] || TIME_PRESETS['1h'];
    }

    try {
      const rawLogs = await fetchJournalctlLogs(since, until);
      const lines = rawLogs.split('\n').filter(Boolean);

      // Parse all log lines
      let parsedLogs = lines
        .map((line) => parseLogLine(line))
        .filter((log): log is ParsedLogEntry => log !== null);

      // Apply category filter
      if (category !== 'all') {
        parsedLogs = parsedLogs.filter((log) => {
          switch (category) {
            case 'connections':
              return log.category === 'connection' || log.category === 'disconnect';
            case 'kills':
              // For kills tab, filter gameplay events that are kill-related
              return log.category === 'gameplay' &&
                ['kill', 'death', 'suicide', 'teamkill'].includes(log.details?.eventType || '');
            case 'chat':
              return log.category === 'chat';
            case 'errors':
              return log.category === 'error';
            case 'gameplay':
              return log.category === 'gameplay';
            default:
              return true;
          }
        });
      }

      // Apply player name filter
      if (playerFilter) {
        const filterLower = playerFilter.toLowerCase();
        parsedLogs = parsedLogs.filter((log) =>
          log.playerName?.toLowerCase().includes(filterLower) ||
          log.raw.toLowerCase().includes(filterLower)
        );
      }

      // For connections, also return grouped attempts
      const connectionAttempts = category === 'connections' || category === 'all'
        ? groupConnectionAttempts(parsedLogs)
        : [];

      return {
        logs: parsedLogs, // Return ALL logs, no limit
        connectionAttempts,
        totalLines: lines.length,
        filteredCount: parsedLogs.length,
        timeRange: { since, until },
      };
    } catch (err) {
      fastify.log.error({ err }, 'Failed to fetch logs from VPS');
      return reply.status(500).send({
        error: 'Failed to fetch logs from server',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Get available time presets
  fastify.get('/presets', { preHandler: requireModerator }, async () => {
    return {
      presets: Object.entries(TIME_PRESETS).map(([key, value]) => ({
        key,
        label: key.replace('h', ' hour').replace('d', ' day').replace('w', ' week').replace('m', ' month')
          .replace('1 hour', '1 hour').replace('1 day', '1 day')
          .replace('3 hour', '3 hours').replace('6 hour', '6 hours').replace('12 hour', '12 hours')
          .replace('3 day', '3 days').replace('1 week', '1 week').replace('1 month', '1 month'),
        value,
      })),
    };
  });
};
