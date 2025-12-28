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
  category: 'connection' | 'disconnect' | 'kill' | 'chat' | 'error' | 'system' | 'other';
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
}

export interface LogsQueryParams {
  timeRange?: string;
  category?: 'connections' | 'kills' | 'chat' | 'errors' | 'all';
  playerFilter?: string;
  customSince?: string;
  customUntil?: string;
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
  query: (params: LogsQueryParams = {}) => {
    const searchParams = new URLSearchParams();
    if (params.timeRange) searchParams.set('timeRange', params.timeRange);
    if (params.category) searchParams.set('category', params.category);
    if (params.playerFilter) searchParams.set('playerFilter', params.playerFilter);
    if (params.customSince) searchParams.set('customSince', params.customSince);
    if (params.customUntil) searchParams.set('customUntil', params.customUntil);
    return apiRequest<LogsResponse>(`/logs/query?${searchParams.toString()}`);
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
  setVisibility: (alias: string, visibility: 'private' | 'shared' | 'public') =>
    apiRequest<{ success: boolean; visibility: string }>(`/sounds/${encodeURIComponent(alias)}/visibility`, {
      method: 'PATCH',
      body: { visibility },
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
  adminDeletePublic: (soundFileId: number) =>
    apiRequest<{ success: boolean }>(`/sounds/admin/public/${soundFileId}`, { method: 'DELETE' }),
  adminSetVisibility: (soundFileId: number, isPublic: boolean) =>
    apiRequest<{ success: boolean; isPublic: boolean }>(`/sounds/admin/public/${soundFileId}/visibility`, {
      method: 'PATCH',
      body: { isPublic },
    }),

  // Upload operations
  uploadFile: async (file: File, alias: string): Promise<UploadResponse> => {
    const token = localStorage.getItem('accessToken');
    if (!token) throw new Error('Not authenticated');

    const formData = new FormData();
    // Alias must come before file for multipart parsing
    formData.append('alias', alias);
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/sounds/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }

    return response.json();
  },

  importFromUrl: (url: string, alias: string) =>
    apiRequest<UploadResponse>('/sounds/import-url', {
      method: 'POST',
      body: { url, alias },
    }),
};

// Sound types
export interface UserSound {
  id: number;
  alias: string;
  visibility: 'private' | 'shared' | 'public';
  createdAt: string;
  updatedAt?: string;
  soundFileId: number;
  originalName: string;
  filePath?: string;
  fileSize: number;
  durationSeconds?: number;
  isPublic?: boolean;
  inPublicPlaylist?: boolean;  // True if this sound is in any public playlist
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
  createdAt: string;
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
