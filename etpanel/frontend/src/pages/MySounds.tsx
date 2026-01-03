import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { sounds, settings } from '../api/client';
import type { UserSound, PendingShare, TempUploadResponse, UnfinishedSound, UnfinishedEditResponse, QuickCommandAlias } from '../api/client';
import AudioPlayer from '../components/AudioPlayer';
import SoundClipEditor from '../components/SoundClipEditor';
import SoundMenuEditor from '../components/SoundMenuEditor';
import { renderETColors } from '../utils/etColors';
import { useAuthStore } from '../stores/auth';

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

type TabType = 'library' | 'unfinished' | 'menus' | 'server-menus';

export default function MySounds() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  // Tab state - default to 'library', can be set via URL param
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const tab = searchParams.get('tab');
    if (tab === 'menus') return 'menus';
    if (tab === 'server-menus') return 'server-menus';
    if (tab === 'unfinished') return 'unfinished';
    return 'library';
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
  const pageSize = 100;

  // Upload modal state
  const [uploadModal, setUploadModal] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'multi' | 'url'>('file');
  const [uploadUrl, setUploadUrl] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // Clip editor state (after temp upload)
  const [tempUploadData, setTempUploadData] = useState<TempUploadResponse | null>(null);
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [saveClipError, setSaveClipError] = useState('');
  const [isReclip, setIsReclip] = useState(false); // True when re-clipping an existing sound
  const [reclipAlias, setReclipAlias] = useState<string | null>(null); // Original alias when re-clipping

  // Overwrite confirmation state
  const [overwriteConfirm, setOverwriteConfirm] = useState<{
    alias: string;
    startTime: number;
    endTime: number;
    isPublic: boolean;
    volumeDb: number;
  } | null>(null);

  // State for creating clip from existing sound
  const [copyingSound, setCopyingSound] = useState<string | null>(null);

  // Unfinished sounds state
  const [editingUnfinishedAlias, setEditingUnfinishedAlias] = useState<string | null>(null);
  const [newUnfinishedAlias, setNewUnfinishedAlias] = useState('');
  const [unfinishedRenameError, setUnfinishedRenameError] = useState<string | null>(null);
  const [savingUnfinished, setSavingUnfinished] = useState<string | null>(null);
  const [editingUnfinishedSound, setEditingUnfinishedSound] = useState<UnfinishedEditResponse | null>(null);

  // Multi-file upload state
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [isMultiUploading, setIsMultiUploading] = useState(false);
  const [multiUploadProgress, setMultiUploadProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Unfinished sound preview player
  const [playingUnfinishedId, setPlayingUnfinishedId] = useState<string | null>(null);
  const unfinishedAudioRef = useRef<HTMLAudioElement | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>('alias');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Multi-select state for batch playlist add (persists across pagination/search)
  const [selectedSounds, setSelectedSounds] = useState<Set<string>>(new Set());
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [selectedPlaylists, setSelectedPlaylists] = useState<Set<string>>(new Set());
  const [isAddingToPlaylists, setIsAddingToPlaylists] = useState(false);
  const [batchAddResults, setBatchAddResults] = useState<{ added: number; skipped: number } | null>(null);

  // Single sound add-to-playlist modal state
  const [singleAddSound, setSingleAddSound] = useState<string | null>(null);
  const [singleAddPlaylists, setSingleAddPlaylists] = useState<Set<string>>(new Set());
  const [isSingleAdding, setIsSingleAdding] = useState(false);
  const [singleAddResults, setSingleAddResults] = useState<{ added: number; skipped: number } | null>(null);

  // Quick Command state
  const [quickCmdSettingsOpen, setQuickCmdSettingsOpen] = useState(false);
  const [quickCmdPrefix, setQuickCmdPrefix] = useState('');
  const [quickCmdPrefixError, setQuickCmdPrefixError] = useState<string | null>(null);
  const [quickCmdModalData, setQuickCmdModalData] = useState<{
    soundAlias: string;
    quickAlias: string;
    chatText: string;
    originalAlias: string; // Track original alias to detect renames
  } | null>(null);

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

  // Fetch unfinished sounds
  const { data: unfinishedData, isLoading: unfinishedLoading } = useQuery({
    queryKey: ['unfinishedSounds'],
    queryFn: sounds.listUnfinished,
    enabled: guidStatus?.linked === true,
  });

  // Fetch playlists for batch add modal
  const { data: playlistsData } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
    enabled: guidStatus?.linked === true,
  });

  // Fetch Quick Command settings
  const { data: quickCmdData } = useQuery({
    queryKey: ['quickCommandSettings'],
    queryFn: settings.getQuickCommand,
    enabled: guidStatus?.linked === true,
  });

  // Initialize Quick Command prefix from server data
  useEffect(() => {
    if (quickCmdData?.prefix && !quickCmdPrefix) {
      setQuickCmdPrefix(quickCmdData.prefix);
    }
  }, [quickCmdData?.prefix]);

  // Create a map of sound alias -> quick command alias for easy lookup
  const quickCmdMap = useMemo(() => {
    const map = new Map<string, QuickCommandAlias>();
    if (quickCmdData?.aliases) {
      for (const alias of quickCmdData.aliases) {
        map.set(alias.soundAlias, alias);
      }
    }
    return map;
  }, [quickCmdData?.aliases]);

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

  // Quick Command mutations
  const updatePrefixMutation = useMutation({
    mutationFn: (prefix: string) => settings.updatePrefix(prefix),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['quickCommandSettings'] });
      setQuickCmdPrefix(data.prefix);
      setQuickCmdPrefixError(null);
    },
    onError: (error: Error) => {
      setQuickCmdPrefixError(error.message);
    },
  });

  const setQuickAliasMutation = useMutation({
    mutationFn: ({ alias, soundAlias, chatText }: { alias: string; soundAlias: string; chatText: string | null }) =>
      settings.setQuickAlias(alias, soundAlias, undefined, chatText),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quickCommandSettings'] });
      setQuickCmdModalData(null);
    },
  });

  const removeQuickAliasMutation = useMutation({
    mutationFn: (alias: string) => settings.removeQuickAlias(alias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quickCommandSettings'] });
      setQuickCmdModalData(null);
    },
  });

  // Unfinished sounds mutations
  const renameUnfinishedMutation = useMutation({
    mutationFn: ({ tempId, newAlias }: { tempId: string; newAlias: string }) =>
      sounds.renameUnfinished(tempId, newAlias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unfinishedSounds'] });
      setEditingUnfinishedAlias(null);
      setNewUnfinishedAlias('');
      setUnfinishedRenameError(null);
    },
    onError: (error: Error) => {
      setUnfinishedRenameError(error.message);
    },
  });

  const deleteUnfinishedMutation = useMutation({
    mutationFn: (tempId: string) => sounds.deleteUnfinished(tempId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unfinishedSounds'] });
    },
  });

  const saveUnfinishedMutation = useMutation({
    mutationFn: (tempId: string) => sounds.saveUnfinished(tempId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unfinishedSounds'] });
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      setSavingUnfinished(null);
    },
    onError: (error: Error) => {
      alert('Failed to save sound: ' + error.message);
      setSavingUnfinished(null);
    },
  });

  // Handle multi-file upload
  const handleMultiFileUpload = async () => {
    if (uploadFiles.length === 0) return;

    setIsMultiUploading(true);
    setMultiUploadProgress({ uploaded: 0, total: uploadFiles.length });
    setUploadError('');

    try {
      const result = await sounds.uploadUnfinished(uploadFiles);

      if (result.errors.length > 0) {
        const errorMessages = result.errors.map(e => `${e.filename}: ${e.error}`).join('\n');
        setUploadError(`Some files failed to upload:\n${errorMessages}`);
      }

      if (result.uploaded.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['unfinishedSounds'] });
        // Switch to unfinished tab to show uploaded files
        handleTabChange('unfinished');
      }

      // Reset upload state
      setUploadFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      if (result.errors.length === 0) {
        setUploadModal(false);
      }
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setIsMultiUploading(false);
      setMultiUploadProgress(null);
    }
  };

  // Handle editing unfinished sound (open clip editor)
  const handleEditUnfinished = async (tempId: string) => {
    try {
      const result = await sounds.getUnfinishedForEdit(tempId);
      setEditingUnfinishedSound(result);
    } catch (err) {
      alert('Failed to open editor: ' + (err as Error).message);
    }
  };

  // Save clipped audio from unfinished sound
  const handleSaveUnfinishedClip = async (alias: string, startTime: number, endTime: number, isPublic: boolean, volumeDb: number = 0) => {
    if (!editingUnfinishedSound) return;

    // Check for duplicate alias
    if (soundsData?.sounds.some((s: UserSound) => s.alias.toLowerCase() === alias.toLowerCase())) {
      setSaveClipError('You already have a sound with this alias');
      return;
    }

    setIsSavingClip(true);
    setSaveClipError('');

    try {
      await sounds.saveUnfinishedClip(editingUnfinishedSound.tempId, alias, startTime, endTime, isPublic, volumeDb);
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      queryClient.invalidateQueries({ queryKey: ['unfinishedSounds'] });
      setEditingUnfinishedSound(null);
      setIsSavingClip(false);
      setSaveClipError('');
    } catch (err) {
      setSaveClipError((err as Error).message);
      setIsSavingClip(false);
    }
  };

  // Handle unfinished alias rename
  const handleUnfinishedRename = (tempId: string) => {
    if (!newUnfinishedAlias) {
      setEditingUnfinishedAlias(null);
      setUnfinishedRenameError(null);
      return;
    }
    // Check for duplicate in both user sounds and unfinished sounds
    const isDuplicate = soundsData?.sounds.some(
      (s: UserSound) => s.alias.toLowerCase() === newUnfinishedAlias.toLowerCase()
    ) || unfinishedData?.sounds.some(
      (s: UnfinishedSound) => s.alias.toLowerCase() === newUnfinishedAlias.toLowerCase() && s.tempId !== tempId
    );
    if (isDuplicate) {
      setUnfinishedRenameError(`Alias "${newUnfinishedAlias}" already exists`);
      return;
    }
    setUnfinishedRenameError(null);
    renameUnfinishedMutation.mutate({ tempId, newAlias: newUnfinishedAlias });
  };

  const startUnfinishedEdit = (sound: UnfinishedSound) => {
    setEditingUnfinishedAlias(sound.tempId);
    setNewUnfinishedAlias(sound.alias);
  };

  // Play/stop unfinished sound preview
  const toggleUnfinishedPlay = async (tempId: string) => {
    // If already playing this sound, stop it
    if (playingUnfinishedId === tempId) {
      if (unfinishedAudioRef.current) {
        unfinishedAudioRef.current.pause();
        unfinishedAudioRef.current = null;
      }
      setPlayingUnfinishedId(null);
      return;
    }

    // Stop any currently playing sound
    if (unfinishedAudioRef.current) {
      unfinishedAudioRef.current.pause();
      unfinishedAudioRef.current = null;
    }

    // Start playing the new sound
    try {
      const token = localStorage.getItem('accessToken');
      const streamUrl = sounds.getUnfinishedStreamUrl(tempId);

      const response = await fetch(streamUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) throw new Error('Failed to load audio');

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const audio = new Audio(blobUrl);
      audio.onended = () => {
        setPlayingUnfinishedId(null);
        URL.revokeObjectURL(blobUrl);
      };
      audio.onerror = () => {
        setPlayingUnfinishedId(null);
        URL.revokeObjectURL(blobUrl);
      };

      unfinishedAudioRef.current = audio;
      setPlayingUnfinishedId(tempId);
      audio.play();
    } catch (err) {
      console.error('Failed to play audio:', err);
      setPlayingUnfinishedId(null);
    }
  };

  // Handle multi-file selection
  const handleMultiFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validFiles: File[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const ext = file.name.toLowerCase();
      if (!ext.endsWith('.mp3') && !ext.endsWith('.wav')) {
        errors.push(`${file.name}: Only MP3 and WAV files are allowed`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        errors.push(`${file.name}: File too large (max 10MB)`);
        continue;
      }
      validFiles.push(file);
    }

    if (errors.length > 0) {
      setUploadError(errors.join('\n'));
    } else {
      setUploadError('');
    }

    setUploadFiles(validFiles);
  };

  // Multi-select handlers for batch playlist add
  const toggleSoundSelection = (alias: string) => {
    setSelectedSounds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(alias)) {
        newSet.delete(alias);
      } else {
        newSet.add(alias);
      }
      return newSet;
    });
  };

  const toggleSelectAllOnPage = (pageItems: UserSound[]) => {
    // Toggle all sounds on current page
    const pageAliases = pageItems.map((s: UserSound) => s.alias);
    const allSelected = pageAliases.every((alias: string) => selectedSounds.has(alias));

    setSelectedSounds(prev => {
      const newSet = new Set(prev);
      if (allSelected) {
        // Deselect all on current page
        pageAliases.forEach((alias: string) => newSet.delete(alias));
      } else {
        // Select all on current page
        pageAliases.forEach((alias: string) => newSet.add(alias));
      }
      return newSet;
    });
  };

  const clearSelection = () => {
    setSelectedSounds(new Set());
  };

  const togglePlaylistSelection = (playlistName: string) => {
    setSelectedPlaylists(prev => {
      const newSet = new Set(prev);
      if (newSet.has(playlistName)) {
        newSet.delete(playlistName);
      } else {
        newSet.add(playlistName);
      }
      return newSet;
    });
  };

  const handleBatchAddToPlaylists = async () => {
    if (selectedSounds.size === 0 || selectedPlaylists.size === 0) return;

    setIsAddingToPlaylists(true);
    setBatchAddResults(null);

    let added = 0;
    let skipped = 0;

    // Add each selected sound to each selected playlist
    for (const playlistName of selectedPlaylists) {
      for (const soundAlias of selectedSounds) {
        try {
          await sounds.addToPlaylist(playlistName, soundAlias);
          added++;
        } catch (err) {
          // If error is "already exists", count as skipped
          const errorMessage = (err as Error).message || '';
          if (errorMessage.includes('already') || errorMessage.includes('exists')) {
            skipped++;
          } else {
            // Other errors - still count as skipped but log
            console.error(`Failed to add ${soundAlias} to ${playlistName}:`, err);
            skipped++;
          }
        }
      }
    }

    setBatchAddResults({ added, skipped });
    setIsAddingToPlaylists(false);

    // Refresh playlists data
    queryClient.invalidateQueries({ queryKey: ['playlists'] });
    queryClient.invalidateQueries({ queryKey: ['mySounds'] });
  };

  const closeBatchAddModal = () => {
    setShowPlaylistModal(false);
    setSelectedPlaylists(new Set());
    setBatchAddResults(null);
    // Clear selection after successful add
    if (batchAddResults && batchAddResults.added > 0) {
      setSelectedSounds(new Set());
    }
  };

  // Single sound add-to-playlist handlers
  const toggleSingleAddPlaylist = (playlistName: string) => {
    setSingleAddPlaylists(prev => {
      const newSet = new Set(prev);
      if (newSet.has(playlistName)) {
        newSet.delete(playlistName);
      } else {
        newSet.add(playlistName);
      }
      return newSet;
    });
  };

  const handleSingleAddToPlaylists = async () => {
    if (!singleAddSound || singleAddPlaylists.size === 0) return;

    setIsSingleAdding(true);
    setSingleAddResults(null);

    let added = 0;
    let skipped = 0;

    for (const playlistName of singleAddPlaylists) {
      try {
        await sounds.addToPlaylist(playlistName, singleAddSound);
        added++;
      } catch (err) {
        const errorMessage = (err as Error).message || '';
        if (errorMessage.includes('already') || errorMessage.includes('exists')) {
          skipped++;
        } else {
          console.error(`Failed to add ${singleAddSound} to ${playlistName}:`, err);
          skipped++;
        }
      }
    }

    setSingleAddResults({ added, skipped });
    setIsSingleAdding(false);

    // Refresh data
    queryClient.invalidateQueries({ queryKey: ['playlists'] });
    queryClient.invalidateQueries({ queryKey: ['mySounds'] });
  };

  const closeSingleAddModal = () => {
    setSingleAddSound(null);
    setSingleAddPlaylists(new Set());
    setSingleAddResults(null);
  };

  // Quick Command helpers
  const openQuickCmdEditor = (soundAlias: string) => {
    const existing = quickCmdMap.get(soundAlias);
    setQuickCmdModalData({
      soundAlias,
      quickAlias: existing?.alias || '',
      chatText: existing?.chatText || '',
      originalAlias: existing?.alias || '', // Track original for rename detection
    });
  };

  const handleSaveQuickCmd = async () => {
    if (!quickCmdModalData) return;
    const { soundAlias, quickAlias, chatText, originalAlias } = quickCmdModalData;
    const newAlias = quickAlias.trim().toLowerCase();

    if (!newAlias) {
      // If no alias, remove the quick command
      if (originalAlias) {
        removeQuickAliasMutation.mutate(originalAlias);
      } else {
        setQuickCmdModalData(null);
      }
      return;
    }

    // If alias changed and there was an original, delete the old one first
    if (originalAlias && originalAlias !== newAlias) {
      try {
        await settings.removeQuickAlias(originalAlias);
      } catch {
        // Ignore errors - old alias may not exist
      }
    }

    setQuickAliasMutation.mutate({
      alias: newAlias,
      soundAlias,
      chatText: chatText.trim() || null,
    });
  };

  const handleRemoveQuickCmd = () => {
    if (!quickCmdModalData) return;
    const existing = quickCmdMap.get(quickCmdModalData.soundAlias);
    if (existing) {
      removeQuickAliasMutation.mutate(existing.alias);
    } else {
      setQuickCmdModalData(null);
    }
  };

  const handlePrefixSave = () => {
    if (quickCmdPrefix !== quickCmdData?.prefix) {
      updatePrefixMutation.mutate(quickCmdPrefix);
    }
  };

  // Format prefix for display - show trailing space visually
  const formatPrefixDisplay = (prefix: string) => {
    if (prefix.endsWith(' ')) {
      return prefix.slice(0, -1) + '␣';
    }
    return prefix;
  };

  // Get user's own playlists for batch add
  const userPlaylists = useMemo(() => {
    if (!playlistsData?.playlists) return [];
    return playlistsData.playlists.filter((p) => p.isOwner === true);
  }, [playlistsData]);

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
    setUploadFiles([]);
    setUploadError('');
    setIsUploading(false);
    setIsMultiUploading(false);
    setMultiUploadProgress(null);
    setTempUploadData(null);
    setIsSavingClip(false);
    setSaveClipError('');
    setIsReclip(false);
    setReclipAlias(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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
  const handleSaveClip = async (alias: string, startTime: number, endTime: number, isPublic: boolean, volumeDb: number = 0, overwrite: boolean = false) => {
    if (!tempUploadData) return;

    // Check for duplicate alias - only if not overwriting
    if (!overwrite) {
      const existingSound = soundsData?.sounds.find((s: UserSound) => s.alias.toLowerCase() === alias.toLowerCase());
      if (existingSound) {
        // If user owns the sound, offer to overwrite
        if (existingSound.isOwner) {
          setOverwriteConfirm({ alias, startTime, endTime, isPublic, volumeDb });
          return;
        }
        // User doesn't own this sound, can't overwrite
        setSaveClipError('You already have a sound with this alias');
        return;
      }
    }

    setIsSavingClip(true);
    setSaveClipError('');

    try {
      await sounds.saveClip(tempUploadData.tempId, alias, startTime, endTime, isPublic, volumeDb, overwrite);
      queryClient.invalidateQueries({ queryKey: ['mySounds'] });
      queryClient.invalidateQueries({ queryKey: ['publicLibrary'] });
      setOverwriteConfirm(null);
      resetUploadModal();
    } catch (err) {
      setSaveClipError((err as Error).message);
      setIsSavingClip(false);
    }
  };

  // Handle overwrite confirmation
  const handleOverwriteConfirm = () => {
    if (overwriteConfirm) {
      handleSaveClip(
        overwriteConfirm.alias,
        overwriteConfirm.startTime,
        overwriteConfirm.endTime,
        overwriteConfirm.isPublic,
        overwriteConfirm.volumeDb,
        true // overwrite = true
      );
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
      setReclipAlias(alias); // Store the original alias
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
    // Normalize: remove extension, strip invalid chars (allow spaces)
    const rawName = share.suggestedAlias || share.originalName.replace(/\.(mp3|wav)$/i, '');
    setAcceptAlias(rawName.replace(/[^a-zA-Z0-9_\- ]/g, ''));
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
            <div className="flex gap-3 items-center flex-wrap">
              <input
                type="text"
                placeholder="Search sounds..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full sm:w-48 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
              />
              {/* Selection Actions */}
              {selectedSounds.size > 0 && (
                <div className="flex items-center gap-2 bg-blue-900/40 border border-blue-600 rounded px-3 py-1.5">
                  <span className="text-sm text-blue-300">
                    {selectedSounds.size} selected
                  </span>
                  <button
                    onClick={() => setShowPlaylistModal(true)}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium transition-colors"
                  >
                    Add to Playlists
                  </button>
                  <button
                    onClick={clearSelection}
                    className="px-2 py-1 text-gray-400 hover:text-white text-sm transition-colors"
                    title="Clear selection"
                  >
                    ✕
                  </button>
                </div>
              )}
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
            {soundsData?.sounds && soundsData.sounds.length > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-gray-600 text-white">
                {soundsData.sounds.length}
              </span>
            )}
          </button>
          <button
            onClick={() => handleTabChange('unfinished')}
            className={`px-4 py-2 rounded-t-lg font-medium transition-colors relative ${
              activeTab === 'unfinished'
                ? 'bg-gray-800 text-white border-b-2 border-orange-500'
                : 'bg-gray-800/50 text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            Unfinished
            {unfinishedData && unfinishedData.count > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-yellow-600 text-white">
                {unfinishedData.count}
              </span>
            )}
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
          {isAdmin && (
            <button
              onClick={() => handleTabChange('server-menus')}
              className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${
                activeTab === 'server-menus'
                  ? 'bg-gray-800 text-white border-b-2 border-orange-500'
                  : 'bg-gray-800/50 text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              🔊 Server Menus
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 md:px-8 py-4 h-[calc(100vh-130px)] flex flex-col gap-4">
        {/* Sound Menus Tab */}
        {activeTab === 'menus' && (
          <SoundMenuEditor userSounds={soundsData?.sounds || []} />
        )}

        {/* Server Menus Tab (Admin Only) */}
        {activeTab === 'server-menus' && isAdmin && (
          <div className="flex flex-col gap-4">
            <div className="bg-blue-900/30 border border-blue-600 rounded-lg p-4 flex-shrink-0">
              <h2 className="text-lg font-semibold text-blue-400 mb-2">🔊 Server Sound Menus</h2>
              <p className="text-gray-300 text-sm">
                Configure server-wide sound menus that <strong>all players</strong> see when they press{' '}
                <kbd className="bg-gray-700 px-1.5 py-0.5 rounded text-orange-400 text-xs">V</kbd> (or{' '}
                <kbd className="bg-gray-700 px-1.5 py-0.5 rounded text-orange-400 text-xs">8</kbd> in alt menu) in-game.
                These are separate from players' personal menus.
              </p>
            </div>
            <SoundMenuEditor userSounds={soundsData?.sounds || []} mode="server" />
          </div>
        )}

        {/* Unfinished Sounds Tab */}
        {activeTab === 'unfinished' && (
          <div className="flex-1 flex flex-col gap-4">
            <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-4 flex-shrink-0">
              <h2 className="text-lg font-semibold text-yellow-400 mb-2">📦 Unfinished Uploads</h2>
              <p className="text-gray-300 text-sm">
                These sounds have been uploaded but not yet added to your library.
                You can edit the alias, use the <strong>Edit</strong> button to clip/trim the audio,
                or <strong>Save</strong> directly to add them as-is. Only files under 10MB can be saved directly.
              </p>
            </div>

            {unfinishedLoading ? (
              <div className="flex items-center justify-center h-32">
                <div className="text-gray-400">Loading unfinished sounds...</div>
              </div>
            ) : !unfinishedData?.sounds || unfinishedData.sounds.length === 0 ? (
              <div className="bg-gray-800 rounded-lg p-8 text-center flex-1 flex flex-col items-center justify-center">
                <div className="text-4xl mb-4">📭</div>
                <h2 className="text-xl font-semibold mb-2">No Unfinished Sounds</h2>
                <p className="text-gray-400 mb-4">
                  Upload multiple files at once and they'll appear here for you to review before adding to your library.
                </p>
                <button
                  onClick={() => setUploadModal(true)}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors"
                >
                  Upload Sounds
                </button>
              </div>
            ) : (
              <div className="bg-gray-800 rounded-lg flex-1 overflow-hidden flex flex-col">
                <div className="overflow-y-auto flex-1 divide-y divide-gray-700">
                  {unfinishedData.sounds.map((sound: UnfinishedSound) => (
                    <div key={sound.tempId} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                      {/* Sound Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {editingUnfinishedAlias === sound.tempId ? (
                            <div className="flex-1">
                              <input
                                type="text"
                                value={newUnfinishedAlias}
                                onChange={(e) => {
                                  setNewUnfinishedAlias(e.target.value.replace(/[^a-zA-Z0-9_\- ]/g, ''));
                                  setUnfinishedRenameError(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleUnfinishedRename(sound.tempId);
                                  if (e.key === 'Escape') {
                                    setEditingUnfinishedAlias(null);
                                    setUnfinishedRenameError(null);
                                  }
                                }}
                                onBlur={() => handleUnfinishedRename(sound.tempId)}
                                autoFocus
                                maxLength={32}
                                className={`bg-gray-700 border rounded px-2 py-1 text-white w-full max-w-xs ${unfinishedRenameError ? 'border-red-500' : 'border-blue-500'}`}
                              />
                              {unfinishedRenameError && <div className="text-xs text-red-400 mt-1">{unfinishedRenameError}</div>}
                            </div>
                          ) : (
                            <div
                              className="font-medium truncate cursor-pointer hover:text-blue-400"
                              onClick={() => startUnfinishedEdit(sound)}
                              title="Click to rename"
                            >
                              {sound.alias}
                            </div>
                          )}
                        </div>
                        <div className="text-sm text-gray-400 flex items-center gap-2 flex-wrap">
                          <span title="Original filename">{sound.originalName}</span>
                          <span>•</span>
                          <span>{formatFileSize(sound.fileSize)}</span>
                          {sound.durationSeconds && (
                            <>
                              <span>•</span>
                              <span>{formatDuration(sound.durationSeconds)}</span>
                            </>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Uploaded {formatRelativeTime(sound.createdAt)}
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          onClick={() => toggleUnfinishedPlay(sound.tempId)}
                          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                            playingUnfinishedId === sound.tempId
                              ? 'bg-orange-600 hover:bg-orange-500'
                              : 'bg-gray-600 hover:bg-gray-500'
                          }`}
                          title={playingUnfinishedId === sound.tempId ? 'Stop' : 'Play preview'}
                        >
                          {playingUnfinishedId === sound.tempId ? '⏹️' : '▶️'}
                        </button>
                        <button
                          onClick={() => handleEditUnfinished(sound.tempId)}
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium transition-colors flex items-center gap-1"
                          title="Open clip editor to trim audio"
                        >
                          ✂️ Edit
                        </button>
                        <button
                          onClick={() => {
                            setSavingUnfinished(sound.tempId);
                            saveUnfinishedMutation.mutate(sound.tempId);
                          }}
                          disabled={savingUnfinished === sound.tempId || saveUnfinishedMutation.isPending}
                          className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors flex items-center gap-1"
                          title="Save directly to library (file must be under 2MB)"
                        >
                          {savingUnfinished === sound.tempId ? '...' : '💾'} Save
                        </button>
                        <button
                          onClick={() => deleteUnfinishedMutation.mutate(sound.tempId)}
                          disabled={deleteUnfinishedMutation.isPending}
                          className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
                          title="Delete this upload"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Library Tab Content */}
        {activeTab === 'library' && (
          <>
        {/* Quick Command Settings Panel */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg flex-shrink-0 mb-4">
          <button
            onClick={() => setQuickCmdSettingsOpen(!quickCmdSettingsOpen)}
            className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-700/50 transition-colors rounded-lg"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">⚡</span>
              <span className="font-medium">Quick Command Settings</span>
              {quickCmdData?.prefix && (
                <span className="text-sm text-gray-400">
                  (prefix: <span className="text-cyan-400 font-mono">{formatPrefixDisplay(quickCmdData.prefix)}</span>)
                </span>
              )}
            </div>
            <span className={`text-gray-400 transition-transform ${quickCmdSettingsOpen ? 'rotate-180' : ''}`}>
              ▼
            </span>
          </button>

          {quickCmdSettingsOpen && (
            <div className="px-4 pb-4 border-t border-gray-700">
              <div className="mt-4 space-y-4">
                {/* Prefix Setting */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Quick Command Prefix
                  </label>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <input
                        type="text"
                        value={quickCmdPrefix}
                        onChange={(e) => {
                          const val = e.target.value;
                          // Allow trailing space but not leading/middle whitespace
                          if (val.length <= 4 && !/^\s/.test(val) && !/\s[^\s]/.test(val)) {
                            setQuickCmdPrefix(val);
                            setQuickCmdPrefixError(null);
                          }
                        }}
                        onBlur={handlePrefixSave}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handlePrefixSave();
                        }}
                        maxLength={4}
                        className={`w-24 bg-gray-700 border rounded px-3 py-2 text-white font-mono text-center focus:outline-none ${
                          quickCmdPrefixError ? 'border-red-500' : 'border-gray-600 focus:border-cyan-500'
                        }`}
                        placeholder="@"
                      />
                      {quickCmdPrefix.endsWith(' ') && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-cyan-400" title="Includes trailing space">
                          ␣
                        </span>
                      )}
                    </div>
                    {updatePrefixMutation.isPending && (
                      <span className="text-sm text-gray-400">Saving...</span>
                    )}
                    {quickCmdPrefixError && (
                      <span className="text-sm text-red-400">{quickCmdPrefixError}</span>
                    )}
                  </div>
                </div>

                {/* Instructions */}
                <div className="bg-gray-900/50 rounded-lg p-3 text-sm">
                  <p className="text-gray-300 mb-2">
                    <span className="text-cyan-400 font-semibold">How it works:</span> Type your prefix + alias in chat to play a sound.
                  </p>
                  <p className="text-gray-400">
                    Example: <span className="text-cyan-400 font-mono">{quickCmdPrefix || '@'}lol</span> plays your sound
                    {quickCmdData?.aliases?.length ? ' and shows your custom chat text' : ''}
                  </p>
                  <div className="mt-2 pt-2 border-t border-gray-700">
                    <p className="text-yellow-400 text-xs">
                      ⚠️ Blocked prefixes: <span className="font-mono">!</span> (admin commands), <span className="font-mono">/</span> and <span className="font-mono">\</span> (console)
                    </p>
                  </div>
                </div>

                {/* Stats */}
                {quickCmdData?.aliases && quickCmdData.aliases.length > 0 && (
                  <div className="text-sm text-gray-400">
                    You have <span className="text-cyan-400 font-medium">{quickCmdData.aliases.length}</span> quick command{quickCmdData.aliases.length !== 1 ? 's' : ''} configured.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

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
                <div key={sound.id} className={`p-4 ${selectedSounds.has(sound.alias) ? 'bg-blue-900/20' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <input
                      type="checkbox"
                      checked={selectedSounds.has(sound.alias)}
                      onChange={() => toggleSoundSelection(sound.alias)}
                      className="w-4 h-4 mt-1 rounded bg-gray-700 border-gray-600 text-orange-600 focus:ring-orange-500 cursor-pointer flex-shrink-0"
                    />
                    <span className="text-sm text-gray-500 w-6 flex-shrink-0">{page * pageSize + index + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <AudioPlayer alias={sound.alias} />
                        {editingAlias === sound.alias ? (
                          <div className="flex-1">
                            <input
                              type="text"
                              value={newAlias}
                              onChange={(e) => {
                                setNewAlias(e.target.value.replace(/[^a-zA-Z0-9_\- ]/g, ''));
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
                        {/* Quick Command for mobile */}
                        {(() => {
                          const quickCmd = quickCmdMap.get(sound.alias);
                          return quickCmd ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openQuickCmdEditor(sound.alias);
                              }}
                              className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-cyan-700 text-white hover:bg-cyan-600"
                              title={`Type "${quickCmdData?.prefix || '@'}${quickCmd.alias}" in chat`}
                            >
                              ⚡{quickCmd.alias}
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openQuickCmdEditor(sound.alias);
                              }}
                              className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-gray-700 text-gray-400 hover:bg-gray-600"
                              title="Add quick command"
                            >
                              ⚡+
                            </button>
                          );
                        })()}
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
                        {/* Add to Playlist button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSingleAddSound(sound.alias);
                          }}
                          className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-600 text-white hover:bg-blue-500"
                          title="Add to playlist"
                        >
                          ➕
                        </button>
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
                      <th className="px-2 py-2 w-10">
                        <input
                          type="checkbox"
                          checked={userSounds.length > 0 && userSounds.every((s: UserSound) => selectedSounds.has(s.alias))}
                          onChange={() => toggleSelectAllOnPage(userSounds)}
                          className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-orange-600 focus:ring-orange-500 cursor-pointer"
                          title="Select all on this page"
                        />
                      </th>
                      <th className="px-2 py-2 w-12">#</th>
                      <th className="px-4 py-2 w-16">Play</th>
                      <SortableHeader label="Alias" field="alias" currentSort={sortField} currentDirection={sortDirection} onSort={handleSort} />
                      <th className="px-4 py-2 w-20" title="Quick command alias">Quick Cmd</th>
                      <th className="px-4 py-2 w-28" title="Chat text replacement">Chat Text</th>
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
                    <tr key={sound.id} className={`hover:bg-gray-700/30 ${selectedSounds.has(sound.alias) ? 'bg-blue-900/20' : ''}`}>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={selectedSounds.has(sound.alias)}
                          onChange={() => toggleSoundSelection(sound.alias)}
                          className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-orange-600 focus:ring-orange-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-2 py-2 text-sm text-gray-500">{page * pageSize + index + 1}</td>
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
                                setNewAlias(e.target.value.replace(/[^a-zA-Z0-9_\- ]/g, ''));
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
                      {/* Quick Command Alias */}
                      <td className="px-4 py-2">
                        {(() => {
                          const quickCmd = quickCmdMap.get(sound.alias);
                          return quickCmd ? (
                            <button
                              onClick={() => openQuickCmdEditor(sound.alias)}
                              className="text-cyan-400 hover:text-cyan-300 font-mono text-sm cursor-pointer"
                              title={`Type "${quickCmdData?.prefix || '@'}${quickCmd.alias}" in chat`}
                            >
                              ({quickCmd.alias})
                            </button>
                          ) : (
                            <button
                              onClick={() => openQuickCmdEditor(sound.alias)}
                              className="text-gray-500 hover:text-gray-400 cursor-pointer"
                              title="Add quick command"
                            >
                              (+)
                            </button>
                          );
                        })()}
                      </td>
                      {/* Chat Text */}
                      <td className="px-4 py-2">
                        {(() => {
                          const quickCmd = quickCmdMap.get(sound.alias);
                          if (!quickCmd) {
                            return <span className="text-gray-700">—</span>;
                          }
                          return quickCmd.chatText ? (
                            <button
                              onClick={() => openQuickCmdEditor(sound.alias)}
                              className="text-gray-400 hover:text-gray-300 text-sm truncate max-w-[100px] block cursor-pointer"
                              title={quickCmd.chatText}
                            >
                              "{quickCmd.chatText}"
                            </button>
                          ) : (
                            <button
                              onClick={() => openQuickCmdEditor(sound.alias)}
                              className="text-gray-600 hover:text-gray-500 cursor-pointer"
                              title="Add chat text"
                            >
                              —
                            </button>
                          );
                        })()}
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
                          {/* Add to Playlist Button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSingleAddSound(sound.alias);
                            }}
                            className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-gray-700 rounded transition-colors"
                            title="Add to playlist"
                          >
                            ➕
                          </button>
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
              onChange={(e) => setAcceptAlias(e.target.value.replace(/[^a-zA-Z0-9_\- ]/g, ''))}
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
                initialAlias={reclipAlias || undefined}
              />
            </div>
          ) : (
            /* Upload Form Mode */
            <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full">
              <h3 className="text-lg font-semibold mb-4">Add New Sound</h3>

              {/* Mode Toggle - now with 3 options */}
              <div className="flex mb-4 bg-gray-700 rounded-lg p-1">
                <button
                  onClick={() => setUploadMode('file')}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    uploadMode === 'file' ? 'bg-orange-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  Single File
                </button>
                <button
                  onClick={() => setUploadMode('multi')}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    uploadMode === 'multi' ? 'bg-orange-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  Multiple Files
                </button>
                <button
                  onClick={() => setUploadMode('url')}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    uploadMode === 'url' ? 'bg-orange-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  From URL
                </button>
              </div>

              <div className="space-y-4">
                {/* Single File Upload */}
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

                {/* Multi-File Upload */}
                {uploadMode === 'multi' && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">
                      Audio Files (MP3 or WAV, max 10MB each)
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".mp3,.wav,audio/mpeg,audio/wav,audio/wave"
                      multiple
                      onChange={handleMultiFileSelect}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white file:mr-4 file:py-1 file:px-4 file:rounded file:border-0 file:bg-orange-600 file:text-white file:cursor-pointer hover:file:bg-orange-500"
                    />
                    {uploadFiles.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-sm text-gray-400">
                          {uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''} selected
                          ({(uploadFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(1)} MB total)
                        </p>
                        <div className="max-h-32 overflow-y-auto text-xs text-gray-500 space-y-0.5">
                          {uploadFiles.map((f, i) => (
                            <div key={i} className="truncate">
                              • {f.name} ({(f.size / 1024 / 1024).toFixed(1)} MB)
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="mt-2 p-3 bg-yellow-900/30 border border-yellow-600/50 rounded text-sm">
                      <p className="text-yellow-400 font-medium">📦 Batch Upload Mode</p>
                      <p className="text-yellow-300/80 text-xs mt-1">
                        Files will go to the <strong>Unfinished</strong> tab where you can:
                      </p>
                      <ul className="text-yellow-300/80 text-xs mt-1 ml-3 list-disc">
                        <li>Edit aliases before saving</li>
                        <li>Clip/trim each sound individually</li>
                        <li>Save directly if under 10MB</li>
                      </ul>
                    </div>
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
                <p className="text-red-400 text-sm mt-3 whitespace-pre-wrap">{uploadError}</p>
              )}

              {isMultiUploading && multiUploadProgress && (
                <div className="mt-3">
                  <div className="flex justify-between text-sm text-gray-400 mb-1">
                    <span>Uploading...</span>
                    <span>{multiUploadProgress.uploaded}/{multiUploadProgress.total}</span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-orange-600 h-2 rounded-full transition-all"
                      style={{ width: `${(multiUploadProgress.uploaded / multiUploadProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={resetUploadModal}
                  disabled={isUploading || isMultiUploading}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded transition-colors"
                >
                  Cancel
                </button>
                {uploadMode === 'multi' ? (
                  <button
                    onClick={handleMultiFileUpload}
                    disabled={isMultiUploading || uploadFiles.length === 0}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                  >
                    {isMultiUploading ? 'Uploading...' : `Upload ${uploadFiles.length} File${uploadFiles.length !== 1 ? 's' : ''}`}
                  </button>
                ) : (
                  <button
                    onClick={handleTempUpload}
                    disabled={isUploading || (uploadMode === 'file' ? !uploadFile : !uploadUrl)}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                  >
                    {isUploading ? 'Uploading...' : 'Continue to Editor'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Unfinished Sound Clip Editor Modal */}
      {editingUnfinishedSound && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="max-w-3xl w-full my-8">
            <SoundClipEditor
              tempId={editingUnfinishedSound.tempId}
              durationSeconds={editingUnfinishedSound.durationSeconds}
              maxClipDuration={editingUnfinishedSound.maxClipDuration}
              originalName={editingUnfinishedSound.originalName}
              onSave={handleSaveUnfinishedClip}
              onCancel={() => {
                setEditingUnfinishedSound(null);
                setIsSavingClip(false);
                setSaveClipError('');
              }}
              isSaving={isSavingClip}
              saveError={saveClipError}
              isReclip={false}
              existingAliases={[
                ...(soundsData?.sounds?.map((s: UserSound) => s.alias) || []),
                ...(unfinishedData?.sounds?.map((s: UnfinishedSound) => s.alias) || []),
              ]}
              initialAlias={editingUnfinishedSound.alias}
              streamUrl={sounds.getUnfinishedStreamUrl(editingUnfinishedSound.tempId)}
            />
          </div>
        </div>
      )}

      {/* Overwrite Confirmation Modal */}
      {overwriteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4 text-orange-400">Overwrite Existing Sound?</h3>
            <p className="text-gray-300 mb-4">
              You already have a sound named{' '}
              <span className="text-blue-400 font-medium">"{overwriteConfirm.alias}"</span>.
            </p>
            <div className="bg-yellow-900/30 border border-yellow-600/50 rounded p-3 mb-4">
              <p className="text-yellow-400 text-sm">⚠️ Overwriting will:</p>
              <ul className="text-yellow-300 text-sm mt-2 space-y-1 ml-4 list-disc">
                <li>Replace the existing sound with this new clip</li>
                <li>Remove it from any playlists it was in</li>
                <li>This action cannot be undone</li>
              </ul>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setOverwriteConfirm(null)}
                disabled={isSavingClip}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleOverwriteConfirm}
                disabled={isSavingClip}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {isSavingClip ? 'Saving...' : 'Overwrite'}
              </button>
            </div>
          </div>
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

      {/* Batch Add to Playlists Modal */}
      {showPlaylistModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full max-h-[80vh] flex flex-col">
            <h3 className="text-lg font-semibold mb-4">Add to Playlists</h3>

            {batchAddResults ? (
              // Show results after batch add
              <div className="flex-1">
                <div className="bg-green-900/30 border border-green-600 rounded-lg p-4 mb-4">
                  <p className="text-green-400 font-medium mb-2">Done!</p>
                  <ul className="text-gray-300 text-sm space-y-1">
                    <li>✓ {batchAddResults.added} sound{batchAddResults.added !== 1 ? 's' : ''} added to playlist{selectedPlaylists.size !== 1 ? 's' : ''}</li>
                    {batchAddResults.skipped > 0 && (
                      <li className="text-gray-400">⊘ {batchAddResults.skipped} skipped (already in playlist)</li>
                    )}
                  </ul>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={closeBatchAddModal}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              // Show playlist selection
              <>
                <p className="text-gray-400 text-sm mb-4">
                  Adding {selectedSounds.size} sound{selectedSounds.size !== 1 ? 's' : ''} to selected playlists.
                  {' '}Sounds already in a playlist will be skipped.
                </p>

                {userPlaylists.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-8">
                    <div className="text-4xl mb-3">📁</div>
                    <p className="text-gray-400 text-center">
                      You don't have any playlists yet.
                    </p>
                    <button
                      onClick={() => {
                        closeBatchAddModal();
                        navigate('/sounds/playlists');
                      }}
                      className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded font-medium transition-colors"
                    >
                      Create a Playlist
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex-1 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700 mb-4">
                      {userPlaylists.map((playlist: { name: string; soundCount?: number }) => (
                        <label
                          key={playlist.name}
                          className="flex items-center gap-3 p-3 hover:bg-gray-700/50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedPlaylists.has(playlist.name)}
                            onChange={() => togglePlaylistSelection(playlist.name)}
                            className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="flex-1 font-medium">{playlist.name}</span>
                          {playlist.soundCount !== undefined && (
                            <span className="text-sm text-gray-500">{playlist.soundCount} sounds</span>
                          )}
                        </label>
                      ))}
                    </div>

                    <div className="flex justify-end gap-3">
                      <button
                        onClick={closeBatchAddModal}
                        disabled={isAddingToPlaylists}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleBatchAddToPlaylists}
                        disabled={isAddingToPlaylists || selectedPlaylists.size === 0}
                        className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                      >
                        {isAddingToPlaylists
                          ? 'Adding...'
                          : `Add to ${selectedPlaylists.size} Playlist${selectedPlaylists.size !== 1 ? 's' : ''}`
                        }
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Single Sound Add to Playlist Modal */}
      {singleAddSound && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full max-h-[80vh] flex flex-col">
            <h3 className="text-lg font-semibold mb-2">Add to Playlist</h3>
            <p className="text-gray-400 text-sm mb-4">
              Adding "<span className="text-white font-medium">{singleAddSound}</span>" to selected playlists.
            </p>

            {singleAddResults ? (
              // Show results after add
              <div className="flex-1">
                <div className="bg-green-900/30 border border-green-600 rounded-lg p-4 mb-4">
                  <p className="text-green-400 font-medium mb-2">Done!</p>
                  <ul className="text-gray-300 text-sm space-y-1">
                    <li>✓ Added to {singleAddResults.added} playlist{singleAddResults.added !== 1 ? 's' : ''}</li>
                    {singleAddResults.skipped > 0 && (
                      <li className="text-gray-400">⊘ {singleAddResults.skipped} skipped (already in playlist)</li>
                    )}
                  </ul>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={closeSingleAddModal}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              // Show playlist selection
              <>
                {userPlaylists.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-8">
                    <div className="text-4xl mb-3">📁</div>
                    <p className="text-gray-400 text-center">
                      You don't have any playlists yet.
                    </p>
                    <button
                      onClick={() => {
                        closeSingleAddModal();
                        navigate('/sounds/playlists');
                      }}
                      className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded font-medium transition-colors"
                    >
                      Create a Playlist
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex-1 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700 mb-4 max-h-[50vh]">
                      {userPlaylists.map((playlist: { name: string; soundCount?: number }) => (
                        <label
                          key={playlist.name}
                          className="flex items-center gap-3 p-3 hover:bg-gray-700/50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={singleAddPlaylists.has(playlist.name)}
                            onChange={() => toggleSingleAddPlaylist(playlist.name)}
                            className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="flex-1 font-medium">{playlist.name}</span>
                          {playlist.soundCount !== undefined && (
                            <span className="text-sm text-gray-500">{playlist.soundCount} sounds</span>
                          )}
                        </label>
                      ))}
                    </div>

                    <div className="flex justify-end gap-3">
                      <button
                        onClick={closeSingleAddModal}
                        disabled={isSingleAdding}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSingleAddToPlaylists}
                        disabled={isSingleAdding || singleAddPlaylists.size === 0}
                        className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                      >
                        {isSingleAdding
                          ? 'Adding...'
                          : `Add to ${singleAddPlaylists.size} Playlist${singleAddPlaylists.size !== 1 ? 's' : ''}`
                        }
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Quick Command Editor Modal */}
      {quickCmdModalData && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">
                Quick Command for "{quickCmdModalData.soundAlias}"
              </h3>
              <button
                onClick={() => setQuickCmdModalData(null)}
                className="text-gray-400 hover:text-white text-xl"
              >
                ×
              </button>
            </div>

            <div className="space-y-4">
              {/* Quick Alias Input */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Quick Alias
                </label>
                <input
                  type="text"
                  value={quickCmdModalData.quickAlias}
                  onChange={(e) => {
                    const val = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
                    setQuickCmdModalData({ ...quickCmdModalData, quickAlias: val });
                  }}
                  placeholder="e.g., lol"
                  maxLength={16}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-cyan-500 font-mono"
                />
                <p className="text-sm text-gray-400 mt-1">
                  {quickCmdModalData.quickAlias ? (
                    <>
                      Type <span className="text-cyan-400 font-mono">{quickCmdData?.prefix || '@'}{quickCmdModalData.quickAlias}</span> in chat to trigger
                    </>
                  ) : (
                    'Leave empty to remove quick command'
                  )}
                </p>
              </div>

              {/* Chat Text Input */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Chat Text <span className="text-gray-500 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={quickCmdModalData.chatText}
                  onChange={(e) => setQuickCmdModalData({ ...quickCmdModalData, chatText: e.target.value })}
                  placeholder="LOLOL"
                  maxLength={128}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-cyan-500"
                />
                <p className="text-sm text-gray-400 mt-1">
                  {quickCmdModalData.chatText ? (
                    <>Shows "<span className="text-gray-300">{quickCmdModalData.chatText}</span>" in chat</>
                  ) : (
                    'Leave empty for sound only (no chat message)'
                  )}
                </p>
              </div>

              {/* Error Display */}
              {(setQuickAliasMutation.isError || removeQuickAliasMutation.isError) && (
                <p className="text-red-400 text-sm">
                  {(setQuickAliasMutation.error as Error)?.message || (removeQuickAliasMutation.error as Error)?.message || 'An error occurred'}
                </p>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex justify-between gap-3 mt-6">
              <div>
                {quickCmdMap.has(quickCmdModalData.soundAlias) && (
                  <button
                    onClick={handleRemoveQuickCmd}
                    disabled={removeQuickAliasMutation.isPending || setQuickAliasMutation.isPending}
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                  >
                    {removeQuickAliasMutation.isPending ? 'Removing...' : 'Remove'}
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setQuickCmdModalData(null)}
                  disabled={setQuickAliasMutation.isPending || removeQuickAliasMutation.isPending}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveQuickCmd}
                  disabled={setQuickAliasMutation.isPending || removeQuickAliasMutation.isPending}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {setQuickAliasMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
