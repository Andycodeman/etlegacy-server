import { useState, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { logs } from '../api/client';
import type { LogEntry, ConnectionAttempt } from '../api/client';

type CategoryFilter = 'connections' | 'kills' | 'chat' | 'errors' | 'all';

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
  { value: 'kills', label: 'Kills', icon: '💀' },
  { value: 'chat', label: 'Chat', icon: '💬' },
  { value: 'errors', label: 'Errors', icon: '⚠️' },
];

function getStatusIcon(status: ConnectionAttempt['status']) {
  switch (status) {
    case 'joined':
      return { icon: '✓', color: 'text-green-400', label: 'Joined successfully' };
    case 'downloading':
      return { icon: '↓', color: 'text-yellow-400', label: 'Downloading pk3' };
    case 'checksum_error':
      return { icon: '✗', color: 'text-red-400', label: 'sv_pure checksum mismatch' };
    case 'disconnected':
      return { icon: '⚡', color: 'text-orange-400', label: 'Disconnected' };
    case 'pending':
    default:
      return { icon: '?', color: 'text-gray-400', label: 'Connection attempt' };
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
    default:
      return 'text-gray-300';
  }
}

function getCategoryIcon(category: LogEntry['category']) {
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
    default:
      return '📝';
  }
}

// Parse server timestamp (e.g., "Dec 20 04:15:10") and convert to local time
// Server is in UTC, so we parse as UTC and display in user's local timezone
function formatLocalTime(serverTimestamp: string): string {
  // Parse "Dec 20 04:15:10" format - assume current year and UTC
  const currentYear = new Date().getFullYear();
  const dateStr = `${serverTimestamp} ${currentYear} UTC`;
  const date = new Date(dateStr);

  // If date is in the future (e.g., "Dec 20" parsed as this year but it's actually last year)
  // This can happen around year boundaries
  if (date > new Date()) {
    date.setFullYear(currentYear - 1);
  }

  // Check if valid date
  if (isNaN(date.getTime())) {
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
            {data?.connectionAttempts.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                No player connections found in this time range.
              </div>
            ) : (
              <div className="space-y-3">
                {data?.connectionAttempts.map((attempt, idx) => {
                  const statusInfo = getStatusIcon(attempt.status);
                  return (
                    <div
                      key={`${attempt.name}-${attempt.timestamp}-${idx}`}
                      className="bg-gray-900 rounded-lg p-4 border border-gray-700"
                    >
                      {/* Mobile Card Layout */}
                      <div className="md:hidden">
                        <div className="flex items-start justify-between mb-2">
                          <div className="font-bold text-blue-400">{attempt.name}</div>
                          <span className={`${statusInfo.color} text-lg`}>{statusInfo.icon}</span>
                        </div>
                        <div className="space-y-1 text-sm">
                          <div className="text-gray-400">
                            <span className="text-gray-500">Time:</span> {formatLocalTime(attempt.timestamp)}
                          </div>
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
                            <div className="text-gray-400">
                              <span className="text-gray-500">Download:</span> {attempt.downloadFile}
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
                          <div className="flex-1 grid grid-cols-4 gap-4">
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Player</div>
                              <div className="font-medium text-blue-400">{attempt.name}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Time</div>
                              <div className="text-sm text-gray-300">{formatLocalTime(attempt.timestamp)}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">IP / Client</div>
                              <div className="text-sm text-gray-400">
                                {attempt.ip || '-'}
                                {attempt.version && <span className="ml-2 text-gray-500">({attempt.version})</span>}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Status</div>
                              <div className={`text-sm ${statusInfo.color}`}>{statusInfo.label}</div>
                            </div>
                          </div>
                        </div>
                        {attempt.downloadFile && (
                          <div className="mt-2 ml-10 text-sm text-gray-400">
                            <span className="text-gray-500">Download:</span> {attempt.downloadFile}
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
        ) : (
          // Raw Logs View
          <div className="h-full overflow-y-auto p-3 md:p-4 font-mono text-xs md:text-sm">
            {data?.logs.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                No logs found for this filter.
              </div>
            ) : (
              data?.logs.map((log, idx) => (
                <div
                  key={`${log.timestamp}-${idx}`}
                  className={`py-1 ${getCategoryStyle(log.category)}`}
                >
                  <span className="text-gray-600 mr-2">{formatLocalTime(log.timestamp)}</span>
                  <span className="mr-2">{getCategoryIcon(log.category)}</span>
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
          <p><span className="text-green-400">✓</span> = Joined successfully</p>
          <p><span className="text-yellow-400">↓</span> = Downloading pk3, may have disconnected</p>
          <p><span className="text-red-400">✗</span> = sv_pure checksum mismatch - player should delete their legacy/ folder cache</p>
          <p><span className="text-gray-400">?</span> = Connection attempt (no further info)</p>
        </div>
      )}
    </div>
  );
}
