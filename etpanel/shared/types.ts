// User types
export interface User {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'moderator' | 'user';
  createdAt: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

// Server types
export interface ServerStatus {
  online: boolean;
  map?: string;
  hostname?: string;
  players?: number;
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
  playtimeSeconds: number;
  lastSeen: string;
  firstSeen: string;
}

export interface KillLogEntry {
  id: number;
  killerGuid: string | null;
  victimGuid: string | null;
  killerName: string | null;
  victimName: string | null;
  weapon: string | null;
  map: string | null;
  timestamp: string;
}

// Config types
export interface CvarMap {
  [key: string]: string;
}

export interface ConfigSnapshot {
  id: number;
  name: string;
  configJson: CvarMap;
  createdBy?: string;
  createdAt: string;
}

// Schedule types
export type EventType = 'config_change' | 'map_rotation' | 'custom';

export interface ScheduledEvent {
  id: number;
  name: string;
  description?: string;
  eventType: EventType;
  configJson: CvarMap;
  cronExpression?: string;
  oneTimeAt?: string;
  isActive: boolean;
  createdBy?: string;
  createdAt: string;
}

export type ReservationStatus = 'pending' | 'approved' | 'active' | 'completed' | 'rejected';

export interface Reservation {
  id: number;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  configJson?: CvarMap;
  status: ReservationStatus;
  user?: string;
  createdAt: string;
}

// WebSocket message types
export type WebSocketMessageType =
  | 'connected'
  | 'player_connect'
  | 'player_disconnect'
  | 'kill'
  | 'chat'
  | 'server_status';

export interface WebSocketMessage<T = unknown> {
  type: WebSocketMessageType;
  data?: T;
  timestamp?: string;
}

export interface PlayerConnectData {
  slot: number;
  name: string;
  timestamp: string;
}

export interface PlayerDisconnectData {
  slot: number;
  name: string;
  timestamp: string;
}

export interface KillData {
  killer: string;
  victim: string;
  weapon: string;
  timestamp: string;
}

export interface ChatData {
  name: string;
  message: string;
  team: boolean;
  timestamp: string;
}

// API Response types
export interface ApiError {
  error: string;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// RCON types
export interface RconResponse {
  success: boolean;
  response: string;
  error?: string;
}
