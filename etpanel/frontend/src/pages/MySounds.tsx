import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { sounds } from '../api/client';
import type { UserSound, PendingShare, TempUploadResponse } from '../api/client';
import AudioPlayer from '../components/AudioPlayer';
import SoundClipEditor from '../components/SoundClipEditor';
import SoundMenuEditor from '../components/SoundMenuEditor';
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

const visibilityColors: Record<string, string> = {
  private: 'bg-gray-600 text-gray-200',
  public: 'bg-green-600 text-green-100',
  shared: 'bg-gray-600 text-gray-200', // Legacy - treat as private
};

const visibilityIcons: Record<string, string> = {
  private: '🔒',
  public: '🌐',
  shared: '🔒', // Legacy - treat as private
};

type SortField = 'alias' | 'fileSize' | 'durationSeconds' | 'visibility' | 'isOwner' | 'publicPlaylistCount' | 'privatePlaylistCount' | 'createdAt';
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
      className={`px-4 py-2 cursor-pointer hover:bg-gray-700/50 select-none transition-colors ${className}`}
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

type TabType = 'library' | 'menus';

export default function MySounds() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Tab state - default to 'library', can be set via URL param
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const tab = searchParams.get('tab');
    return tab === 'menus' ? 'menus' : 'library';
  });

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setSearchParams(tab === 'library' ? {} : { tab });
  };

  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [newAlias, setNewAlias] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteWarningSound, setDeleteWarningSound] = useState<UserSound | null>(null);
  const [visibilityWarning, setVisibilityWarning] = useState<{ sound: UserSound; newVisibility: 'private' | 'public' } | null>(null);
  const [playlistPopover, setPlaylistPopover] = useState<{ alias: string; type: 'public' | 'private' } | null>(null);
  const [acceptModal, setAcceptModal] = useState<PendingShare | null>(null);
  const [acceptAlias, setAcceptAlias] = useState('');
  const [linkCodeInput, setLinkCodeInput] = useState('');
  const [linkError, setLinkError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;

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
  const [isReclip, setIsReclip] = useState(false); // True when re-clipping an existing sound

  // State for creating clip from existing sound
  const [copyingSound, setCopyingSound] = useState<string | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>('alias');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page when search changes
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch]);

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

  // Filter and sort sounds
  const filteredSounds = useMemo(() => {
    if (!soundsData?.sounds) return [];

    // Filter by search
    let result = soundsData.sounds;
    if (debouncedSearch) {
      const searchLower = debouncedSearch.toLowerCase();
      result = result.filter(
        (s: UserSound) =>
          s.alias.toLowerCase().includes(searchLower) ||
          s.originalName.toLowerCase().includes(searchLower)
      );
    }

    // Sort
    result = [...result].sort((a: UserSound, b: UserSound) => {
      let comparison = 0;
      switch (sortField) {
        case 'alias':
          comparison = a.alias.localeCompare(b.alias);
          break;
        case 'fileSize':
          comparison = a.fileSize - b.fileSize;
          break;
        case 'durationSeconds':
          comparison = (a.durationSeconds || 0) - (b.durationSeconds || 0);
          break;
        case 'visibility':
          comparison = a.visibility.localeCompare(b.visibility);
          break;
        case 'isOwner':
          comparison = (a.isOwner ? 1 : 0) - (b.isOwner ? 1 : 0);
          break;
        case 'publicPlaylistCount':
          comparison = (a.publicPlaylists?.length || 0) - (b.publicPlaylists?.length || 0);
          break;
        case 'privatePlaylistCount':
          comparison = (a.privatePlaylists?.length || 0) - (b.privatePlaylists?.length || 0);
          break;
        case 'createdAt':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [soundsData?.sounds, debouncedSearch, sortField, sortDirection]);

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
      queryClient.invalidateQueries({ queryKey: ['publicLibrary'] });
      setDeleteConfirm(null);
      setDeleteWarningSound(null);
    },
    onError: (error) => {
      console.error('Delete failed:', error);
      alert('Failed to delete sound: ' + (error as Error).message);
      setDeleteConfirm(null);
      setDeleteWarningSound(null);
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: ({ alias, visibility, removeFromPublicPlaylists }: { alias: string; visibility: 'private' | 'public'; removeFromPublicPlaylists?: boolean }) =>
      sounds.setVisibility(alias, visibility, removeFromPublicPlaylists),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      queryClient.invalidateQueries({ queryKey: ['publicLibrary'] });
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setVisibilityWarning(null);
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

  // Handle delete with warning for sounds that have public visibility implications
  const handleDeleteClick = (sound: UserSound) => {
    const inPublicPlaylists = sound.publicPlaylists && sound.publicPlaylists.length > 0;
    // Show warning if:
    // 1. You own the sound AND it's set to public visibility (will remove from public library)
    // 2. The sound is in any of your public playlists (will be removed from them)
    const isOwnedAndPublic = sound.isOwner && sound.visibility === 'public';

    if (isOwnedAndPublic || inPublicPlaylists) {
      setDeleteWarningSound(sound);
    } else {
      setDeleteConfirm(sound.alias);
    }
  };

  const confirmDeletePublic = () => {
    if (deleteWarningSound) {
      deleteMutation.mutate(deleteWarningSound.alias);
    }
  };

  // Handle visibility change with warning when going from public to private
  // or when the sound is in public playlists
  const handleVisibilityChange = (sound: UserSound, newVisibility: 'private' | 'public') => {
    const inPublicPlaylists = sound.publicPlaylists && sound.publicPlaylists.length > 0;
    const isCurrentlyPublic = sound.visibility === 'public' || inPublicPlaylists;

    if (isCurrentlyPublic && newVisibility === 'private') {
      setVisibilityWarning({ sound, newVisibility });
    } else {
      visibilityMutation.mutate({ alias: sound.alias, visibility: newVisibility });
    }
  };

  const confirmVisibilityChange = () => {
    if (visibilityWarning) {
      const hasPublicPlaylists = visibilityWarning.sound.publicPlaylists && visibilityWarning.sound.publicPlaylists.length > 0;
      visibilityMutation.mutate({
        alias: visibilityWarning.sound.alias,
        visibility: visibilityWarning.newVisibility,
        removeFromPublicPlaylists: hasPublicPlaylists
      });
    }
  };

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
    setIsReclip(false);
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
      const ext = file.name.toLowerCase();
      if (!ext.endsWith('.mp3') && !ext.endsWith('.wav')) {
        setUploadError('Only MP3 and WAV files are allowed');
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

  // Create a new clip from an existing sound
  const handleCreateClipFromSound = async (alias: string) => {
    setCopyingSound(alias);
    try {
      const result = await sounds.copyToTemp(alias);
      setTempUploadData(result);
      setIsReclip(true); // Mark as re-clip for _clip suffix
      setUploadModal(true);
    } catch (err) {
      alert('Failed to prepare sound for editing: ' + (err as Error).message);
    } finally {
      setCopyingSound(null);
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
    // Normalize: remove extension, replace spaces with underscores, strip invalid chars
    const rawName = share.suggestedAlias || share.originalName.replace(/\.(mp3|wav)$/i, '');
    setAcceptAlias(rawName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, ''));
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
  const totalSounds = filteredSounds.length;
  const totalPages = Math.max(1, Math.ceil(totalSounds / pageSize));
  const userSounds = filteredSounds.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="-m-4 md:-m-8">
      {/* Sticky Header */}
      <div className="sticky -top-4 md:-top-8 z-10 bg-gray-900 px-4 md:px-8 pt-4 pb-2 border-b border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl md:text-2xl font-bold">My Sounds</h1>
            {activeTab === 'library' && (
              <span className="text-sm text-gray-400">
                {userSounds.length}{debouncedSearch ? ` of ${soundsData?.sounds?.length || 0}` : ''} sound{userSounds.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {activeTab === 'library' && (
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
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          <button
            onClick={() => handleTabChange('library')}
            className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${
              activeTab === 'library'
                ? 'bg-gray-800 text-white border-b-2 border-orange-500'
                : 'bg-gray-800/50 text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            Sound Library
          </button>
          <button
            onClick={() => handleTabChange('menus')}
            className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${
              activeTab === 'menus'
                ? 'bg-gray-800 text-white border-b-2 border-orange-500'
                : 'bg-gray-800/50 text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            Sound Menus
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 md:px-8 py-4 h-[calc(100vh-130px)] flex flex-col gap-4">
        {/* Sound Menus Tab */}
        {activeTab === 'menus' && (
          <SoundMenuEditor userSounds={soundsData?.sounds || []} />
        )}

        {/* Library Tab Content */}
        {activeTab === 'library' && (
          <>
        {/* Pending Shares Section */}
        {pendingShares.length > 0 && (
          <div className="bg-blue-900/30 border border-blue-600 rounded-lg p-4 flex-shrink-0">
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
          <div className="bg-gray-800 rounded-lg p-8 text-center flex-1 flex flex-col items-center justify-center">
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
          <div className="bg-gray-800 rounded-lg flex-1 overflow-hidden flex flex-col">
            {/* Mobile: Card Layout */}
            <div className="md:hidden divide-y divide-gray-700 overflow-y-auto flex-1">
              {userSounds.map((sound, index) => (
                <div key={sound.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm text-gray-500 w-8 flex-shrink-0">{page * pageSize + index + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <AudioPlayer alias={sound.alias} />
                        {editingAlias === sound.alias ? (
                          <div className="flex-1">
                            <input
                              type="text"
                              value={newAlias}
                              onChange={(e) => {
                                setNewAlias(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''));
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
                      <div className="text-sm text-gray-400 ml-8 flex items-center gap-2 flex-wrap">
                        {formatFileSize(sound.fileSize)} • {formatDuration(sound.durationSeconds)} • {sound.isOwner ? <span className="text-green-400">You</span> : renderETColors(sound.ownerName || 'Unknown')}
                        {/* Playlist counts for mobile */}
                        {sound.publicPlaylists && sound.publicPlaylists.length > 0 && (
                          <div className="relative inline-block">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPlaylistPopover(
                                  playlistPopover?.alias === sound.alias && playlistPopover?.type === 'public'
                                    ? null
                                    : { alias: sound.alias, type: 'public' }
                                );
                              }}
                              className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-600 text-white hover:bg-green-500"
                              title="Public playlists"
                            >
                              🌐 {sound.publicPlaylists.length}
                            </button>
                            {playlistPopover?.alias === sound.alias && playlistPopover?.type === 'public' && (
                              <div className="absolute left-0 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-lg z-20 min-w-[150px] py-1">
                                <div className="px-3 py-1 text-xs text-gray-400 border-b border-gray-600">Public Playlists</div>
                                {sound.publicPlaylists.map((pl) => (
                                  <button
                                    key={pl.id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setPlaylistPopover(null);
                                      navigate(`/sounds/playlists?id=${pl.id}`);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-600"
                                  >
                                    {pl.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {sound.privatePlaylists && sound.privatePlaylists.length > 0 && (
                          <div className="relative inline-block">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPlaylistPopover(
                                  playlistPopover?.alias === sound.alias && playlistPopover?.type === 'private'
                                    ? null
                                    : { alias: sound.alias, type: 'private' }
                                );
                              }}
                              className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-gray-600 text-white hover:bg-gray-500"
                              title="Your private playlists"
                            >
                              🔒 {sound.privatePlaylists.length}
                            </button>
                            {playlistPopover?.alias === sound.alias && playlistPopover?.type === 'private' && (
                              <div className="absolute left-0 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-lg z-20 min-w-[150px] py-1">
                                <div className="px-3 py-1 text-xs text-gray-400 border-b border-gray-600">Your Private Playlists</div>
                                {sound.privatePlaylists.map((pl) => (
                                  <button
                                    key={pl.id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setPlaylistPopover(null);
                                      navigate(`/sounds/playlists?id=${pl.id}`);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-600"
                                  >
                                    {pl.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1 ml-8">
                        Added {formatRelativeTime(sound.createdAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Visibility Toggle */}
                      {(() => {
                        const inPublicPlaylists = sound.publicPlaylists && sound.publicPlaylists.length > 0;
                        const effectiveVisibility = inPublicPlaylists ? 'public' : sound.visibility;
                        const newVisibility = effectiveVisibility === 'public' ? 'private' : 'public';
                        return (
                          <button
                            onClick={() => sound.isOwner && handleVisibilityChange(sound, newVisibility)}
                            className={`px-2 py-1 rounded text-xs font-medium ${visibilityColors[effectiveVisibility]} ${
                              !sound.isOwner ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
                            } transition-opacity`}
                            title={
                              !sound.isOwner
                                ? 'Only the owner can change visibility'
                                : `Click to make ${newVisibility}`
                            }
                          >
                            {visibilityIcons[effectiveVisibility]} {effectiveVisibility}
                          </button>
                        );
                      })()}

                      {/* Create Clip Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCreateClipFromSound(sound.alias);
                        }}
                        disabled={copyingSound === sound.alias}
                        className="p-1.5 text-gray-400 hover:text-purple-400 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
                        title="Create new clip from this sound"
                      >
                        {copyingSound === sound.alias ? (
                          <span className="animate-spin inline-block">⏳</span>
                        ) : (
                          '✂️'
                        )}
                      </button>

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
                            handleDeleteClick(sound);
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
            <div className="hidden md:flex md:flex-col md:flex-1 md:overflow-hidden">
              {/* Scrollable Table with Sticky Header */}
              <div className="flex-1 overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-gray-800 z-10">
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="px-4 py-2 w-12">#</th>
                      <th className="px-4 py-2 w-16">Play</th>
                      <SortableHeader label="Alias" field="alias" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Size" field="fileSize" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Duration" field="durationSeconds" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Owner" field="isOwner" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} className="w-16" />
                      <SortableHeader label="🌐" field="publicPlaylistCount" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} className="w-12 text-center" />
                      <SortableHeader label="🔒" field="privatePlaylistCount" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} className="w-12 text-center" />
                      <SortableHeader label="Visibility" field="visibility" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <SortableHeader label="Added" field="createdAt" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <th className="px-4 py-2 w-20">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                  {userSounds.map((sound, index) => (
                    <tr key={sound.id} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2 text-sm text-gray-500">{page * pageSize + index + 1}</td>
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
                                setNewAlias(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''));
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
                      <td className="px-4 py-2 text-sm">
                        {sound.isOwner ? (
                          <span className="text-green-400">You</span>
                        ) : (
                          renderETColors(sound.ownerName || 'Unknown')
                        )}
                      </td>
                      {/* Public Playlists Count */}
                      <td className="px-4 py-2 text-center relative">
                        {sound.publicPlaylists && sound.publicPlaylists.length > 0 ? (
                          <div className="relative inline-block">
                            <button
                              onClick={() => setPlaylistPopover(
                                playlistPopover?.alias === sound.alias && playlistPopover?.type === 'public'
                                  ? null
                                  : { alias: sound.alias, type: 'public' }
                              )}
                              className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-600 text-white hover:bg-green-500 cursor-pointer"
                              title="Click to see public playlists"
                            >
                              {sound.publicPlaylists.length}
                            </button>
                            {playlistPopover?.alias === sound.alias && playlistPopover?.type === 'public' && (
                              <div className="absolute left-1/2 -translate-x-1/2 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-lg z-20 min-w-[150px] py-1">
                                <div className="px-3 py-1 text-xs text-gray-400 border-b border-gray-600">Public Playlists</div>
                                {sound.publicPlaylists.map((pl) => (
                                  <button
                                    key={pl.id}
                                    onClick={() => {
                                      setPlaylistPopover(null);
                                      navigate(`/sounds/playlists?id=${pl.id}`);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-600"
                                  >
                                    {pl.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-600">–</span>
                        )}
                      </td>
                      {/* Private Playlists Count */}
                      <td className="px-4 py-2 text-center relative">
                        {sound.privatePlaylists && sound.privatePlaylists.length > 0 ? (
                          <div className="relative inline-block">
                            <button
                              onClick={() => setPlaylistPopover(
                                playlistPopover?.alias === sound.alias && playlistPopover?.type === 'private'
                                  ? null
                                  : { alias: sound.alias, type: 'private' }
                              )}
                              className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-600 text-white hover:bg-gray-500 cursor-pointer"
                              title="Click to see your private playlists"
                            >
                              {sound.privatePlaylists.length}
                            </button>
                            {playlistPopover?.alias === sound.alias && playlistPopover?.type === 'private' && (
                              <div className="absolute left-1/2 -translate-x-1/2 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-lg z-20 min-w-[150px] py-1">
                                <div className="px-3 py-1 text-xs text-gray-400 border-b border-gray-600">Your Private Playlists</div>
                                {sound.privatePlaylists.map((pl) => (
                                  <button
                                    key={pl.id}
                                    onClick={() => {
                                      setPlaylistPopover(null);
                                      navigate(`/sounds/playlists?id=${pl.id}`);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-600"
                                  >
                                    {pl.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-600">–</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {(() => {
                          const inPublicPlaylists = sound.publicPlaylists && sound.publicPlaylists.length > 0;
                          const effectiveVisibility = inPublicPlaylists ? 'public' : sound.visibility;
                          const newVisibility = effectiveVisibility === 'public' ? 'private' : 'public';
                          return (
                            <button
                              onClick={() => sound.isOwner && handleVisibilityChange(sound, newVisibility)}
                              className={`px-2 py-1 rounded text-xs font-medium ${visibilityColors[effectiveVisibility]} ${
                                !sound.isOwner ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
                              } transition-opacity`}
                              title={
                                !sound.isOwner
                                  ? 'Only the owner can change visibility'
                                  : `Click to make ${newVisibility}`
                              }
                            >
                              {visibilityIcons[effectiveVisibility]} {effectiveVisibility}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-400">
                        {formatRelativeTime(sound.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1">
                          {/* Create Clip Button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCreateClipFromSound(sound.alias);
                            }}
                            disabled={copyingSound === sound.alias}
                            className="p-1.5 text-gray-400 hover:text-purple-400 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
                            title="Create new clip from this sound"
                          >
                            {copyingSound === sound.alias ? (
                              <span className="animate-spin inline-block">⏳</span>
                            ) : (
                              '✂️'
                            )}
                          </button>

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
                                handleDeleteClick(sound);
                              }}
                              className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                              title="Delete"
                            >
                              🗑️
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
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
                title="Next page"
              >
                ›
              </button>
              <button
                onClick={() => setPage(totalPages - 1)}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
                title="Last page"
              >
                »
              </button>
            </div>
          </div>
        )}
        </>
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
              onChange={(e) => setAcceptAlias(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
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
                isReclip={isReclip}
                existingAliases={soundsData?.sounds?.map((s: UserSound) => s.alias) || []}
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
                    <label className="block text-sm text-gray-400 mb-1">Audio File (MP3 or WAV, max 20MB)</label>
                    <input
                      type="file"
                      accept=".mp3,.wav,audio/mpeg,audio/wav,audio/wave"
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
                    <label className="block text-sm text-gray-400 mb-1">Audio URL (MP3 or WAV)</label>
                    <input
                      type="url"
                      value={uploadUrl}
                      onChange={(e) => setUploadUrl(e.target.value)}
                      placeholder="https://example.com/sound.mp3"
                      className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-2">
                      The server will download the audio and you can select a 30-second clip
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

      {/* Delete Sound Warning Modal */}
      {deleteWarningSound && (() => {
        const inPublicPlaylists = deleteWarningSound.publicPlaylists && deleteWarningSound.publicPlaylists.length > 0;
        const isOwnedAndPublic = deleteWarningSound.isOwner && deleteWarningSound.visibility === 'public';

        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
              <h3 className="text-lg font-semibold mb-4 text-orange-400">
                {isOwnedAndPublic ? 'Delete Public Sound' : 'Delete Sound'}
              </h3>
              <p className="text-gray-300 mb-2">
                You are about to delete{' '}
                <span className="text-blue-400 font-medium">{deleteWarningSound.alias}</span>
              </p>
              <div className="bg-yellow-900/30 border border-yellow-600/50 rounded p-3 mb-4">
                <p className="text-yellow-400 text-sm">⚠️ Deleting this sound will:</p>
                <ul className="text-yellow-300 text-sm mt-2 space-y-1 ml-4 list-disc">
                  <li>Remove it from your library</li>
                  {isOwnedAndPublic && (
                    <>
                      <li>Remove it from the public library</li>
                      <li>Other users who added it will keep their copies</li>
                    </>
                  )}
                  {inPublicPlaylists && (
                    <li>
                      Remove it from {deleteWarningSound.publicPlaylists!.length} public playlist{deleteWarningSound.publicPlaylists!.length > 1 ? 's' : ''}:
                      <ul className="mt-1 ml-4 list-none">
                        {deleteWarningSound.publicPlaylists!.map((pl) => (
                          <li key={pl.id} className="text-orange-300">• {pl.name}</li>
                        ))}
                      </ul>
                    </li>
                  )}
                </ul>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setDeleteWarningSound(null)}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeletePublic}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {deleteMutation.isPending ? 'Deleting...' : 'Delete Anyway'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Change Visibility Warning Modal (public -> private) */}
      {visibilityWarning && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4 text-orange-400">Make Sound Private</h3>
            <p className="text-gray-300 mb-2">
              You are about to make{' '}
              <span className="text-blue-400 font-medium">{visibilityWarning.sound.alias}</span>{' '}
              private.
            </p>
            <div className="bg-yellow-900/30 border border-yellow-600/50 rounded p-3 mb-4">
              <p className="text-yellow-400 text-sm">
                ⚠️ Making this sound private will:
              </p>
              <ul className="text-yellow-300 text-sm mt-2 space-y-1 ml-4 list-disc">
                {visibilityWarning.sound.visibility === 'public' && (
                  <li>Remove it from the public library</li>
                )}
                {visibilityWarning.sound.publicPlaylists && visibilityWarning.sound.publicPlaylists.length > 0 && (
                  <li>
                    Remove it from the following public playlist{visibilityWarning.sound.publicPlaylists.length > 1 ? 's' : ''}:
                    <ul className="mt-1 ml-4 list-none">
                      {visibilityWarning.sound.publicPlaylists.map((pl) => (
                        <li key={pl.id} className="text-orange-300">• {pl.name}</li>
                      ))}
                    </ul>
                  </li>
                )}
                <li>New users will no longer be able to find or add it</li>
                <li>Users who already added it will keep their copies</li>
              </ul>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setVisibilityWarning(null)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmVisibilityChange}
                disabled={visibilityMutation.isPending}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {visibilityMutation.isPending ? 'Changing...' : 'Make Private'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
