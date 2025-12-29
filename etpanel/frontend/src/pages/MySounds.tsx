import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds } from '../api/client';
import type { UserSound, PendingShare, TempUploadResponse } from '../api/client';
import AudioPlayer from '../components/AudioPlayer';
import SoundClipEditor from '../components/SoundClipEditor';

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

const visibilityColors = {
  private: 'bg-gray-600 text-gray-200',
  shared: 'bg-blue-600 text-blue-100',
  public: 'bg-green-600 text-green-100',
};

const visibilityIcons = {
  private: '🔒',
  shared: '👥',
  public: '🌐',
};

export default function MySounds() {
  const queryClient = useQueryClient();
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [newAlias, setNewAlias] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [visibilityMenu, setVisibilityMenu] = useState<string | null>(null);
  const [acceptModal, setAcceptModal] = useState<PendingShare | null>(null);
  const [acceptAlias, setAcceptAlias] = useState('');
  const [linkCodeInput, setLinkCodeInput] = useState('');
  const [linkError, setLinkError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Upload modal state
  const [uploadModal, setUploadModal] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'url'>('file');
  const [uploadUrl, setUploadUrl] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // Clip editor state (after temp upload)
  const [tempUploadData, setTempUploadData] = useState<TempUploadResponse | null>(null);
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [saveClipError, setSaveClipError] = useState('');

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

  // Fetch user sounds
  const { data: soundsData, isLoading: soundsLoading } = useQuery({
    queryKey: ['mySounds'],
    queryFn: sounds.list,
    enabled: guidStatus?.linked === true,
  });

  // Fetch pending shares
  const { data: sharesData } = useQuery({
    queryKey: ['pendingShares'],
    queryFn: sounds.pendingShares,
    enabled: guidStatus?.linked === true,
  });

  // Filter sounds by search
  const filteredSounds = useMemo(() => {
    if (!soundsData?.sounds) return [];
    if (!debouncedSearch) return soundsData.sounds;
    const searchLower = debouncedSearch.toLowerCase();
    return soundsData.sounds.filter(
      (s: UserSound) =>
        s.alias.toLowerCase().includes(searchLower) ||
        s.originalName.toLowerCase().includes(searchLower)
    );
  }, [soundsData?.sounds, debouncedSearch]);

  // Mutations
  const renameMutation = useMutation({
    mutationFn: ({ alias, newAlias }: { alias: string; newAlias: string }) =>
      sounds.rename(alias, newAlias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      setEditingAlias(null);
      setNewAlias('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (alias: string) => sounds.delete(alias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      setDeleteConfirm(null);
    },
    onError: (error) => {
      console.error('Delete failed:', error);
      alert('Failed to delete sound: ' + (error as Error).message);
      setDeleteConfirm(null);
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: ({ alias, visibility }: { alias: string; visibility: 'private' | 'shared' | 'public' }) =>
      sounds.setVisibility(alias, visibility),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      setVisibilityMenu(null);
    },
  });

  const acceptShareMutation = useMutation({
    mutationFn: ({ shareId, alias }: { shareId: number; alias: string }) =>
      sounds.acceptShare(shareId, alias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      queryClient.invalidateQueries({ queryKey: ['pendingShares'] });
      setAcceptModal(null);
      setAcceptAlias('');
    },
  });

  const rejectShareMutation = useMutation({
    mutationFn: (shareId: number) => sounds.rejectShare(shareId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingShares'] });
    },
  });

  const linkGuidMutation = useMutation({
    mutationFn: (code: string) => sounds.verifyCode(code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['guidStatus'] });
      setLinkCodeInput('');
      setLinkError('');
    },
    onError: (error: Error) => {
      setLinkError(error.message);
    },
  });

  // Upload handlers
  const resetUploadModal = () => {
    // Clean up temp file if we're canceling during edit
    if (tempUploadData) {
      sounds.deleteTempFile(tempUploadData.tempId).catch(() => {});
    }
    setUploadModal(false);
    setUploadMode('file');
    setUploadUrl('');
    setUploadFile(null);
    setUploadError('');
    setIsUploading(false);
    setTempUploadData(null);
    setIsSavingClip(false);
    setSaveClipError('');
  };

  // Upload to temp storage and switch to clip editor
  const handleTempUpload = async () => {
    setIsUploading(true);
    setUploadError('');

    try {
      let result: TempUploadResponse;

      if (uploadMode === 'file') {
        if (!uploadFile) {
          setUploadError('Please select a file');
          setIsUploading(false);
          return;
        }
        result = await sounds.uploadFileToTemp(uploadFile);
      } else {
        if (!uploadUrl) {
          setUploadError('Please enter a URL');
          setIsUploading(false);
          return;
        }
        result = await sounds.importFromUrlToTemp(uploadUrl);
      }

      // Switch to clip editor
      setTempUploadData(result);
      setIsUploading(false);
    } catch (err) {
      setUploadError((err as Error).message);
      setIsUploading(false);
    }
  };

  // Save the clipped audio
  const handleSaveClip = async (alias: string, startTime: number, endTime: number, isPublic: boolean) => {
    if (!tempUploadData) return;

    // Check for duplicate alias
    if (soundsData?.sounds.some((s: UserSound) => s.alias.toLowerCase() === alias.toLowerCase())) {
      setSaveClipError('You already have a sound with this alias');
      return;
    }

    setIsSavingClip(true);
    setSaveClipError('');

    try {
      await sounds.saveClip(tempUploadData.tempId, alias, startTime, endTime, isPublic);
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      resetUploadModal();
    } catch (err) {
      setSaveClipError((err as Error).message);
      setIsSavingClip(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.mp3')) {
        setUploadError('Only MP3 files are allowed');
        return;
      }
      // Allow up to 20MB for editing (will be clipped to 30 seconds)
      if (file.size > 20 * 1024 * 1024) {
        setUploadError('File too large. Maximum size is 20MB.');
        return;
      }
      setUploadFile(file);
      setUploadError('');
    }
  };

  const startEdit = (sound: UserSound) => {
    setEditingAlias(sound.alias);
    setNewAlias(sound.alias);
  };

  const [renameError, setRenameError] = useState<string | null>(null);

  const handleRename = (alias: string) => {
    if (!newAlias) {
      setEditingAlias(null);
      setRenameError(null);
      return;
    }
    if (newAlias === alias) {
      setEditingAlias(null);
      setRenameError(null);
      return;
    }
    // Check for duplicate
    const isDuplicate = soundsData?.sounds.some(
      (s: UserSound) => s.alias.toLowerCase() === newAlias.toLowerCase() && s.alias !== alias
    );
    if (isDuplicate) {
      setRenameError(`Alias "${newAlias}" already exists`);
      return;
    }
    setRenameError(null);
    renameMutation.mutate({ alias, newAlias });
  };

  const openAcceptModal = (share: PendingShare) => {
    setAcceptModal(share);
    setAcceptAlias(share.suggestedAlias || share.originalName.replace(/\.mp3$/i, ''));
  };

  if (guidLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  // If GUID not linked, show linking form
  if (!guidStatus?.linked) {
    return (
      <div className="flex flex-col h-full">
        <div className="sticky top-0 z-10 bg-gray-900 pb-4">
          <h1 className="text-xl md:text-2xl font-bold">My Sounds</h1>
        </div>

        <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-yellow-400 mb-2">Link Your Game Account</h2>
          <p className="text-gray-300 mb-4">
            To manage your sounds, you need to link your in-game account.
            Type <code className="bg-gray-700 px-2 py-1 rounded">/etman register</code> in-game
            to get a verification code, then enter it below.
          </p>

          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={linkCodeInput}
              onChange={(e) => setLinkCodeInput(e.target.value.toUpperCase())}
              placeholder="Enter 6-digit code"
              maxLength={6}
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-yellow-500 uppercase tracking-widest text-center text-lg"
            />
            <button
              onClick={() => linkGuidMutation.mutate(linkCodeInput)}
              disabled={linkCodeInput.length !== 6 || linkGuidMutation.isPending}
              className="px-6 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
            >
              {linkGuidMutation.isPending ? 'Verifying...' : 'Link Account'}
            </button>
          </div>

          {linkError && (
            <p className="text-red-400 mt-3">{linkError}</p>
          )}
        </div>
      </div>
    );
  }

  if (soundsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading sounds...</div>
      </div>
    );
  }

  const pendingShares = sharesData?.shares || [];
  const userSounds = filteredSounds;

  return (
    <div className="-m-4 md:-m-8">
      {/* Sticky Header */}
      <div className="sticky -top-4 md:-top-8 z-10 bg-gray-900 px-4 md:px-8 pt-4 pb-4 border-b border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl md:text-2xl font-bold">My Sounds</h1>
            <span className="text-sm text-gray-400">
              {userSounds.length}{debouncedSearch ? ` of ${soundsData?.sounds?.length || 0}` : ''} sound{userSounds.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Search sounds..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-48 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => setUploadModal(true)}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors flex items-center gap-2 whitespace-nowrap"
            >
              <span>+</span> Add Sound
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 md:p-8">
        {/* Pending Shares Section */}
        {pendingShares.length > 0 && (
          <div className="bg-blue-900/30 border border-blue-600 rounded-lg p-4 mb-4">
            <h2 className="text-lg font-semibold text-blue-400 mb-3 flex items-center gap-2">
              <span>📨</span>
              Pending Shares ({pendingShares.length})
            </h2>
            <div className="space-y-2">
              {pendingShares.map((share) => (
                <div key={share.id} className="bg-gray-800 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{share.originalName}</div>
                    <div className="text-sm text-gray-400">
                      From: {share.fromGuid.substring(0, 8)}... • {formatFileSize(share.fileSize)}
                      {share.durationSeconds && ` • ${formatDuration(share.durationSeconds)}`}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => openAcceptModal(share)}
                      className="px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded text-sm font-medium transition-colors"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => rejectShareMutation.mutate(share.id)}
                      disabled={rejectShareMutation.isPending}
                      className="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-sm font-medium transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sounds List */}
        {userSounds.length === 0 ? (
          <div className="bg-gray-800 rounded-lg p-8 text-center">
            <div className="text-4xl mb-4">🔇</div>
            <h2 className="text-xl font-semibold mb-2">
              {debouncedSearch ? 'No Matching Sounds' : 'No Sounds Yet'}
            </h2>
            <p className="text-gray-400 mb-4">
              {debouncedSearch
                ? 'Try a different search term'
                : <>Use <code className="bg-gray-700 px-2 py-1 rounded">/etman add &lt;url&gt; &lt;name&gt;</code> in-game to add your first sound.</>
              }
            </p>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            {/* Mobile: Card Layout */}
            <div className="md:hidden divide-y divide-gray-700">
              {userSounds.map((sound) => (
                <div key={sound.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <AudioPlayer alias={sound.alias} />
                        {editingAlias === sound.alias ? (
                          <div className="flex-1">
                            <input
                              type="text"
                              value={newAlias}
                              onChange={(e) => {
                                setNewAlias(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''));
                                setRenameError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRename(sound.alias);
                                if (e.key === 'Escape') {
                                  setEditingAlias(null);
                                  setRenameError(null);
                                }
                              }}
                              onBlur={() => handleRename(sound.alias)}
                              autoFocus
                              className={`bg-gray-700 border rounded px-2 py-1 text-white w-full ${renameError ? 'border-red-500' : 'border-blue-500'}`}
                            />
                            {renameError && <div className="text-xs text-red-400 mt-1">{renameError}</div>}
                          </div>
                        ) : (
                          <div
                            className="font-medium truncate cursor-pointer hover:text-blue-400 flex-1"
                            onClick={() => startEdit(sound)}
                            title="Click to rename"
                          >
                            {sound.alias}
                          </div>
                        )}
                      </div>
                      <div className="text-sm text-gray-400 ml-8">
                        {formatFileSize(sound.fileSize)} • {formatDuration(sound.durationSeconds)}
                      </div>
                      <div className="text-xs text-gray-500 mt-1 ml-8">
                        Added {formatRelativeTime(sound.createdAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* In Public Playlist Indicator */}
                      {sound.inPublicPlaylist && (
                        <span
                          className="px-2 py-1 rounded text-xs font-medium bg-purple-600 cursor-help flex items-center gap-1"
                          title="This sound is in a public playlist - visibility locked"
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                          In Public Playlist
                        </span>
                      )}

                      {/* Visibility Badge */}
                      <div className="relative">
                        <button
                          onClick={() => !sound.inPublicPlaylist && setVisibilityMenu(visibilityMenu === sound.alias ? null : sound.alias)}
                          className={`px-2 py-1 rounded text-xs font-medium ${visibilityColors[sound.visibility]} ${
                            sound.inPublicPlaylist ? 'opacity-50 cursor-not-allowed' : ''
                          }`}
                          title={sound.inPublicPlaylist ? 'Visibility locked - sound is in a public playlist' : 'Click to change visibility'}
                        >
                          {visibilityIcons[sound.visibility]} {sound.visibility}
                        </button>
                        {visibilityMenu === sound.alias && !sound.inPublicPlaylist && (
                          <div className="absolute right-0 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-lg z-10 overflow-hidden">
                            {(['private', 'shared', 'public'] as const).map((v) => (
                              <button
                                key={v}
                                onClick={() => visibilityMutation.mutate({ alias: sound.alias, visibility: v })}
                                className={`block w-full px-4 py-2 text-left text-sm hover:bg-gray-600 ${
                                  sound.visibility === v ? 'bg-gray-600' : ''
                                }`}
                              >
                                {visibilityIcons[v]} {v}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Delete Button */}
                      {deleteConfirm === sound.alias ? (
                        <div className="flex gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteMutation.mutate(sound.alias);
                            }}
                            disabled={deleteMutation.isPending}
                            className="px-2 py-1 bg-red-600 hover:bg-red-500 disabled:bg-red-800 rounded text-xs"
                          >
                            {deleteMutation.isPending ? '...' : 'Yes'}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirm(null);
                            }}
                            className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm(sound.alias);
                          }}
                          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                          title="Delete"
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: Table Layout */}
            <div className="hidden md:block">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700 bg-gray-800/50">
                    <th className="px-4 py-2 w-16">Play</th>
                    <th className="px-4 py-2">Alias</th>
                    <th className="px-4 py-2">Size</th>
                    <th className="px-4 py-2">Duration</th>
                    <th className="px-4 py-2">Visibility</th>
                    <th className="px-4 py-2">Added</th>
                    <th className="px-4 py-2 w-20">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {userSounds.map((sound) => (
                    <tr key={sound.id} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2">
                        <AudioPlayer alias={sound.alias} />
                      </td>
                      <td className="px-4 py-2">
                        {editingAlias === sound.alias ? (
                          <div>
                            <input
                              type="text"
                              value={newAlias}
                              onChange={(e) => {
                                setNewAlias(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''));
                                setRenameError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRename(sound.alias);
                                if (e.key === 'Escape') {
                                  setEditingAlias(null);
                                  setRenameError(null);
                                }
                              }}
                              onBlur={() => handleRename(sound.alias)}
                              autoFocus
                              className={`bg-gray-700 border rounded px-2 py-1 text-white w-full max-w-[200px] ${renameError ? 'border-red-500' : 'border-blue-500'}`}
                            />
                            {renameError && <div className="text-xs text-red-400 mt-1">{renameError}</div>}
                          </div>
                        ) : (
                          <span
                            className="font-medium cursor-pointer hover:text-blue-400"
                            onClick={() => startEdit(sound)}
                            title="Click to rename"
                          >
                            {sound.alias}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm">{formatFileSize(sound.fileSize)}</td>
                      <td className="px-4 py-2 text-sm">{formatDuration(sound.durationSeconds)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          {sound.inPublicPlaylist && (
                            <span
                              className="p-1.5 rounded bg-purple-600 cursor-help"
                              title="This sound is in a public playlist - visibility locked"
                            >
                              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                              </svg>
                            </span>
                          )}
                          <div className="relative inline-block">
                            <button
                              onClick={() => !sound.inPublicPlaylist && setVisibilityMenu(visibilityMenu === sound.alias ? null : sound.alias)}
                              className={`px-2 py-1 rounded text-xs font-medium ${visibilityColors[sound.visibility]} ${
                                sound.inPublicPlaylist ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                              title={sound.inPublicPlaylist ? 'Visibility locked - sound is in a public playlist' : 'Click to change visibility'}
                            >
                              {visibilityIcons[sound.visibility]} {sound.visibility}
                            </button>
                            {visibilityMenu === sound.alias && !sound.inPublicPlaylist && (
                              <div className="absolute left-0 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-lg z-10 overflow-hidden min-w-[120px]">
                                {(['private', 'shared', 'public'] as const).map((v) => (
                                  <button
                                    key={v}
                                    onClick={() => visibilityMutation.mutate({ alias: sound.alias, visibility: v })}
                                    className={`block w-full px-4 py-2 text-left text-sm hover:bg-gray-600 ${
                                      sound.visibility === v ? 'bg-gray-600' : ''
                                    }`}
                                  >
                                    {visibilityIcons[v]} {v}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatRelativeTime(sound.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        {deleteConfirm === sound.alias ? (
                          <div className="flex gap-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteMutation.mutate(sound.alias);
                              }}
                              disabled={deleteMutation.isPending}
                              className="px-2 py-1 bg-red-600 hover:bg-red-500 disabled:bg-red-800 rounded text-xs"
                            >
                              {deleteMutation.isPending ? '...' : 'Yes'}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteConfirm(null);
                              }}
                              className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirm(sound.alias);
                            }}
                            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                            title="Delete"
                          >
                            🗑️
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Accept Share Modal */}
      {acceptModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Accept Shared Sound</h3>
            <p className="text-gray-300 mb-4">
              Choose an alias for <span className="text-blue-400">{acceptModal.originalName}</span>
            </p>
            <input
              type="text"
              value={acceptAlias}
              onChange={(e) => setAcceptAlias(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              placeholder="Sound alias"
              className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 mb-4"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setAcceptModal(null);
                  setAcceptAlias('');
                }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => acceptShareMutation.mutate({ shareId: acceptModal.id, alias: acceptAlias })}
                disabled={!acceptAlias || acceptShareMutation.isPending}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {acceptShareMutation.isPending ? 'Accepting...' : 'Accept'}
              </button>
            </div>
            {acceptShareMutation.isError && (
              <p className="text-red-400 mt-3 text-sm">
                {(acceptShareMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}


      {/* Upload Modal */}
      {uploadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 overflow-y-auto">
          {tempUploadData ? (
            /* Clip Editor Mode */
            <div className="max-w-3xl w-full my-8">
              <SoundClipEditor
                tempId={tempUploadData.tempId}
                durationSeconds={tempUploadData.durationSeconds}
                maxClipDuration={tempUploadData.maxClipDuration}
                originalName={tempUploadData.originalName}
                onSave={handleSaveClip}
                onCancel={resetUploadModal}
                isSaving={isSavingClip}
                saveError={saveClipError}
              />
            </div>
          ) : (
            /* Upload Form Mode */
            <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
              <h3 className="text-lg font-semibold mb-4">Add New Sound</h3>

              {/* Mode Toggle */}
              <div className="flex mb-4 bg-gray-700 rounded-lg p-1">
                <button
                  onClick={() => setUploadMode('file')}
                  className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                    uploadMode === 'file' ? 'bg-orange-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  Upload File
                </button>
                <button
                  onClick={() => setUploadMode('url')}
                  className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                    uploadMode === 'url' ? 'bg-orange-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  From URL
                </button>
              </div>

              <div className="space-y-4">
                {/* File Upload */}
                {uploadMode === 'file' && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">MP3 File (max 20MB)</label>
                    <input
                      type="file"
                      accept=".mp3,audio/mpeg"
                      onChange={handleFileSelect}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white file:mr-4 file:py-1 file:px-4 file:rounded file:border-0 file:bg-orange-600 file:text-white file:cursor-pointer hover:file:bg-orange-500"
                    />
                    {uploadFile && (
                      <p className="text-sm text-gray-400 mt-1">
                        Selected: {uploadFile.name} ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
                      </p>
                    )}
                    <p className="text-xs text-gray-500 mt-2">
                      You'll be able to select a 30-second clip after uploading
                    </p>
                  </div>
                )}

                {/* URL Input */}
                {uploadMode === 'url' && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">MP3 URL</label>
                    <input
                      type="url"
                      value={uploadUrl}
                      onChange={(e) => setUploadUrl(e.target.value)}
                      placeholder="https://example.com/sound.mp3"
                      className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-2">
                      The server will download the MP3 and you can select a 30-second clip
                    </p>
                  </div>
                )}
              </div>

              {uploadError && (
                <p className="text-red-400 text-sm mt-3">{uploadError}</p>
              )}

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={resetUploadModal}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTempUpload}
                  disabled={isUploading || (uploadMode === 'file' ? !uploadFile : !uploadUrl)}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {isUploading ? 'Uploading...' : 'Continue to Editor'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
