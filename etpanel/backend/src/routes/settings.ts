import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';

// ============================================================================
// Quick Sound Commands - Settings API
// ============================================================================
// Allows players to trigger sounds from chat using a prefix + alias.
// Example: Player types "*lol" in chat → plays their "laugh" sound + shows "LOLOL" in chat
// ============================================================================

// Blocked prefixes - reserved for other ET functionality
const BLOCKED_PREFIXES = ['!', '/', '\\'];

// Validation schemas
const aliasRegex = /^[a-zA-Z0-9_]+$/;
const aliasMessage = 'Only letters, numbers, and underscores allowed';

const updatePrefixSchema = z.object({
  prefix: z.string().min(1).max(4),
});

const createAliasSchema = z.object({
  alias: z.string().min(1).max(16).regex(aliasRegex, aliasMessage),
  soundAlias: z.string().min(1).max(32).optional(),    // User's sound alias (optional if publicSoundId set)
  publicSoundId: z.number().positive().optional(),      // Public sound file ID (optional if soundAlias set)
  chatText: z.string().max(128).nullable().optional(),  // Chat replacement text (null/empty = no chat)
});

const updateAliasSchema = z.object({
  chatText: z.string().max(128).nullable().optional(),
});

/**
 * Validate a prefix string
 * Returns { valid: true } or { valid: false, error: string }
 */
function validatePrefix(prefix: string): { valid: boolean; error?: string } {
  if (!prefix || prefix.length === 0) {
    return { valid: false, error: 'Prefix cannot be empty' };
  }
  if (prefix.length > 4) {
    return { valid: false, error: 'Prefix must be 4 characters or less' };
  }
  // Allow trailing space (e.g., "v " for "v lol"), but not leading/middle whitespace
  if (/^\s/.test(prefix)) {
    return { valid: false, error: 'Prefix cannot start with whitespace' };
  }
  if (/\s[^\s]/.test(prefix)) {
    return { valid: false, error: 'Prefix cannot have whitespace before other characters' };
  }
  for (const blocked of BLOCKED_PREFIXES) {
    if (prefix.startsWith(blocked)) {
      return { valid: false, error: `Prefix cannot start with "${blocked}" (reserved)` };
    }
  }
  return { valid: true };
}

// Helper to get user's GUID from their account
async function getUserGuid(userId: number): Promise<string | null> {
  const [user] = await db
    .select({ guid: schema.users.guid })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user?.guid || null;
}

// Default quick command prefix
const DEFAULT_PREFIX = '@';

// Helper to get or create player settings
async function getOrCreatePlayerSettings(guid: string): Promise<{ prefix: string }> {
  // Try to get existing settings
  const [existing] = await db
    .select({ quickCmdPrefix: schema.playerSettings.quickCmdPrefix })
    .from(schema.playerSettings)
    .where(eq(schema.playerSettings.guid, guid))
    .limit(1);

  if (existing) {
    return { prefix: existing.quickCmdPrefix };
  }

  // Create default settings
  await db.insert(schema.playerSettings).values({
    guid,
    quickCmdPrefix: DEFAULT_PREFIX,
  });

  return { prefix: DEFAULT_PREFIX };
}

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  // ============================================================================
  // GET /api/settings/quick-command
  // Get player's quick command settings (prefix + all aliases)
  // ============================================================================
  fastify.get(
    '/quick-command',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.user.userId;
      const guid = await getUserGuid(userId);

      if (!guid) {
        return reply.status(400).send({
          error: 'No linked ET account. Please link your account in-game first.',
        });
      }

      // Get player settings (creates default if not exists)
      const settings = await getOrCreatePlayerSettings(guid);

      // Get all quick command aliases with sound info
      const aliasesResult = await db.execute(sql`
        SELECT
          qca.alias,
          qca.chat_text as "chatText",
          qca.is_public as "isPublic",
          COALESCE(us.alias, sf.original_name) as "soundAlias"
        FROM quick_command_aliases qca
        LEFT JOIN user_sounds us ON qca.user_sound_id = us.id
        LEFT JOIN sound_files sf ON qca.sound_file_id = sf.id
        WHERE qca.guid = ${guid}
        ORDER BY qca.alias
      `);

      const aliases = aliasesResult.rows.map((row) => ({
        alias: row.alias as string,
        soundAlias: row.soundAlias as string,
        isPublic: row.isPublic as boolean,
        chatText: row.chatText as string | null,
      }));

      return {
        prefix: settings.prefix,
        aliases,
      };
    }
  );

  // ============================================================================
  // PUT /api/settings/quick-command/prefix
  // Update quick command prefix
  // ============================================================================
  fastify.put(
    '/quick-command/prefix',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.user.userId;
      const guid = await getUserGuid(userId);

      if (!guid) {
        return reply.status(400).send({
          error: 'No linked ET account. Please link your account in-game first.',
        });
      }

      // Parse and validate input
      const parseResult = updatePrefixSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      const { prefix } = parseResult.data;

      // Validate prefix (blocked chars, whitespace, etc.)
      const validation = validatePrefix(prefix);
      if (!validation.valid) {
        return reply.status(400).send({ error: validation.error });
      }

      // Upsert player settings
      await db
        .insert(schema.playerSettings)
        .values({
          guid,
          quickCmdPrefix: prefix,
        })
        .onConflictDoUpdate({
          target: schema.playerSettings.guid,
          set: {
            quickCmdPrefix: prefix,
            updatedAt: new Date(),
          },
        });

      return { success: true, prefix };
    }
  );

  // ============================================================================
  // POST /api/settings/quick-command/alias
  // Create or update a quick command alias
  // ============================================================================
  fastify.post(
    '/quick-command/alias',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.user.userId;
      const guid = await getUserGuid(userId);

      if (!guid) {
        return reply.status(400).send({
          error: 'No linked ET account. Please link your account in-game first.',
        });
      }

      // Parse and validate input
      const parseResult = createAliasSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      const { alias, soundAlias, publicSoundId, chatText } = parseResult.data;

      // Must provide either soundAlias OR publicSoundId
      if (!soundAlias && !publicSoundId) {
        return reply.status(400).send({
          error: 'Must provide either soundAlias or publicSoundId',
        });
      }

      if (soundAlias && publicSoundId) {
        return reply.status(400).send({
          error: 'Cannot provide both soundAlias and publicSoundId',
        });
      }

      let userSoundId: number | null = null;
      let soundFileId: number | null = null;
      let isPublic = false;

      if (soundAlias) {
        // Look up user's sound by alias
        const [userSound] = await db
          .select({ id: schema.userSounds.id })
          .from(schema.userSounds)
          .where(
            and(
              eq(schema.userSounds.guid, guid),
              eq(schema.userSounds.alias, soundAlias)
            )
          )
          .limit(1);

        if (!userSound) {
          return reply.status(404).send({
            error: `Sound "${soundAlias}" not found in your library`,
          });
        }

        userSoundId = userSound.id;
      } else if (publicSoundId) {
        // Verify public sound exists
        const [soundFile] = await db
          .select({ id: schema.soundFiles.id, isPublic: schema.soundFiles.isPublic })
          .from(schema.soundFiles)
          .where(eq(schema.soundFiles.id, publicSoundId))
          .limit(1);

        if (!soundFile) {
          return reply.status(404).send({
            error: 'Public sound not found',
          });
        }

        if (!soundFile.isPublic) {
          return reply.status(400).send({
            error: 'Sound is not public',
          });
        }

        soundFileId = publicSoundId;
        isPublic = true;
      }

      // Normalize chatText: convert empty string to null
      const normalizedChatText = chatText?.trim() || null;

      // Upsert the alias
      await db
        .insert(schema.quickCommandAliases)
        .values({
          guid,
          alias: alias.toLowerCase(), // Normalize alias to lowercase
          userSoundId,
          soundFileId,
          isPublic,
          chatText: normalizedChatText,
        })
        .onConflictDoUpdate({
          target: [schema.quickCommandAliases.guid, schema.quickCommandAliases.alias],
          set: {
            userSoundId,
            soundFileId,
            isPublic,
            chatText: normalizedChatText,
            updatedAt: new Date(),
          },
        });

      return {
        success: true,
        alias: alias.toLowerCase(),
        chatText: normalizedChatText,
      };
    }
  );

  // ============================================================================
  // PUT /api/settings/quick-command/alias/:alias
  // Update an existing quick command alias (e.g., just change chat text)
  // ============================================================================
  fastify.put<{ Params: { alias: string } }>(
    '/quick-command/alias/:alias',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.user.userId;
      const guid = await getUserGuid(userId);

      if (!guid) {
        return reply.status(400).send({
          error: 'No linked ET account. Please link your account in-game first.',
        });
      }

      const aliasParam = request.params.alias.toLowerCase();

      // Parse and validate input
      const parseResult = updateAliasSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      const { chatText } = parseResult.data;

      // Check if alias exists
      const [existing] = await db
        .select({ id: schema.quickCommandAliases.id })
        .from(schema.quickCommandAliases)
        .where(
          and(
            eq(schema.quickCommandAliases.guid, guid),
            eq(schema.quickCommandAliases.alias, aliasParam)
          )
        )
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: `Quick command alias "${aliasParam}" not found`,
        });
      }

      // Normalize chatText: convert empty string to null
      const normalizedChatText = chatText?.trim() || null;

      // Update the alias
      await db
        .update(schema.quickCommandAliases)
        .set({
          chatText: normalizedChatText,
          updatedAt: new Date(),
        })
        .where(eq(schema.quickCommandAliases.id, existing.id));

      return {
        success: true,
        alias: aliasParam,
        chatText: normalizedChatText,
      };
    }
  );

  // ============================================================================
  // DELETE /api/settings/quick-command/alias/:alias
  // Remove a quick command alias
  // ============================================================================
  fastify.delete<{ Params: { alias: string } }>(
    '/quick-command/alias/:alias',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.user.userId;
      const guid = await getUserGuid(userId);

      if (!guid) {
        return reply.status(400).send({
          error: 'No linked ET account. Please link your account in-game first.',
        });
      }

      const aliasParam = request.params.alias.toLowerCase();

      // Delete the alias
      const result = await db
        .delete(schema.quickCommandAliases)
        .where(
          and(
            eq(schema.quickCommandAliases.guid, guid),
            eq(schema.quickCommandAliases.alias, aliasParam)
          )
        )
        .returning({ id: schema.quickCommandAliases.id });

      if (result.length === 0) {
        return reply.status(404).send({
          error: `Quick command alias "${aliasParam}" not found`,
        });
      }

      return { success: true, alias: aliasParam };
    }
  );
};
