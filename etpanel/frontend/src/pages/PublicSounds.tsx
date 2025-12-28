import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds, auth } from '../api/client';
import type { PublicSound } from '../api/client';
import AudioPlayer from '../components/AudioPlayer';

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

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 1) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
}

export default function PublicSounds() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [addModal, setAddModal] = useState<PublicSound | null>(null);
  const [customAlias, setCustomAlias] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>('');

  // Admin state - inline editing by soundFileId
  const [editingSoundId, setEditingSoundId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<PublicSound | null>(null);

  // Proper debounce with useEffect
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0); // Reset to first page on new search
    }, 300);

    return () => clearTimeout(timer);
  }, [search]);

  // Check if user has linked GUID
  const { data: guidStatus, isLoading: guidLoading } = useQuery({
    queryKey: ['guidStatus'],
    queryFn: sounds.getGuidStatus,
  });

  // Get user role for admin check
  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: auth.me,
  });
  const isAdmin = user?.role === 'admin';

  // Fetch public library
  const { data: libraryData, isLoading: libraryLoading } = useQuery({
    queryKey: ['publicLibrary', page, debouncedSearch],
    queryFn: () => sounds.publicLibrary(page, debouncedSearch || undefined),
  });

  // Fetch user's playlists for the "add to playlist" dropdown
  const { data: playlistsData } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
    enabled: guidStatus?.linked === true,
  });

  // Add to library mutation
  const addMutation = useMutation({
    mutationFn: ({ soundFileId, alias }: { soundFileId: number; alias: string }) =>
      sounds.addFromPublic(soundFileId, alias),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      setAddModal(null);
      setCustomAlias('');
      setSuccessMessage(`Added "${variables.alias}" to your library!`);
      setTimeout(() => setSuccessMessage(''), 3000);

      // If a playlist was selected, add to it
      if (selectedPlaylist) {
        addToPlaylistMutation.mutate({
          playlistName: selectedPlaylist,
          soundAlias: variables.alias,
        });
      }
    },
  });

  // Add to playlist mutation
  const addToPlaylistMutation = useMutation({
    mutationFn: ({ playlistName, soundAlias }: { playlistName: string; soundAlias: string }) =>
      sounds.addToPlaylist(playlistName, soundAlias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist', selectedPlaylist] });
      setSelectedPlaylist('');
    },
  });

  // Admin: Rename mutation
  const renameMutation = useMutation({
    mutationFn: ({ soundFileId, name }: { soundFileId: number; name: string }) =>
      sounds.adminRenamePublic(soundFileId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publicLibrary'] });
      setEditingSoundId(null);
      setEditName('');
      setEditError('');
    },
    onError: (err: Error) => {
      setEditError(err.message);
    },
  });

  // Admin: Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (soundFileId: number) => sounds.adminDeletePublic(soundFileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publicLibrary'] });
      setDeleteConfirm(null);
      setSuccessMessage('Sound deleted from public library!');
      setTimeout(() => setSuccessMessage(''), 3000);
    },
  });

  const startEdit = (sound: PublicSound) => {
    setEditingSoundId(sound.soundFileId);
    setEditName(sound.originalName.replace(/\.mp3$/i, ''));
    setEditError('');
  };

  const handleRename = (soundFileId: number, originalName: string) => {
    if (!editName) {
      setEditingSoundId(null);
      setEditError('');
      return;
    }
    const cleanOriginal = originalName.replace(/\.mp3$/i, '');
    if (editName === cleanOriginal) {
      setEditingSoundId(null);
      setEditError('');
      return;
    }
    // Validate name format
    if (!/^[a-zA-Z0-9_-]+$/.test(editName)) {
      setEditError('Only letters, numbers, underscores, and dashes allowed');
      return;
    }
    renameMutation.mutate({ soundFileId, name: editName });
  };

  const openAddModal = (sound: PublicSound) => {
    setAddModal(sound);
    setCustomAlias(sound.originalName.replace(/\.mp3$/i, '').replace(/[^a-zA-Z0-9_]/g, '_'));
    setSelectedPlaylist('');
  };

  if (guidLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  const isLinked = guidStatus?.linked === true;
  const playlists = playlistsData?.playlists || [];

  return (
    <div className="-m-4 md:-m-8">
      {/* Sticky Header */}
      <div className="sticky -top-4 md:-top-8 z-10 bg-gray-900 px-4 md:px-8 pt-4 pb-4 border-b border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl md:text-2xl font-bold">Public Sound Library</h1>
            <span className="text-sm text-gray-400">
              {libraryData?.totalCount || 0} sound{(libraryData?.totalCount || 0) !== 1 ? 's' : ''}
            </span>
          </div>
          <input
            type="text"
            placeholder="Search sounds..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Success Message */}
        {successMessage && (
          <div className="mt-3 bg-green-900/30 border border-green-600 rounded-lg p-3 flex items-center gap-3">
            <span className="text-green-400">✓</span>
            <span className="text-green-300">{successMessage}</span>
          </div>
        )}

        {/* Link Account Warning */}
        {!isLinked && (
          <div className="mt-3 bg-yellow-900/30 border border-yellow-600 rounded-lg p-3">
            <p className="text-yellow-400 text-sm">
              <span className="font-medium">Note:</span> Link your game account in{' '}
              <span className="text-blue-400">My Sounds</span> to add sounds to your library.
            </p>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 md:p-8">
      {libraryLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-400">Loading public sounds...</div>
        </div>
      ) : libraryData?.sounds.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <div className="text-4xl mb-4">🔇</div>
          <h2 className="text-xl font-semibold mb-2">No Public Sounds</h2>
          <p className="text-gray-400">
            {debouncedSearch
              ? 'No sounds match your search'
              : 'No one has shared sounds publicly yet'}
          </p>
        </div>
      ) : (
        <>
          {/* Sound Table */}
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            {/* Mobile: Card Layout */}
            <div className="md:hidden divide-y divide-gray-700">
              {libraryData?.sounds.map((sound: PublicSound) => (
                <div key={sound.soundFileId} className="p-3">
                  <div className="flex items-center gap-3">
                    <AudioPlayer soundFileId={sound.soundFileId} />
                    <div className="flex-1 min-w-0">
                      {isAdmin && editingSoundId === sound.soundFileId ? (
                        <div>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename(sound.soundFileId, sound.originalName);
                              if (e.key === 'Escape') {
                                setEditingSoundId(null);
                                setEditError('');
                              }
                            }}
                            onBlur={() => handleRename(sound.soundFileId, sound.originalName)}
                            autoFocus
                            className={`bg-gray-700 border rounded px-2 py-1 text-white w-full text-sm ${editError ? 'border-red-500' : 'border-blue-500'}`}
                          />
                          {editError && <div className="text-xs text-red-400 mt-1">{editError}</div>}
                        </div>
                      ) : (
                        <div
                          className={`font-medium truncate ${isAdmin ? 'cursor-pointer hover:text-blue-400' : ''}`}
                          onClick={() => isAdmin && startEdit(sound)}
                        >
                          {sound.originalName.replace(/\.mp3$/i, '')}
                        </div>
                      )}
                      <div className="text-sm text-gray-400">
                        {formatFileSize(sound.fileSize)} • {formatDuration(sound.durationSeconds)} • {formatRelativeTime(sound.createdAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isLinked && (
                        <button
                          onClick={() => openAddModal(sound)}
                          className="p-1.5 bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                          title="Add to my library"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          onClick={() => setDeleteConfirm(sound)}
                          className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: Table Layout */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700 bg-gray-800/50">
                    <th className="px-4 py-3 w-16">Play</th>
                    <th className="px-4 py-3">Alias</th>
                    <th className="px-4 py-3 w-24">Size</th>
                    <th className="px-4 py-3 w-20">Duration</th>
                    <th className="px-4 py-3 w-28">Added</th>
                    {(isLinked || isAdmin) && <th className="px-4 py-3 w-32">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {libraryData?.sounds.map((sound: PublicSound) => (
                    <tr key={sound.soundFileId} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2">
                        <AudioPlayer soundFileId={sound.soundFileId} />
                      </td>
                      <td className="px-4 py-2">
                        {isAdmin && editingSoundId === sound.soundFileId ? (
                          <div>
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRename(sound.soundFileId, sound.originalName);
                                if (e.key === 'Escape') {
                                  setEditingSoundId(null);
                                  setEditError('');
                                }
                              }}
                              onBlur={() => handleRename(sound.soundFileId, sound.originalName)}
                              autoFocus
                              className={`bg-gray-700 border rounded px-2 py-1 text-white w-full max-w-[200px] text-sm ${editError ? 'border-red-500' : 'border-blue-500'}`}
                            />
                            {editError && <div className="text-xs text-red-400 mt-1">{editError}</div>}
                          </div>
                        ) : (
                          <span
                            className={`font-medium ${isAdmin ? 'cursor-pointer hover:text-blue-400' : ''}`}
                            onClick={() => isAdmin && startEdit(sound)}
                            title={isAdmin ? 'Click to rename' : undefined}
                          >
                            {sound.originalName.replace(/\.mp3$/i, '')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatFileSize(sound.fileSize)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatDuration(sound.durationSeconds)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatRelativeTime(sound.createdAt)}
                      </td>
                      {(isLinked || isAdmin) && (
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            {isLinked && (
                              <button
                                onClick={() => openAddModal(sound)}
                                className="p-1.5 bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                                title="Add to my library"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                onClick={() => setDeleteConfirm(sound)}
                                className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                                title="Delete"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {(libraryData?.totalPages || 0) > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
              >
                Previous
              </button>
              <span className="text-gray-400 px-4">
                Page {page + 1} of {libraryData?.totalPages || 1}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= (libraryData?.totalPages || 1) - 1}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      </div>

      {/* Add Modal */}
      {addModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Add to My Library</h3>
            <p className="text-gray-300 mb-4">
              Adding <span className="text-blue-400">{addModal.originalName}</span>
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Your alias for this sound</label>
                <input
                  type="text"
                  value={customAlias}
                  onChange={(e) => setCustomAlias(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  placeholder="sound_alias"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Only letters, numbers, and underscores allowed
                </p>
              </div>

              {playlists.length > 0 && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Also add to playlist (optional)</label>
                  <select
                    value={selectedPlaylist}
                    onChange={(e) => setSelectedPlaylist(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="">-- None --</option>
                    {playlists.map((pl) => (
                      <option key={pl.id} value={pl.name}>
                        {pl.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setAddModal(null);
                  setCustomAlias('');
                  setSelectedPlaylist('');
                }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => addMutation.mutate({
                  soundFileId: addModal.soundFileId,
                  alias: customAlias,
                })}
                disabled={!customAlias || addMutation.isPending}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {addMutation.isPending ? 'Adding...' : 'Add to Library'}
              </button>
            </div>
            {addMutation.isError && (
              <p className="text-red-400 mt-3 text-sm">
                {(addMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Admin: Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4 text-red-400">Delete Sound</h3>
            <p className="text-gray-300 mb-2">
              Are you sure you want to delete{' '}
              <span className="text-blue-400 font-medium">
                {deleteConfirm.originalName.replace(/\.mp3$/i, '')}
              </span>{' '}
              from the public library?
            </p>
            <p className="text-yellow-400 text-sm mb-4">
              This will also remove it from all users who added it to their libraries.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm.soundFileId)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
