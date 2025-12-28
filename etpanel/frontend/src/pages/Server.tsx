import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { server, serverAdmin } from '../api/client';
import type { Player } from '../api/client';
import { useAuthStore } from '../stores/auth';

function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// Common admin commands with descriptions
const ADMIN_COMMANDS = [
  { command: 'vstr nextmap', label: 'Next Map', description: 'Switch to next map in rotation', icon: '⏭️' },
  { command: 'map_restart', label: 'Restart Map', description: 'Restart current map', icon: '🔄' },
  { command: 'reset_match', label: 'Reset Match', description: 'Reset match scores', icon: '🔁' },
  { command: 'shuffle', label: 'Shuffle Teams', description: 'Shuffle players between teams', icon: '🔀' },
  { command: 'swapteams', label: 'Swap Teams', description: 'Swap Axis and Allies', icon: '↔️' },
  { command: 'pause', label: 'Pause', description: 'Pause the game', icon: '⏸️' },
  { command: 'unpause', label: 'Unpause', description: 'Resume the game', icon: '▶️' },
  { command: 'putallies all', label: 'All to Allies', description: 'Move all players to Allies', icon: '🔵' },
  { command: 'putaxis all', label: 'All to Axis', description: 'Move all players to Axis', icon: '🔴' },
];

export default function Server() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [rconCommand, setRconCommand] = useState('');
  const [rconResponse, setRconResponse] = useState<string | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [kickReason, setKickReason] = useState('');
  const [banReason, setBanReason] = useState('');
  const [banDuration, setBanDuration] = useState('0'); // 0 = permanent
  const [showKickModal, setShowKickModal] = useState(false);
  const [showBanModal, setShowBanModal] = useState(false);

  // Check admin access
  if (user?.role !== 'admin') {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-6">
        <h2 className="text-xl font-bold text-red-400">Access Denied</h2>
        <p className="text-gray-400 mt-2">You must be an admin to access server management.</p>
      </div>
    );
  }

  const { data: status, isLoading } = useQuery({
    queryKey: ['serverStatus'],
    queryFn: server.status,
    refetchInterval: 5000,
  });

  const { data: gameInfo } = useQuery({
    queryKey: ['gameInfo'],
    queryFn: serverAdmin.gameInfo,
    refetchInterval: 10000,
    enabled: status?.online,
  });

  const kickMutation = useMutation({
    mutationFn: ({ slot, reason }: { slot: number; reason?: string }) =>
      serverAdmin.kick(slot, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverStatus'] });
      setShowKickModal(false);
      setKickReason('');
      setSelectedPlayer(null);
    },
  });

  const banMutation = useMutation({
    mutationFn: ({ slot, reason, duration }: { slot: number; reason?: string; duration?: number }) =>
      serverAdmin.ban(slot, reason, duration),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverStatus'] });
      setShowBanModal(false);
      setBanReason('');
      setBanDuration('0');
      setSelectedPlayer(null);
    },
  });

  const commandMutation = useMutation({
    mutationFn: (command: string) => serverAdmin.command(command),
    onSuccess: (data) => {
      setRconResponse(data.response || 'Command executed successfully');
      queryClient.invalidateQueries({ queryKey: ['serverStatus'] });
      queryClient.invalidateQueries({ queryKey: ['gameInfo'] });
    },
    onError: (error: Error) => {
      setRconResponse(`Error: ${error.message}`);
    },
  });

  const quickCommandMutation = useMutation({
    mutationFn: (command: string) => serverAdmin.command(command),
    onSuccess: (data) => {
      console.log('Quick command result:', data);
      queryClient.invalidateQueries({ queryKey: ['serverStatus'] });
      queryClient.invalidateQueries({ queryKey: ['gameInfo'] });
    },
    onError: (error: Error) => {
      console.error('Quick command error:', error);
      alert(`Command failed: ${error.message}`);
    },
  });

  const handleRconSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (rconCommand.trim()) {
      commandMutation.mutate(rconCommand.trim());
      setRconCommand('');
    }
  };

  const handleKick = (player: Player) => {
    setSelectedPlayer(player);
    setShowKickModal(true);
  };

  const handleBan = (player: Player) => {
    setSelectedPlayer(player);
    setShowBanModal(true);
  };

  const confirmKick = () => {
    if (selectedPlayer) {
      kickMutation.mutate({ slot: selectedPlayer.slot, reason: kickReason || undefined });
    }
  };

  const confirmBan = () => {
    if (selectedPlayer) {
      banMutation.mutate({
        slot: selectedPlayer.slot,
        reason: banReason || undefined,
        duration: parseInt(banDuration) || 0,
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading server status...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Server Management</h1>
        <span
          className={`px-3 py-1 rounded-full text-sm font-medium ${
            status?.online ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
          }`}
        >
          {status?.online ? 'Online' : 'Offline'}
        </span>
      </div>

      {/* Game Stats */}
      {status?.online && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Game Status</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <div className="bg-gray-700 rounded-lg p-4">
              <div className="text-gray-400 text-sm">Current Map</div>
              <div className="text-lg font-medium">{status.map || 'Unknown'}</div>
            </div>
            <div className="bg-gray-700 rounded-lg p-4">
              <div className="text-gray-400 text-sm">Players</div>
              <div className="text-lg font-medium">
                {status.players?.length || 0} / {status.maxPlayers || 20}
              </div>
            </div>
            {gameInfo?.timelimit && (
              <div className="bg-gray-700 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Time Limit</div>
                <div className="text-lg font-medium">{stripColors(gameInfo.timelimit)} min</div>
              </div>
            )}
            {gameInfo?.serverTime !== undefined && (
              <div className="bg-gray-700 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Time Elapsed</div>
                <div className="text-lg font-medium">{formatTime(gameInfo.serverTime)}</div>
              </div>
            )}
            {gameInfo?.timeRemaining !== undefined && (
              <div className="bg-gray-700 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Time Remaining</div>
                <div className={`text-lg font-medium ${gameInfo.timeRemaining < 300 ? 'text-red-400' : 'text-orange-400'}`}>
                  {formatTime(gameInfo.timeRemaining)}
                </div>
              </div>
            )}
            {gameInfo?.axisScore !== undefined && (
              <div className="bg-gray-700 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Axis Score</div>
                <div className="text-lg font-medium text-red-400">{gameInfo.axisScore}</div>
              </div>
            )}
            {gameInfo?.alliesScore !== undefined && (
              <div className="bg-gray-700 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Allies Score</div>
                <div className="text-lg font-medium text-blue-400">{gameInfo.alliesScore}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick Commands */}
      {status?.online && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Quick Commands</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {ADMIN_COMMANDS.map((cmd) => (
              <button
                key={cmd.command}
                onClick={() => quickCommandMutation.mutate(cmd.command)}
                disabled={quickCommandMutation.isPending}
                className="flex items-center gap-2 px-4 py-3 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 disabled:opacity-50 rounded-lg transition-colors text-left"
                title={cmd.description}
              >
                <span className="text-xl">{cmd.icon}</span>
                <div>
                  <div className="font-medium text-sm">{cmd.label}</div>
                  <div className="text-xs text-gray-400 hidden lg:block">{cmd.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Player Management */}
      {status?.online && status.players && status.players.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">
            Player Management ({status.players.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">Slot</th>
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4">Score</th>
                  <th className="pb-3 pr-4">Ping</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {status.players.map((player) => (
                  <tr key={player.slot} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                    <td className="py-3 pr-4 text-gray-400">{player.slot}</td>
                    <td className="py-3 pr-4 font-medium">{stripColors(player.name)}</td>
                    <td className="py-3 pr-4">{player.score}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={
                          player.ping === 0
                            ? 'text-blue-400'
                            : player.ping < 50
                            ? 'text-green-400'
                            : player.ping < 100
                            ? 'text-yellow-400'
                            : 'text-red-400'
                        }
                      >
                        {player.ping === 0 ? 'BOT' : `${player.ping}ms`}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex gap-2">
                        {player.ping !== 0 && (
                          <>
                            <button
                              onClick={() => handleKick(player)}
                              className="px-3 py-1 text-sm bg-yellow-600 hover:bg-yellow-500 rounded transition-colors"
                            >
                              Kick
                            </button>
                            <button
                              onClick={() => handleBan(player)}
                              className="px-3 py-1 text-sm bg-red-600 hover:bg-red-500 rounded transition-colors"
                            >
                              Ban
                            </button>
                          </>
                        )}
                        {player.ping === 0 && (
                          <button
                            onClick={() => quickCommandMutation.mutate(`kick ${player.slot}`)}
                            className="px-3 py-1 text-sm bg-gray-600 hover:bg-gray-500 rounded transition-colors"
                          >
                            Remove Bot
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* RCON Console */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">RCON Console</h2>
        <form onSubmit={handleRconSubmit} className="space-y-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={rconCommand}
              onChange={(e) => setRconCommand(e.target.value)}
              placeholder="Enter RCON command (e.g., status, map oasis, sv_maxclients 20)"
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-4 py-2 focus:ring-2 focus:ring-orange-500 focus:border-transparent text-white font-mono"
            />
            <button
              type="submit"
              disabled={commandMutation.isPending || !rconCommand.trim()}
              className="px-6 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
            >
              {commandMutation.isPending ? 'Sending...' : 'Execute'}
            </button>
          </div>
          {rconResponse && (
            <div className="bg-gray-900 rounded p-4 font-mono text-sm whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
              <div className="text-gray-400 text-xs mb-2">Response:</div>
              <div className="text-green-400">{stripColors(rconResponse)}</div>
            </div>
          )}
        </form>
        <div className="mt-4 text-sm text-gray-400">
          <p className="font-medium mb-2">Common commands:</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 font-mono text-xs">
            <span>status - Show server info</span>
            <span>map &lt;name&gt; - Change map</span>
            <span>kick &lt;slot&gt; - Kick player</span>
            <span>g_gravity &lt;val&gt; - Set gravity</span>
            <span>g_speed &lt;val&gt; - Set speed</span>
            <span>timelimit &lt;min&gt; - Set time</span>
          </div>
        </div>
      </div>

      {/* Kick Modal */}
      {showKickModal && selectedPlayer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-xl font-bold mb-4">Kick Player</h3>
            <p className="text-gray-300 mb-4">
              Are you sure you want to kick <span className="font-bold text-orange-400">{stripColors(selectedPlayer.name)}</span>?
            </p>
            <input
              type="text"
              value={kickReason}
              onChange={(e) => setKickReason(e.target.value)}
              placeholder="Reason (optional)"
              className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 mb-4 focus:ring-2 focus:ring-orange-500 focus:border-transparent text-white"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowKickModal(false);
                  setKickReason('');
                  setSelectedPlayer(null);
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmKick}
                disabled={kickMutation.isPending}
                className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 rounded transition-colors"
              >
                {kickMutation.isPending ? 'Kicking...' : 'Kick'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ban Modal */}
      {showBanModal && selectedPlayer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-xl font-bold mb-4">Ban Player</h3>
            <p className="text-gray-300 mb-4">
              Are you sure you want to ban <span className="font-bold text-red-400">{stripColors(selectedPlayer.name)}</span>?
            </p>
            <input
              type="text"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              placeholder="Reason (optional)"
              className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 mb-4 focus:ring-2 focus:ring-orange-500 focus:border-transparent text-white"
            />
            <div className="mb-4">
              <label className="block text-gray-400 text-sm mb-2">Ban Duration</label>
              <select
                value={banDuration}
                onChange={(e) => setBanDuration(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 focus:ring-2 focus:ring-orange-500 focus:border-transparent text-white"
              >
                <option value="0">Permanent</option>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="1440">1 day</option>
                <option value="10080">1 week</option>
              </select>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowBanModal(false);
                  setBanReason('');
                  setBanDuration('0');
                  setSelectedPlayer(null);
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmBan}
                disabled={banMutation.isPending}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded transition-colors"
              >
                {banMutation.isPending ? 'Banning...' : 'Ban'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
