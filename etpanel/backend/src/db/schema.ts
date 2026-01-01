import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Users table
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  guid: varchar('guid', { length: 32 }).unique(), // ET GUID for game-registered users
  email: varchar('email', { length: 255 }).unique(), // Optional for game-registered users
  passwordHash: varchar('password_hash', { length: 255 }),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 20 }).default('user').notNull(), // 'admin', 'moderator', 'user'
  googleId: varchar('google_id', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Sessions table (for JWT refresh tokens)
export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  refreshToken: varchar('refresh_token', { length: 500 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Scheduled events
export const scheduledEvents = pgTable('scheduled_events', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  eventType: varchar('event_type', { length: 50 }).notNull(), // 'config_change', 'map_rotation', 'custom'
  configJson: jsonb('config_json').notNull(), // {"g_gravity": "200", "g_speed": "450"}
  cronExpression: varchar('cron_expression', { length: 100 }), // "0 20 * * 5"
  oneTimeAt: timestamp('one_time_at'),
  isActive: boolean('is_active').default(true).notNull(),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Server reservations
export const reservations = pgTable('reservations', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: varchar('title', { length: 100 }).notNull(),
  description: text('description'),
  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time').notNull(),
  configJson: jsonb('config_json'), // Custom settings during reservation
  status: varchar('status', { length: 20 }).default('pending').notNull(), // 'pending', 'approved', 'active', 'completed'
  approvedBy: integer('approved_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Player stats (populated from Lua callbacks)
export const playerStats = pgTable(
  'player_stats',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(), // Clean name (color codes stripped) for sorting/searching
    displayName: varchar('display_name', { length: 100 }), // Original name with ET color codes for display
    // Human vs Human stats
    kills: integer('kills').default(0).notNull(),
    deaths: integer('deaths').default(0).notNull(),
    // Human vs Bot stats
    botKills: integer('bot_kills').default(0).notNull(),
    botDeaths: integer('bot_deaths').default(0).notNull(),
    // Suicides (falling, self-damage, etc.)
    suicides: integer('suicides').default(0).notNull(),
    playtimeSeconds: integer('playtime_seconds').default(0).notNull(),
    lastSeen: timestamp('last_seen').defaultNow().notNull(),
    firstSeen: timestamp('first_seen').defaultNow().notNull(),
  },
  (table) => ({
    guidIdx: uniqueIndex('player_stats_guid_idx').on(table.guid),
  })
);

// Kill log (from Lua callbacks)
export const killLog = pgTable('kill_log', {
  id: serial('id').primaryKey(),
  killerGuid: varchar('killer_guid', { length: 32 }),
  victimGuid: varchar('victim_guid', { length: 32 }),
  killerName: varchar('killer_name', { length: 100 }),
  victimName: varchar('victim_name', { length: 100 }),
  weapon: varchar('weapon', { length: 50 }),
  map: varchar('map', { length: 100 }),
  isTeamKill: boolean('is_team_kill').default(false).notNull(),
  killerIsBot: boolean('killer_is_bot').default(false).notNull(),
  victimIsBot: boolean('victim_is_bot').default(false).notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

// Player vs Player matchup stats (aggregated by weapon)
// Tracks kills/deaths between specific player pairs with weapon breakdown
// Note: opponent name/displayName come from JOIN with player_stats, not stored here
export const playerMatchups = pgTable(
  'player_matchups',
  {
    id: serial('id').primaryKey(),
    playerGuid: varchar('player_guid', { length: 32 }).notNull(),  // The player whose stats these are
    opponentGuid: varchar('opponent_guid', { length: 32 }).notNull(),  // Their opponent (human or BOT_xxx)
    opponentIsBot: boolean('opponent_is_bot').default(false).notNull(),
    weapon: varchar('weapon', { length: 50 }).notNull(),  // e.g., MOD_MP40, MOD_KNIFE
    kills: integer('kills').default(0).notNull(),  // Times player killed opponent with this weapon
    deaths: integer('deaths').default(0).notNull(),  // Times opponent killed player with this weapon
    teamKills: integer('team_kills').default(0).notNull(),  // Times player TK'd opponent with this weapon
    teamDeaths: integer('team_deaths').default(0).notNull(),  // Times opponent TK'd player with this weapon
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Composite unique index for upserts
    matchupIdx: uniqueIndex('player_matchup_idx').on(
      table.playerGuid,
      table.opponentGuid,
      table.weapon
    ),
  })
);

// Server config snapshots
export const configSnapshots = pgTable('config_snapshots', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  configJson: jsonb('config_json').notNull(),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Map-specific configs
export const mapConfigs = pgTable(
  'map_configs',
  {
    id: serial('id').primaryKey(),
    mapName: varchar('map_name', { length: 100 }).notNull(),
    configJson: jsonb('config_json').notNull(), // {"g_gravity": "200", "g_speed": "450"}
    createdBy: integer('created_by').references(() => users.id),
    updatedBy: integer('updated_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    mapNameIdx: uniqueIndex('map_configs_map_name_idx').on(table.mapName),
  })
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  reservations: many(reservations),
  scheduledEvents: many(scheduledEvents),
  configSnapshots: many(configSnapshots),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  user: one(users, {
    fields: [reservations.userId],
    references: [users.id],
  }),
  approver: one(users, {
    fields: [reservations.approvedBy],
    references: [users.id],
  }),
}));

// ============================================================================
// Sound Management Tables (Voice Server Custom Sounds Upgrade)
// ============================================================================

// Sound files - actual MP3s on disk (centralized storage)
export const soundFiles = pgTable(
  'sound_files',
  {
    id: serial('id').primaryKey(),
    filename: varchar('filename', { length: 64 }).notNull(), // UUID-based filename
    originalName: varchar('original_name', { length: 64 }).notNull(), // Original upload name
    filePath: varchar('file_path', { length: 512 }).notNull().unique(), // Full path to MP3
    fileSize: integer('file_size').notNull(), // File size in bytes
    durationSeconds: integer('duration_seconds'), // Duration (calculated on add)
    addedByGuid: varchar('added_by_guid', { length: 32 }).notNull(), // Who originally uploaded
    referenceCount: integer('reference_count').default(1).notNull(), // How many user_sounds reference this
    isPublic: boolean('is_public').default(false).notNull(), // Available in public library
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    publicIdx: index('sound_files_public_idx').on(table.isPublic), // For public library queries
    addedByIdx: index('sound_files_added_by_idx').on(table.addedByGuid), // For uploader queries
  })
);

// User sounds - junction table linking users to files with their custom aliases
export const userSounds = pgTable(
  'user_sounds',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull(), // User's ET GUID
    soundFileId: integer('sound_file_id')
      .references(() => soundFiles.id, { onDelete: 'restrict' })
      .notNull(),
    alias: varchar('alias', { length: 32 }).notNull(), // User's custom name for this sound
    visibility: varchar('visibility', { length: 10 }).default('private').notNull(), // 'private', 'shared', 'public'
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    guidAliasIdx: uniqueIndex('user_sounds_guid_alias_idx').on(table.guid, table.alias),
    guidFileIdx: uniqueIndex('user_sounds_guid_file_idx').on(table.guid, table.soundFileId),
    guidIdx: index('user_sounds_guid_idx').on(table.guid), // Non-unique - for queries
  })
);

// Sound playlists - user-created playlists/categories
export const soundPlaylists = pgTable(
  'sound_playlists',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull(), // Owner's ET GUID (or 'PUBLIC' for public playlists)
    name: varchar('name', { length: 32 }).notNull(), // Playlist name
    description: text('description'),
    isPublic: boolean('is_public').default(false).notNull(), // True = server-wide public playlist
    currentPosition: integer('current_position').default(1).notNull(), // For playlist playback tracking
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    guidNameIdx: uniqueIndex('playlists_guid_name_idx').on(table.guid, table.name),
    guidIdx: index('sound_playlists_guid_idx').on(table.guid), // Non-unique - for queries
    publicIdx: index('sound_playlists_public_idx').on(table.isPublic), // For public playlists
  })
);

// Playlist items - many-to-many between playlists and user_sounds with ordering
export const soundPlaylistItems = pgTable(
  'sound_playlist_items',
  {
    id: serial('id').primaryKey(),
    playlistId: integer('playlist_id')
      .references(() => soundPlaylists.id, { onDelete: 'cascade' })
      .notNull(),
    userSoundId: integer('user_sound_id')
      .references(() => userSounds.id, { onDelete: 'cascade' })
      .notNull(),
    orderNumber: integer('order_number').notNull(), // User-editable order
    addedAt: timestamp('added_at').defaultNow().notNull(),
  },
  (table) => ({
    playlistSoundIdx: uniqueIndex('playlist_sound_idx').on(table.playlistId, table.userSoundId),
    playlistIdx: index('sound_playlist_items_playlist_idx').on(table.playlistId), // Non-unique - for queries
  })
);

// Sound shares - track pending and accepted share requests between users
export const soundShares = pgTable(
  'sound_shares',
  {
    id: serial('id').primaryKey(),
    soundFileId: integer('sound_file_id')
      .references(() => soundFiles.id, { onDelete: 'cascade' })
      .notNull(),
    fromGuid: varchar('from_guid', { length: 32 }).notNull(), // Who shared it
    toGuid: varchar('to_guid', { length: 32 }).notNull(), // Who it's shared with
    suggestedAlias: varchar('suggested_alias', { length: 32 }), // Suggested name for recipient
    status: varchar('status', { length: 10 }).default('pending').notNull(), // 'pending', 'accepted', 'rejected'
    createdAt: timestamp('created_at').defaultNow().notNull(),
    respondedAt: timestamp('responded_at'),
  },
  (table) => ({
    shareUniqueIdx: uniqueIndex('share_unique_idx').on(
      table.soundFileId,
      table.fromGuid,
      table.toGuid
    ),
    toGuidIdx: index('sound_shares_to_guid_idx').on(table.toGuid), // Non-unique - for queries
    pendingIdx: index('sound_shares_pending_idx').on(table.toGuid, table.status), // Non-unique - for queries
  })
);

// Verification codes - for in-game account registration
export const verificationCodes = pgTable(
  'verification_codes',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull().unique(), // ET GUID
    code: varchar('code', { length: 6 }).notNull(), // 6-char alphanumeric code
    playerName: varchar('player_name', { length: 64 }).notNull(), // In-game name at time of request
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(), // 10 minute expiry
    used: boolean('used').default(false).notNull(),
  },
  (table) => ({
    codeIdx: uniqueIndex('verification_codes_code_idx').on(table.code),
  })
);

// ============================================================================
// Server Browser Favorites
// ============================================================================

// User favorite servers - for Server Scout
export const favoriteServers = pgTable(
  'favorite_servers',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    address: varchar('address', { length: 64 }).notNull(), // ip:port
    name: varchar('name', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userServerIdx: uniqueIndex('favorite_servers_user_server_idx').on(table.userId, table.address),
    userIdx: index('favorite_servers_user_idx').on(table.userId),
  })
);

// ============================================================================
// Sound Relations
// ============================================================================

export const soundFilesRelations = relations(soundFiles, ({ many }) => ({
  userSounds: many(userSounds),
  shares: many(soundShares),
}));

export const userSoundsRelations = relations(userSounds, ({ one, many }) => ({
  soundFile: one(soundFiles, {
    fields: [userSounds.soundFileId],
    references: [soundFiles.id],
  }),
  playlistItems: many(soundPlaylistItems),
}));

export const soundPlaylistsRelations = relations(soundPlaylists, ({ many }) => ({
  items: many(soundPlaylistItems),
}));

export const soundPlaylistItemsRelations = relations(soundPlaylistItems, ({ one }) => ({
  playlist: one(soundPlaylists, {
    fields: [soundPlaylistItems.playlistId],
    references: [soundPlaylists.id],
  }),
  userSound: one(userSounds, {
    fields: [soundPlaylistItems.userSoundId],
    references: [userSounds.id],
  }),
}));

export const soundSharesRelations = relations(soundShares, ({ one }) => ({
  soundFile: one(soundFiles, {
    fields: [soundShares.soundFileId],
    references: [soundFiles.id],
  }),
}));

// ============================================================================
// Admin System Tables (ETMan !commands integration)
// ============================================================================

// Admin levels (hierarchical permission tiers: 0=Guest to 5=Owner)
export const adminLevels = pgTable('admin_levels', {
  id: serial('id').primaryKey(),
  level: integer('level').notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Admin commands registry (all available !commands)
export const adminCommands = pgTable('admin_commands', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 50 }).notNull().unique(),
  description: text('description'),
  usage: varchar('usage', { length: 255 }),
  defaultLevel: integer('default_level').notNull().default(5),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Players (identified by GUID)
export const adminPlayers = pgTable(
  'admin_players',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull().unique(),
    levelId: integer('level_id').references(() => adminLevels.id).default(1),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastSeen: timestamp('last_seen').defaultNow().notNull(),
    timesSeen: integer('times_seen').default(1).notNull(),
  },
  (table) => ({
    guidIdx: index('idx_admin_players_guid').on(table.guid),
  })
);

// Player aliases (name history)
export const adminAliases = pgTable(
  'admin_aliases',
  {
    id: serial('id').primaryKey(),
    playerId: integer('player_id')
      .references(() => adminPlayers.id, { onDelete: 'cascade' })
      .notNull(),
    alias: varchar('alias', { length: 64 }).notNull(),
    cleanAlias: varchar('clean_alias', { length: 64 }).notNull(),
    lastUsed: timestamp('last_used').defaultNow().notNull(),
    timesUsed: integer('times_used').default(1).notNull(),
  },
  (table) => ({
    cleanIdx: index('idx_aliases_clean').on(table.cleanAlias),
    playerIdx: index('idx_aliases_player').on(table.playerId),
  })
);

// Bans
export const adminBans = pgTable(
  'admin_bans',
  {
    id: serial('id').primaryKey(),
    playerId: integer('player_id')
      .references(() => adminPlayers.id, { onDelete: 'cascade' })
      .notNull(),
    bannedBy: integer('banned_by').references(() => adminPlayers.id),
    reason: text('reason'),
    issuedAt: timestamp('issued_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at'), // NULL = permanent
    active: boolean('active').default(true).notNull(),
  },
  (table) => ({
    playerIdx: index('idx_bans_player').on(table.playerId),
  })
);

// Mutes
export const adminMutes = pgTable(
  'admin_mutes',
  {
    id: serial('id').primaryKey(),
    playerId: integer('player_id')
      .references(() => adminPlayers.id, { onDelete: 'cascade' })
      .notNull(),
    mutedBy: integer('muted_by').references(() => adminPlayers.id),
    reason: text('reason'),
    issuedAt: timestamp('issued_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at'),
    active: boolean('active').default(true).notNull(),
    voiceMute: boolean('voice_mute').default(false).notNull(),
  }
);

// Warnings
export const adminWarnings = pgTable('admin_warnings', {
  id: serial('id').primaryKey(),
  playerId: integer('player_id')
    .references(() => adminPlayers.id, { onDelete: 'cascade' })
    .notNull(),
  warnedBy: integer('warned_by').references(() => adminPlayers.id),
  reason: text('reason').notNull(),
  issuedAt: timestamp('issued_at').defaultNow().notNull(),
});

// Command execution log (audit trail)
export const adminCommandLog = pgTable(
  'admin_command_log',
  {
    id: serial('id').primaryKey(),
    playerId: integer('player_id').references(() => adminPlayers.id),
    command: varchar('command', { length: 50 }).notNull(),
    args: text('args'),
    targetPlayerId: integer('target_player_id').references(() => adminPlayers.id),
    success: boolean('success'),
    executedAt: timestamp('executed_at').defaultNow().notNull(),
    source: varchar('source', { length: 20 }).default('game').notNull(), // 'game', 'etpanel', 'rcon'
  },
  (table) => ({
    playerIdx: index('idx_command_log_player').on(table.playerId),
    timeIdx: index('idx_command_log_time').on(table.executedAt),
  })
);

// Level permissions (which levels can use which commands)
export const adminLevelPermissions = pgTable(
  'admin_level_permissions',
  {
    levelId: integer('level_id')
      .references(() => adminLevels.id, { onDelete: 'cascade' })
      .notNull(),
    commandId: integer('command_id')
      .references(() => adminCommands.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (table) => ({
    pk: uniqueIndex('admin_level_permissions_pkey').on(table.levelId, table.commandId),
  })
);

// Per-player permission overrides
export const adminPlayerPermissions = pgTable(
  'admin_player_permissions',
  {
    playerId: integer('player_id')
      .references(() => adminPlayers.id, { onDelete: 'cascade' })
      .notNull(),
    commandId: integer('command_id')
      .references(() => adminCommands.id, { onDelete: 'cascade' })
      .notNull(),
    granted: boolean('granted').notNull(),
    grantedBy: integer('granted_by').references(() => adminPlayers.id),
    grantedAt: timestamp('granted_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: uniqueIndex('admin_player_permissions_pkey').on(table.playerId, table.commandId),
  })
);

// Admin system relations
export const adminLevelsRelations = relations(adminLevels, ({ many }) => ({
  players: many(adminPlayers),
  permissions: many(adminLevelPermissions),
}));

export const adminPlayersRelations = relations(adminPlayers, ({ one, many }) => ({
  level: one(adminLevels, {
    fields: [adminPlayers.levelId],
    references: [adminLevels.id],
  }),
  aliases: many(adminAliases),
  bans: many(adminBans),
  mutes: many(adminMutes),
  warnings: many(adminWarnings),
  commandLogs: many(adminCommandLog),
}));

export const adminAliasesRelations = relations(adminAliases, ({ one }) => ({
  player: one(adminPlayers, {
    fields: [adminAliases.playerId],
    references: [adminPlayers.id],
  }),
}));

export const adminBansRelations = relations(adminBans, ({ one }) => ({
  player: one(adminPlayers, {
    fields: [adminBans.playerId],
    references: [adminPlayers.id],
  }),
  bannedByPlayer: one(adminPlayers, {
    fields: [adminBans.bannedBy],
    references: [adminPlayers.id],
  }),
}));

export const adminCommandLogRelations = relations(adminCommandLog, ({ one }) => ({
  player: one(adminPlayers, {
    fields: [adminCommandLog.playerId],
    references: [adminPlayers.id],
  }),
  targetPlayer: one(adminPlayers, {
    fields: [adminCommandLog.targetPlayerId],
    references: [adminPlayers.id],
  }),
}));

// ============================================================================
// Dynamic Sound Menus (Per-Player Custom Menus with Hierarchical Nesting)
// ============================================================================

// User's custom sound menus (supports hierarchical nesting via parent_id)
export const userSoundMenus = pgTable(
  'user_sound_menus',
  {
    id: serial('id').primaryKey(),
    userGuid: varchar('user_guid', { length: 32 }).notNull(), // Owner's ET GUID
    menuName: varchar('menu_name', { length: 32 }).notNull(), // Display name: "Taunts", "Music", etc.
    menuPosition: integer('menu_position').notNull().default(0), // 1-9 position in parent menu
    parentId: integer('parent_id'), // Self-referential for nesting (NULL = root level)
    playlistId: integer('playlist_id').references(() => soundPlaylists.id, { onDelete: 'set null' }), // If set, auto-populate from playlist
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Unique position within same parent (COALESCE handles NULL parent_id)
    guidParentPositionIdx: uniqueIndex('user_sound_menus_guid_parent_position_idx').on(table.userGuid, table.menuPosition),
    guidIdx: index('user_sound_menus_guid_idx').on(table.userGuid),
    parentIdx: index('user_sound_menus_parent_idx').on(table.parentId),
  })
);

// Individual items in a menu - can be sounds, nested menus, OR playlists
export const userSoundMenuItems = pgTable(
  'user_sound_menu_items',
  {
    id: serial('id').primaryKey(),
    menuId: integer('menu_id')
      .references(() => userSoundMenus.id, { onDelete: 'cascade' })
      .notNull(),
    itemPosition: integer('item_position').notNull(), // 1-9 position in submenu
    itemType: varchar('item_type', { length: 10 }).notNull().default('sound'), // 'sound', 'menu', or 'playlist'
    soundId: integer('sound_id')
      .references(() => userSounds.id, { onDelete: 'cascade' }), // For itemType='sound'
    nestedMenuId: integer('nested_menu_id'), // For itemType='menu' (references userSoundMenus.id)
    playlistId: integer('playlist_id')
      .references(() => soundPlaylists.id, { onDelete: 'cascade' }), // For itemType='playlist'
    displayName: varchar('display_name', { length: 32 }), // Override name (NULL = use source name)
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    menuPositionIdx: uniqueIndex('user_sound_menu_items_menu_position_idx').on(table.menuId, table.itemPosition),
    menuIdx: index('user_sound_menu_items_menu_idx').on(table.menuId),
  })
);

// Sound Menu Relations
export const userSoundMenusRelations = relations(userSoundMenus, ({ one, many }) => ({
  playlist: one(soundPlaylists, {
    fields: [userSoundMenus.playlistId],
    references: [soundPlaylists.id],
  }),
  parent: one(userSoundMenus, {
    fields: [userSoundMenus.parentId],
    references: [userSoundMenus.id],
    relationName: 'menuHierarchy',
  }),
  children: many(userSoundMenus, { relationName: 'menuHierarchy' }),
  items: many(userSoundMenuItems),
}));

export const userSoundMenuItemsRelations = relations(userSoundMenuItems, ({ one }) => ({
  menu: one(userSoundMenus, {
    fields: [userSoundMenuItems.menuId],
    references: [userSoundMenus.id],
  }),
  sound: one(userSounds, {
    fields: [userSoundMenuItems.soundId],
    references: [userSounds.id],
  }),
  nestedMenu: one(userSoundMenus, {
    fields: [userSoundMenuItems.nestedMenuId],
    references: [userSoundMenus.id],
  }),
  playlist: one(soundPlaylists, {
    fields: [userSoundMenuItems.playlistId],
    references: [soundPlaylists.id],
  }),
}));

// ============================================================================
// Unfinished Sounds (Multi-file Upload Staging Area)
// ============================================================================

// Unfinished sounds - temporary storage for multi-file uploads before editing/saving
export const unfinishedSounds = pgTable(
  'unfinished_sounds',
  {
    id: serial('id').primaryKey(),
    userGuid: varchar('user_guid', { length: 32 }).notNull(), // Owner's ET GUID
    tempId: varchar('temp_id', { length: 36 }).notNull().unique(), // UUID for temp file reference
    alias: varchar('alias', { length: 32 }).notNull(), // Auto-generated or user-edited alias
    originalName: varchar('original_name', { length: 255 }).notNull(), // Original uploaded filename
    fileSize: integer('file_size').notNull(), // File size in bytes
    durationSeconds: integer('duration_seconds'), // Duration (calculated on upload)
    fileExtension: varchar('file_extension', { length: 10 }).notNull().default('.mp3'), // .mp3 or .wav
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    guidIdx: index('unfinished_sounds_guid_idx').on(table.userGuid),
    guidAliasIdx: uniqueIndex('unfinished_sounds_guid_alias_idx').on(table.userGuid, table.alias),
  })
);

export const unfinishedSoundsRelations = relations(unfinishedSounds, () => ({}));

// ============================================================================
// Type exports
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ScheduledEvent = typeof scheduledEvents.$inferSelect;
export type NewScheduledEvent = typeof scheduledEvents.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;
export type PlayerStat = typeof playerStats.$inferSelect;
export type NewPlayerStat = typeof playerStats.$inferInsert;
export type KillLogEntry = typeof killLog.$inferSelect;
export type NewKillLogEntry = typeof killLog.$inferInsert;
export type ConfigSnapshot = typeof configSnapshots.$inferSelect;
export type NewConfigSnapshot = typeof configSnapshots.$inferInsert;
export type PlayerMatchup = typeof playerMatchups.$inferSelect;
export type NewPlayerMatchup = typeof playerMatchups.$inferInsert;
export type MapConfig = typeof mapConfigs.$inferSelect;
export type NewMapConfig = typeof mapConfigs.$inferInsert;

// Sound management types
export type SoundFile = typeof soundFiles.$inferSelect;
export type NewSoundFile = typeof soundFiles.$inferInsert;
export type UserSound = typeof userSounds.$inferSelect;
export type NewUserSound = typeof userSounds.$inferInsert;
export type SoundPlaylist = typeof soundPlaylists.$inferSelect;
export type NewSoundPlaylist = typeof soundPlaylists.$inferInsert;
export type SoundPlaylistItem = typeof soundPlaylistItems.$inferSelect;
export type NewSoundPlaylistItem = typeof soundPlaylistItems.$inferInsert;
export type SoundShare = typeof soundShares.$inferSelect;
export type NewSoundShare = typeof soundShares.$inferInsert;
export type VerificationCode = typeof verificationCodes.$inferSelect;
export type NewVerificationCode = typeof verificationCodes.$inferInsert;

// Sound menu types
export type UserSoundMenu = typeof userSoundMenus.$inferSelect;
export type NewUserSoundMenu = typeof userSoundMenus.$inferInsert;
export type UserSoundMenuItem = typeof userSoundMenuItems.$inferSelect;
export type NewUserSoundMenuItem = typeof userSoundMenuItems.$inferInsert;

// Unfinished sound types
export type UnfinishedSound = typeof unfinishedSounds.$inferSelect;
export type NewUnfinishedSound = typeof unfinishedSounds.$inferInsert;

// Admin system types
export type AdminLevel = typeof adminLevels.$inferSelect;
export type AdminCommand = typeof adminCommands.$inferSelect;
export type AdminPlayer = typeof adminPlayers.$inferSelect;
export type AdminAlias = typeof adminAliases.$inferSelect;
export type AdminBan = typeof adminBans.$inferSelect;
export type AdminMute = typeof adminMutes.$inferSelect;
export type AdminWarning = typeof adminWarnings.$inferSelect;
export type AdminCommandLogEntry = typeof adminCommandLog.$inferSelect;
