import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds } from '../api/client';
import type { Playlist, PlaylistItem, UserSound } from '../api/client';
import AudioPlayer from '../components/AudioPlayer';
import { renderETColors } from '../utils/etColors';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function Playlists() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedPlaylist, setSelectedPlaylist] = useState<{ name: string; id: number; isOwner: boolean } | null>(null);
  const [createModal, setCreateModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistDesc, setNewPlaylistDesc] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteWarningPlaylist, setDeleteWarningPlaylist] = useState<Playlist | null>(null);
  const [visibilityWarning, setVisibilityWarning] = useState<Playlist | null>(null);
  const [addSoundModal, setAddSoundModal] = useState(false);
  const [draggedItem, setDraggedItem] = useState<number | null>(null);
  const [dragOverItem, setDragOverItem] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Check if user has linked GUID
  const { data: guidStatus, isLoading: guidLoading } = useQuery({
    queryKey: ['guidStatus'],
    queryFn: sounds.getGuidStatus,
  });

  // Fetch playlists
  const { data: playlistsData, isLoading: playlistsLoading } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
    enabled: guidStatus?.linked === true,
  });

  // Auto-select playlist from URL query parameter
  const urlPlaylistId = searchParams.get('id');
  useEffect(() => {
    if (urlPlaylistId && playlistsData?.playlists && !playlistsLoading) {
      const playlistId = parseInt(urlPlaylistId, 10);
      const playlist = playlistsData.playlists.find((p: Playlist) => p.id === playlistId);
      if (playlist) {
        setSelectedPlaylist({ name: playlist.name, id: playlist.id, isOwner: playlist.isOwner ?? false });
        // Clear the URL param after selecting
        searchParams.delete('id');
        setSearchParams(searchParams, { replace: true });
      }
    }
  }, [urlPlaylistId, playlistsData?.playlists, playlistsLoading, searchParams, setSearchParams]);

  // Fetch selected playlist details
  const { data: playlistDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['playlist', selectedPlaylist?.id],
    queryFn: () => sounds.getPlaylist(selectedPlaylist!.name, selectedPlaylist!.id),
    enabled: !!selectedPlaylist && guidStatus?.linked === true,
  });

  // Fetch user sounds for adding to playlist
  const { data: soundsData } = useQuery({
    queryKey: ['mySounds'],
    queryFn: sounds.list,
    enabled: addSoundModal && guidStatus?.linked === true,
  });

  // Filter and split playlists into personal and public (from others)
  const { myPlaylists, publicPlaylists } = useMemo(() => {
    if (!playlistsData?.playlists) return { myPlaylists: [], publicPlaylists: [] };

    let playlists = playlistsData.playlists;
    if (debouncedSearch) {
      const searchLower = debouncedSearch.toLowerCase();
      playlists = playlists.filter((p: Playlist) => p.name.toLowerCase().includes(searchLower));
    }

    const mine = playlists.filter((p: Playlist) => p.isOwner !== false);
    const others = playlists.filter((p: Playlist) => p.isOwner === false);

    return { myPlaylists: mine, publicPlaylists: others };
  }, [playlistsData?.playlists, debouncedSearch]);

  // Mutations
  const createMutation = useMutation({
    mutationFn: ({ name, description }: { name: string; description?: string }) =>
      sounds.createPlaylist(name, description),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setCreateModal(false);
      setNewPlaylistName('');
      setNewPlaylistDesc('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => sounds.deletePlaylist(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      if (deleteConfirm === selectedPlaylist?.name) {
        setSelectedPlaylist(null);
      }
      setDeleteConfirm(null);
    },
  });

  const addSoundMutation = useMutation({
    mutationFn: ({ playlistName, soundAlias }: { playlistName: string; soundAlias: string }) =>
      sounds.addToPlaylist(playlistName, soundAlias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist', selectedPlaylist?.id] });
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
    },
  });

  const removeSoundMutation = useMutation({
    mutationFn: ({ playlistName, soundAlias }: { playlistName: string; soundAlias: string }) =>
      sounds.removeFromPlaylist(playlistName, soundAlias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist', selectedPlaylist?.id] });
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: ({ playlistName, soundAliases }: { playlistName: string; soundAliases: string[] }) =>
      sounds.reorderPlaylist(playlistName, soundAliases),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist', selectedPlaylist?.id] });
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: ({ playlistName, isPublic }: { playlistName: string; isPublic: boolean }) =>
      sounds.setPlaylistVisibility(playlistName, isPublic),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      queryClient.invalidateQueries({ queryKey: ['playlist', selectedPlaylist?.id] });
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
    },
  });

  const handleDragStart = (index: number) => {
    setDraggedItem(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverItem(index);
  };

  const handleDrop = () => {
    if (draggedItem === null || dragOverItem === null || !playlistDetail || !selectedPlaylist?.isOwner) return;

    const items = [...playlistDetail.items];
    const [draggedElement] = items.splice(draggedItem, 1);
    items.splice(dragOverItem, 0, draggedElement);

    // Update order in backend
    const soundAliases = items.map((item) => item.alias);
    reorderMutation.mutate({ playlistName: selectedPlaylist.name, soundAliases });

    setDraggedItem(null);
    setDragOverItem(null);
  };

  // Filter sounds not already in playlist
  const availableSounds = soundsData?.sounds.filter((sound: UserSound) => {
    if (!playlistDetail) return true;
    return !playlistDetail.items.some((item) => item.alias === sound.alias);
  }) || [];

  if (guidLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!guidStatus?.linked) {
    return (
      <div className="flex flex-col h-full">
        <div className="sticky top-0 z-10 bg-gray-900 pb-4">
          <h1 className="text-xl md:text-2xl font-bold">Playlists</h1>
        </div>
        <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-yellow-400 mb-2">Link Your Game Account</h2>
          <p className="text-gray-300">
            To manage playlists, you need to link your in-game account first.
            Go to <span className="text-blue-400">My Sounds</span> to link your account.
          </p>
        </div>
      </div>
    );
  }

  if (playlistsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading playlists...</div>
      </div>
    );
  }

  // Helper to render a playlist item
  const renderPlaylistItem = (playlist: Playlist) => (
    <div
      key={playlist.id}
      className={`p-3 cursor-pointer transition-colors ${
        selectedPlaylist?.id === playlist.id
          ? 'bg-gray-700'
          : 'hover:bg-gray-700/50'
      }`}
      onClick={() => setSelectedPlaylist({
        name: playlist.name,
        id: playlist.id,
        isOwner: playlist.isOwner !== false
      })}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate flex items-center gap-2">
            {playlist.isPublic && <span title="Public">🌐</span>}
            {playlist.name}
          </div>
          <div className="text-sm text-gray-400">
            {playlist.soundCount || 0} sound{(playlist.soundCount || 0) !== 1 ? 's' : ''}
            {playlist.isOwner === false && playlist.ownerName && (
              <span className="ml-2">by {renderETColors(playlist.ownerName)}</span>
            )}
          </div>
        </div>
        {playlist.isOwner !== false && (
          deleteConfirm === playlist.name ? (
            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => deleteMutation.mutate(playlist.name)}
                className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs"
              >
                Yes
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (playlist.isPublic) {
                  setDeleteWarningPlaylist(playlist);
                } else {
                  setDeleteConfirm(playlist.name);
                }
              }}
              className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-600 rounded transition-colors"
              title="Delete"
            >
              🗑️
            </button>
          )
        )}
      </div>
    </div>
  );

  return (
    <div className="-m-4 md:-m-8">
      {/* Sticky Header */}
      <div className="sticky -top-4 md:-top-8 z-10 bg-gray-900 px-4 md:px-8 pt-4 pb-4 border-b border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl md:text-2xl font-bold">Playlists</h1>
            <span className="text-sm text-gray-400">
              {myPlaylists.length + publicPlaylists.length}{debouncedSearch ? ` of ${playlistsData?.playlists?.length || 0}` : ''} playlist{(myPlaylists.length + publicPlaylists.length) !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Search playlists..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-48 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => setCreateModal(true)}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors flex items-center gap-2 whitespace-nowrap"
            >
              <span>+</span> New
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 md:px-8 py-4 h-[calc(100vh-90px)]">
        <div className="flex flex-col lg:flex-row gap-4 h-full">
          {/* Playlist Lists - Two stacked cards, sticky */}
          <div className="lg:w-1/3 flex flex-col gap-4 lg:sticky lg:top-0 lg:self-start h-full">
            {/* My Playlists Card */}
            <div className="bg-gray-800 rounded-lg overflow-hidden h-[calc(50%-8px)] min-h-[200px] flex flex-col">
              <div className="p-3 border-b border-gray-700 flex-shrink-0">
                <h2 className="font-semibold">📁 My Playlists</h2>
              </div>
              {myPlaylists.length === 0 ? (
                <div className="p-4 text-center text-gray-400 flex-1 flex flex-col justify-center">
                  <div className="text-2xl mb-2">📁</div>
                  <p className="text-sm">{debouncedSearch ? 'No matching playlists' : 'No playlists yet'}</p>
                  {!debouncedSearch && <p className="text-xs mt-1">Create one to organize your sounds!</p>}
                </div>
              ) : (
                <div className="divide-y divide-gray-700 overflow-y-auto flex-1">
                  {myPlaylists.map((playlist: Playlist) => renderPlaylistItem(playlist))}
                </div>
              )}
            </div>

            {/* Public Playlists Card */}
            <div className="bg-gray-800 rounded-lg overflow-hidden h-[calc(50%-8px)] min-h-[200px] flex flex-col">
              <div className="p-3 border-b border-gray-700 flex-shrink-0">
                <h2 className="font-semibold">🌐 Public Playlists</h2>
                <p className="text-xs text-gray-500">From other players</p>
              </div>
              {publicPlaylists.length === 0 ? (
                <div className="p-4 text-center text-gray-400 flex-1 flex flex-col justify-center">
                  <div className="text-2xl mb-2">🌐</div>
                  <p className="text-sm">{debouncedSearch ? 'No matching playlists' : 'No public playlists'}</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-700 overflow-y-auto flex-1">
                  {publicPlaylists.map((playlist: Playlist) => renderPlaylistItem(playlist))}
                </div>
              )}
            </div>
          </div>

          {/* Playlist Detail */}
          <div className="lg:w-2/3 h-full">
            {!selectedPlaylist ? (
              <div className="bg-gray-800 rounded-lg p-8 text-center h-full flex flex-col items-center justify-center">
                <div className="text-4xl mb-4">📋</div>
                <h2 className="text-xl font-semibold mb-2">Select a Playlist</h2>
                <p className="text-gray-400">
                  Choose a playlist from the left to view and manage its sounds.
                </p>
              </div>
            ) : detailLoading ? (
              <div className="bg-gray-800 rounded-lg p-8 text-center">
                <div className="text-gray-400">Loading playlist...</div>
              </div>
            ) : playlistDetail ? (
              <div className="bg-gray-800 rounded-lg overflow-hidden h-full flex flex-col">
                <div className="p-4 border-b border-gray-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-shrink-0">
                  <div>
                    <h2 className="font-semibold text-lg flex items-center gap-2">
                      {playlistDetail.playlist.name}
                      {playlistDetail.playlist.isPublic && (
                        <span className="text-xs px-2 py-0.5 bg-green-600 rounded-full">Public</span>
                      )}
                      {!selectedPlaylist.isOwner && (
                        <span className="text-xs px-2 py-0.5 bg-gray-600 rounded-full">View Only</span>
                      )}
                    </h2>
                    {playlistDetail.playlist.description && (
                      <p className="text-sm text-gray-400">{playlistDetail.playlist.description}</p>
                    )}
                  </div>
                  {selectedPlaylist.isOwner && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (playlistDetail.playlist.isPublic) {
                            // Show warning when making private
                            setVisibilityWarning(playlistDetail.playlist);
                          } else {
                            // No warning needed when making public
                            visibilityMutation.mutate({
                              playlistName: selectedPlaylist.name,
                              isPublic: true
                            });
                          }
                        }}
                        disabled={visibilityMutation.isPending}
                        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-2 ${
                          playlistDetail.playlist.isPublic
                            ? 'bg-green-600 hover:bg-green-500'
                            : 'bg-gray-600 hover:bg-gray-500'
                        }`}
                        title={playlistDetail.playlist.isPublic
                          ? 'Make private (removes from public library)'
                          : 'Make public (sounds will appear in public library)'
                        }
                      >
                        {visibilityMutation.isPending ? '...' : playlistDetail.playlist.isPublic ? '🌐 Public' : '🔒 Private'}
                      </button>
                      <button
                        onClick={() => setAddSoundModal(true)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium transition-colors flex items-center gap-2"
                      >
                        <span>+</span> Add Sound
                      </button>
                    </div>
                  )}
                </div>

                {playlistDetail.items.length === 0 ? (
                  <div className="p-6 text-center text-gray-400 flex-1 flex flex-col justify-center">
                    <p>This playlist is empty</p>
                    {selectedPlaylist.isOwner && <p className="text-sm mt-1">Add some sounds to get started!</p>}
                  </div>
                ) : (
                  <div className="divide-y divide-gray-700 overflow-y-auto flex-1">
                    {playlistDetail.items.map((item: PlaylistItem, index: number) => (
                      <div
                        key={item.id}
                        draggable={selectedPlaylist.isOwner}
                        onDragStart={() => selectedPlaylist.isOwner && handleDragStart(index)}
                        onDragOver={(e) => selectedPlaylist.isOwner && handleDragOver(e, index)}
                        onDrop={() => selectedPlaylist.isOwner && handleDrop()}
                        className={`p-3 flex items-center gap-3 transition-colors ${
                          dragOverItem === index ? 'bg-blue-900/30' : 'hover:bg-gray-700/50'
                        } ${draggedItem === index ? 'opacity-50' : ''}`}
                      >
                        {selectedPlaylist.isOwner && (
                          <div className="cursor-grab text-gray-500 hover:text-gray-300" title="Drag to reorder">
                            ⋮⋮
                          </div>
                        )}
                        <div className="w-8 text-center text-gray-500 text-sm">
                          {item.orderNumber}
                        </div>
                        <AudioPlayer
                          alias={selectedPlaylist.isOwner ? item.alias : undefined}
                          soundFileId={selectedPlaylist.isOwner ? undefined : item.soundFileId}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{item.alias}</div>
                          <div className="text-sm text-gray-400">
                            {formatFileSize(item.fileSize)} • {formatDuration(item.durationSeconds)}
                          </div>
                        </div>
                        {selectedPlaylist.isOwner && (
                          <button
                            onClick={() => removeSoundMutation.mutate({
                              playlistName: selectedPlaylist.name,
                              soundAlias: item.alias,
                            })}
                            disabled={removeSoundMutation.isPending}
                            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                            title="Remove from playlist"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="p-4 border-t border-gray-700 text-sm text-gray-400">
                  {selectedPlaylist.isOwner ? (
                    <p>💡 In-game: Use <code className="bg-gray-700 px-1 rounded">/etman playlist {selectedPlaylist.name} 1</code> to play by position</p>
                  ) : (
                    <p>💡 In-game: Use <code className="bg-gray-700 px-1 rounded">/etman publicplaylist {selectedPlaylist.name} 1</code> to play by position</p>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Create Playlist Modal */}
      {createModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Create Playlist</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Name</label>
                <input
                  type="text"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  placeholder="playlist_name"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={newPlaylistDesc}
                  onChange={(e) => setNewPlaylistDesc(e.target.value)}
                  placeholder="A collection of..."
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setCreateModal(false);
                  setNewPlaylistName('');
                  setNewPlaylistDesc('');
                }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => createMutation.mutate({ name: newPlaylistName, description: newPlaylistDesc })}
                disabled={!newPlaylistName || createMutation.isPending}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
            {createMutation.isError && (
              <p className="text-red-400 mt-3 text-sm">
                {(createMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Add Sound Modal */}
      {addSoundModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full max-h-[80vh] flex flex-col">
            <h3 className="text-lg font-semibold mb-4">Add Sound to Playlist</h3>
            {availableSounds.length === 0 ? (
              <div className="text-center text-gray-400 py-8">
                <p>No more sounds to add</p>
                <p className="text-sm mt-1">All your sounds are already in this playlist!</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto divide-y divide-gray-700">
                {availableSounds.map((sound: UserSound) => (
                  <div
                    key={sound.id}
                    className="p-3 flex items-center justify-between hover:bg-gray-700/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{sound.alias}</div>
                      <div className="text-sm text-gray-400">
                        {formatFileSize(sound.fileSize)} • {formatDuration(sound.durationSeconds)}
                      </div>
                    </div>
                    <button
                      onClick={() => addSoundMutation.mutate({
                        playlistName: selectedPlaylist!.name,
                        soundAlias: sound.alias,
                      })}
                      disabled={addSoundMutation.isPending}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium transition-colors"
                    >
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end mt-4 pt-4 border-t border-gray-700">
              <button
                onClick={() => setAddSoundModal(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Visibility Warning Modal - Public to Private */}
      {visibilityWarning && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4 text-yellow-400">⚠️ Make Playlist Private?</h3>
            <p className="text-gray-300 mb-4">
              This playlist is currently <span className="text-green-400 font-medium">public</span> and visible to other players.
            </p>
            <p className="text-gray-300 mb-4">
              Making it private will:
            </p>
            <ul className="list-disc list-inside text-gray-400 mb-4 space-y-1">
              <li>Remove it from the public playlists list</li>
              <li>Other players will no longer be able to see or play from it</li>
              <li>The sounds will remain in your library</li>
            </ul>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setVisibilityWarning(null)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  visibilityMutation.mutate({
                    playlistName: visibilityWarning.name,
                    isPublic: false
                  });
                  setVisibilityWarning(null);
                }}
                className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded font-medium transition-colors"
              >
                Make Private
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Public Playlist Warning Modal */}
      {deleteWarningPlaylist && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4 text-red-400">⚠️ Delete Public Playlist?</h3>
            <p className="text-gray-300 mb-4">
              The playlist "<span className="font-medium">{deleteWarningPlaylist.name}</span>" is currently <span className="text-green-400 font-medium">public</span> and visible to other players.
            </p>
            <p className="text-gray-300 mb-4">
              Deleting it will:
            </p>
            <ul className="list-disc list-inside text-gray-400 mb-4 space-y-1">
              <li>Remove it from the public playlists list</li>
              <li>Other players will no longer be able to see or play from it</li>
              <li>The sounds will remain in your library</li>
            </ul>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteWarningPlaylist(null)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteMutation.mutate(deleteWarningPlaylist.name);
                  setDeleteWarningPlaylist(null);
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded font-medium transition-colors"
              >
                Delete Playlist
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
