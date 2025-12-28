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
  category: z.enum(['connections', 'kills', 'chat', 'errors', 'all']).default('all'),
  playerFilter: z.string().optional(),
  customSince: z.string().optional(), // ISO date string
  customUntil: z.string().optional(), // ISO date string
});

interface ParsedLogEntry {
  timestamp: string;
  raw: string;
  category: 'connection' | 'disconnect' | 'kill' | 'chat' | 'error' | 'system' | 'other';
  playerName?: string;
  playerIp?: string;
  clientVersion?: string;
  status?: string;
  details?: Record<string, string>;
}

interface ConnectionAttempt {
  name: string;
  timestamp: string;
  ip?: string;
  version?: string;
  status: 'joined' | 'downloading' | 'checksum_error' | 'disconnected' | 'pending';
  downloadFile?: string;
  checksumError?: string;
}

// Parse ET:Legacy logs and categorize them
function parseLogLine(line: string): ParsedLogEntry | null {
  // Extract timestamp from journalctl format: "Dec 20 04:15:10"
  const timestampMatch = line.match(/^(\w{3}\s+\d+\s+\d+:\d+:\d+)/);
  if (!timestampMatch) return null;

  const timestamp = timestampMatch[1];
  const raw = line;

  // Skip bot entries
  if (line.includes('OMNIBOT') || line.includes('localhost') || line.includes('[BOT]')) {
    return null;
  }

  const lower = line.toLowerCase();

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

  // Disconnections
  if (line.includes('ClientDisconnect:')) {
    return { timestamp, raw, category: 'disconnect' };
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

  // Kills
  if (lower.includes('killed') || lower.includes('was killed') ||
      lower.includes('headshot') || lower.includes('was gibbed')) {
    return { timestamp, raw, category: 'kill' };
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
function groupConnectionAttempts(logs: ParsedLogEntry[]): ConnectionAttempt[] {
  const attempts: Map<string, ConnectionAttempt> = new Map();

  for (const log of logs) {
    if (log.category !== 'connection' && log.category !== 'error') continue;

    if (log.playerName) {
      const key = `${log.playerName}_${log.timestamp}`;
      const existing = attempts.get(key);

      if (existing) {
        // Update existing attempt
        if (log.playerIp) existing.ip = log.playerIp;
        if (log.clientVersion) existing.version = log.clientVersion;
        if (log.status === 'joined') existing.status = 'joined';
        if (log.status === 'downloading') {
          existing.status = 'downloading';
          existing.downloadFile = log.details?.downloadFile;
        }
      } else {
        attempts.set(key, {
          name: log.playerName,
          timestamp: log.timestamp,
          ip: log.playerIp,
          version: log.clientVersion,
          status: (log.status as ConnectionAttempt['status']) || 'pending',
        });
      }
    }

    // Associate checksum errors with recent attempts
    if (log.category === 'error' && log.status === 'checksum_error') {
      // Find most recent pending attempt
      for (const [, attempt] of attempts) {
        if (attempt.status === 'pending') {
          attempt.status = 'checksum_error';
          attempt.checksumError = log.raw;
        }
      }
    }
  }

  return Array.from(attempts.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
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
        .map(parseLogLine)
        .filter((log): log is ParsedLogEntry => log !== null);

      // Apply category filter
      if (category !== 'all') {
        parsedLogs = parsedLogs.filter((log) => {
          switch (category) {
            case 'connections':
              return log.category === 'connection' || log.category === 'disconnect';
            case 'kills':
              return log.category === 'kill';
            case 'chat':
              return log.category === 'chat';
            case 'errors':
              return log.category === 'error';
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
        logs: parsedLogs.slice(-500), // Limit to 500 most recent
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
