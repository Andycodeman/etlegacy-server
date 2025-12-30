import { useState, useRef, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { logs } from '../api/client';
import type { LogEntry, ConnectionAttempt } from '../api/client';

type CategoryFilter = 'connections' | 'kills' | 'chat' | 'errors' | 'gameplay' | 'all';

const TIME_PRESETS = [
  { key: '1h', label: '1 Hour' },
  { key: '3h', label: '3 Hours' },
  { key: '6h', label: '6 Hours' },
  { key: '12h', label: '12 Hours' },
  { key: '1d', label: '1 Day' },
  { key: '3d', label: '3 Days' },
  { key: '1w', label: '1 Week' },
  { key: '1m', label: '1 Month' },
];

const CATEGORY_FILTERS: { value: CategoryFilter; label: string; icon: string }[] = [
  { value: 'all', label: 'All', icon: '📋' },
  { value: 'connections', label: 'Connections', icon: '🔌' },
  { value: 'gameplay', label: 'Gameplay', icon: '🎮' },
  { value: 'kills', label: 'Kills', icon: '💀' },
  { value: 'chat', label: 'Chat', icon: '💬' },
  { value: 'errors', label: 'Errors', icon: '⚠️' },
];

function getStatusIcon(status: ConnectionAttempt['status'], hasDisconnect = false) {
  // If session ended (has disconnect time), show as disconnected regardless of last status
  if (hasDisconnect) {
    return { icon: '⏹', color: 'text-red-400', label: 'Disconnected' };
  }
  switch (status) {
    case 'joined':
      return { icon: '✓', color: 'text-green-400', label: 'Connected' };
    case 'downloading':
      return { icon: '↓', color: 'text-amber-400', label: 'Downloading pk3' };
    case 'checksum_error':
      return { icon: '✗', color: 'text-red-500', label: 'sv_pure checksum mismatch' };
    case 'disconnected':
      return { icon: '⏹', color: 'text-red-400', label: 'Disconnected' };
    case 'pending':
    default:
      return { icon: '?', color: 'text-gray-400', label: 'Connection attempt' };
  }
}

// Get icon and styling for gameplay events
function getGameplayEventStyle(eventType: string) {
  switch (eventType) {
    case 'kill':
      return { icon: '💀', color: 'text-red-400', label: 'Kill' };
    case 'death':
      return { icon: '☠️', color: 'text-orange-400', label: 'Death' };
    case 'suicide':
      return { icon: '💥', color: 'text-yellow-400', label: 'Suicide' };
    case 'teamkill':
      return { icon: '🔫', color: 'text-pink-400', label: 'Team Kill' };
    case 'rocket_mode':
      return { icon: '🚀', color: 'text-purple-400', label: 'Rocket Mode' };
    case 'panzerfest':
      return { icon: '🎉', color: 'text-yellow-300', label: 'PANZERFEST!' };
    case 'voice':
      return { icon: '📢', color: 'text-blue-400', label: 'Voice' };
    case 'spawn':
      return { icon: '🟢', color: 'text-green-400', label: 'Spawned' };
    case 'revive':
      return { icon: '💉', color: 'text-green-300', label: 'Revived' };
    case 'objective':
      return { icon: '🎯', color: 'text-cyan-400', label: 'Objective' };
    case 'flag':
      return { icon: '🚩', color: 'text-orange-400', label: 'Flag' };
    default:
      return { icon: '📝', color: 'text-gray-400', label: eventType };
  }
}

// Check if a player name is a bot or world
function isBot(name: string | undefined): boolean {
  if (!name) return false;
  return name.includes('[BOT]') || name === '<world>';
}

// Check if gameplay event involves a human player
function involvesHuman(log: LogEntry): boolean {
  const player = log.playerName;
  const target = log.details?.target;
  const eventType = log.details?.eventType;

  // Kill/death events - at least one participant must be human
  if (eventType === 'kill' || eventType === 'death' || eventType === 'suicide' || eventType === 'teamkill') {
    // For death events, player is often <world>, so check target
    // For kill events, check both attacker and victim
    const playerIsHuman = !isBot(player);
    const targetIsHuman = !isBot(target);
    return playerIsHuman || targetIsHuman;
  }

  // Other events - player must be human
  return !isBot(player);
}

// Format gameplay event for display
function formatGameplayEvent(log: LogEntry): { text: string; subtext?: string; indicator?: string; indicatorColor?: string } {
  const eventType = log.details?.eventType;
  const player = log.playerName || 'Unknown';
  const target = log.details?.target;
  const playerIsBot = isBot(player);

  switch (eventType) {
    case 'kill':
      // Human killed someone
      if (!playerIsBot) {
        return {
          text: `${player} → ${target}`,
          subtext: log.details?.weapon,
          indicator: '⚔️ KILL',
          indicatorColor: 'text-green-400',
        };
      }
      // Bot killed human (human died)
      return {
        text: `${target} ← ${player}`,
        subtext: log.details?.weapon,
        indicator: '💀 DIED',
        indicatorColor: 'text-red-400',
      };
    case 'death':
      return {
        text: `${target} died`,
        subtext: log.details?.weapon,
        indicator: '💀 DIED',
        indicatorColor: 'text-red-400',
      };
    case 'suicide':
      return {
        text: `${player} killed themselves`,
        subtext: log.details?.weapon,
        indicator: '💥 SUICIDE',
        indicatorColor: 'text-orange-400',
      };
    case 'rocket_mode':
      return {
        text: `${player} switched rockets`,
        subtext: log.details?.rocketMode,
      };
    case 'panzerfest':
      return {
        text: `${player} triggered PANZERFEST!`,
        subtext: '30 kills streak!',
        indicator: '🎉 PANZERFEST',
        indicatorColor: 'text-yellow-300',
      };
    case 'voice':
      return {
        text: `${player}`,
        subtext: log.details?.voiceCommand,
      };
    case 'spawn':
      return {
        text: `${player} entered the game`,
        subtext: log.details?.map,
        indicator: '🟢 JOINED',
        indicatorColor: 'text-green-400',
      };
    default:
      return { text: player };
  }
}

function getCategoryStyle(category: LogEntry['category']) {
  switch (category) {
    case 'connection':
      return 'text-green-400';
    case 'disconnect':
      return 'text-yellow-400';
    case 'kill':
      return 'text-red-400';
    case 'chat':
      return 'text-blue-400';
    case 'error':
      return 'text-orange-400';
    case 'system':
      return 'text-gray-400';
    case 'gameplay':
      return 'text-purple-400';
    default:
      return 'text-gray-300';
  }
}

function getCategoryIcon(category: LogEntry['category'], eventType?: string) {
  if (category === 'gameplay' && eventType) {
    return getGameplayEventStyle(eventType).icon;
  }
  switch (category) {
    case 'connection':
      return '🟢';
    case 'disconnect':
      return '🔴';
    case 'kill':
      return '💀';
    case 'chat':
      return '💬';
    case 'error':
      return '⚠️';
    case 'system':
      return '⚙️';
    case 'gameplay':
      return '🎮';
    default:
      return '📝';
  }
}

// Parse server timestamp (e.g., "Dec 20 04:15:10") to Date object
function parseServerTimestamp(serverTimestamp: string): Date | null {
  const currentYear = new Date().getFullYear();
  const dateStr = `${serverTimestamp} ${currentYear} UTC`;
  const date = new Date(dateStr);

  // If date is in the future, it's probably from last year
  if (date > new Date()) {
    date.setFullYear(currentYear - 1);
  }

  if (isNaN(date.getTime())) {
    return null;
  }
  return date;
}

// Calculate session duration between two timestamps
function calculateDuration(startTimestamp: string, endTimestamp: string): string | null {
  const start = parseServerTimestamp(startTimestamp);
  const end = parseServerTimestamp(endTimestamp);

  if (!start || !end) return null;

  const diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) return null;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

// Parse server timestamp (e.g., "Dec 20 04:15:10") and convert to local time
// Server is in UTC, so we parse as UTC and display in user's local timezone
function formatLocalTime(serverTimestamp: string): string {
  const date = parseServerTimestamp(serverTimestamp);

  // Check if valid date
  if (!date) {
    return serverTimestamp; // Return original if parsing fails
  }

  // Format in user's local timezone with 12-hour format
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export default function Logs() {
  const queryClient = useQueryClient();
  const [timeRange, setTimeRange] = useState('1h');
  const [category, setCategory] = useState<CategoryFilter>('connections');
  const [playerFilter, setPlayerFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [viewMode, setViewMode] = useState<'connections' | 'raw'>('connections');
  const [showETMan, setShowETMan] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const queryParams = {
    timeRange,
    category,
    playerFilter: playerFilter || undefined,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['logs', queryParams],
    queryFn: () => {
      // Store abort controller so we can cancel
      abortControllerRef.current = new AbortController();
      return logs.query({ ...queryParams, signal: abortControllerRef.current.signal });
    },
    staleTime: 30000, // 30 seconds
    refetchOnWindowFocus: false,
  });

  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Also cancel the query
    queryClient.cancelQueries({ queryKey: ['logs', queryParams] });
  }, [queryClient, queryParams]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPlayerFilter(searchInput);
  };

  const handleClearFilter = () => {
    setSearchInput('');
    setPlayerFilter('');
  };

  // Filter out ETMan entries if toggle is off, and filter bot-only gameplay events
  const filteredData = useMemo(() => {
    if (!data) return data;

    let logs = data.logs;
    let connectionAttempts = data.connectionAttempts;

    // Filter out ETMan if toggle is off
    if (!showETMan) {
      logs = logs.filter(log =>
        !log.playerName?.toLowerCase().includes('etman') &&
        !log.raw.toLowerCase().includes('\\name\\etman')
      );
      connectionAttempts = connectionAttempts.filter(attempt =>
        !attempt.name.toLowerCase().includes('etman')
      );
    }

    // Filter out bot-only gameplay events (always)
    logs = logs.filter(log => {
      if (log.category !== 'gameplay') return true;
      return involvesHuman(log);
    });

    return {
      ...data,
      logs,
      connectionAttempts,
    };
  }, [data, showETMan]);

  return (
    <div className="h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl md:text-2xl font-bold">Server Logs</h1>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              isFetching
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {isFetching ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        {data && (
          <div className="text-sm text-gray-400">
            {data.filteredCount.toLocaleString()} of {data.totalLines.toLocaleString()} log entries
          </div>
        )}
      </div>

      {/* Time Range Selector */}
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-sm text-gray-400 self-center mr-2">Time:</span>
        {TIME_PRESETS.map((preset) => (
          <button
            key={preset.key}
            onClick={() => setTimeRange(preset.key)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              timeRange === preset.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Category Filter Tabs */}
      <div className="flex overflow-x-auto hide-scrollbar gap-2 mb-4 pb-1">
        {CATEGORY_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setCategory(f.value)}
            className={`px-3 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-colors ${
              category === f.value
                ? 'bg-orange-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            <span className="mr-1">{f.icon}</span>
            {f.label}
          </button>
        ))}
      </div>

      {/* Search / Player Filter */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Filter by player name..."
            className="w-full bg-gray-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {playerFilter && (
            <button
              type="button"
              onClick={handleClearFilter}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            >
              ✕
            </button>
          )}
        </div>
        <button
          type="submit"
          className="px-4 py-2.5 bg-orange-600 hover:bg-orange-500 rounded-lg font-medium text-sm transition-colors"
        >
          Search
        </button>
        {/* ETMan Toggle */}
        <button
          type="button"
          onClick={() => setShowETMan(!showETMan)}
          className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
            showETMan
              ? 'bg-purple-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
          title={showETMan ? 'Showing ETMan entries' : 'ETMan entries hidden'}
        >
          {showETMan ? '👤 ETMan' : '👤 ETMan'}
        </button>
      </form>

      {/* View Mode Toggle (for connections) */}
      {category === 'connections' && (
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setViewMode('connections')}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              viewMode === 'connections'
                ? 'bg-gray-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            Connection Summary
          </button>
          <button
            onClick={() => setViewMode('raw')}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              viewMode === 'raw'
                ? 'bg-gray-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            Raw Logs
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 bg-gray-800 rounded-lg overflow-hidden min-h-0">
        {isLoading || isFetching ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-400 text-center">
              <div className="animate-spin w-8 h-8 border-2 border-gray-600 border-t-orange-500 rounded-full mx-auto mb-4" />
              <p className="mb-4">Fetching logs from server...</p>
              <p className="text-sm text-gray-500 mb-4">This may take a while for large time ranges</p>
              <button
                onClick={handleCancel}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-red-400">
              <p className="text-lg mb-2">Failed to fetch logs</p>
              <p className="text-sm text-gray-500">{error instanceof Error ? error.message : 'Unknown error'}</p>
              <button
                onClick={() => refetch()}
                className="mt-4 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : category === 'connections' && viewMode === 'connections' ? (
          // Connection Attempts View
          <div className="h-full overflow-y-auto p-4">
            {filteredData?.connectionAttempts.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                No player connections found in this time range.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredData?.connectionAttempts.map((attempt, idx) => {
                  const hasDisconnect = !!attempt.disconnectTime;
                  const statusInfo = getStatusIcon(attempt.status, hasDisconnect);
                  const duration = attempt.disconnectTime
                    ? calculateDuration(attempt.timestamp, attempt.disconnectTime)
                    : null;
                  return (
                    <div
                      key={`${attempt.name}-${attempt.timestamp}-${idx}`}
                      className="bg-gray-900 rounded-lg p-4 border border-gray-700"
                    >
                      {/* Mobile Card Layout */}
                      <div className="md:hidden">
                        <div className="flex items-start justify-between mb-2">
                          <div className="font-bold text-blue-400">{attempt.name}</div>
                          <div className="flex items-center gap-2">
                            {duration && (
                              <span className="text-xs text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded">
                                {duration}
                              </span>
                            )}
                            <span className={`${statusInfo.color} text-lg`}>{statusInfo.icon}</span>
                          </div>
                        </div>
                        <div className="space-y-1 text-sm">
                          <div className="text-gray-400">
                            <span className="text-gray-500">Connected:</span> {formatLocalTime(attempt.timestamp)}
                          </div>
                          {attempt.disconnectTime && (
                            <div className="text-red-400">
                              <span className="text-gray-500">Disconnected:</span> {formatLocalTime(attempt.disconnectTime)}
                            </div>
                          )}
                          {attempt.ip && (
                            <div className="text-gray-400">
                              <span className="text-gray-500">IP:</span> {attempt.ip}
                            </div>
                          )}
                          {attempt.version && (
                            <div className="text-gray-400">
                              <span className="text-gray-500">Client:</span> {attempt.version}
                            </div>
                          )}
                          {attempt.downloadFile && (
                            <div className="text-amber-400">
                              <span className="text-gray-500">Download:</span> {attempt.downloadFile.split('/').pop()}
                            </div>
                          )}
                          <div className={statusInfo.color}>
                            <span className="text-gray-500">Status:</span> {statusInfo.label}
                          </div>
                        </div>
                      </div>

                      {/* Desktop Row Layout */}
                      <div className="hidden md:block">
                        <div className="flex items-center gap-4">
                          <span className={`${statusInfo.color} text-xl w-6`}>{statusInfo.icon}</span>
                          <div className="flex-1 grid grid-cols-6 gap-4">
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Player</div>
                              <div className="font-medium text-blue-400">{attempt.name}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Connected</div>
                              <div className="text-sm text-green-400">{formatLocalTime(attempt.timestamp)}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Disconnected</div>
                              <div className={`text-sm ${attempt.disconnectTime ? 'text-red-400' : 'text-gray-600'}`}>
                                {attempt.disconnectTime ? formatLocalTime(attempt.disconnectTime) : '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Duration</div>
                              <div className={`text-sm ${duration ? 'text-cyan-400' : 'text-gray-600'}`}>
                                {duration || '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-0.5">IP / Client</div>
                              <div className="text-xs text-gray-400">
                                {attempt.ip || '-'}
                              </div>
                              {attempt.version && (
                                <div className="text-xs text-gray-500 truncate">
                                  {attempt.version}
                                </div>
                              )}
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Status</div>
                              <div className={`text-sm ${statusInfo.color}`}>{statusInfo.label}</div>
                            </div>
                          </div>
                        </div>
                        {attempt.downloadFile && (
                          <div className="mt-2 ml-10 text-sm text-amber-400">
                            <span className="text-gray-500">↓ Download:</span> {attempt.downloadFile}
                          </div>
                        )}
                        {attempt.checksumError && (
                          <div className="mt-2 ml-10 text-sm text-red-400">
                            <span className="text-gray-500">Error:</span> {attempt.checksumError}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : category === 'gameplay' ? (
          // Gameplay Events View
          <div className="h-full overflow-y-auto p-4">
            {filteredData?.logs.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                No gameplay events found in this time range.
              </div>
            ) : (
              <div className="space-y-2">
                {filteredData?.logs.map((log, idx) => {
                  const eventType = log.details?.eventType || '';
                  const eventStyle = getGameplayEventStyle(eventType);
                  const formatted = formatGameplayEvent(log);
                  return (
                    <div
                      key={`${log.timestamp}-${idx}`}
                      className="bg-gray-900 rounded-lg px-4 py-3 border border-gray-700 flex items-center gap-3"
                    >
                      <span className="text-xl w-8 text-center">{eventStyle.icon}</span>
                      {formatted.indicator && (
                        <span className={`text-xs font-bold px-2 py-1 rounded ${formatted.indicatorColor} bg-gray-800 whitespace-nowrap`}>
                          {formatted.indicator}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className={`font-medium ${formatted.indicatorColor || eventStyle.color}`}>{formatted.text}</div>
                        {formatted.subtext && (
                          <div className="text-sm text-gray-500">{formatted.subtext}</div>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 whitespace-nowrap">
                        {formatLocalTime(log.timestamp)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          // Raw Logs View
          <div className="h-full overflow-y-auto p-3 md:p-4 font-mono text-xs md:text-sm">
            {filteredData?.logs.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                No logs found for this filter.
              </div>
            ) : (
              filteredData?.logs.map((log, idx) => (
                <div
                  key={`${log.timestamp}-${idx}`}
                  className={`py-1 ${getCategoryStyle(log.category)}`}
                >
                  <span className="text-gray-600 mr-2">{formatLocalTime(log.timestamp)}</span>
                  <span className="mr-2">{getCategoryIcon(log.category, log.details?.eventType)}</span>
                  <span>{log.raw.substring(log.raw.indexOf('etlded') + 10 || 0)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Tips */}
      {category === 'connections' && (
        <div className="mt-4 text-xs text-gray-500 space-y-1">
          <p><span className="text-green-400">✓</span> = Connected and playing</p>
          <p><span className="text-amber-400">↓</span> = Downloading pk3 file</p>
          <p><span className="text-red-400">⏹</span> = Disconnected / Session ended</p>
          <p><span className="text-red-500">✗</span> = sv_pure checksum mismatch - player should delete their legacy/ folder cache</p>
          <p><span className="text-gray-400">?</span> = Connection attempt (no further info)</p>
        </div>
      )}
      {category === 'gameplay' && (
        <div className="mt-4 text-xs text-gray-500 space-y-1">
          <p><span>💀</span> Kill | <span>💥</span> Suicide | <span>☠️</span> Death (world) | <span>🟢</span> Spawn</p>
          <p><span>🚀</span> Rocket Mode | <span>🎉</span> PANZERFEST | <span>📢</span> Voice Command</p>
        </div>
      )}
    </div>
  );
}
