import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { players } from '../api/client';
import { renderETColors } from '../utils/etColors';

function formatPlaytime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${diffYears}y ago`;
}

function formatLastSeenParts(dateString: string): { formatted: string; relative: string } {
  const date = new Date(dateString);
  const formatted = date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const relative = formatRelativeTime(date);
  return { formatted, relative };
}

type SortField = 'lastSeen' | 'name' | 'kills' | 'deaths' | 'suicides' | 'playtimeSeconds';
type SortOrder = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  order: SortOrder;
}

export default function Players() {
  const location = useLocation();
  const isPublicRoute = location.pathname.startsWith('/stats');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<SortConfig>({ field: 'lastSeen', order: 'desc' });

  // Debounce search input
  const handleSearchChange = (value: string) => {
    setSearch(value);
    // Simple debounce
    setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  };

  const handleSort = (field: SortField) => {
    setSort((prev) => ({
      field,
      order: prev.field === field && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  };

  const { data: statsData, isLoading } = useQuery({
    queryKey: ['playerStats', debouncedSearch, sort.field, sort.order],
    queryFn: () => players.stats(100, 0, debouncedSearch, sort.field, sort.order),
  });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sort.field !== field) {
      return <span className="ml-1 text-gray-600">↕</span>;
    }
    return <span className="ml-1 text-orange-400">{sort.order === 'desc' ? '↓' : '↑'}</span>;
  };

  const SortableHeader = ({ field, children, className = '' }: { field: SortField; children: React.ReactNode; className?: string }) => (
    <th
      className={`pb-3 pr-4 cursor-pointer hover:text-white transition-colors select-none ${className}`}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center">
        {children}
        <SortIcon field={field} />
      </span>
    </th>
  );

  return (
    <div className={`space-y-4 md:space-y-6 ${isPublicRoute ? 'min-h-screen bg-gray-900 p-4 md:p-8' : ''}`}>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
        <h1 className="text-xl md:text-2xl font-bold">Player Statistics</h1>
        <div className="text-sm text-gray-400">
          {statsData?.total ?? 0} players tracked
        </div>
      </div>

      {/* Search */}
      <div className="bg-gray-800 rounded-lg p-3 md:p-4">
        <input
          type="text"
          placeholder="Search players by name..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 md:px-4 py-2.5 md:py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 text-base"
        />
      </div>

      {/* Mobile Sort Dropdown */}
      <div className="md:hidden bg-gray-800 rounded-lg p-3">
        <label className="text-sm text-gray-400 mr-2">Sort by:</label>
        <select
          value={`${sort.field}-${sort.order}`}
          onChange={(e) => {
            const [field, order] = e.target.value.split('-') as [SortField, SortOrder];
            setSort({ field, order });
          }}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm"
        >
          <option value="lastSeen-desc">Last Seen (newest)</option>
          <option value="lastSeen-asc">Last Seen (oldest)</option>
          <option value="name-asc">Name (A-Z)</option>
          <option value="name-desc">Name (Z-A)</option>
          <option value="kills-desc">Kills (high-low)</option>
          <option value="kills-asc">Kills (low-high)</option>
          <option value="deaths-desc">Deaths (high-low)</option>
          <option value="deaths-asc">Deaths (low-high)</option>
          <option value="suicides-desc">Suicides (high-low)</option>
          <option value="suicides-asc">Suicides (low-high)</option>
          <option value="playtimeSeconds-desc">Playtime (most)</option>
          <option value="playtimeSeconds-asc">Playtime (least)</option>
        </select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-400">Loading player stats...</div>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg p-4 md:p-6">
          {/* Mobile: Card Layout */}
          <div className="md:hidden space-y-3">
            {statsData?.players.map((player, index) => {
              const humanKD = player.deaths > 0
                ? (player.kills / player.deaths).toFixed(2)
                : player.kills.toString();
              const botKD = player.botDeaths > 0
                ? (player.botKills / player.botDeaths).toFixed(2)
                : player.botKills.toString();

              return (
                <Link
                  key={player.id}
                  to={`${isPublicRoute ? '/stats' : '/players'}/${player.guid}`}
                  className="block bg-gray-700 rounded-lg p-4 hover:bg-gray-600 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">
                      {renderETColors(player.displayName || player.name)}
                    </span>
                    <span className="text-xs text-gray-400">#{index + 1}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-gray-400">Human K/D: </span>
                      <span className="text-green-400">{player.kills}</span>
                      <span className="text-gray-500">/</span>
                      <span className="text-red-400">{player.deaths}</span>
                      <span className="text-gray-400 ml-1">({humanKD})</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Bot K/D: </span>
                      <span className="text-green-400">{player.botKills}</span>
                      <span className="text-gray-500">/</span>
                      <span className="text-red-400">{player.botDeaths}</span>
                      <span className="text-gray-400 ml-1">({botKD})</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Playtime: </span>
                      <span>{formatPlaytime(player.playtimeSeconds)}</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Suicides: </span>
                      <span className="text-yellow-400">{player.suicides}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {(() => {
                      const { formatted, relative } = formatLastSeenParts(player.lastSeen);
                      return <>Last seen: {formatted} ({relative})</>;
                    })()}
                  </div>
                </Link>
              );
            })}
            {(!statsData?.players || statsData.players.length === 0) && (
              <div className="py-8 text-center text-gray-400">
                {debouncedSearch ? 'No players found matching your search' : 'No player statistics yet'}
              </div>
            )}
          </div>

          {/* Desktop: Table Layout */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">#</th>
                  <SortableHeader field="name">Name</SortableHeader>
                  <SortableHeader field="kills">Human K/D</SortableHeader>
                  <SortableHeader field="deaths" className="hidden lg:table-cell">Deaths</SortableHeader>
                  <SortableHeader field="suicides">Suicides</SortableHeader>
                  <SortableHeader field="playtimeSeconds">Playtime</SortableHeader>
                  <SortableHeader field="lastSeen" className="w-64">Last Seen</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {statsData?.players.map((player, index) => {
                  const humanKD = player.deaths > 0
                    ? (player.kills / player.deaths).toFixed(2)
                    : player.kills.toString();
                  const botKD = player.botDeaths > 0
                    ? (player.botKills / player.botDeaths).toFixed(2)
                    : player.botKills.toString();

                  return (
                    <tr key={player.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="py-3 pr-4 text-gray-400">{index + 1}</td>
                      <td className="py-3 pr-4">
                        <Link
                          to={`${isPublicRoute ? '/stats' : '/players'}/${player.guid}`}
                          className="font-medium hover:underline"
                        >
                          {renderETColors(player.displayName || player.name)}
                        </Link>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-green-400">{player.kills}</span>
                        <span className="text-gray-500"> / </span>
                        <span className="text-red-400">{player.deaths}</span>
                        <span className="text-gray-400 ml-2">({humanKD})</span>
                      </td>
                      <td className="py-3 pr-4 hidden lg:table-cell">
                        <span className="text-green-400">{player.botKills}</span>
                        <span className="text-gray-500"> / </span>
                        <span className="text-red-400">{player.botDeaths}</span>
                        <span className="text-gray-400 ml-2">({botKD})</span>
                      </td>
                      <td className="py-3 pr-4 text-yellow-400">{player.suicides}</td>
                      <td className="py-3 pr-4">{formatPlaytime(player.playtimeSeconds)}</td>
                      <td className="py-3 text-gray-400 w-64">
                        {(() => {
                          const { formatted, relative } = formatLastSeenParts(player.lastSeen);
                          return (
                            <div className="flex justify-between">
                              <span>{formatted}</span>
                              <span className="text-gray-500">({relative})</span>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
                {(!statsData?.players || statsData.players.length === 0) && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-gray-400">
                      {debouncedSearch ? 'No players found matching your search' : 'No player statistics yet'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
