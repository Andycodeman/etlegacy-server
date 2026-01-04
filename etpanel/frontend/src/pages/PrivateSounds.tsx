import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds, auth } from '../api/client';
import type { PrivateSound } from '../api/client';
import AudioPlayer from '../components/AudioPlayer';
import { renderETColors, stripColors } from '../utils/etColors';

type SortField = 'alias' | 'originalName' | 'fileSize' | 'durationSeconds' | 'ownerName' | 'createdAt';
type SortDirection = 'asc' | 'desc';

function SortableHeader({
  label,
  field,
  currentSort,
  currentDirection,
  onSort,
  className = ''
}: {
  label: string;
  field: SortField;
  currentSort: SortField;
  currentDirection: SortDirection;
  onSort: (field: SortField) => void;
  className?: string;
}) {
  const isActive = currentSort === field;
  return (
    <th
      className={`px-4 py-3 cursor-pointer hover:bg-gray-700/50 select-none transition-colors ${className}`}
      onClick={() => onSort(field)}
    >
      <div className="flex items-center gap-1">
        {label}
        <span className={`text-xs ${isActive ? 'text-orange-400' : 'text-gray-500'}`}>
          {isActive ? (currentDirection === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </div>
    </th>
  );
}

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

export default function PrivateSounds() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedOwner, setSelectedOwner] = useState<string>('');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'public' | 'private'>('all');
  const [successMessage, setSuccessMessage] = useState('');

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<PrivateSound | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Check if user is admin
  const { data: currentUser, isLoading: userLoading } = useQuery({
    queryKey: ['me'],
    queryFn: auth.me,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Proper debounce with useEffect
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0); // Reset to first page on new search
    }, 300);

    return () => clearTimeout(timer);
  }, [search]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [selectedOwner, visibilityFilter]);

  // Fetch sounds library
  const { data: libraryData, isLoading: libraryLoading } = useQuery({
    queryKey: ['privateLibrary', page, debouncedSearch, selectedOwner, visibilityFilter],
    queryFn: () => sounds.adminPrivateLibrary(page, debouncedSearch || undefined, selectedOwner || undefined, visibilityFilter),
  });

  // Sort sounds client-side
  const sortedSounds = useMemo(() => {
    if (!libraryData?.sounds) return [];

    return [...libraryData.sounds].sort((a: PrivateSound, b: PrivateSound) => {
      let comparison = 0;
      switch (sortField) {
        case 'alias':
          comparison = a.alias.localeCompare(b.alias);
          break;
        case 'originalName':
          comparison = a.originalName.localeCompare(b.originalName);
          break;
        case 'fileSize':
          comparison = a.fileSize - b.fileSize;
          break;
        case 'durationSeconds':
          comparison = (a.durationSeconds || 0) - (b.durationSeconds || 0);
          break;
        case 'ownerName':
          comparison = stripColors(a.ownerName).localeCompare(stripColors(b.ownerName));
          break;
        case 'createdAt':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [libraryData?.sounds, sortField, sortDirection]);

  // Toggle visibility mutation
  const toggleVisibilityMutation = useMutation({
    mutationFn: ({ soundFileId, isPublic }: { soundFileId: number; isPublic: boolean }) =>
      sounds.adminSetSoundVisibility(soundFileId, isPublic),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['privateLibrary'] });
      queryClient.invalidateQueries({ queryKey: ['publicLibrary'] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (soundFileId: number) => sounds.adminDeletePrivate(soundFileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['privateLibrary'] });
      setDeleteConfirm(null);
      setSuccessMessage('Sound deleted from all users and disk');
      setTimeout(() => setSuccessMessage(''), 4000);
    },
  });

  const handleDeleteClick = (sound: PrivateSound) => {
    setDeleteConfirm(sound);
  };

  const cancelDelete = () => {
    setDeleteConfirm(null);
  };

  // Admin check - show access denied for non-admins
  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (currentUser?.role !== 'admin') {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-6">
        <h2 className="text-xl font-bold text-red-400">Access Denied</h2>
        <p className="text-gray-400 mt-2">You must be an admin to access the private sound library.</p>
      </div>
    );
  }

  return (
    <div className="-m-4 md:-m-8">
      {/* Sticky Header */}
      <div className="sticky -top-4 md:-top-8 z-10 bg-gray-900 px-4 md:px-8 pt-4 pb-4 border-b border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl md:text-2xl font-bold">
              <span className="text-red-400">Admin:</span> Private Sound Library
            </h1>
            <span className="text-sm text-gray-400">
              {libraryData?.totalCount || 0} sound{(libraryData?.totalCount || 0) !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {/* Visibility filter dropdown */}
            <select
              value={visibilityFilter}
              onChange={(e) => setVisibilityFilter(e.target.value as 'all' | 'public' | 'private')}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-orange-500"
            >
              <option value="all">All sounds</option>
              <option value="private">Private only</option>
              <option value="public">Public only</option>
            </select>
            {/* Owner filter dropdown */}
            {libraryData?.owners && libraryData.owners.length > 0 && (
              <select
                value={selectedOwner}
                onChange={(e) => setSelectedOwner(e.target.value)}
                className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-orange-500"
              >
                <option value="">All owners</option>
                {libraryData.owners.map((owner) => (
                  <option key={owner.guid} value={owner.guid}>
                    {stripColors(owner.name)}
                  </option>
                ))}
              </select>
            )}
            <input
              type="text"
              placeholder="Search sounds..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-64 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>

        {/* Success Message */}
        {successMessage && (
          <div className="mt-3 bg-green-900/30 border border-green-600 rounded-lg p-3 flex items-center gap-3">
            <span className="text-green-400">✓</span>
            <span className="text-green-300">{successMessage}</span>
          </div>
        )}

        {/* Info Banner */}
        <div className="mt-3 bg-orange-900/30 border border-orange-600 rounded-lg p-3">
          <p className="text-orange-400 text-sm">
            <span className="font-medium">Admin View:</span> Manage all sounds across all users.
            Toggle the globe icon to make sounds public/private.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 md:px-8 py-4 h-[calc(100vh-130px)]">
      {libraryLoading ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-gray-400">Loading private sounds...</div>
        </div>
      ) : libraryData?.sounds.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-8 text-center h-full flex flex-col items-center justify-center">
          <div className="text-4xl mb-4">🔒</div>
          <h2 className="text-xl font-semibold mb-2">No Private Sounds</h2>
          <p className="text-gray-400">
            {debouncedSearch || selectedOwner
              ? 'No sounds match your filters'
              : 'All sounds are either public or in public playlists'}
          </p>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-hidden h-full flex flex-col">
          {/* Sound Table */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Mobile: Card Layout */}
            <div className="md:hidden divide-y divide-gray-700 overflow-y-auto flex-1">
              {sortedSounds.map((sound: PrivateSound, index: number) => (
                <div key={sound.soundFileId} className="p-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-8 flex-shrink-0">{page * 100 + index + 1}.</span>
                    <AudioPlayer soundFileId={sound.soundFileId} adminMode />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{sound.alias}</div>
                      <div className="text-sm text-gray-400 flex items-center gap-2 flex-wrap">
                        {formatFileSize(sound.fileSize)} • {formatDuration(sound.durationSeconds)} • {renderETColors(sound.ownerName)} • {formatRelativeTime(sound.createdAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => toggleVisibilityMutation.mutate({ soundFileId: sound.soundFileId, isPublic: !sound.isPublic })}
                        disabled={toggleVisibilityMutation.isPending}
                        className={`p-1.5 rounded transition-colors ${
                          sound.isPublic
                            ? 'bg-green-600 hover:bg-green-500 text-white'
                            : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                        }`}
                        title={sound.isPublic ? 'Public (click to make private)' : 'Private (click to make public)'}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDeleteClick(sound)}
                        className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                        title="Delete permanently"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: Table Layout */}
            <div className="hidden md:flex md:flex-col md:flex-1 md:overflow-hidden">
              {/* Scrollable Table with Sticky Header */}
              <div className="flex-1 overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-gray-800 z-10">
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="px-4 py-3 w-12">#</th>
                      <th className="px-4 py-3 w-16">Play</th>
                      <SortableHeader label="Alias" field="alias" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Original" field="originalName" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Size" field="fileSize" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Duration" field="durationSeconds" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Owner" field="ownerName" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Added" field="createdAt" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <th className="px-4 py-3 w-28">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                  {sortedSounds.map((sound: PrivateSound, index: number) => (
                    <tr key={sound.soundFileId} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2 text-sm text-gray-500">{page * 100 + index + 1}</td>
                      <td className="px-4 py-2">
                        <AudioPlayer soundFileId={sound.soundFileId} adminMode />
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-medium">{sound.alias}</span>
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {sound.originalName.replace(/\.(mp3|wav)$/i, '')}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatFileSize(sound.fileSize)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatDuration(sound.durationSeconds)}
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {renderETColors(sound.ownerName)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatRelativeTime(sound.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => toggleVisibilityMutation.mutate({ soundFileId: sound.soundFileId, isPublic: !sound.isPublic })}
                            disabled={toggleVisibilityMutation.isPending}
                            className={`p-1.5 rounded transition-colors ${
                              sound.isPublic
                                ? 'bg-green-600 hover:bg-green-500 text-white'
                                : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                            }`}
                            title={sound.isPublic ? 'Public (click to make private)' : 'Private (click to make public)'}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDeleteClick(sound)}
                            className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                            title="Delete permanently"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sticky Pagination Footer */}
          <div className="flex-shrink-0 border-t border-gray-700 bg-gray-800 px-4 py-3 flex items-center justify-center gap-1">
            <button
              onClick={() => setPage(0)}
              disabled={page === 0}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
              title="First page"
            >
              «
            </button>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
              title="Previous page"
            >
              ‹
            </button>
            <span className="text-gray-400 px-4">
              Page {page + 1} of {libraryData?.totalPages || 1}
            </span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= (libraryData?.totalPages || 1) - 1}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
              title="Next page"
            >
              ›
            </button>
            <button
              onClick={() => setPage((libraryData?.totalPages || 1) - 1)}
              disabled={page >= (libraryData?.totalPages || 1) - 1}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
              title="Last page"
            >
              »
            </button>
          </div>
        </div>
      )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full">
            <h3 className="text-lg font-semibold mb-4 text-red-400">Permanently Delete Sound</h3>
            <p className="text-gray-300 mb-2">
              Are you sure you want to permanently delete{' '}
              <span className="text-blue-400 font-medium">
                {deleteConfirm.alias}
              </span>
              ?
            </p>

            <div className="mb-4 space-y-2">
              <p className="text-red-400 text-sm">
                ⚠️ This will DELETE the file from disk and remove it from ALL users' libraries!
              </p>
              <p className="text-gray-400 text-sm">
                Owner: {renderETColors(deleteConfirm.ownerName)}
              </p>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={cancelDelete}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm.soundFileId)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
