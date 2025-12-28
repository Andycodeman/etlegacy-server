import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { admin } from '../api/client';
import type { AdminBanListItem } from '../api/client';

type TabType = 'overview' | 'players' | 'bans' | 'logs' | 'commands';

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getLevelColor(level: number | null): string {
  switch (level) {
    case 0: return 'text-gray-400';
    case 1: return 'text-gray-300';
    case 2: return 'text-blue-400';
    case 3: return 'text-green-400';
    case 4: return 'text-yellow-400';
    case 5: return 'text-red-400';
    default: return 'text-gray-400';
  }
}

function getSourceBadge(source: string): { bg: string; text: string } {
  switch (source) {
    case 'game': return { bg: 'bg-blue-500/20', text: 'text-blue-400' };
    case 'etpanel': return { bg: 'bg-purple-500/20', text: 'text-purple-400' };
    case 'rcon': return { bg: 'bg-orange-500/20', text: 'text-orange-400' };
    default: return { bg: 'bg-gray-500/20', text: 'text-gray-400' };
  }
}

// Overview Tab
function OverviewTab() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: admin.stats,
    refetchInterval: 30000,
  });

  const { data: logStats } = useQuery({
    queryKey: ['admin', 'logStats'],
    queryFn: admin.logStats,
  });

  const { data: myStatus } = useQuery({
    queryKey: ['admin', 'me'],
    queryFn: admin.me,
  });

  if (isLoading) {
    return <div className="text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-gray-700 rounded-lg p-4">
          <div className="text-3xl font-bold text-white">{stats?.totalPlayers ?? 0}</div>
          <div className="text-gray-400 text-sm">Total Players</div>
        </div>
        <div className="bg-gray-700 rounded-lg p-4">
          <div className="text-3xl font-bold text-red-400">{stats?.activeBans ?? 0}</div>
          <div className="text-gray-400 text-sm">Active Bans</div>
        </div>
        <div className="bg-gray-700 rounded-lg p-4">
          <div className="text-3xl font-bold text-green-400">{stats?.adminCount ?? 0}</div>
          <div className="text-gray-400 text-sm">Admins</div>
        </div>
        <div className="bg-gray-700 rounded-lg p-4">
          <div className="text-3xl font-bold text-blue-400">{stats?.recentCommands ?? 0}</div>
          <div className="text-gray-400 text-sm">Commands (24h)</div>
        </div>
      </div>

      {/* Your Admin Status */}
      <div className="bg-gray-700 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-3">Your Admin Status</h3>
        {myStatus?.linked ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">GUID:</span>
              <code className="text-sm bg-gray-600 px-2 py-1 rounded">{myStatus.guid}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-400">Level:</span>
              {myStatus.adminLevel !== null && myStatus.adminLevel !== undefined ? (
                <span className={getLevelColor(myStatus.adminLevel)}>
                  {myStatus.adminLevel} ({myStatus.adminLevelName})
                </span>
              ) : (
                <span className="text-gray-500">Not set</span>
              )}
            </div>
            {myStatus.lastSeen && (
              <div className="flex items-center gap-2">
                <span className="text-gray-400">Last seen in-game:</span>
                <span>{formatRelativeTime(myStatus.lastSeen)}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-gray-400">
            {myStatus?.message || 'No game account linked'}
          </div>
        )}
      </div>

      {/* Command Stats */}
      {logStats && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-3">Top Commands (24h)</h3>
            <div className="space-y-2">
              {logStats.commandCounts.slice(0, 8).map((cmd) => (
                <div key={cmd.command} className="flex justify-between">
                  <span className="text-orange-400">!{cmd.command}</span>
                  <span className="text-gray-400">{cmd.count}</span>
                </div>
              ))}
              {logStats.commandCounts.length === 0 && (
                <div className="text-gray-500">No commands in last 24h</div>
              )}
            </div>
          </div>
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-3">By Source (24h)</h3>
            <div className="space-y-2">
              {logStats.sourceCounts.map((src) => {
                const badge = getSourceBadge(src.source);
                return (
                  <div key={src.source} className="flex justify-between items-center">
                    <span className={`px-2 py-1 rounded text-sm ${badge.bg} ${badge.text}`}>
                      {src.source}
                    </span>
                    <span className="text-gray-400">{src.count}</span>
                  </div>
                );
              })}
              {logStats.sourceCounts.length === 0 && (
                <div className="text-gray-500">No commands in last 24h</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Players Tab
function PlayersTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [editingLevel, setEditingLevel] = useState<{ guid: string; level: number } | null>(null);

  const { data: playersData, isLoading } = useQuery({
    queryKey: ['admin', 'players', search],
    queryFn: () => admin.players(100, 0, search),
  });

  const { data: levels } = useQuery({
    queryKey: ['admin', 'levels'],
    queryFn: admin.levels,
  });

  const { data: playerDetail, isLoading: isLoadingDetail } = useQuery({
    queryKey: ['admin', 'player', selectedPlayer],
    queryFn: () => (selectedPlayer ? admin.player(selectedPlayer) : Promise.resolve(null)),
    enabled: !!selectedPlayer,
  });

  const setLevelMutation = useMutation({
    mutationFn: ({ guid, level }: { guid: string; level: number }) => admin.setLevel(guid, level),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'players'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'player', editingLevel?.guid] });
      setEditingLevel(null);
    },
  });

  return (
    <div className="grid md:grid-cols-2 gap-6">
      {/* Player List */}
      <div className="space-y-4">
        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
        />

        {isLoading ? (
          <div className="text-gray-400">Loading players...</div>
        ) : (
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {playersData?.players.map((player) => (
              <div
                key={player.guid}
                onClick={() => setSelectedPlayer(player.guid)}
                className={`p-3 rounded-lg cursor-pointer transition-colors ${
                  selectedPlayer === player.guid
                    ? 'bg-orange-600'
                    : 'bg-gray-700 hover:bg-gray-600'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium">{player.cleanName}</div>
                    <div className="text-xs text-gray-400 font-mono">{player.guid}</div>
                  </div>
                  <div className="text-right">
                    <div className={getLevelColor(player.levelNum)}>
                      {player.levelName || 'Guest'}
                    </div>
                    <div className="text-xs text-gray-400">
                      {formatRelativeTime(player.lastSeen)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {playersData?.players.length === 0 && (
              <div className="text-gray-500 text-center py-8">No players found</div>
            )}
          </div>
        )}
      </div>

      {/* Player Detail */}
      <div className="bg-gray-700 rounded-lg p-4">
        {selectedPlayer ? (
          isLoadingDetail ? (
            <div className="text-gray-400">Loading player details...</div>
          ) : playerDetail ? (
            <div className="space-y-4">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-xl font-semibold">
                    {playerDetail.aliases[0]?.cleanAlias || 'Unknown'}
                  </h3>
                  <code className="text-xs text-gray-400">{playerDetail.player.guid}</code>
                </div>
                <div className="text-right">
                  {editingLevel?.guid === playerDetail.player.guid ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={editingLevel.level}
                        onChange={(e) => setEditingLevel({ ...editingLevel, level: parseInt(e.target.value) })}
                        className="bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                      >
                        {levels?.levels.map((l) => (
                          <option key={l.id} value={l.level}>
                            {l.level} - {l.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setLevelMutation.mutate(editingLevel)}
                        disabled={setLevelMutation.isPending}
                        className="px-2 py-1 bg-green-600 hover:bg-green-500 rounded text-sm"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingLevel(null)}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div>
                      <span className={getLevelColor(playerDetail.player.levelNum)}>
                        {playerDetail.player.levelName || 'Guest'}
                      </span>
                      <button
                        onClick={() => setEditingLevel({
                          guid: playerDetail.player.guid,
                          level: playerDetail.player.levelNum ?? 0,
                        })}
                        className="ml-2 text-blue-400 hover:text-blue-300 text-sm"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-400">First seen</div>
                  <div>{formatDateTime(playerDetail.player.createdAt)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Last seen</div>
                  <div>{formatDateTime(playerDetail.player.lastSeen)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Times seen</div>
                  <div>{playerDetail.player.timesSeen}</div>
                </div>
              </div>

              {/* Aliases */}
              <div>
                <h4 className="font-semibold text-gray-300 mb-2">Aliases ({playerDetail.aliases.length})</h4>
                <div className="flex flex-wrap gap-2">
                  {playerDetail.aliases.slice(0, 10).map((alias) => (
                    <span key={alias.id} className="bg-gray-600 px-2 py-1 rounded text-sm">
                      {alias.cleanAlias}
                    </span>
                  ))}
                  {playerDetail.aliases.length > 10 && (
                    <span className="text-gray-400 text-sm">+{playerDetail.aliases.length - 10} more</span>
                  )}
                </div>
              </div>

              {/* Warnings */}
              {playerDetail.warnings.length > 0 && (
                <div>
                  <h4 className="font-semibold text-yellow-400 mb-2">
                    Warnings ({playerDetail.warnings.length})
                  </h4>
                  <div className="space-y-2">
                    {playerDetail.warnings.map((w) => (
                      <div key={w.id} className="bg-yellow-500/10 border border-yellow-500/30 rounded p-2 text-sm">
                        <div>{w.reason}</div>
                        <div className="text-xs text-gray-400">{formatDateTime(w.issuedAt)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Bans */}
              {playerDetail.bans.length > 0 && (
                <div>
                  <h4 className="font-semibold text-red-400 mb-2">
                    Ban History ({playerDetail.bans.length})
                  </h4>
                  <div className="space-y-2">
                    {playerDetail.bans.map((b) => (
                      <div
                        key={b.id}
                        className={`rounded p-2 text-sm ${
                          b.active ? 'bg-red-500/20 border border-red-500/30' : 'bg-gray-600'
                        }`}
                      >
                        <div className="flex justify-between">
                          <span>{b.reason || 'No reason'}</span>
                          {b.active && <span className="text-red-400 text-xs">ACTIVE</span>}
                        </div>
                        <div className="text-xs text-gray-400">
                          {formatDateTime(b.issuedAt)}
                          {b.expiresAt && ` - Expires: ${formatDateTime(b.expiresAt)}`}
                          {!b.expiresAt && ' - Permanent'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null
        ) : (
          <div className="text-gray-400 text-center py-8">
            Select a player to view details
          </div>
        )}
      </div>
    </div>
  );
}

// Bans Tab
function BansTab() {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);

  const { data: bansData, isLoading } = useQuery({
    queryKey: ['admin', 'bans', showHistory],
    queryFn: () => (showHistory ? admin.banHistory(200) : admin.bans(100)),
  });

  const unbanMutation = useMutation({
    mutationFn: (banId: number) => admin.unban(banId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });

  const bans = showHistory
    ? (bansData as { bans: AdminBanListItem[] } | undefined)?.bans
    : (bansData as { bans: AdminBanListItem[] } | undefined)?.bans;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setShowHistory(false)}
            className={`px-4 py-2 rounded ${
              !showHistory ? 'bg-orange-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Active Bans
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className={`px-4 py-2 rounded ${
              showHistory ? 'bg-orange-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Ban History
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-gray-400">Loading bans...</div>
      ) : (
        <div className="bg-gray-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-left text-gray-400 bg-gray-600">
                <th className="p-3">Player</th>
                <th className="p-3">Reason</th>
                <th className="p-3">Issued</th>
                <th className="p-3">Expires</th>
                <th className="p-3">Status</th>
                {!showHistory && <th className="p-3">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {bans?.map((ban) => (
                <tr key={ban.id} className="border-t border-gray-600">
                  <td className="p-3">
                    <div>{ban.playerCleanName}</div>
                    <div className="text-xs text-gray-400 font-mono">{ban.playerGuid}</div>
                  </td>
                  <td className="p-3 text-gray-300">{ban.reason || 'No reason'}</td>
                  <td className="p-3 text-gray-400">{formatRelativeTime(ban.issuedAt)}</td>
                  <td className="p-3 text-gray-400">
                    {ban.isPermanent ? (
                      <span className="text-red-400">Permanent</span>
                    ) : ban.expiresAt ? (
                      formatDateTime(ban.expiresAt)
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="p-3">
                    {ban.active ? (
                      <span className="bg-red-500/20 text-red-400 px-2 py-1 rounded text-sm">Active</span>
                    ) : (
                      <span className="bg-gray-500/20 text-gray-400 px-2 py-1 rounded text-sm">Inactive</span>
                    )}
                  </td>
                  {!showHistory && (
                    <td className="p-3">
                      {ban.active && (
                        <button
                          onClick={() => unbanMutation.mutate(ban.id)}
                          disabled={unbanMutation.isPending}
                          className="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm"
                        >
                          Unban
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {bans?.length === 0 && (
                <tr>
                  <td colSpan={showHistory ? 5 : 6} className="p-8 text-center text-gray-400">
                    {showHistory ? 'No ban history' : 'No active bans'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Logs Tab
function LogsTab() {
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [commandFilter, setCommandFilter] = useState<string>('');

  const { data: logsData, isLoading } = useQuery({
    queryKey: ['admin', 'logs', sourceFilter, commandFilter],
    queryFn: () => admin.logs(200, 0, commandFilter || undefined, sourceFilter || undefined),
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
        >
          <option value="">All Sources</option>
          <option value="game">Game</option>
          <option value="etpanel">ETPanel</option>
          <option value="rcon">RCON</option>
        </select>
        <input
          type="text"
          placeholder="Filter by command..."
          value={commandFilter}
          onChange={(e) => setCommandFilter(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white placeholder-gray-400 flex-1"
        />
      </div>

      {isLoading ? (
        <div className="text-gray-400">Loading logs...</div>
      ) : (
        <div className="bg-gray-700 rounded-lg overflow-hidden max-h-[600px] overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-gray-600">
              <tr className="text-left text-gray-400">
                <th className="p-3">Time</th>
                <th className="p-3">Source</th>
                <th className="p-3">Player</th>
                <th className="p-3">Command</th>
                <th className="p-3">Target</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {logsData?.logs.map((log) => {
                const badge = getSourceBadge(log.source);
                return (
                  <tr key={log.id} className="border-t border-gray-600">
                    <td className="p-3 text-gray-400 text-sm whitespace-nowrap">
                      {formatRelativeTime(log.executedAt)}
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-1 rounded text-xs ${badge.bg} ${badge.text}`}>
                        {log.source}
                      </span>
                    </td>
                    <td className="p-3">{log.playerName || '-'}</td>
                    <td className="p-3">
                      <span className="text-orange-400">!{log.command}</span>
                      {log.args && <span className="text-gray-400 ml-2">{log.args}</span>}
                    </td>
                    <td className="p-3">{log.targetPlayerName || '-'}</td>
                    <td className="p-3">
                      {log.success === true && (
                        <span className="text-green-400">Success</span>
                      )}
                      {log.success === false && (
                        <span className="text-red-400">Failed</span>
                      )}
                      {log.success === null && (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {logsData?.logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-gray-400">
                    No command logs found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Commands Tab (Admin-editable table)
function CommandsTab() {
  const queryClient = useQueryClient();

  const { data: commandsData, isLoading } = useQuery({
    queryKey: ['admin', 'commands'],
    queryFn: admin.commands,
  });

  const { data: levels } = useQuery({
    queryKey: ['admin', 'levels'],
    queryFn: admin.levels,
  });

  const setLevelMutation = useMutation({
    mutationFn: ({ commandId, level }: { commandId: number; level: number }) =>
      admin.setCommandLevel(commandId, level),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'commands'] });
    },
  });

  const setEnabledMutation = useMutation({
    mutationFn: ({ commandId, enabled }: { commandId: number; enabled: boolean }) =>
      admin.setCommandEnabled(commandId, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'commands'] });
    },
  });

  if (isLoading) {
    return <div className="text-gray-400">Loading commands...</div>;
  }

  const sortedCommands = [...(commandsData?.commands || [])].sort((a, b) => {
    if (a.defaultLevel !== b.defaultLevel) return a.defaultLevel - b.defaultLevel;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-400">
        Click the level dropdown to change which admin level can use each command.
      </div>

      <div className="bg-gray-700 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="text-left text-gray-400 bg-gray-600">
              <th className="p-3">Command</th>
              <th className="p-3">Description</th>
              <th className="p-3">Usage</th>
              <th className="p-3 w-36">Level</th>
              <th className="p-3 w-24">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {sortedCommands.map((cmd) => (
              <tr key={cmd.id} className="border-t border-gray-600 hover:bg-gray-600/50">
                <td className="p-3">
                  <span className="text-orange-400 font-mono font-medium">!{cmd.name}</span>
                </td>
                <td className="p-3 text-gray-300 text-sm">
                  {cmd.description || <span className="text-gray-500">-</span>}
                </td>
                <td className="p-3 text-gray-400 text-xs font-mono">
                  {cmd.usage || <span className="text-gray-500">-</span>}
                </td>
                <td className="p-3">
                  <select
                    value={cmd.defaultLevel}
                    onChange={(e) =>
                      setLevelMutation.mutate({ commandId: cmd.id, level: parseInt(e.target.value) })
                    }
                    disabled={setLevelMutation.isPending}
                    className={`bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm w-full ${getLevelColor(cmd.defaultLevel)}`}
                  >
                    {levels?.levels.map((level) => (
                      <option key={level.id} value={level.level}>
                        {level.level} - {level.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <button
                    onClick={() =>
                      setEnabledMutation.mutate({ commandId: cmd.id, enabled: !cmd.enabled })
                    }
                    disabled={setEnabledMutation.isPending}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                      cmd.enabled
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    }`}
                  >
                    {cmd.enabled ? 'Yes' : 'No'}
                  </button>
                </td>
              </tr>
            ))}
            {sortedCommands.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-gray-400">
                  No commands configured
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Main Admin Page
export default function Admin() {
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  const tabs: { id: TabType; label: string; icon: string }[] = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'players', label: 'Players', icon: '👥' },
    { id: 'bans', label: 'Bans', icon: '🚫' },
    { id: 'logs', label: 'Logs', icon: '📜' },
    { id: 'commands', label: 'Commands', icon: '⌘' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin System</h1>
        <div className="text-sm text-gray-400">
          In-game !commands management
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-700 pb-2 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-t transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
            }`}
          >
            <span className="mr-2">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="bg-gray-800 rounded-lg p-4 md:p-6">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'players' && <PlayersTab />}
        {activeTab === 'bans' && <BansTab />}
        {activeTab === 'logs' && <LogsTab />}
        {activeTab === 'commands' && <CommandsTab />}
      </div>
    </div>
  );
}
