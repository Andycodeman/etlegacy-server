import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { browser } from '../api/client';
import type { BrowserResponse } from '../api/client';

function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

interface Player {
  name: string;
  score: number;
  ping: number;
}

interface ServerInfo {
  address: string;
  name: string;
  favoriteName: string;
  hostname: string;
  map: string;
  mod: string;
  maxPlayers: number;
  players: Player[];
  humans: number;
  bots: number;
  ping: number;
  online: boolean;
  protocol: number;
}

export default function ServerBrowser() {
  const queryClient = useQueryClient();
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<BrowserResponse>({
    queryKey: ['serverBrowser'],
    queryFn: browser.servers,
    staleTime: 0, // Always consider data stale so refresh always fetches fresh
    gcTime: 0, // Don't cache results (formerly cacheTime)
  });

  const addMutation = useMutation({
    mutationFn: ({ address, name }: { address: string; name?: string }) =>
      browser.addFavorite(address, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverBrowser'] });
      setShowAddModal(false);
      setNewAddress('');
      setNewName('');
      setAddError('');
    },
    onError: (err: Error) => {
      setAddError(err.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ address, name }: { address: string; name: string }) =>
      browser.updateFavorite(address, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverBrowser'] });
      setEditingServer(null);
      setEditName('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (address: string) => browser.deleteFavorite(address),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverBrowser'] });
    },
  });

  const handleConnect = (address: string) => {
    window.location.href = `et://${address}`;
  };

  const handleQueryServer = async () => {
    if (!newAddress || !newAddress.includes(':')) {
      setAddError('Enter address as ip:port (e.g., 192.168.1.1:27960)');
      return;
    }
    setIsQuerying(true);
    setAddError('');
    try {
      const info = await browser.queryServer(newAddress);
      if (info.online) {
        setNewName(stripColors(info.name));
      } else {
        setAddError('Server is offline or unreachable');
      }
    } catch {
      setAddError('Failed to query server');
    } finally {
      setIsQuerying(false);
    }
  };

  const handleAddServer = () => {
    if (!newAddress || !newAddress.includes(':')) {
      setAddError('Enter address as ip:port');
      return;
    }
    addMutation.mutate({ address: newAddress, name: newName || undefined });
  };

  const handleStartEdit = (server: ServerInfo) => {
    setEditingServer(server.address);
    setEditName(server.favoriteName);
  };

  const handleSaveEdit = (address: string) => {
    if (editName.trim()) {
      updateMutation.mutate({ address, name: editName.trim() });
    }
  };

  const handleDelete = (address: string, name: string) => {
    if (confirm(`Remove "${stripColors(name)}" from favorites?`)) {
      deleteMutation.mutate(address);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Querying servers...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-4">
        <p className="text-red-400">Failed to load server list</p>
        <button
          onClick={() => refetch()}
          className="mt-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  const servers = data?.servers || [];

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Server Scout</h1>
          <p className="text-sm text-gray-400 mt-1">
            {data?.onlineCount || 0} of {data?.total || 0} servers online
            {data?.totalHumans ? ` • ${data.totalHumans} players` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 rounded-lg font-medium bg-green-600 hover:bg-green-700 text-white transition-colors"
          >
            + Add Server
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              isFetching
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-orange-600 hover:bg-orange-700 text-white'
            }`}
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Add Server Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-4">Add Server</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  Server Address (ip:port)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    placeholder="192.168.1.1:27960"
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:border-orange-500 focus:outline-none"
                  />
                  <button
                    onClick={handleQueryServer}
                    disabled={isQuerying}
                    className="px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm disabled:opacity-50"
                  >
                    {isQuerying ? '...' : 'Query'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  Server Name (optional)
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Auto-detected from server"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:border-orange-500 focus:outline-none"
                />
              </div>

              {addError && (
                <p className="text-red-400 text-sm">{addError}</p>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowAddModal(false);
                    setNewAddress('');
                    setNewName('');
                    setAddError('');
                  }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddServer}
                  disabled={addMutation.isPending}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded disabled:opacity-50"
                >
                  {addMutation.isPending ? 'Adding...' : 'Add Server'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Server List */}
      {servers.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400">No favorite servers configured</p>
          <p className="text-sm text-gray-500 mt-2">
            Click "Add Server" to add your first server
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <div
              key={server.address}
              className={`bg-gray-800 rounded-lg overflow-hidden transition-all ${
                server.online ? '' : 'opacity-60'
              }`}
            >
              {/* Server Header */}
              <div className="p-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  {/* Server Info */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() =>
                      setExpandedServer(
                        expandedServer === server.address ? null : server.address
                      )
                    }
                  >
                    <div className="flex items-center gap-2">
                      {server.humans > 0 && (
                        <span className="text-yellow-400 text-lg">★</span>
                      )}
                      {editingServer === server.address ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit(server.address);
                            if (e.key === 'Escape') setEditingServer(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2 py-1 bg-gray-700 border border-gray-600 rounded focus:border-orange-500 focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <h3 className="font-semibold truncate">
                          {stripColors(server.hostname || server.favoriteName)}
                        </h3>
                      )}
                      {!server.online && (
                        <span className="px-2 py-0.5 bg-red-900/50 text-red-400 text-xs rounded">
                          Offline
                        </span>
                      )}
                      {server.protocol === 82 && server.online && (
                        <span className="px-2 py-0.5 bg-yellow-900/50 text-yellow-400 text-xs rounded">
                          ET 2.60b
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{server.address}</div>
                    {server.online && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-gray-400">
                        <span>{server.map}</span>
                        <span>{server.mod}</span>
                        <span>{server.ping}ms</span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {server.online && (
                      <div className="flex items-center gap-2 text-sm mr-2">
                        <span className="text-green-400">{server.humans}</span>
                        <span className="text-gray-500">/</span>
                        <span className="text-gray-400">{server.maxPlayers}</span>
                        {server.bots > 0 && (
                          <span className="text-blue-400 text-xs">
                            +{server.bots} bots
                          </span>
                        )}
                      </div>
                    )}

                    {editingServer === server.address ? (
                      <>
                        <button
                          onClick={() => handleSaveEdit(server.address)}
                          className="px-3 py-2 bg-green-600 hover:bg-green-700 rounded text-sm"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingServer(null)}
                          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleStartEdit(server)}
                          className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                          title="Edit name"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => handleDelete(server.address, server.favoriteName)}
                          className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded"
                          title="Remove"
                        >
                          🗑️
                        </button>
                        <button
                          onClick={() => handleConnect(server.address)}
                          disabled={!server.online}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            server.online
                              ? 'bg-green-600 hover:bg-green-700 text-white'
                              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                          }`}
                        >
                          Connect
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded Player List */}
              {expandedServer === server.address && server.online && server.players.length > 0 && (
                <div className="border-t border-gray-700 p-4 bg-gray-900/50">
                  <h4 className="text-sm font-medium text-gray-400 mb-3">
                    Players ({server.players.filter((p) => p.ping > 0).length})
                  </h4>

                  {/* Mobile: Card Layout */}
                  <div className="md:hidden space-y-2">
                    {server.players
                      .filter((p) => p.ping > 0)
                      .sort((a, b) => b.score - a.score)
                      .map((player, idx) => (
                        <div
                          key={idx}
                          className="bg-gray-700 rounded p-2 flex items-center justify-between"
                        >
                          <span className="font-medium truncate">
                            {stripColors(player.name)}
                          </span>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="text-gray-300">{player.score}</span>
                            <span
                              className={
                                player.ping < 50
                                  ? 'text-green-400'
                                  : player.ping < 100
                                  ? 'text-yellow-400'
                                  : 'text-red-400'
                              }
                            >
                              {player.ping}ms
                            </span>
                          </div>
                        </div>
                      ))}
                    {server.bots > 0 && (
                      <div className="text-sm text-blue-400 mt-2">
                        + {server.bots} bots
                      </div>
                    )}
                  </div>

                  {/* Desktop: Table Layout */}
                  <div className="hidden md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-700">
                          <th className="pb-2">Name</th>
                          <th className="pb-2 text-right">Score</th>
                          <th className="pb-2 text-right">Ping</th>
                        </tr>
                      </thead>
                      <tbody>
                        {server.players
                          .filter((p) => p.ping > 0)
                          .sort((a, b) => b.score - a.score)
                          .map((player, idx) => (
                            <tr key={idx} className="border-b border-gray-700/50">
                              <td className="py-2 font-medium">
                                {stripColors(player.name)}
                              </td>
                              <td className="py-2 text-right text-gray-300">
                                {player.score}
                              </td>
                              <td className="py-2 text-right">
                                <span
                                  className={
                                    player.ping < 50
                                      ? 'text-green-400'
                                      : player.ping < 100
                                      ? 'text-yellow-400'
                                      : 'text-red-400'
                                  }
                                >
                                  {player.ping}ms
                                </span>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {server.bots > 0 && (
                      <div className="text-sm text-blue-400 mt-2">
                        + {server.bots} bots not shown
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* No players message */}
              {expandedServer === server.address && server.online && server.players.length === 0 && (
                <div className="border-t border-gray-700 p-4 bg-gray-900/50">
                  <p className="text-sm text-gray-500">No players online</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Connection Info */}
      <div className="bg-gray-800/50 rounded-lg p-4 text-sm text-gray-400">
        <p>
          <strong>Note:</strong> Clicking "Connect" will attempt to launch ET:Legacy
          using the <code className="bg-gray-700 px-1 rounded">et://</code> protocol.
          Make sure ET:Legacy is installed and registered as the protocol handler.
        </p>
      </div>
    </div>
  );
}
