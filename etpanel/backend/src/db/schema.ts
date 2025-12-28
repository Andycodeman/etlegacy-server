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
    name: varchar('name', { length: 100 }).notNull(),
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
export const playerMatchups = pgTable(
  'player_matchups',
  {
    id: serial('id').primaryKey(),
    playerGuid: varchar('player_guid', { length: 32 }).notNull(),  // The player whose stats these are
    opponentGuid: varchar('opponent_guid', { length: 32 }).notNull(),  // Their opponent (human or BOT_xxx)
    opponentName: varchar('opponent_name', { length: 100 }).notNull(),  // Display name (for bots especially)
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
