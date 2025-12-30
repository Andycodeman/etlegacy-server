const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3000/api';

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function apiRequest<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const token = localStorage.getItem('accessToken');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    // Try to refresh token
    const refreshed = await refreshToken();
    if (refreshed) {
      return apiRequest(endpoint, options);
    }
    // Redirect to login
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    window.location.href = '/login';
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

async function refreshToken(): Promise<boolean> {
  const refreshTokenValue = localStorage.getItem('refreshToken');
  if (!refreshTokenValue) return false;

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshTokenValue }),
    });

    if (!response.ok) return false;

    const data = await response.json();
    localStorage.setItem('accessToken', data.accessToken);
    return true;
  } catch {
    return false;
  }
}

// Helper for handling 401 with token refresh for custom fetch calls
async function handleUnauthorized<T>(
  makeRequest: () => Promise<Response>,
  parseResponse: (res: Response) => Promise<T>
): Promise<T> {
  let response = await makeRequest();

  if (response.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      // Retry the request with new token
      response = await makeRequest();
    } else {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return parseResponse(response);
}

// Auth
export const auth = {
  login: (email: string, password: string) =>
    apiRequest<{ user: User; accessToken: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  register: (email: string, password: string, displayName: string) =>
    apiRequest<{ user: User; accessToken: string; refreshToken: string }>('/auth/register', {
      method: 'POST',
      body: { email, password, displayName },
    }),
  me: () => apiRequest<User>('/auth/me'),
  logout: () => {
    const refreshToken = localStorage.getItem('refreshToken');
    return apiRequest('/auth/logout', { method: 'POST', body: { refreshToken } });
  },
};

// Server
export const server = {
  status: () => apiRequest<ServerStatus>('/server/status'),
  restart: () => apiRequest('/server/restart', { method: 'POST' }),
  command: (command: string) => apiRequest('/server/command', { method: 'POST', body: { command } }),
  changeMap: (map: string) => apiRequest('/server/map', { method: 'POST', body: { map } }),
};

// Server Admin (admin only)
export const serverAdmin = {
  kick: (slot: number, reason?: string) =>
    apiRequest<{ success: boolean; message: string; playerName: string }>(`/server-admin/kick/${slot}`, {
      method: 'POST',
      body: { reason },
    }),
  ban: (slot: number, reason?: string, duration?: number) =>
    apiRequest<{ success: boolean; message: string; playerName: string; duration: number | string }>(`/server-admin/ban/${slot}`, {
      method: 'POST',
      body: { reason, duration },
    }),
  command: (command: string) =>
    apiRequest<{ success: boolean; response: string; error?: string }>('/server-admin/command', {
      method: 'POST',
      body: { command },
    }),
  gameInfo: () =>
    apiRequest<GameInfo>('/server-admin/game-info'),
  maps: () =>
    apiRequest<{ maps: string[] }>('/server-admin/maps'),
};

// Players
export const players = {
  list: () => apiRequest<Player[]>('/players'),
  stats: (limit = 50, offset = 0, search = '', sortBy = 'lastSeen', sortOrder: 'asc' | 'desc' = 'desc') =>
    apiRequest<{ players: PlayerStats[]; total: number }>(
      `/players/stats?limit=${limit}&offset=${offset}&sortBy=${sortBy}&sortOrder=${sortOrder}${search ? `&search=${encodeURIComponent(search)}` : ''}`
    ),
  get: (guid: string) => apiRequest<PlayerStats>(`/players/${guid}`),
  matchups: (guid: string, opponent?: string, weapon?: string) => {
    const params = new URLSearchParams();
    if (opponent) params.set('opponent', opponent);
    if (weapon) params.set('weapon', weapon);
    const query = params.toString();
    return apiRequest<PlayerMatchupsResponse>(`/players/${guid}/matchups${query ? `?${query}` : ''}`);
  },
  weapons: (guid: string) => apiRequest<WeaponStats[]>(`/players/${guid}/weapons`),
  kick: (slot: number, reason?: string) =>
    apiRequest(`/players/${slot}/kick`, { method: 'POST', body: { reason } }),
};

// Users (admin)
export const users = {
  list: () => apiRequest<{ users: AdminUser[] }>('/users'),
  get: (id: number) => apiRequest<AdminUser>(`/users/${id}`),
  create: (data: CreateUserRequest) => apiRequest<AdminUser>('/users', { method: 'POST', body: data }),
  update: (id: number, data: UpdateUserRequest) => apiRequest<AdminUser>(`/users/${id}`, { method: 'PUT', body: data }),
  delete: (id: number) => apiRequest<{ success: boolean }>(`/users/${id}`, { method: 'DELETE' }),
};

// Console
export const console = {
  recent: (count = 100) => apiRequest<{ lines: ConsoleLine[]; logPath: string }>(`/console/recent?count=${count}`),
  messages: (count = 50) => apiRequest<{ messages: PlayerMessage[] }>(`/console/messages?count=${count}`),
  say: (message: string) => apiRequest<{ success: boolean; message: string; error?: string }>('/console/say', { method: 'POST', body: { message } }),
  dm: (slot: number, message: string) => apiRequest<{ success: boolean; targetSlot: number; targetName: string; message: string; hint: string }>('/console/dm', { method: 'POST', body: { slot, message } }),
  players: () => apiRequest<{ players: ConsolePlayer[] }>('/console/players'),
  command: (command: string) => apiRequest<{ success: boolean; response: string; error?: string }>('/console/command', { method: 'POST', body: { command } }),
};

// Config
export const config = {
  // Live server CVARs
  getCvars: () => apiRequest<{ cvars: Record<string, string>; allowed: string[] }>('/config/cvars'),
  setCvars: (cvars: Record<string, string>) =>
    apiRequest('/config/cvars', { method: 'POST', body: { cvars } }),

  // Config templates (database)
  getTemplates: () => apiRequest<ConfigTemplate[]>('/config/templates'),
  getTemplate: (id: number) => apiRequest<ConfigTemplateDetail>(`/config/templates/${id}`),
  saveTemplate: (name: string, cvars: Record<string, string>) =>
    apiRequest<ConfigTemplateDetail>('/config/templates', { method: 'POST', body: { name, cvars } }),
  applyTemplate: (id: number) =>
    apiRequest(`/config/templates/${id}/apply`, { method: 'POST' }),
  deleteTemplate: (id: number) =>
    apiRequest(`/config/templates/${id}`, { method: 'DELETE' }),
  saveTemplateAsMapConfig: (id: number, mapName: string) =>
    apiRequest(`/config/templates/${id}/save-as-mapconfig`, { method: 'POST', body: { mapName } }),

  // Map config files (disk)
  getMapFiles: () => apiRequest<string[]>('/config/mapfiles'),
  getMapFile: (mapName: string) => apiRequest<MapFileContent>(`/config/mapfiles/${encodeURIComponent(mapName)}`),
  saveMapFile: (mapName: string, cvars: Record<string, string>) =>
    apiRequest(`/config/mapfiles/${encodeURIComponent(mapName)}`, { method: 'PUT', body: { cvars } }),
  deleteMapFile: (mapName: string) =>
    apiRequest(`/config/mapfiles/${encodeURIComponent(mapName)}`, { method: 'DELETE' }),

  // Legacy (backwards compat)
  getSnapshots: () => apiRequest<ConfigTemplate[]>('/config/snapshots'),
  applySnapshot: (id: number) =>
    apiRequest(`/config/snapshots/${id}/apply`, { method: 'POST' }),
};

// Types
export interface User {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'moderator' | 'user';
}

export interface ServerStatus {
  online: boolean;
  map?: string;
  hostname?: string;
  players?: Player[];
  maxPlayers?: number;
  wsClients?: number;
}

export interface Player {
  slot: number;
  name: string;
  score: number;
  ping: number;
}

export interface PlayerStats {
  id: number;
  guid: string;
  name: string;
  displayName?: string;  // Original name with ET color codes
  kills: number;
  deaths: number;
  botKills: number;
  botDeaths: number;
  suicides: number;
  playtimeSeconds: number;
  lastSeen: string;
  firstSeen: string;
}

export interface OpponentMatchup {
  opponentGuid: string;
  opponentName: string;
  opponentDisplayName?: string;  // Name with ET color codes
  opponentIsBot: boolean;
  totalKills: number;
  totalDeaths: number;
  totalTeamKills: number;
  totalTeamDeaths: number;
  weapons: WeaponMatchup[];
}

export interface WeaponMatchup {
  weapon: string;
  kills: number;
  deaths: number;
  teamKills: number;
  teamDeaths: number;
}

export interface PlayerMatchupsResponse {
  guid: string;
  matchups: OpponentMatchup[];
  rawMatchups: RawMatchup[];
}

export interface RawMatchup {
  id: number;
  playerGuid: string;
  opponentGuid: string;
  opponentName: string;
  opponentIsBot: boolean;
  weapon: string;
  kills: number;
  deaths: number;
  teamKills: number;
  teamDeaths: number;
}

export interface WeaponStats {
  weapon: string;
  kills: number;
  deaths: number;
  teamKills: number;
  teamDeaths: number;
}

export interface ConfigTemplate {
  id: number;
  name: string;
  createdAt: string;
  createdBy?: string;
}

export interface ConfigTemplateDetail extends ConfigTemplate {
  configJson: Record<string, string>;
}

export interface MapFileContent {
  mapName: string;
  cvars: Record<string, string>;
  raw: string;
}

// Legacy alias
export type ConfigSnapshot = ConfigTemplate;

// Console types
export interface ConsoleLine {
  timestamp: string;
  raw: string;
  type: 'say' | 'sayteam' | 'kill' | 'connect' | 'disconnect' | 'system' | 'unknown';
  player?: string;
  message?: string;
}

export interface PlayerMessage {
  timestamp: string;
  slot: number;
  name: string;
  message: string;
  isReply?: boolean;
}

export interface ConsolePlayer {
  slot: number;
  name: string;
  score: number;
  ping: number;
  isBot: boolean;
}

// Admin user types
export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'moderator' | 'user';
  createdAt: string;
  updatedAt?: string;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  displayName: string;
  role: 'admin' | 'moderator' | 'user';
}

export interface UpdateUserRequest {
  email?: string;
  displayName?: string;
  role?: 'admin' | 'moderator' | 'user';
  password?: string;
  adminLevel?: number;
}

// Game info types
export interface GameInfo {
  timelimit?: string;
  gameState?: string;
  currentRound?: string;
  axisScore?: number;
  alliesScore?: number;
  timeRemaining?: number; // seconds remaining
  serverTime?: number; // seconds elapsed since map start
}

// Logs types
export interface LogEntry {
  timestamp: string;
  raw: string;
  category: 'connection' | 'disconnect' | 'kill' | 'chat' | 'error' | 'system' | 'gameplay' | 'other';
  playerName?: string;
  playerIp?: string;
  clientVersion?: string;
  status?: string;
  details?: Record<string, string>;
}

export interface ConnectionAttempt {
  name: string;
  timestamp: string;
  ip?: string;
  version?: string;
  status: 'joined' | 'downloading' | 'checksum_error' | 'disconnected' | 'pending';
  downloadFile?: string;
  checksumError?: string;
  disconnectTime?: string;
  clientSlot?: string;
}

export interface LogsQueryParams {
  timeRange?: string;
  category?: 'connections' | 'kills' | 'chat' | 'errors' | 'gameplay' | 'all';
  playerFilter?: string;
  customSince?: string;
  customUntil?: string;
  signal?: AbortSignal;
}

export interface LogsResponse {
  logs: LogEntry[];
  connectionAttempts: ConnectionAttempt[];
  totalLines: number;
  filteredCount: number;
  timeRange: { since: string; until?: string };
}

export interface TimePreset {
  key: string;
  label: string;
  value: string;
}

// Logs
export const logs = {
  query: async (params: LogsQueryParams = {}): Promise<LogsResponse> => {
    const searchParams = new URLSearchParams();
    if (params.timeRange) searchParams.set('timeRange', params.timeRange);
    if (params.category) searchParams.set('category', params.category);
    if (params.playerFilter) searchParams.set('playerFilter', params.playerFilter);
    if (params.customSince) searchParams.set('customSince', params.customSince);
    if (params.customUntil) searchParams.set('customUntil', params.customUntil);

    const makeRequest = () => {
      const token = localStorage.getItem('accessToken');
      return fetch(`${API_BASE}/logs/query?${searchParams.toString()}`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: params.signal,
      });
    };

    return handleUnauthorized(makeRequest, (res) => res.json());
  },
  presets: () => apiRequest<{ presets: TimePreset[] }>('/logs/presets'),
};

// Server Browser
export const browser = {
  servers: () => apiRequest<BrowserResponse>('/browser/servers'),
  favorites: () => apiRequest<{ favorites: FavoriteServer[] }>('/browser/favorites'),
  addFavorite: (address: string, name?: string) =>
    apiRequest<{ success: boolean; favorite: FavoriteServer }>('/browser/favorites', {
      method: 'POST',
      body: { address, name },
    }),
  updateFavorite: (address: string, name: string) =>
    apiRequest<{ success: boolean; favorite: FavoriteServer }>(`/browser/favorites/${encodeURIComponent(address)}`, {
      method: 'PUT',
      body: { name },
    }),
  deleteFavorite: (address: string) =>
    apiRequest<{ success: boolean }>(`/browser/favorites/${encodeURIComponent(address)}`, {
      method: 'DELETE',
    }),
  queryServer: (address: string) =>
    apiRequest<BrowserServer & { online: boolean }>(`/browser/query?address=${encodeURIComponent(address)}`),
};

// Sounds API
export const sounds = {
  // User sounds
  list: () => apiRequest<SoundsListResponse>('/sounds'),
  get: (alias: string) => apiRequest<UserSound>(`/sounds/${encodeURIComponent(alias)}`),
  rename: (alias: string, newAlias: string) =>
    apiRequest<{ success: boolean; alias: string }>(`/sounds/${encodeURIComponent(alias)}`, {
      method: 'PATCH',
      body: { newAlias },
    }),
  delete: (alias: string) =>
    apiRequest<{ success: boolean }>(`/sounds/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  setVisibility: (alias: string, visibility: 'private' | 'shared' | 'public', removeFromPublicPlaylists?: boolean) =>
    apiRequest<{ success: boolean; visibility: string }>(`/sounds/${encodeURIComponent(alias)}/visibility`, {
      method: 'PATCH',
      body: { visibility, removeFromPublicPlaylists },
    }),

  // Playlists
  playlists: () => apiRequest<PlaylistsResponse>('/sounds/playlists'),
  getPlaylist: (name: string, id?: number) => {
    const url = `/sounds/playlists/${encodeURIComponent(name)}${id ? `?id=${id}` : ''}`;
    return apiRequest<PlaylistDetailResponse>(url);
  },
  createPlaylist: (name: string, description?: string) =>
    apiRequest<{ success: boolean; playlist: Playlist }>('/sounds/playlists', {
      method: 'POST',
      body: { name, description },
    }),
  deletePlaylist: (name: string) =>
    apiRequest<{ success: boolean }>(`/sounds/playlists/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  addToPlaylist: (playlistName: string, soundAlias: string) =>
    apiRequest<{ success: boolean }>(`/sounds/playlists/${encodeURIComponent(playlistName)}/sounds`, {
      method: 'POST',
      body: { soundAlias },
    }),
  removeFromPlaylist: (playlistName: string, soundAlias: string) =>
    apiRequest<{ success: boolean }>(
      `/sounds/playlists/${encodeURIComponent(playlistName)}/sounds/${encodeURIComponent(soundAlias)}`,
      { method: 'DELETE' }
    ),
  reorderPlaylist: (playlistName: string, soundAliases: string[]) =>
    apiRequest<{ success: boolean }>(`/sounds/playlists/${encodeURIComponent(playlistName)}/reorder`, {
      method: 'PUT',
      body: { soundAliases },
    }),
  setPlaylistVisibility: (playlistName: string, isPublic: boolean) =>
    apiRequest<{ success: boolean; isPublic: boolean }>(
      `/sounds/playlists/${encodeURIComponent(playlistName)}/visibility`,
      {
        method: 'PATCH',
        body: { isPublic },
      }
    ),

  // Public library
  publicLibrary: (page = 0, search?: string) => {
    const params = new URLSearchParams();
    params.set('page', page.toString());
    if (search) params.set('search', search);
    return apiRequest<PublicLibraryResponse>(`/sounds/public/library?${params.toString()}`);
  },
  addFromPublic: (soundFileId: number, alias: string) =>
    apiRequest<{ success: boolean; alias: string }>(`/sounds/public/${soundFileId}`, {
      method: 'POST',
      body: { alias },
    }),

  // Shares
  pendingShares: () => apiRequest<PendingSharesResponse>('/sounds/shares/pending'),
  acceptShare: (shareId: number, alias: string) =>
    apiRequest<{ success: boolean; alias: string }>(`/sounds/shares/${shareId}/accept`, {
      method: 'POST',
      body: { alias },
    }),
  rejectShare: (shareId: number) =>
    apiRequest<{ success: boolean }>(`/sounds/shares/${shareId}/reject`, { method: 'POST' }),

  // Account
  getGuidStatus: () => apiRequest<GuidStatusResponse>('/sounds/account/guid'),
  verifyCode: (code: string) =>
    apiRequest<VerifyCodeResponse>('/sounds/verify-code', {
      method: 'POST',
      body: { code },
    }),

  // Admin operations
  adminRenamePublic: (soundFileId: number, originalName: string) =>
    apiRequest<{ success: boolean; originalName: string }>(`/sounds/admin/public/${soundFileId}`, {
      method: 'PATCH',
      body: { originalName },
    }),
  adminGetDeleteInfo: (soundFileId: number) =>
    apiRequest<{
      soundFileId: number;
      originalName: string;
      isDirectlyPublic: boolean;
      affectedPlaylists: { id: number; name: string; isPublic: boolean; ownerName: string }[];
      affectedUserCount: number;
    }>(`/sounds/admin/public/${soundFileId}/delete-info`),
  adminDeletePublic: (soundFileId: number) =>
    apiRequest<{ success: boolean }>(`/sounds/admin/public/${soundFileId}`, { method: 'DELETE' }),
  adminSetVisibility: (soundFileId: number, isPublic: boolean) =>
    apiRequest<{ success: boolean; isPublic: boolean }>(`/sounds/admin/public/${soundFileId}/visibility`, {
      method: 'PATCH',
      body: { isPublic },
    }),

  // Upload operations
  uploadFile: async (file: File, alias: string): Promise<UploadResponse> => {
    const formData = new FormData();
    // Alias must come before file for multipart parsing
    formData.append('alias', alias);
    formData.append('file', file);

    const makeRequest = () => {
      const token = localStorage.getItem('accessToken');
      if (!token) throw new Error('Not authenticated');
      return fetch(`${API_BASE}/sounds/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
    };

    return handleUnauthorized(makeRequest, (res) => res.json());
  },

  importFromUrl: (url: string, alias: string) =>
    apiRequest<UploadResponse>('/sounds/import-url', {
      method: 'POST',
      body: { url, alias },
    }),

  // Temp upload operations (for clip editor)
  uploadFileToTemp: async (file: File): Promise<TempUploadResponse> => {
    const formData = new FormData();
    formData.append('file', file);

    const makeRequest = () => {
      const token = localStorage.getItem('accessToken');
      if (!token) throw new Error('Not authenticated');
      return fetch(`${API_BASE}/sounds/upload-temp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
    };

    return handleUnauthorized(makeRequest, (res) => res.json());
  },

  importFromUrlToTemp: (url: string) =>
    apiRequest<TempUploadResponse>('/sounds/import-url-temp', {
      method: 'POST',
      body: { url },
    }),

  getTempStreamUrl: (tempId: string): string => {
    return `${API_BASE}/sounds/temp/${tempId}`;
  },

  getWaveform: (tempId: string) =>
    apiRequest<WaveformResponse>(`/sounds/temp/${tempId}/waveform`),

  saveClip: (tempId: string, alias: string, startTime: number, endTime: number, isPublic: boolean = false) =>
    apiRequest<SaveClipResponse>('/sounds/save-clip', {
      method: 'POST',
      body: { tempId, alias, startTime, endTime, isPublic },
    }),

  deleteTempFile: (tempId: string) =>
    apiRequest<{ success: boolean }>(`/sounds/temp/${tempId}`, { method: 'DELETE' }),

  // Copy existing sound to temp for creating a new clip
  copyToTemp: (alias: string) =>
    apiRequest<TempUploadResponse>(`/sounds/copy-to-temp/${encodeURIComponent(alias)}`, {
      method: 'POST',
      body: {},
    }),

  // Copy public sound to temp for creating a clip
  copyPublicToTemp: (soundFileId: number) =>
    apiRequest<TempUploadResponse>(`/sounds/copy-public-to-temp/${soundFileId}`, {
      method: 'POST',
      body: {},
    }),
};

// Sound types
export interface UserSound {
  id: number;
  alias: string;
  visibility: 'private' | 'public' | 'shared'; // 'shared' is legacy, treated as private
  createdAt: string;
  updatedAt?: string;
  soundFileId: number;
  originalName: string;
  filePath?: string;
  fileSize: number;
  durationSeconds?: number;
  isPublic?: boolean;
  isOwner?: boolean;  // True if current user uploaded/created this sound
  ownerName?: string;  // Display name of the user who uploaded this sound
  publicPlaylists?: { id: number; name: string }[];  // List of public playlists this sound is in
  privatePlaylists?: { id: number; name: string }[];  // List of user's private playlists this sound is in
}

export interface SoundsListResponse {
  sounds: UserSound[];
  count: number;
}

export interface Playlist {
  id: number;
  name: string;
  description?: string;
  isPublic: boolean;
  currentPosition: number;
  createdAt: string;
  soundCount?: number;
  isOwner?: boolean;
  ownerName?: string;
  ownerGuid?: string;
}

export interface PlaylistsResponse {
  playlists: Playlist[];
}

export interface PlaylistItem {
  id: number;
  orderNumber: number;
  addedAt: string;
  alias: string;
  soundFileId: number;
  fileSize: number;
  durationSeconds?: number;
}

export interface PlaylistDetailResponse {
  playlist: Playlist;
  items: PlaylistItem[];
}

export interface PublicSound {
  soundFileId: number;
  originalName: string;
  fileSize: number;
  durationSeconds?: number;
  addedByGuid: string;
  addedByName: string;
  createdAt: string;
  isDirectlyPublic: boolean;
}

export interface PublicLibraryResponse {
  sounds: PublicSound[];
  page: number;
  totalPages: number;
  totalCount: number;
}

export interface PendingShare {
  id: number;
  soundFileId: number;
  fromGuid: string;
  suggestedAlias?: string;
  createdAt: string;
  originalName: string;
  fileSize: number;
  durationSeconds?: number;
}

export interface PendingSharesResponse {
  shares: PendingShare[];
}

export interface GuidStatusResponse {
  linked: boolean;
  guid: string | null;
}

export interface VerifyCodeResponse {
  success: boolean;
  guid: string;
  playerName: string;
  message: string;
}

export interface UploadResponse {
  success: boolean;
  alias: string;
  fileSize: number;
  durationSeconds?: number;
  originalName?: string;
}

export interface TempUploadResponse {
  success: boolean;
  tempId: string;
  durationSeconds: number;
  fileSize: number;
  originalName: string;
  maxClipDuration: number;
}

export interface WaveformResponse {
  peaks: number[];
}

export interface SaveClipResponse {
  success: boolean;
  alias: string;
  fileSize: number;
  durationSeconds: number;
  isPublic: boolean;
}

// Browser types
export interface FavoriteServer {
  address: string;
  name: string;
  added_date: string;
}

export interface BrowserPlayer {
  name: string;
  score: number;
  ping: number;
}

export interface BrowserServer {
  address: string;
  name: string;
  favoriteName: string;
  hostname: string;
  map: string;
  gametype: string;
  mod: string;
  maxPlayers: number;
  players: BrowserPlayer[];
  humans: number;
  bots: number;
  ping: number;
  online: boolean;
  protocol: number;
}

export interface BrowserResponse {
  servers: BrowserServer[];
  total: number;
  onlineCount: number;
  totalHumans: number;
}

// ============================================================================
// Admin System API
// ============================================================================

export const admin = {
  // Levels
  levels: () => apiRequest<AdminLevelsResponse>('/admin/levels'),

  // Players
  players: (limit = 50, offset = 0, search = '') => {
    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());
    if (search) params.set('search', search);
    return apiRequest<AdminPlayersResponse>(`/admin/players?${params.toString()}`);
  },
  player: (guid: string) => apiRequest<AdminPlayerDetailResponse>(`/admin/players/${guid}`),
  setLevel: (guid: string, level: number) =>
    apiRequest<{ success: boolean; message: string }>(`/admin/players/${guid}/level`, {
      method: 'PUT',
      body: { level },
    }),

  // Bans
  bans: (limit = 50, offset = 0) =>
    apiRequest<AdminBansResponse>(`/admin/bans?limit=${limit}&offset=${offset}`),
  banHistory: (limit = 100, offset = 0) =>
    apiRequest<AdminBanHistoryResponse>(`/admin/bans/history?limit=${limit}&offset=${offset}`),
  ban: (guid: string, reason?: string, duration?: number) =>
    apiRequest<{ success: boolean; message: string; ban: AdminBan }>(`/admin/bans/${guid}`, {
      method: 'POST',
      body: { reason, duration },
    }),
  unban: (banId: number) =>
    apiRequest<{ success: boolean; message: string }>(`/admin/bans/${banId}`, {
      method: 'DELETE',
    }),

  // Logs
  logs: (limit = 100, offset = 0, command?: string, source?: string) => {
    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());
    if (command) params.set('command', command);
    if (source) params.set('source', source);
    return apiRequest<AdminLogsResponse>(`/admin/logs?${params.toString()}`);
  },
  logStats: () => apiRequest<AdminLogStatsResponse>('/admin/logs/stats'),

  // Commands
  commands: () => apiRequest<AdminCommandsResponse>('/admin/commands'),
  setCommandLevel: (commandId: number, level: number) =>
    apiRequest<{ success: boolean; message: string }>(`/admin/commands/${commandId}/level`, {
      method: 'PUT',
      body: { level },
    }),
  setCommandEnabled: (commandId: number, enabled: boolean) =>
    apiRequest<{ success: boolean; message: string }>(`/admin/commands/${commandId}/enabled`, {
      method: 'PUT',
      body: { enabled },
    }),
  availableCommands: () =>
    apiRequest<AvailableCommandsResponse>('/admin/commands/available'),
  executeCommand: (command: string, args?: string) =>
    apiRequest<ExecuteCommandResponse>('/admin/commands/execute', {
      method: 'POST',
      body: { command, args },
    }),

  // Stats
  stats: () => apiRequest<AdminStatsResponse>('/admin/stats'),

  // Current user's admin status
  me: () => apiRequest<AdminMeResponse>('/admin/me'),
};

// Admin types
export interface AdminLevel {
  id: number;
  level: number;
  name: string;
  createdAt: string;
}

export interface AdminLevelsResponse {
  levels: AdminLevel[];
}

export interface AdminPlayerListItem {
  id: number;
  guid: string;
  levelId: number | null;
  levelName: string | null;
  levelNum: number | null;
  createdAt: string;
  lastSeen: string;
  timesSeen: number;
  name: string;
  cleanName: string;
}

export interface AdminPlayersResponse {
  players: AdminPlayerListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminAlias {
  id: number;
  playerId: number;
  alias: string;
  cleanAlias: string;
  lastUsed: string;
  timesUsed: number;
}

export interface AdminWarning {
  id: number;
  reason: string;
  issuedAt: string;
  warnedBy: number | null;
}

export interface AdminBan {
  id: number;
  playerId: number;
  bannedBy: number | null;
  reason: string | null;
  issuedAt: string;
  expiresAt: string | null;
  active: boolean;
}

export interface AdminMute {
  id: number;
  playerId: number;
  mutedBy: number | null;
  reason: string | null;
  issuedAt: string;
  expiresAt: string | null;
  active: boolean;
  voiceMute: boolean;
}

export interface AdminCommandLogEntry {
  id: number;
  playerId: number | null;
  command: string;
  args: string | null;
  targetPlayerId: number | null;
  success: boolean | null;
  executedAt: string;
  source: string;
}

export interface AdminPlayerDetailResponse {
  player: {
    id: number;
    guid: string;
    levelId: number | null;
    levelName: string | null;
    levelNum: number | null;
    createdAt: string;
    lastSeen: string;
    timesSeen: number;
  };
  aliases: AdminAlias[];
  warnings: AdminWarning[];
  bans: AdminBan[];
  mutes: AdminMute[];
  commandLogs: AdminCommandLogEntry[];
}

export interface AdminBanListItem extends AdminBan {
  playerGuid: string;
  playerName: string;
  playerCleanName: string;
  isPermanent: boolean;
}

export interface AdminBansResponse {
  bans: AdminBanListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminBanHistoryResponse {
  bans: AdminBanListItem[];
}

export interface AdminLogListItem extends AdminCommandLogEntry {
  playerName: string | null;
  targetPlayerName: string | null;
}

export interface AdminLogsResponse {
  logs: AdminLogListItem[];
}

export interface AdminLogStatsResponse {
  commandCounts: { command: string; count: number }[];
  sourceCounts: { source: string; count: number }[];
}

export interface AdminCommand {
  id: number;
  name: string;
  description: string | null;
  usage: string | null;
  defaultLevel: number;
  enabled: boolean;
  createdAt: string;
}

export interface AdminCommandsResponse {
  commands: AdminCommand[];
}

export interface AdminStatsResponse {
  totalPlayers: number;
  activeBans: number;
  adminCount: number;
  recentCommands: number;
}

export interface AdminMeResponse {
  linked: boolean;
  guid?: string;
  adminLevel?: number | null;
  adminLevelName?: string | null;
  lastSeen?: string;
  message?: string;
}

export interface AvailableCommandsResponse {
  commands: AdminCommand[];
  userLevel: number;
  userGuid: string | null;
}

export interface ExecuteCommandResponse {
  success: boolean;
  message: string;
  response?: string;
  needsInGame?: boolean;
  note?: string;
}
