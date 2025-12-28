import { useQuery } from '@tanstack/react-query';
import { server } from '../api/client';
import { useAuthStore } from '../stores/auth';

function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

export default function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const { data: status, isLoading, error } = useQuery({
    queryKey: ['serverStatus'],
    queryFn: server.status,
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading server status...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-4">
        <p className="text-red-400">Failed to load server status</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h1 className="text-xl md:text-2xl font-bold">Dashboard</h1>
        <span className="text-sm text-gray-400">Welcome, {user?.displayName}</span>
      </div>

      {/* Server Status Card */}
      <div className="bg-gray-800 rounded-lg p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-semibold">Server Status</h2>
          <span
            className={`px-2 md:px-3 py-1 rounded-full text-xs md:text-sm font-medium ${
              status?.online ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
            }`}
          >
            {status?.online ? 'Online' : 'Offline'}
          </span>
        </div>

        {status?.online && (
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            <div className="bg-gray-700 rounded-lg p-3 md:p-4">
              <div className="text-gray-400 text-xs md:text-sm">Map</div>
              <div className="text-base md:text-lg font-medium truncate">{status.map}</div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3 md:p-4">
              <div className="text-gray-400 text-xs md:text-sm">Players</div>
              <div className="text-base md:text-lg font-medium">
                {status.players?.length || 0} / {status.maxPlayers}
              </div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3 md:p-4 col-span-2 md:col-span-1">
              <div className="text-gray-400 text-xs md:text-sm">Server Name</div>
              <div className="text-base md:text-lg font-medium truncate">
                {status.hostname ? stripColors(status.hostname) : 'Unknown'}
              </div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3 md:p-4 col-span-2 md:col-span-1">
              <div className="text-gray-400 text-xs md:text-sm">WebSocket Clients</div>
              <div className="text-base md:text-lg font-medium">{status.wsClients || 0}</div>
            </div>
          </div>
        )}
      </div>

      {/* Players List */}
      {status?.online && status.players && status.players.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4 md:p-6">
          <h2 className="text-lg md:text-xl font-semibold mb-4">
            Current Players ({status.players.length})
          </h2>

          {/* Mobile: Card Layout */}
          <div className="md:hidden space-y-2">
            {status.players.map((player) => (
              <div key={player.slot} className="bg-gray-700 rounded-lg p-3 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-gray-400 text-sm w-6 flex-shrink-0">#{player.slot}</span>
                  <span className="font-medium truncate">{stripColors(player.name)}</span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm text-gray-300">{player.score}</span>
                  <span
                    className={`text-sm ${
                      player.ping === 0
                        ? 'text-blue-400'
                        : player.ping < 50
                        ? 'text-green-400'
                        : player.ping < 100
                        ? 'text-yellow-400'
                        : 'text-red-400'
                    }`}
                  >
                    {player.ping === 0 ? 'BOT' : `${player.ping}ms`}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: Table Layout */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">Slot</th>
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4">Score</th>
                  <th className="pb-3">Ping</th>
                </tr>
              </thead>
              <tbody>
                {status.players.map((player) => (
                  <tr key={player.slot} className="border-b border-gray-700/50">
                    <td className="py-3 pr-4 text-gray-400">{player.slot}</td>
                    <td className="py-3 pr-4 font-medium">{stripColors(player.name)}</td>
                    <td className="py-3 pr-4">{player.score}</td>
                    <td className="py-3">
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
