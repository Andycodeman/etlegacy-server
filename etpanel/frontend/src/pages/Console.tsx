import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { console as consoleApi } from '../api/client';
import { useAuthStore } from '../stores/auth';

interface ConsoleLine {
  id: string;
  timestamp: string;
  raw: string;
  category: 'kill' | 'connect' | 'disconnect' | 'game' | 'system' | 'other';
}

function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function categorizeLog(raw: string): ConsoleLine['category'] {
  const lower = raw.toLowerCase();

  // Kills
  if (lower.includes('killed') || lower.includes('was killed') ||
      lower.includes('headshot') || lower.includes('was gibbed') ||
      lower.includes('hit from') || /\d+ dmg/.test(lower)) {
    return 'kill';
  }

  // Connections
  if (lower.includes('clientconnect:') || lower.includes('connected') ||
      lower.includes('entered the game') || lower.includes('joined')) {
    return 'connect';
  }

  // Disconnections
  if (lower.includes('clientdisconnect:') || lower.includes('disconnected') ||
      lower.includes('timed out') || lower.includes('was kicked') ||
      lower.includes('was dropped') || lower.includes('left the game')) {
    return 'disconnect';
  }

  // Game events
  if (lower.includes('map_restart') || lower.includes('round') ||
      lower.includes('timelimit') || lower.includes('allies') ||
      lower.includes('axis') || lower.includes('planted') ||
      lower.includes('defused') || lower.includes('dynamite') ||
      lower.includes('objective') || lower.includes('captured') ||
      lower.includes('flag') || lower.includes('spawn')) {
    return 'game';
  }

  // System messages
  if (lower.includes('broadcast:') || lower.includes('print:') ||
      lower.includes('warmup') || lower.includes('match') ||
      lower.includes('server') || lower.startsWith('---')) {
    return 'system';
  }

  // Skip chat messages (they go to Chat page)
  if (lower.startsWith('say:') || lower.startsWith('sayteam:')) {
    return 'other';
  }

  return 'other';
}

type FilterType = 'all' | 'kills' | 'connections' | 'game' | 'system';

export default function Console() {
  const user = useAuthStore((s) => s.user);
  const [logs, setLogs] = useState<ConsoleLine[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [command, setCommand] = useState('');
  const [commandResult, setCommandResult] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const canUseCommands = user?.role === 'admin' || user?.role === 'moderator';

  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Send command mutation
  const sendCommandMutation = useMutation({
    mutationFn: consoleApi.command,
    onSuccess: (data) => {
      // Add command to logs
      addLog({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        raw: `> ${command}`,
        category: 'system',
      });
      if (data.response) {
        addLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          raw: data.response,
          category: 'system',
        });
      }
      setCommand('');
      setCommandResult(data.response || 'Command executed');
      setTimeout(() => setCommandResult(null), 3000);
    },
    onError: (error: Error) => {
      addLog({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        raw: `Error: ${error.message}`,
        category: 'system',
      });
    },
  });

  const addLog = useCallback((log: ConsoleLine) => {
    setLogs((prev) => {
      const updated = [...prev, log];
      if (updated.length > 1000) {
        return updated.slice(-1000);
      }
      return updated;
    });
  }, []);

  // WebSocket connection
  useEffect(() => {
    let isMounted = true;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const wsUrl = import.meta.env.PROD
      ? `wss://${window.location.host}/ws`
      : 'ws://localhost:3000/ws';

    const connect = () => {
      if (!isMounted) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) {
          ws.close();
          return;
        }
        setIsConnected(true);
        ws.send(JSON.stringify({ type: 'subscribe_console' }));
        addLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          raw: 'Connected to server console',
          category: 'system',
        });
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'console_history') {
            const historyLogs: ConsoleLine[] = data.data
              .filter((line: { raw?: string }) => {
                if (!line.raw) return false;
                const cat = categorizeLog(line.raw);
                return cat !== 'other'; // Skip chat and misc
              })
              .map((line: { timestamp: string; raw: string }) => ({
                id: crypto.randomUUID(),
                timestamp: line.timestamp,
                raw: line.raw,
                category: categorizeLog(line.raw),
              }));
            setLogs((prev) => [...historyLogs, ...prev]);
          }

          if (data.type === 'console_line') {
            const line = data.data;
            if (line.raw) {
              const category = categorizeLog(line.raw);
              if (category !== 'other') {
                addLog({
                  id: crypto.randomUUID(),
                  timestamp: line.timestamp,
                  raw: line.raw,
                  category,
                });
              }
            }
          }
        } catch (err) {
          console.error('WebSocket message parse error:', err);
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setIsConnected(false);
        addLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          raw: 'Disconnected from server. Reconnecting...',
          category: 'system',
        });
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [addLog]);

  const handleScroll = () => {
    const container = logsContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setAutoScroll(distanceFromBottom < 150);
  };

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleSendCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim() || !canUseCommands) return;
    sendCommandMutation.mutate(command.trim());
  };

  // Filter logs
  const filteredLogs = logs.filter((log) => {
    if (filter === 'all') return true;
    if (filter === 'kills') return log.category === 'kill';
    if (filter === 'connections') return log.category === 'connect' || log.category === 'disconnect';
    if (filter === 'game') return log.category === 'game';
    if (filter === 'system') return log.category === 'system';
    return true;
  });

  const getCategoryStyle = (category: ConsoleLine['category']) => {
    switch (category) {
      case 'kill':
        return 'text-red-400';
      case 'connect':
        return 'text-green-400';
      case 'disconnect':
        return 'text-yellow-400';
      case 'game':
        return 'text-blue-400';
      case 'system':
        return 'text-gray-400 italic';
      default:
        return 'text-gray-300';
    }
  };

  const getCategoryIcon = (category: ConsoleLine['category']) => {
    switch (category) {
      case 'kill':
        return '💀';
      case 'connect':
        return '🟢';
      case 'disconnect':
        return '🔴';
      case 'game':
        return '🎮';
      case 'system':
        return '⚙️';
      default:
        return '📝';
    }
  };

  const filters: { value: FilterType; label: string; icon: string }[] = [
    { value: 'all', label: 'All', icon: '📋' },
    { value: 'kills', label: 'Kills', icon: '💀' },
    { value: 'connections', label: 'Connections', icon: '🔌' },
    { value: 'game', label: 'Game Events', icon: '🎮' },
    { value: 'system', label: 'System', icon: '⚙️' },
  ];

  return (
    <div className="h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl md:text-2xl font-bold">Server Console</h1>
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${
              isConnected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
            }`}
          >
            {isConnected ? '● Live' : '○ Disconnected'}
          </span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex overflow-x-auto hide-scrollbar gap-2 mb-4 pb-1">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-colors ${
              filter === f.value
                ? 'bg-orange-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            <span className="mr-1">{f.icon}</span>
            {f.label}
          </button>
        ))}
      </div>

      {/* Console Output */}
      <div className="flex-1 flex flex-col bg-gray-800 rounded-lg overflow-hidden min-h-0">
        <div
          ref={logsContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-3 md:p-4 font-mono text-xs md:text-sm"
        >
          {filteredLogs.length === 0 ? (
            <div className="text-gray-500 text-center py-8">
              {filter === 'all' ? 'Waiting for console output...' : `No ${filter} logs yet...`}
            </div>
          ) : (
            filteredLogs.map((log) => (
              <div
                key={log.id}
                className={`py-1 ${getCategoryStyle(log.category)}`}
              >
                <span className="text-gray-600 mr-2">{formatTime(log.timestamp)}</span>
                <span className="mr-2">{getCategoryIcon(log.category)}</span>
                <span>{stripColors(log.raw)}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>

        {/* Command Input - Only for admins/mods */}
        {canUseCommands && (
          <form onSubmit={handleSendCommand} className="p-3 bg-gray-900 border-t border-gray-700">
            <div className="flex gap-2">
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="Enter RCON command (status, map, kick, etc.)..."
                className="flex-1 bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base md:text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={sendCommandMutation.isPending}
              />
              <button
                type="submit"
                disabled={sendCommandMutation.isPending || !command.trim()}
                className="px-4 py-2.5 md:py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {sendCommandMutation.isPending ? '...' : 'Run'}
              </button>
            </div>
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-gray-500 hidden md:block">
                Commands: status, map [name], kick [slot], g_gravity [value], etc.
              </p>
              {commandResult && (
                <span className="text-xs text-green-400">✓ {commandResult}</span>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
