import { db, schema } from '../db/index.js';
import { eq, sql, and } from 'drizzle-orm';
import { broadcast } from '../websocket/index.js';

export interface PlayerConnectEvent {
  slot: number;
  name: string;
  display_name?: string;  // Original name with ET color codes
  guid: string;
  timestamp: number;
}

export interface PlayerDisconnectEvent {
  slot: number;
  name: string;
  guid: string;
  playtime: number;
  timestamp: number;
}

export interface KillEvent {
  killer_slot: number;
  killer_name: string;
  killer_display_name?: string;
  killer_guid: string;
  victim_slot: number;
  victim_name: string;
  victim_display_name?: string;
  victim_guid: string;
  victim_is_bot?: boolean;
  is_team_kill?: boolean;
  kill_type?: 'human' | 'bot' | 'teamkill';
  weapon: string;
  map: string;
  timestamp: number;
}

export interface DeathEvent {
  slot: number;
  name: string;
  display_name?: string;
  guid: string;
  killer_slot?: number;
  killer_name?: string;
  killer_display_name?: string;
  killer_guid?: string;
  killer_is_bot?: boolean;
  is_team_kill?: boolean;
  death_type: 'human' | 'bot' | 'suicide' | 'teamkill';
  cause: string;
  map?: string;
  timestamp: number;
}

export interface ChatEvent {
  slot: number;
  name: string;
  guid: string;
  message: string;
  team: boolean;
  timestamp: number;
}

export async function handlePlayerConnect(event: PlayerConnectEvent) {
  // Upsert player stats - always update name and displayName on connect
  // (players can change their name between sessions, but GUID stays the same)
  await db
    .insert(schema.playerStats)
    .values({
      guid: event.guid,
      name: event.name,
      displayName: event.display_name || event.name,  // Use display_name if provided, fallback to name
      lastSeen: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.playerStats.guid,
      set: {
        name: event.name,
        displayName: event.display_name || event.name,  // Always update displayName on connect
        lastSeen: new Date(),
      },
    });

  // Broadcast to websocket clients
  broadcast({
    type: 'player_connect',
    data: {
      slot: event.slot,
      name: event.name,
      displayName: event.display_name,
      timestamp: new Date(event.timestamp * 1000).toISOString(),
    },
  });
}

export async function handlePlayerDisconnect(event: PlayerDisconnectEvent) {
  // Update playtime
  await db
    .update(schema.playerStats)
    .set({
      playtimeSeconds: sql`${schema.playerStats.playtimeSeconds} + ${event.playtime}`,
      lastSeen: new Date(),
    })
    .where(eq(schema.playerStats.guid, event.guid));

  broadcast({
    type: 'player_disconnect',
    data: {
      slot: event.slot,
      name: event.name,
      timestamp: new Date(event.timestamp * 1000).toISOString(),
    },
  });
}

// Upsert a matchup record (player -> opponent with weapon)
// Note: opponent name comes from JOIN with player_stats, not stored here
async function upsertMatchup(
  playerGuid: string,
  opponentGuid: string,
  opponentIsBot: boolean,
  weapon: string,
  field: 'kills' | 'deaths' | 'teamKills' | 'teamDeaths'
) {
  // Try to update existing record
  const result = await db
    .update(schema.playerMatchups)
    .set({
      [field]: sql`${schema.playerMatchups[field]} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.playerMatchups.playerGuid, playerGuid),
        eq(schema.playerMatchups.opponentGuid, opponentGuid),
        eq(schema.playerMatchups.weapon, weapon)
      )
    );

  // If no rows updated, insert new record
  if (result.rowCount === 0) {
    await db.insert(schema.playerMatchups).values({
      playerGuid,
      opponentGuid,
      opponentIsBot,
      weapon,
      [field]: 1,
    });
  }
}

export async function handleKill(event: KillEvent) {
  const isVictimBot = event.victim_is_bot || event.kill_type === 'bot';
  const isTeamKill = event.is_team_kill || event.kill_type === 'teamkill';

  // Log the kill (we could add display name columns to kill_log later if needed)
  await db.insert(schema.killLog).values({
    killerGuid: event.killer_guid,
    victimGuid: event.victim_guid,
    killerName: event.killer_name,
    victimName: event.victim_name,
    weapon: event.weapon,
    map: event.map,
    isTeamKill: isTeamKill,
    killerIsBot: false,  // Killer is always human in kill events
    victimIsBot: isVictimBot,
    timestamp: new Date(event.timestamp * 1000),
  });

  // Update killer's aggregate stats
  if (isTeamKill) {
    await db
      .update(schema.playerStats)
      .set({
        // Team kills don't count as regular kills, but we track them
        // Could add teamKills column to playerStats if desired
      })
      .where(eq(schema.playerStats.guid, event.killer_guid));
  } else if (isVictimBot) {
    await db
      .update(schema.playerStats)
      .set({
        botKills: sql`${schema.playerStats.botKills} + 1`,
      })
      .where(eq(schema.playerStats.guid, event.killer_guid));
  } else {
    await db
      .update(schema.playerStats)
      .set({
        kills: sql`${schema.playerStats.kills} + 1`,
      })
      .where(eq(schema.playerStats.guid, event.killer_guid));
  }

  // Update matchup stats (killer's perspective)
  const matchupField = isTeamKill ? 'teamKills' : 'kills';
  await upsertMatchup(
    event.killer_guid,
    event.victim_guid,
    isVictimBot,
    event.weapon,
    matchupField
  );

  broadcast({
    type: 'kill',
    data: {
      killer: event.killer_name,
      victim: event.victim_name,
      victimIsBot: isVictimBot,
      isTeamKill: isTeamKill,
      weapon: event.weapon,
      timestamp: new Date(event.timestamp * 1000).toISOString(),
    },
  });
}

export async function handleDeath(event: DeathEvent) {
  const isTeamKill = event.is_team_kill || event.death_type === 'teamkill';
  const killerIsBot = event.killer_is_bot || event.death_type === 'bot';

  // Update victim's aggregate stats based on death type
  if (event.death_type === 'suicide') {
    await db
      .update(schema.playerStats)
      .set({
        suicides: sql`${schema.playerStats.suicides} + 1`,
      })
      .where(eq(schema.playerStats.guid, event.guid));
  } else if (isTeamKill) {
    // Team deaths don't count as regular deaths, but we track them
    // Could add teamDeaths column to playerStats if desired
  } else if (killerIsBot) {
    await db
      .update(schema.playerStats)
      .set({
        botDeaths: sql`${schema.playerStats.botDeaths} + 1`,
      })
      .where(eq(schema.playerStats.guid, event.guid));
  } else {
    await db
      .update(schema.playerStats)
      .set({
        deaths: sql`${schema.playerStats.deaths} + 1`,
      })
      .where(eq(schema.playerStats.guid, event.guid));
  }

  // Update matchup stats (victim's perspective) - only if there's a killer
  if (event.killer_guid && event.death_type !== 'suicide') {
    const matchupField = isTeamKill ? 'teamDeaths' : 'deaths';
    await upsertMatchup(
      event.guid,
      event.killer_guid,
      killerIsBot,
      event.cause,
      matchupField
    );
  }

  broadcast({
    type: 'death',
    data: {
      name: event.name,
      killer: event.killer_name,
      killerIsBot: killerIsBot,
      deathType: event.death_type,
      isTeamKill: isTeamKill,
      cause: event.cause,
      timestamp: new Date(event.timestamp * 1000).toISOString(),
    },
  });
}

export async function handleChat(event: ChatEvent) {
  broadcast({
    type: 'chat',
    data: {
      name: event.name,
      message: event.message,
      team: event.team,
      timestamp: new Date(event.timestamp * 1000).toISOString(),
    },
  });
}
