import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and, desc, asc, sql, ilike, or } from 'drizzle-orm';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { SOUNDS_DIR, SOUNDS_TEMP_DIR, MAX_CLIP_DURATION_SECONDS } from '../config.js';
import {
  getAudioDuration,
  generateWaveformPeaks,
  clipAndConvertAudio,
  ensureTempDir,
  cleanupTempFiles,
  deleteTempFile,
  getTempFileExtension,
} from '../utils/audio.js';

// Supported audio formats
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav'];
const SUPPORTED_CONTENT_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav'];

// Validation schemas
// Aliases allow: letters, numbers, underscores, and dashes
const aliasRegex = /^[a-zA-Z0-9_-]+$/;
const aliasMessage = 'Only letters, numbers, underscores, and dashes allowed';

const addSoundSchema = z.object({
  alias: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
  visibility: z.enum(['private', 'shared', 'public']).optional().default('private'),
});

const renameSoundSchema = z.object({
  newAlias: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
});

const visibilitySchema = z.object({
  visibility: z.enum(['private', 'shared', 'public']),
});

const createPlaylistSchema = z.object({
  name: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
  description: z.string().max(256).optional(),
});

const playlistItemSchema = z.object({
  soundAlias: z.string().min(1).max(32),
});

const reorderPlaylistSchema = z.object({
  soundAliases: z.array(z.string().min(1).max(32)),
});

const shareSchema = z.object({
  toGuid: z.string().length(32),
  suggestedAlias: z.string().min(1).max(32).optional(),
});

const acceptShareSchema = z.object({
  alias: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
});

const verifyCodeSchema = z.object({
  code: z.string().length(6),
});

const uploadFromUrlSchema = z.object({
  url: z.string().url(),
  alias: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
});

const tempUploadFromUrlSchema = z.object({
  url: z.string().url(),
});

const saveClipSchema = z.object({
  tempId: z.string().uuid(),
  alias: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
  startTime: z.number().min(0),
  endTime: z.number().min(0),
  isPublic: z.boolean().optional().default(false),
});

// Max file size for temp uploads: 20MB (larger files allowed, will be clipped down)
const MAX_TEMP_FILE_SIZE = 20 * 1024 * 1024;
// Max file size for final clips: 2MB
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// Helper to get MP3 duration - uses FFmpeg if available, falls back to estimate
async function getMP3Duration(filePath: string): Promise<number | null> {
  try {
    // Try accurate FFmpeg-based duration first
    const duration = await getAudioDuration(filePath);
    return Math.round(duration);
  } catch {
    // Fall back to bitrate estimate
    try {
      const stats = statSync(filePath);
      const estimatedDuration = Math.round((stats.size * 8) / (128 * 1000));
      return estimatedDuration > 0 ? estimatedDuration : null;
    } catch {
      return null;
    }
  }
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

export const soundsRoutes: FastifyPluginAsync = async (fastify) => {
  // ============================================================================
  // Sound CRUD Operations
  // ============================================================================

  // List user's sounds
  fastify.get('/', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    // Get sounds with a flag indicating if they're in any public playlist
    // Also include isOwner to indicate if current user uploaded the sound
    // And the list of public playlists and count of private playlists this sound is in
    const query = sql`
      SELECT
        us.id,
        us.alias,
        us.visibility,
        us.created_at as "createdAt",
        us.sound_file_id as "soundFileId",
        sf.original_name as "originalName",
        sf.file_size as "fileSize",
        sf.duration_seconds as "durationSeconds",
        sf.is_public as "isPublic",
        sf.added_by_guid as "addedByGuid",
        CASE WHEN sf.added_by_guid = ${guid} THEN true ELSE false END as "isOwner",
        COALESCE(ps.display_name, ps.name, 'Unknown') as "ownerName",
        COALESCE(
          (SELECT json_agg(json_build_object('id', sp.id, 'name', sp.name))
           FROM sound_playlist_items spi
           JOIN sound_playlists sp ON sp.id = spi.playlist_id
           WHERE spi.user_sound_id = us.id AND sp.is_public = true),
          '[]'::json
        ) as "publicPlaylists",
        COALESCE(
          (SELECT json_agg(json_build_object('id', sp.id, 'name', sp.name))
           FROM sound_playlist_items spi
           JOIN sound_playlists sp ON sp.id = spi.playlist_id
           WHERE spi.user_sound_id = us.id AND sp.is_public = false AND sp.guid = ${guid}),
          '[]'::json
        ) as "privatePlaylists"
      FROM user_sounds us
      INNER JOIN sound_files sf ON sf.id = us.sound_file_id
      LEFT JOIN player_stats ps ON ps.guid = sf.added_by_guid
      WHERE us.guid = ${guid}
      ORDER BY us.alias ASC
    `;

    const result = await db.execute(query);
    const sounds = result.rows;

    return { sounds, count: sounds.length };
  });

  // Get a specific sound
  fastify.get('/:alias', { preHandler: authenticate }, async (request, reply) => {
    const { alias } = request.params as { alias: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const [sound] = await db
      .select({
        id: schema.userSounds.id,
        alias: schema.userSounds.alias,
        visibility: schema.userSounds.visibility,
        createdAt: schema.userSounds.createdAt,
        updatedAt: schema.userSounds.updatedAt,
        soundFileId: schema.userSounds.soundFileId,
        originalName: schema.soundFiles.originalName,
        filePath: schema.soundFiles.filePath,
        fileSize: schema.soundFiles.fileSize,
        durationSeconds: schema.soundFiles.durationSeconds,
        isPublic: schema.soundFiles.isPublic,
      })
      .from(schema.userSounds)
      .innerJoin(schema.soundFiles, eq(schema.userSounds.soundFileId, schema.soundFiles.id))
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (!sound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    return sound;
  });

  // Rename a sound
  fastify.patch('/:alias', { preHandler: authenticate }, async (request, reply) => {
    const { alias } = request.params as { alias: string };
    const body = renameSoundSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Check if new alias already exists
    const [existing] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, body.data.newAlias)))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: 'A sound with that name already exists' });
    }

    const result = await db
      .update(schema.userSounds)
      .set({ alias: body.data.newAlias, updatedAt: new Date() })
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    return { success: true, alias: body.data.newAlias };
  });

  // Delete a sound
  fastify.delete('/:alias', { preHandler: authenticate }, async (request, reply) => {
    const { alias } = request.params as { alias: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get sound info first
    const [sound] = await db
      .select({
        id: schema.userSounds.id,
        soundFileId: schema.userSounds.soundFileId,
        visibility: schema.userSounds.visibility,
      })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (!sound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    // Get file info
    const [file] = await db
      .select({ referenceCount: schema.soundFiles.referenceCount, filePath: schema.soundFiles.filePath })
      .from(schema.soundFiles)
      .where(eq(schema.soundFiles.id, sound.soundFileId))
      .limit(1);

    // Delete user_sounds entry
    await db.delete(schema.userSounds).where(eq(schema.userSounds.id, sound.id));

    // Decrement reference count
    await db
      .update(schema.soundFiles)
      .set({ referenceCount: sql`${schema.soundFiles.referenceCount} - 1` })
      .where(eq(schema.soundFiles.id, sound.soundFileId));

    // If this was the last reference and it was private, delete the file record
    // (actual file deletion would be handled by a cleanup job)
    if (file && file.referenceCount === 1 && sound.visibility === 'private') {
      await db.delete(schema.soundFiles).where(eq(schema.soundFiles.id, sound.soundFileId));
      // TODO: Queue file for deletion from disk
    }

    return { success: true };
  });

  // Set sound visibility
  fastify.patch('/:alias/visibility', { preHandler: authenticate }, async (request, reply) => {
    const { alias } = request.params as { alias: string };
    const body = request.body as { visibility?: string; removeFromPublicPlaylists?: boolean };

    if (!body.visibility || !['private', 'public', 'shared'].includes(body.visibility)) {
      return reply.status(400).send({ error: 'Invalid visibility value' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get user_sound ID and sound file ID
    const [sound] = await db
      .select({ id: schema.userSounds.id, soundFileId: schema.userSounds.soundFileId })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (!sound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    // If setting to private and removeFromPublicPlaylists is true, remove from public playlists
    if (body.visibility === 'private' && body.removeFromPublicPlaylists) {
      // Find all public playlists this sound is in
      const publicPlaylistItems = await db
        .select({ itemId: schema.soundPlaylistItems.id })
        .from(schema.soundPlaylistItems)
        .innerJoin(schema.soundPlaylists, eq(schema.soundPlaylistItems.playlistId, schema.soundPlaylists.id))
        .where(and(
          eq(schema.soundPlaylistItems.userSoundId, sound.id),
          eq(schema.soundPlaylists.isPublic, true)
        ));

      // Remove from all public playlists
      for (const item of publicPlaylistItems) {
        await db
          .delete(schema.soundPlaylistItems)
          .where(eq(schema.soundPlaylistItems.id, item.itemId));
      }
    }

    // Update user_sounds visibility
    await db
      .update(schema.userSounds)
      .set({ visibility: body.visibility as 'private' | 'public' | 'shared', updatedAt: new Date() })
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)));

    // If making public, update sound_files.is_public
    if (body.visibility === 'public') {
      await db
        .update(schema.soundFiles)
        .set({ isPublic: true })
        .where(eq(schema.soundFiles.id, sound.soundFileId));
    }

    return { success: true, visibility: body.visibility };
  });

  // ============================================================================
  // Upload / Import Sounds
  // ============================================================================

  // Upload audio file directly (MP3 or WAV)
  fastify.post('/upload', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Get alias from fields - handle different multipart field formats
    const aliasField = data.fields.alias as unknown;
    let alias: string | undefined;
    if (typeof aliasField === 'object' && aliasField !== null) {
      // Could be { value: string } or an array
      const field = aliasField as Record<string, unknown>;
      if ('value' in field && typeof field.value === 'string') {
        alias = field.value;
      } else if (Array.isArray(aliasField)) {
        const first = aliasField[0] as Record<string, unknown> | undefined;
        if (first && typeof first.value === 'string') {
          alias = first.value;
        }
      }
    } else if (typeof aliasField === 'string') {
      alias = aliasField;
    }

    if (!alias || !aliasRegex.test(alias)) {
      fastify.log.warn({ fields: data.fields, aliasField }, 'Invalid alias field');
      return reply.status(400).send({ error: `Invalid alias. ${aliasMessage}` });
    }

    // Check alias doesn't already exist for this user
    const [existingAlias] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (existingAlias) {
      return reply.status(409).send({ error: 'You already have a sound with this alias' });
    }

    // Validate file type (MP3 or WAV)
    const ext = extname(data.filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return reply.status(400).send({ error: 'Only MP3 and WAV files are allowed' });
    }

    // Read file into buffer to check size
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length > MAX_FILE_SIZE) {
      return reply.status(400).send({ error: 'File too large. Maximum size is 2MB.' });
    }

    // Ensure sounds directory exists
    if (!existsSync(SOUNDS_DIR)) {
      mkdirSync(SOUNDS_DIR, { recursive: true });
    }

    // Generate unique filename (preserve original extension)
    const uniqueFilename = `${randomUUID()}${ext}`;
    const filePath = join(SOUNDS_DIR, uniqueFilename);

    // Write file
    writeFileSync(filePath, buffer);

    // Get duration estimate
    const durationSeconds = await getMP3Duration(filePath);

    // Create sound file record
    const [soundFile] = await db
      .insert(schema.soundFiles)
      .values({
        filename: uniqueFilename,
        originalName: data.filename,
        filePath: uniqueFilename,
        fileSize: buffer.length,
        durationSeconds,
        addedByGuid: guid,
        isPublic: false,
        referenceCount: 1,
      })
      .returning({ id: schema.soundFiles.id });

    // Create user sound record
    await db.insert(schema.userSounds).values({
      guid,
      soundFileId: soundFile.id,
      alias,
      visibility: 'private',
    });

    return {
      success: true,
      alias,
      fileSize: buffer.length,
      durationSeconds,
    };
  });

  // Import sound from URL
  fastify.post('/import-url', { preHandler: authenticate }, async (request, reply) => {
    const body = uploadFromUrlSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request. Provide url and alias.' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    const { url, alias } = body.data;

    // Check alias doesn't already exist for this user
    const [existingAlias] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (existingAlias) {
      return reply.status(409).send({ error: 'You already have a sound with this alias' });
    }

    try {
      // Fetch the URL
      const response = await fetch(url);
      if (!response.ok) {
        return reply.status(400).send({ error: `Failed to download: ${response.statusText}` });
      }

      // Check content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('audio/mpeg') && !contentType.includes('audio/mp3')) {
        // Also allow if URL ends with .mp3
        if (!url.toLowerCase().endsWith('.mp3')) {
          return reply.status(400).send({ error: 'URL does not point to an MP3 file' });
        }
      }

      // Check content length if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        return reply.status(400).send({ error: 'File too large. Maximum size is 2MB.' });
      }

      // Read the file
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > MAX_FILE_SIZE) {
        return reply.status(400).send({ error: 'File too large. Maximum size is 2MB.' });
      }

      // Ensure sounds directory exists
      if (!existsSync(SOUNDS_DIR)) {
        mkdirSync(SOUNDS_DIR, { recursive: true });
      }

      // Generate unique filename
      const uniqueFilename = `${randomUUID()}.mp3`;
      const filePath = join(SOUNDS_DIR, uniqueFilename);

      // Extract original filename from URL
      const urlPath = new URL(url).pathname;
      const originalName = urlPath.split('/').pop() || `${alias}.mp3`;

      // Write file
      writeFileSync(filePath, buffer);

      // Get duration estimate
      const durationSeconds = await getMP3Duration(filePath);

      // Create sound file record
      const [soundFile] = await db
        .insert(schema.soundFiles)
        .values({
          filename: uniqueFilename,
          originalName,
          filePath: uniqueFilename,
          fileSize: buffer.length,
          durationSeconds,
          addedByGuid: guid,
          isPublic: false,
          referenceCount: 1,
        })
        .returning({ id: schema.soundFiles.id });

      // Create user sound record
      await db.insert(schema.userSounds).values({
        guid,
        soundFileId: soundFile.id,
        alias,
        visibility: 'private',
      });

      return {
        success: true,
        alias,
        fileSize: buffer.length,
        durationSeconds,
        originalName,
      };
    } catch (err) {
      fastify.log.error({ err }, 'URL import error');
      return reply.status(500).send({ error: 'Failed to download file from URL' });
    }
  });

  // ============================================================================
  // Temp Upload & Clip Editor (NEW)
  // ============================================================================

  // Upload audio file to temp storage for editing (MP3 or WAV)
  fastify.post('/upload-temp', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Validate file type (MP3 or WAV)
    const ext = extname(data.filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return reply.status(400).send({ error: 'Only MP3 and WAV files are allowed' });
    }

    // Read file into buffer
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length > MAX_TEMP_FILE_SIZE) {
      return reply.status(400).send({ error: 'File too large. Maximum size is 20MB for editing.' });
    }

    // Ensure temp directory exists
    ensureTempDir();

    // Generate temp file ID (preserve original extension)
    const tempId = randomUUID();
    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}${ext}`);

    // Write file to temp storage
    writeFileSync(tempFilePath, buffer);

    // Get accurate duration using ffprobe
    let durationSeconds: number;
    try {
      durationSeconds = await getAudioDuration(tempFilePath);
    } catch (err) {
      // Clean up and report error
      unlinkSync(tempFilePath);
      fastify.log.error({ err }, 'Failed to get audio duration');
      return reply.status(400).send({ error: 'Could not read audio file. Make sure it is a valid audio file.' });
    }

    return {
      success: true,
      tempId,
      durationSeconds,
      fileSize: buffer.length,
      originalName: data.filename,
      maxClipDuration: MAX_CLIP_DURATION_SECONDS,
      format: ext.substring(1), // 'mp3' or 'wav'
    };
  });

  // Import audio from URL to temp storage for editing (MP3 or WAV)
  fastify.post('/import-url-temp', { preHandler: authenticate }, async (request, reply) => {
    const body = tempUploadFromUrlSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request. Provide a valid URL.' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    const { url } = body.data;

    try {
      // Fetch the URL
      const response = await fetch(url);
      if (!response.ok) {
        return reply.status(400).send({ error: `Failed to download: ${response.statusText}` });
      }

      // Check content type
      const contentType = response.headers.get('content-type') || '';
      const isValidContentType = SUPPORTED_CONTENT_TYPES.some(ct => contentType.includes(ct));

      // Determine file extension from URL or content type
      const urlLower = url.toLowerCase();
      let ext = '.mp3'; // default
      if (urlLower.endsWith('.wav') || contentType.includes('wav')) {
        ext = '.wav';
      } else if (urlLower.endsWith('.mp3') || contentType.includes('mpeg') || contentType.includes('mp3')) {
        ext = '.mp3';
      } else if (!isValidContentType) {
        return reply.status(400).send({ error: 'URL does not point to an MP3 or WAV file' });
      }

      // Check content length if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_TEMP_FILE_SIZE) {
        return reply.status(400).send({ error: 'File too large. Maximum size is 20MB for editing.' });
      }

      // Read the file
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > MAX_TEMP_FILE_SIZE) {
        return reply.status(400).send({ error: 'File too large. Maximum size is 20MB for editing.' });
      }

      // Ensure temp directory exists
      ensureTempDir();

      // Generate temp file ID (with detected extension)
      const tempId = randomUUID();
      const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}${ext}`);

      // Extract original filename from URL
      const urlPath = new URL(url).pathname;
      const originalName = urlPath.split('/').pop() || `downloaded${ext}`;

      // Write file to temp storage
      writeFileSync(tempFilePath, buffer);

      // Get accurate duration using ffprobe
      let durationSeconds: number;
      try {
        durationSeconds = await getAudioDuration(tempFilePath);
      } catch (err) {
        // Clean up and report error
        unlinkSync(tempFilePath);
        fastify.log.error({ err }, 'Failed to get audio duration');
        return reply.status(400).send({ error: 'Could not read audio file. Make sure the URL points to a valid audio file.' });
      }

      return {
        success: true,
        tempId,
        durationSeconds,
        fileSize: buffer.length,
        originalName,
        maxClipDuration: MAX_CLIP_DURATION_SECONDS,
        format: ext.substring(1), // 'mp3' or 'wav'
      };
    } catch (err) {
      fastify.log.error({ err }, 'URL temp import error');
      return reply.status(500).send({ error: 'Failed to download file from URL' });
    }
  });

  // Stream temp file for preview (MP3 or WAV)
  fastify.get('/temp/:tempId', { preHandler: authenticate }, async (request, reply) => {
    const { tempId } = request.params as { tempId: string };

    // Validate tempId is a valid UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempId)) {
      return reply.status(400).send({ error: 'Invalid temp file ID' });
    }

    // Check for both extensions
    const ext = getTempFileExtension(tempId);
    if (!ext) {
      return reply.status(404).send({ error: 'Temp file not found or expired' });
    }

    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}${ext}`);
    const contentType = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';

    const stats = statSync(tempFilePath);
    const range = request.headers.range;

    if (range) {
      // Handle range requests for seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = end - start + 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.header('Content-Type', contentType);

      return reply.send(createReadStream(tempFilePath, { start, end }));
    }

    reply.header('Content-Length', stats.size);
    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', 'bytes');

    return reply.send(createReadStream(tempFilePath));
  });

  // Get waveform data for temp file (MP3 or WAV)
  fastify.get('/temp/:tempId/waveform', { preHandler: authenticate }, async (request, reply) => {
    const { tempId } = request.params as { tempId: string };

    // Validate tempId is a valid UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempId)) {
      return reply.status(400).send({ error: 'Invalid temp file ID' });
    }

    // Check for both extensions
    const ext = getTempFileExtension(tempId);
    if (!ext) {
      return reply.status(404).send({ error: 'Temp file not found or expired' });
    }

    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}${ext}`);

    try {
      const peaks = await generateWaveformPeaks(tempFilePath, 200);
      return { peaks };
    } catch (err) {
      fastify.log.error({ err }, 'Failed to generate waveform');
      // Return flat waveform on error
      return { peaks: new Array(200).fill(0.1) };
    }
  });

  // Save clipped audio as permanent sound (preserves WAV format)
  fastify.post('/save-clip', { preHandler: authenticate }, async (request, reply) => {
    const body = saveClipSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    const { tempId, alias, startTime, endTime, isPublic } = body.data;

    // Validate clip duration
    const clipDuration = endTime - startTime;
    if (clipDuration <= 0) {
      return reply.status(400).send({ error: 'End time must be after start time' });
    }
    if (clipDuration > MAX_CLIP_DURATION_SECONDS) {
      return reply.status(400).send({ error: `Clip duration cannot exceed ${MAX_CLIP_DURATION_SECONDS} seconds` });
    }

    // Check alias doesn't already exist for this user
    const [existingAlias] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (existingAlias) {
      return reply.status(409).send({ error: 'You already have a sound with this alias' });
    }

    // Check temp file exists (could be .mp3 or .wav)
    const ext = getTempFileExtension(tempId);
    if (!ext) {
      return reply.status(404).send({ error: 'Temp file not found or expired. Please upload again.' });
    }

    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}${ext}`);

    // Ensure sounds directory exists
    if (!existsSync(SOUNDS_DIR)) {
      mkdirSync(SOUNDS_DIR, { recursive: true });
    }

    // Generate unique filename for permanent storage (preserve format)
    const uniqueFilename = `${randomUUID()}${ext}`;
    const permanentFilePath = join(SOUNDS_DIR, uniqueFilename);

    try {
      // Clip and convert the audio (preserves WAV if input is WAV)
      const { duration, fileSize } = await clipAndConvertAudio(
        tempFilePath,
        permanentFilePath,
        startTime,
        endTime
      );

      // Check final file size (WAV files are larger, allow more for them)
      const maxSize = ext === '.wav' ? MAX_FILE_SIZE * 3 : MAX_FILE_SIZE; // 6MB for WAV, 2MB for MP3
      if (fileSize > maxSize) {
        // Clean up the clipped file
        unlinkSync(permanentFilePath);
        return reply.status(400).send({
          error: `Clipped audio exceeds ${maxSize / 1024 / 1024}MB. Try selecting a shorter portion.`,
        });
      }

      // Create sound file record
      const [soundFile] = await db
        .insert(schema.soundFiles)
        .values({
          filename: uniqueFilename,
          originalName: `${alias}${ext}`,
          filePath: uniqueFilename,
          fileSize,
          durationSeconds: duration,
          addedByGuid: guid,
          isPublic,
          referenceCount: 1,
        })
        .returning({ id: schema.soundFiles.id });

      // Create user sound record
      await db.insert(schema.userSounds).values({
        guid,
        soundFileId: soundFile.id,
        alias,
        visibility: isPublic ? 'public' : 'private',
      });

      // Clean up temp file
      deleteTempFile(tempId);

      return {
        success: true,
        alias,
        fileSize,
        durationSeconds: duration,
        isPublic,
      };
    } catch (err) {
      fastify.log.error({ err }, 'Error saving clipped audio');
      // Clean up any partial files
      if (existsSync(permanentFilePath)) {
        unlinkSync(permanentFilePath);
      }
      return reply.status(500).send({ error: 'Failed to process audio clip' });
    }
  });

  // Copy existing sound to temp storage for re-editing/clipping
  fastify.post('/copy-to-temp/:alias', { preHandler: authenticate }, async (request, reply) => {
    const { alias } = request.params as { alias: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    // Get the user's sound
    const [sound] = await db
      .select({
        filePath: schema.soundFiles.filePath,
        originalName: schema.soundFiles.originalName,
        fileSize: schema.soundFiles.fileSize,
      })
      .from(schema.userSounds)
      .innerJoin(schema.soundFiles, eq(schema.userSounds.soundFileId, schema.soundFiles.id))
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (!sound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    // Check file exists
    const sourcePath = sound.filePath.startsWith('/') ? sound.filePath : join(SOUNDS_DIR, sound.filePath);
    if (!existsSync(sourcePath)) {
      return reply.status(404).send({ error: 'Sound file not found on disk' });
    }

    // Ensure temp directory exists
    ensureTempDir();

    // Generate temp file ID and copy file
    const tempId = randomUUID();
    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);

    try {
      // Copy the file to temp storage
      const { copyFileSync } = await import('fs');
      copyFileSync(sourcePath, tempFilePath);

      // Get accurate duration using ffprobe
      let durationSeconds: number;
      try {
        durationSeconds = await getAudioDuration(tempFilePath);
      } catch (err) {
        // Clean up and report error
        unlinkSync(tempFilePath);
        fastify.log.error({ err }, 'Failed to get audio duration');
        return reply.status(400).send({ error: 'Could not read audio file.' });
      }

      return {
        success: true,
        tempId,
        durationSeconds,
        fileSize: statSync(tempFilePath).size,
        originalName: sound.originalName,
        maxClipDuration: MAX_CLIP_DURATION_SECONDS,
      };
    } catch (err) {
      fastify.log.error({ err }, 'Error copying sound to temp');
      // Clean up if partial file was created
      if (existsSync(tempFilePath)) {
        unlinkSync(tempFilePath);
      }
      return reply.status(500).send({ error: 'Failed to copy sound file' });
    }
  });

  // Copy public sound to temp storage for clipping
  fastify.post('/copy-public-to-temp/:soundFileId', { preHandler: authenticate }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const fileId = parseInt(soundFileId, 10);

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    // Get the public sound file - allow if directly public OR in a public playlist
    const query = sql`
      SELECT DISTINCT sf.file_path as "filePath", sf.original_name as "originalName", sf.file_size as "fileSize"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
      WHERE sf.id = ${fileId}
        AND (sf.is_public = true OR sp.is_public = true OR us.visibility = 'public')
      LIMIT 1
    `;

    const result = await db.execute(query);
    const sound = result.rows[0] as { filePath: string; originalName: string; fileSize: number } | undefined;

    if (!sound) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    // Check file exists
    const sourcePath = sound.filePath.startsWith('/') ? sound.filePath : join(SOUNDS_DIR, sound.filePath);
    if (!existsSync(sourcePath)) {
      return reply.status(404).send({ error: 'Sound file not found on disk' });
    }

    // Ensure temp directory exists
    ensureTempDir();

    // Generate temp file ID and copy file
    const tempId = randomUUID();
    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);

    try {
      // Copy the file to temp storage
      const { copyFileSync } = await import('fs');
      copyFileSync(sourcePath, tempFilePath);

      // Get accurate duration using ffprobe
      let durationSeconds: number;
      try {
        durationSeconds = await getAudioDuration(tempFilePath);
      } catch (err) {
        // Clean up and report error
        unlinkSync(tempFilePath);
        fastify.log.error({ err }, 'Failed to get audio duration');
        return reply.status(400).send({ error: 'Could not read audio file.' });
      }

      return {
        success: true,
        tempId,
        durationSeconds,
        fileSize: statSync(tempFilePath).size,
        originalName: sound.originalName,
        maxClipDuration: MAX_CLIP_DURATION_SECONDS,
      };
    } catch (err) {
      fastify.log.error({ err }, 'Error copying public sound to temp');
      // Clean up if partial file was created
      if (existsSync(tempFilePath)) {
        unlinkSync(tempFilePath);
      }
      return reply.status(500).send({ error: 'Failed to copy sound file' });
    }
  });

  // Delete temp file (cleanup)
  fastify.delete('/temp/:tempId', { preHandler: authenticate }, async (request, reply) => {
    const { tempId } = request.params as { tempId: string };

    // Validate tempId is a valid UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempId)) {
      return reply.status(400).send({ error: 'Invalid temp file ID' });
    }

    const deleted = deleteTempFile(tempId);
    return { success: deleted };
  });

  // Admin: Trigger temp file cleanup
  fastify.post('/admin/cleanup-temp', { preHandler: requireAdmin }, async (request, reply) => {
    const result = await cleanupTempFiles();
    return { success: true, ...result };
  });

  // ============================================================================
  // Public Library
  // ============================================================================

  // List public sounds (includes sounds from public playlists)
  fastify.get('/public/library', { preHandler: authenticate }, async (request, reply) => {
    const { page = '0', search } = request.query as { page?: string; search?: string };
    const pageNum = parseInt(page, 10) || 0;
    const limit = 50;
    const offset = pageNum * limit;

    // Use raw SQL to get DISTINCT sounds that are either:
    // 1. Marked as public in sound_files (isPublic = true), OR
    // 2. Part of a public playlist (via user_sounds -> sound_playlist_items -> sound_playlists where isPublic = true)
    // Show alias from user_sounds when available, fallback to original_name
    const searchCondition = search ? `AND (us.alias ILIKE '%${search.replace(/'/g, "''")}%' OR sf.original_name ILIKE '%${search.replace(/'/g, "''")}%')` : '';

    const query = sql`
      SELECT DISTINCT ON (sf.id)
        sf.id as "soundFileId",
        COALESCE(us.alias, sf.original_name) as "originalName",
        sf.file_size as "fileSize",
        sf.duration_seconds as "durationSeconds",
        sf.added_by_guid as "addedByGuid",
        sf.created_at as "createdAt",
        COALESCE(ps.display_name, ps.name, u.display_name, 'Unknown') as "addedByName",
        sf.is_public as "isDirectlyPublic"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
      LEFT JOIN player_stats ps ON ps.guid = sf.added_by_guid
      LEFT JOIN users u ON u.guid = sf.added_by_guid
      WHERE (sf.is_public = true OR sp.is_public = true)
      ${sql.raw(searchCondition)}
      ORDER BY sf.id, sf.created_at DESC
    `;

    const allSounds = await db.execute(query);

    // Sort by createdAt DESC and apply pagination
    const sortedSounds = (allSounds.rows as any[]).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const totalCount = sortedSounds.length;
    const paginatedSounds = sortedSounds.slice(offset, offset + limit);

    return {
      sounds: paginatedSounds,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limit),
      totalCount,
    };
  });

  // Add public sound to user's library
  fastify.post('/public/:soundFileId', { preHandler: authenticate }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const body = addSoundSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const fileId = parseInt(soundFileId, 10);

    // Check if sound exists and is publicly accessible
    // A sound is public if:
    // 1. soundFiles.isPublic = true (directly public)
    // 2. OR it's in a public playlist
    // 3. OR a user_sound reference has visibility = 'public'
    const publicCheckQuery = sql`
      SELECT DISTINCT sf.id, sf.file_path as "filePath", sf.original_name as "originalName"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
      WHERE sf.id = ${fileId}
        AND (sf.is_public = true OR sp.is_public = true OR us.visibility = 'public')
      LIMIT 1
    `;

    const result = await db.execute(publicCheckQuery);
    const soundFile = result.rows[0] as { id: number; filePath: string; originalName: string } | undefined;

    if (!soundFile) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    // Check if user already has this sound
    const [existing] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.soundFileId, fileId)))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: 'You already have this sound in your library' });
    }

    // Check if alias already exists
    const [aliasExists] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, body.data.alias)))
      .limit(1);

    if (aliasExists) {
      return reply.status(409).send({ error: 'You already have a sound with that name' });
    }

    // Add to user's library
    await db.insert(schema.userSounds).values({
      guid,
      soundFileId: fileId,
      alias: body.data.alias,
      visibility: 'private',
    });

    // Increment reference count
    await db
      .update(schema.soundFiles)
      .set({ referenceCount: sql`${schema.soundFiles.referenceCount} + 1` })
      .where(eq(schema.soundFiles.id, fileId));

    return { success: true, alias: body.data.alias };
  });

  // ============================================================================
  // Playlists
  // ============================================================================

  // List playlists (own + public from others)
  fastify.get('/playlists', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get own playlists + public playlists from others
    const playlistsQuery = sql`
      SELECT
        sp.id,
        sp.name,
        sp.description,
        sp.is_public as "isPublic",
        sp.current_position as "currentPosition",
        sp.created_at as "createdAt",
        sp.guid as "ownerGuid",
        (SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = sp.id) as "soundCount",
        CASE WHEN sp.guid = ${guid} THEN true ELSE false END as "isOwner",
        COALESCE(ps.display_name, ps.name, u.display_name, 'Unknown') as "ownerName"
      FROM sound_playlists sp
      LEFT JOIN player_stats ps ON ps.guid = sp.guid
      LEFT JOIN users u ON u.guid = sp.guid
      WHERE sp.guid = ${guid} OR sp.is_public = true
      ORDER BY
        CASE WHEN sp.guid = ${guid} THEN 0 ELSE 1 END,
        sp.name ASC
    `;

    const result = await db.execute(playlistsQuery);
    const playlists = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      isPublic: row.isPublic,
      currentPosition: row.currentPosition,
      createdAt: row.createdAt,
      soundCount: Number(row.soundCount),
      isOwner: row.isOwner,
      ownerName: row.ownerName,
      ownerGuid: row.ownerGuid,
    }));

    return { playlists };
  });

  // Create playlist
  fastify.post('/playlists', { preHandler: authenticate }, async (request, reply) => {
    const body = createPlaylistSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Check if playlist name already exists
    const [existing] = await db
      .select({ id: schema.soundPlaylists.id })
      .from(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, body.data.name)))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: 'A playlist with that name already exists' });
    }

    const [playlist] = await db
      .insert(schema.soundPlaylists)
      .values({
        guid,
        name: body.data.name,
        description: body.data.description || '',
        isPublic: false,
        currentPosition: 1,
      })
      .returning();

    return { success: true, playlist };
  });

  // Get playlist with sounds (own or public)
  // Use ?id=123 to fetch by ID (for public playlists from others)
  // Or just /playlists/:name for your own
  fastify.get('/playlists/:name', { preHandler: authenticate }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { id: playlistId } = request.query as { id?: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    let playlist;

    if (playlistId) {
      // Fetch by ID - allow if own or public
      const [result] = await db
        .select()
        .from(schema.soundPlaylists)
        .where(eq(schema.soundPlaylists.id, parseInt(playlistId, 10)))
        .limit(1);

      if (!result) {
        return reply.status(404).send({ error: 'Playlist not found' });
      }

      // Must be owner or playlist must be public
      if (result.guid !== guid && !result.isPublic) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      playlist = result;
    } else {
      // Fetch by name - only own playlists
      const [result] = await db
        .select()
        .from(schema.soundPlaylists)
        .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
        .limit(1);

      if (!result) {
        return reply.status(404).send({ error: 'Playlist not found' });
      }

      playlist = result;
    }

    // Get playlist items with sound details
    const items = await db
      .select({
        id: schema.soundPlaylistItems.id,
        orderNumber: schema.soundPlaylistItems.orderNumber,
        addedAt: schema.soundPlaylistItems.addedAt,
        alias: schema.userSounds.alias,
        soundFileId: schema.soundFiles.id,
        fileSize: schema.soundFiles.fileSize,
        durationSeconds: schema.soundFiles.durationSeconds,
      })
      .from(schema.soundPlaylistItems)
      .innerJoin(schema.userSounds, eq(schema.soundPlaylistItems.userSoundId, schema.userSounds.id))
      .innerJoin(schema.soundFiles, eq(schema.userSounds.soundFileId, schema.soundFiles.id))
      .where(eq(schema.soundPlaylistItems.playlistId, playlist.id))
      .orderBy(asc(schema.soundPlaylistItems.orderNumber));

    // Add isOwner flag to response
    const isOwner = playlist.guid === guid;

    return { playlist: { ...playlist, isOwner }, items };
  });

  // Delete playlist
  fastify.delete('/playlists/:name', { preHandler: authenticate }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const result = await db
      .delete(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    return { success: true };
  });

  // Rename playlist
  fastify.patch('/playlists/:name/rename', { preHandler: authenticate }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = z.object({ newName: z.string().min(1).max(32).regex(aliasRegex, aliasMessage) }).safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const { newName } = body.data;
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Check if new name already exists
    const [existing] = await db
      .select({ id: schema.soundPlaylists.id })
      .from(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, newName)))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: 'A playlist with this name already exists' });
    }

    // Rename the playlist
    const result = await db
      .update(schema.soundPlaylists)
      .set({ name: newName })
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    return { success: true, newName };
  });

  // Add sound to playlist
  fastify.post('/playlists/:name/sounds', { preHandler: authenticate }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = playlistItemSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get playlist
    const [playlist] = await db
      .select({ id: schema.soundPlaylists.id })
      .from(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
      .limit(1);

    if (!playlist) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    // Get user sound
    const [userSound] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, body.data.soundAlias)))
      .limit(1);

    if (!userSound) {
      return reply.status(404).send({ error: 'Sound not found in your library' });
    }

    // Get next order number
    const [maxOrder] = await db
      .select({ max: sql<number>`COALESCE(MAX(order_number), 0)` })
      .from(schema.soundPlaylistItems)
      .where(eq(schema.soundPlaylistItems.playlistId, playlist.id));

    await db.insert(schema.soundPlaylistItems).values({
      playlistId: playlist.id,
      userSoundId: userSound.id,
      orderNumber: (maxOrder?.max || 0) + 1,
    });

    return { success: true };
  });

  // Remove sound from playlist
  fastify.delete('/playlists/:name/sounds/:soundAlias', { preHandler: authenticate }, async (request, reply) => {
    const { name, soundAlias } = request.params as { name: string; soundAlias: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get playlist
    const [playlist] = await db
      .select({ id: schema.soundPlaylists.id })
      .from(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
      .limit(1);

    if (!playlist) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    // Get user sound
    const [userSound] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, soundAlias)))
      .limit(1);

    if (!userSound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    const result = await db
      .delete(schema.soundPlaylistItems)
      .where(
        and(
          eq(schema.soundPlaylistItems.playlistId, playlist.id),
          eq(schema.soundPlaylistItems.userSoundId, userSound.id)
        )
      )
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Sound not in playlist' });
    }

    return { success: true };
  });

  // Reorder playlist
  fastify.put('/playlists/:name/reorder', { preHandler: authenticate }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = reorderPlaylistSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get playlist
    const [playlist] = await db
      .select({ id: schema.soundPlaylists.id })
      .from(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
      .limit(1);

    if (!playlist) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    // Update order for each sound
    for (let i = 0; i < body.data.soundAliases.length; i++) {
      const alias = body.data.soundAliases[i];
      const [userSound] = await db
        .select({ id: schema.userSounds.id })
        .from(schema.userSounds)
        .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
        .limit(1);

      if (userSound) {
        await db
          .update(schema.soundPlaylistItems)
          .set({ orderNumber: i + 1 })
          .where(
            and(
              eq(schema.soundPlaylistItems.playlistId, playlist.id),
              eq(schema.soundPlaylistItems.userSoundId, userSound.id)
            )
          );
      }
    }

    return { success: true };
  });

  // Set playlist visibility (public/private)
  fastify.patch('/playlists/:name/visibility', { preHandler: authenticate }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { isPublic: boolean };

    if (typeof body.isPublic !== 'boolean') {
      return reply.status(400).send({ error: 'Invalid input: isPublic must be a boolean' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get playlist
    const [playlist] = await db
      .select({ id: schema.soundPlaylists.id })
      .from(schema.soundPlaylists)
      .where(and(eq(schema.soundPlaylists.guid, guid), eq(schema.soundPlaylists.name, name)))
      .limit(1);

    if (!playlist) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    // Update playlist visibility
    await db
      .update(schema.soundPlaylists)
      .set({ isPublic: body.isPublic, updatedAt: new Date() })
      .where(eq(schema.soundPlaylists.id, playlist.id));

    return { success: true, isPublic: body.isPublic };
  });

  // ============================================================================
  // Sharing
  // ============================================================================

  // List pending share requests (received)
  fastify.get('/shares/pending', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const shares = await db
      .select({
        id: schema.soundShares.id,
        soundFileId: schema.soundShares.soundFileId,
        fromGuid: schema.soundShares.fromGuid,
        suggestedAlias: schema.soundShares.suggestedAlias,
        createdAt: schema.soundShares.createdAt,
        originalName: schema.soundFiles.originalName,
        fileSize: schema.soundFiles.fileSize,
        durationSeconds: schema.soundFiles.durationSeconds,
      })
      .from(schema.soundShares)
      .innerJoin(schema.soundFiles, eq(schema.soundShares.soundFileId, schema.soundFiles.id))
      .where(and(eq(schema.soundShares.toGuid, guid), eq(schema.soundShares.status, 'pending')))
      .orderBy(desc(schema.soundShares.createdAt));

    return { shares };
  });

  // Accept share
  fastify.post('/shares/:shareId/accept', { preHandler: authenticate }, async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const body = acceptShareSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const shareIdNum = parseInt(shareId, 10);

    // Get share request
    const [share] = await db
      .select()
      .from(schema.soundShares)
      .where(
        and(
          eq(schema.soundShares.id, shareIdNum),
          eq(schema.soundShares.toGuid, guid),
          eq(schema.soundShares.status, 'pending')
        )
      )
      .limit(1);

    if (!share) {
      return reply.status(404).send({ error: 'Share request not found' });
    }

    // Check if alias already exists
    const [aliasExists] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, body.data.alias)))
      .limit(1);

    if (aliasExists) {
      return reply.status(409).send({ error: 'You already have a sound with that name' });
    }

    // Update share status
    await db
      .update(schema.soundShares)
      .set({ status: 'accepted', respondedAt: new Date() })
      .where(eq(schema.soundShares.id, shareIdNum));

    // Add to user's library
    await db.insert(schema.userSounds).values({
      guid,
      soundFileId: share.soundFileId,
      alias: body.data.alias,
      visibility: 'private',
    });

    // Increment reference count
    await db
      .update(schema.soundFiles)
      .set({ referenceCount: sql`${schema.soundFiles.referenceCount} + 1` })
      .where(eq(schema.soundFiles.id, share.soundFileId));

    return { success: true, alias: body.data.alias };
  });

  // Reject share
  fastify.post('/shares/:shareId/reject', { preHandler: authenticate }, async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const shareIdNum = parseInt(shareId, 10);

    const result = await db
      .update(schema.soundShares)
      .set({ status: 'rejected', respondedAt: new Date() })
      .where(
        and(
          eq(schema.soundShares.id, shareIdNum),
          eq(schema.soundShares.toGuid, guid),
          eq(schema.soundShares.status, 'pending')
        )
      )
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Share request not found' });
    }

    return { success: true };
  });

  // ============================================================================
  // Registration / GUID Linking
  // ============================================================================

  // Verify registration code and link GUID to account
  fastify.post('/verify-code', { preHandler: authenticate }, async (request, reply) => {
    const body = verifyCodeSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid code format' });
    }

    // Find valid verification code
    const [verification] = await db
      .select()
      .from(schema.verificationCodes)
      .where(
        and(
          eq(schema.verificationCodes.code, body.data.code.toUpperCase()),
          eq(schema.verificationCodes.used, false),
          sql`${schema.verificationCodes.expiresAt} > NOW()`
        )
      )
      .limit(1);

    if (!verification) {
      return reply.status(400).send({ error: 'Invalid or expired code' });
    }

    // Check if GUID is already linked to another account
    const [existingUser] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.guid, verification.guid))
      .limit(1);

    if (existingUser && existingUser.id !== request.user.userId) {
      return reply.status(409).send({ error: 'This GUID is already linked to another account' });
    }

    // Mark code as used
    await db
      .update(schema.verificationCodes)
      .set({ used: true })
      .where(eq(schema.verificationCodes.id, verification.id));

    // Link GUID to user account
    await db
      .update(schema.users)
      .set({ guid: verification.guid })
      .where(eq(schema.users.id, request.user.userId));

    return {
      success: true,
      guid: verification.guid,
      playerName: verification.playerName,
      message: `Successfully linked to in-game account: ${verification.playerName}`,
    };
  });

  // Get account GUID status
  fastify.get('/account/guid', { preHandler: authenticate }, async (request, reply) => {
    const [user] = await db
      .select({ guid: schema.users.guid })
      .from(schema.users)
      .where(eq(schema.users.id, request.user.userId))
      .limit(1);

    return {
      linked: !!user?.guid,
      guid: user?.guid || null,
    };
  });

  // ============================================================================
  // Audio Streaming (MP3 and WAV)
  // ============================================================================

  // Stream user's sound by alias
  fastify.get('/stream/:alias', { preHandler: authenticate }, async (request, reply) => {
    const { alias } = request.params as { alias: string };
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get sound file path
    const [sound] = await db
      .select({
        filePath: schema.soundFiles.filePath,
        fileSize: schema.soundFiles.fileSize,
      })
      .from(schema.userSounds)
      .innerJoin(schema.soundFiles, eq(schema.userSounds.soundFileId, schema.soundFiles.id))
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (!sound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    // Check file exists
    const filePath = sound.filePath.startsWith('/') ? sound.filePath : join(SOUNDS_DIR, sound.filePath);
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'Sound file not found on disk' });
    }

    // Determine content type based on extension
    const contentType = filePath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';

    const stats = statSync(filePath);
    const range = request.headers.range;

    if (range) {
      // Handle range requests for seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = end - start + 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.header('Content-Type', contentType);

      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', stats.size);
    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', 'bytes');

    return reply.send(createReadStream(filePath));
  });

  // Stream public sound by soundFileId
  // Allows streaming if: sound_files.isPublic = true OR sound is in a public playlist
  fastify.get('/stream/public/:soundFileId', { preHandler: authenticate }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const fileId = parseInt(soundFileId, 10);

    // Get sound file path - allow if directly public OR in a public playlist
    const query = sql`
      SELECT DISTINCT sf.file_path as "filePath", sf.file_size as "fileSize"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
      WHERE sf.id = ${fileId}
        AND (sf.is_public = true OR sp.is_public = true OR us.visibility = 'public')
      LIMIT 1
    `;

    const result = await db.execute(query);
    const sound = result.rows[0] as { filePath: string; fileSize: number } | undefined;

    if (!sound) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    const filePath = sound.filePath.startsWith('/') ? sound.filePath : join(SOUNDS_DIR, sound.filePath);
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'Sound file not found on disk' });
    }

    // Determine content type based on extension
    const contentType = filePath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';

    const stats = statSync(filePath);
    const range = request.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = end - start + 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.header('Content-Type', contentType);

      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', stats.size);
    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', 'bytes');

    return reply.send(createReadStream(filePath));
  });

  // ============================================================================
  // Admin Routes
  // ============================================================================

  // Admin: Rename a public sound file
  fastify.patch('/admin/public/:soundFileId', { preHandler: requireAdmin }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const { originalName } = request.body as { originalName?: string };
    const fileId = parseInt(soundFileId, 10);

    if (!originalName) {
      return reply.status(400).send({ error: 'originalName is required' });
    }

    // Validate name format
    if (!/^[a-zA-Z0-9_-]+$/.test(originalName)) {
      return reply.status(400).send({ error: 'Name can only contain letters, numbers, underscores, and dashes' });
    }

    // Check sound exists and is public
    const [existing] = await db
      .select({ id: schema.soundFiles.id })
      .from(schema.soundFiles)
      .where(and(eq(schema.soundFiles.id, fileId), eq(schema.soundFiles.isPublic, true)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    // Update the original name (add .mp3 if not present)
    const newName = originalName.endsWith('.mp3') ? originalName : `${originalName}.mp3`;
    await db
      .update(schema.soundFiles)
      .set({ originalName: newName })
      .where(eq(schema.soundFiles.id, fileId));

    return { success: true, originalName: newName };
  });

  // Admin: Get info about a public sound before deleting (shows affected playlists)
  fastify.get('/admin/public/:soundFileId/delete-info', { preHandler: requireAdmin }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const fileId = parseInt(soundFileId, 10);

    // Check sound exists and is publicly accessible (directly or via playlist)
    const existsQuery = sql`
      SELECT DISTINCT sf.id, sf.original_name as "originalName", sf.is_public as "isDirectlyPublic"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
      WHERE sf.id = ${fileId}
        AND (sf.is_public = true OR sp.is_public = true)
      LIMIT 1
    `;
    const existsResult = await db.execute(existsQuery);
    const existing = existsResult.rows[0] as { id: number; originalName: string; isDirectlyPublic: boolean } | undefined;

    if (!existing) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    // Find all playlists this sound is in
    const playlistsQuery = sql`
      SELECT DISTINCT sp.id, sp.name, sp.is_public as "isPublic", u.display_name as "ownerName"
      FROM sound_playlists sp
      INNER JOIN sound_playlist_items spi ON spi.playlist_id = sp.id
      INNER JOIN user_sounds us ON us.id = spi.user_sound_id
      LEFT JOIN users u ON u.guid = sp.guid
      WHERE us.sound_file_id = ${fileId}
    `;
    const playlistsResult = await db.execute(playlistsQuery);
    const playlists = playlistsResult.rows as { id: number; name: string; isPublic: boolean; ownerName: string }[];

    // Count users who have this sound
    const usersQuery = sql`
      SELECT COUNT(DISTINCT guid) as count FROM user_sounds WHERE sound_file_id = ${fileId}
    `;
    const usersResult = await db.execute(usersQuery);
    const userCount = Number((usersResult.rows[0] as { count: string }).count);

    return {
      soundFileId: fileId,
      originalName: existing.originalName,
      isDirectlyPublic: existing.isDirectlyPublic,
      affectedPlaylists: playlists,
      affectedUserCount: userCount,
    };
  });

  // Admin: Remove a sound from the public library
  // This does NOT delete the sound - it just makes it non-public
  // All users who have it in their library keep it
  fastify.delete('/admin/public/:soundFileId', { preHandler: requireAdmin }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const fileId = parseInt(soundFileId, 10);

    // Check sound exists and is publicly accessible (directly or via playlist)
    const existsQuery = sql`
      SELECT DISTINCT sf.id, sf.is_public as "isDirectlyPublic"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
      WHERE sf.id = ${fileId}
        AND (sf.is_public = true OR sp.is_public = true)
      LIMIT 1
    `;
    const existsResult = await db.execute(existsQuery);
    const existing = existsResult.rows[0] as { id: number; isDirectlyPublic: boolean } | undefined;

    if (!existing) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    // Set the sound to non-public (removes from public library)
    // Users who already have it in their library keep their user_sounds references
    await db
      .update(schema.soundFiles)
      .set({ isPublic: false })
      .where(eq(schema.soundFiles.id, fileId));

    // Also set any user_sounds visibility to 'private' if it was 'public'
    await db
      .update(schema.userSounds)
      .set({ visibility: 'private', updatedAt: new Date() })
      .where(and(
        eq(schema.userSounds.soundFileId, fileId),
        eq(schema.userSounds.visibility, 'public')
      ));

    return { success: true, message: 'Sound removed from public library. All users who had it keep their copies.' };
  });

  // Admin: Set a sound's public status
  fastify.patch('/admin/public/:soundFileId/visibility', { preHandler: requireAdmin }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const { isPublic } = request.body as { isPublic?: boolean };
    const fileId = parseInt(soundFileId, 10);

    if (typeof isPublic !== 'boolean') {
      return reply.status(400).send({ error: 'isPublic must be a boolean' });
    }

    // Check sound exists
    const [existing] = await db
      .select({ id: schema.soundFiles.id })
      .from(schema.soundFiles)
      .where(eq(schema.soundFiles.id, fileId))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    await db
      .update(schema.soundFiles)
      .set({ isPublic })
      .where(eq(schema.soundFiles.id, fileId));

    return { success: true, isPublic };
  });

  // ============================================================================
  // Sound Menus (Dynamic Per-Player Menus)
  // ============================================================================

  // Validation schemas for menus
  const createMenuSchema = z.object({
    menuName: z.string().min(1).max(32).regex(aliasRegex, aliasMessage),
    menuPosition: z.number().int().min(1).max(9),
    playlistId: z.number().int().optional().nullable(),
  });

  const updateMenuSchema = z.object({
    menuName: z.string().min(1).max(32).regex(aliasRegex, aliasMessage).optional(),
    menuPosition: z.number().int().min(1).max(9).optional(),
    playlistId: z.number().int().optional().nullable(),
  });

  const addMenuItemSchema = z.object({
    soundAlias: z.string().min(1).max(32),
    itemPosition: z.number().int().min(1).max(9),
    displayName: z.string().max(32).optional().nullable(),
  });

  const updateMenuItemSchema = z.object({
    itemPosition: z.number().int().min(1).max(9).optional(),
    displayName: z.string().max(32).optional().nullable(),
  });

  const reorderMenuItemsSchema = z.object({
    itemIds: z.array(z.number().int()),
  });

  // GET /api/sounds/menus - List user's menus
  fastify.get('/menus', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    // Get all menus with their playlist info and item counts
    const menusQuery = sql`
      SELECT
        m.id,
        m.menu_name as "menuName",
        m.menu_position as "menuPosition",
        m.playlist_id as "playlistId",
        m.created_at as "createdAt",
        m.updated_at as "updatedAt",
        sp.name as "playlistName",
        CASE
          WHEN m.playlist_id IS NOT NULL THEN
            (SELECT COUNT(*) FROM sound_playlist_items spi WHERE spi.playlist_id = m.playlist_id)
          ELSE
            (SELECT COUNT(*) FROM user_sound_menu_items mi WHERE mi.menu_id = m.id)
        END as "itemCount"
      FROM user_sound_menus m
      LEFT JOIN sound_playlists sp ON sp.id = m.playlist_id
      WHERE m.user_guid = ${guid}
      ORDER BY m.menu_position ASC
    `;

    const result = await db.execute(menusQuery);
    const menus = result.rows.map(row => ({
      id: row.id,
      menuName: row.menuName,
      menuPosition: row.menuPosition,
      playlistId: row.playlistId,
      playlistName: row.playlistName,
      itemCount: Number(row.itemCount),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return { menus };
  });

  // POST /api/sounds/menus - Create a menu
  fastify.post('/menus', { preHandler: authenticate }, async (request, reply) => {
    const body = createMenuSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const { menuName, menuPosition, playlistId } = body.data;

    // Check if position is already taken
    const [existing] = await db
      .select({ id: schema.userSoundMenus.id })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.userGuid, guid),
        eq(schema.userSoundMenus.menuPosition, menuPosition)
      ))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: `Position ${menuPosition} is already in use` });
    }

    // If playlistId provided, verify it exists and belongs to user (or is public)
    if (playlistId) {
      const [playlist] = await db
        .select({ id: schema.soundPlaylists.id })
        .from(schema.soundPlaylists)
        .where(and(
          eq(schema.soundPlaylists.id, playlistId),
          or(
            eq(schema.soundPlaylists.guid, guid),
            eq(schema.soundPlaylists.isPublic, true)
          )
        ))
        .limit(1);

      if (!playlist) {
        return reply.status(404).send({ error: 'Playlist not found or not accessible' });
      }
    }

    const [menu] = await db
      .insert(schema.userSoundMenus)
      .values({
        userGuid: guid,
        menuName,
        menuPosition,
        playlistId: playlistId || null,
      })
      .returning();

    return { success: true, menu };
  });

  // GET /api/sounds/menus/:id - Get a specific menu with its items
  fastify.get('/menus/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const menuId = parseInt(id, 10);

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get the menu
    const [menu] = await db
      .select({
        id: schema.userSoundMenus.id,
        menuName: schema.userSoundMenus.menuName,
        menuPosition: schema.userSoundMenus.menuPosition,
        playlistId: schema.userSoundMenus.playlistId,
        createdAt: schema.userSoundMenus.createdAt,
        updatedAt: schema.userSoundMenus.updatedAt,
      })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .limit(1);

    if (!menu) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    // If menu is backed by a playlist, get first 9 sounds from the playlist
    if (menu.playlistId) {
      const playlistItems = await db
        .select({
          id: schema.soundPlaylistItems.id,
          orderNumber: schema.soundPlaylistItems.orderNumber,
          alias: schema.userSounds.alias,
          soundFileId: schema.soundFiles.id,
          durationSeconds: schema.soundFiles.durationSeconds,
        })
        .from(schema.soundPlaylistItems)
        .innerJoin(schema.userSounds, eq(schema.soundPlaylistItems.userSoundId, schema.userSounds.id))
        .innerJoin(schema.soundFiles, eq(schema.userSounds.soundFileId, schema.soundFiles.id))
        .where(eq(schema.soundPlaylistItems.playlistId, menu.playlistId))
        .orderBy(asc(schema.soundPlaylistItems.orderNumber))
        .limit(9);

      // Map to item format (1-based positions)
      const items = playlistItems.map((item, idx) => ({
        id: item.id,
        itemPosition: idx + 1,
        displayName: item.alias,
        soundAlias: item.alias,
        soundFileId: item.soundFileId,
        durationSeconds: item.durationSeconds,
        isFromPlaylist: true,
      }));

      return { menu, items, isPlaylistBacked: true };
    }

    // Get manual menu items
    const menuItems = await db
      .select({
        id: schema.userSoundMenuItems.id,
        itemPosition: schema.userSoundMenuItems.itemPosition,
        displayName: schema.userSoundMenuItems.displayName,
        soundId: schema.userSoundMenuItems.soundId,
        soundAlias: schema.userSounds.alias,
        soundFileId: schema.soundFiles.id,
        durationSeconds: schema.soundFiles.durationSeconds,
      })
      .from(schema.userSoundMenuItems)
      .innerJoin(schema.userSounds, eq(schema.userSoundMenuItems.soundId, schema.userSounds.id))
      .innerJoin(schema.soundFiles, eq(schema.userSounds.soundFileId, schema.soundFiles.id))
      .where(eq(schema.userSoundMenuItems.menuId, menuId))
      .orderBy(asc(schema.userSoundMenuItems.itemPosition));

    const items = menuItems.map(item => ({
      id: item.id,
      itemPosition: item.itemPosition,
      displayName: item.displayName || item.soundAlias,
      soundAlias: item.soundAlias,
      soundFileId: item.soundFileId,
      durationSeconds: item.durationSeconds,
      isFromPlaylist: false,
    }));

    return { menu, items, isPlaylistBacked: false };
  });

  // PUT /api/sounds/menus/:id - Update a menu
  fastify.put('/menus/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const menuId = parseInt(id, 10);
    const body = updateMenuSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Verify menu exists and belongs to user
    const [existing] = await db
      .select({ id: schema.userSoundMenus.id })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    const { menuName, menuPosition, playlistId } = body.data;

    // If changing position, check it's not taken by another menu
    if (menuPosition !== undefined) {
      const [positionTaken] = await db
        .select({ id: schema.userSoundMenus.id })
        .from(schema.userSoundMenus)
        .where(and(
          eq(schema.userSoundMenus.userGuid, guid),
          eq(schema.userSoundMenus.menuPosition, menuPosition),
          sql`${schema.userSoundMenus.id} != ${menuId}`
        ))
        .limit(1);

      if (positionTaken) {
        return reply.status(409).send({ error: `Position ${menuPosition} is already in use by another menu` });
      }
    }

    // If playlistId provided, verify it exists and belongs to user
    if (playlistId !== undefined && playlistId !== null) {
      const [playlist] = await db
        .select({ id: schema.soundPlaylists.id })
        .from(schema.soundPlaylists)
        .where(and(
          eq(schema.soundPlaylists.id, playlistId),
          or(
            eq(schema.soundPlaylists.guid, guid),
            eq(schema.soundPlaylists.isPublic, true)
          )
        ))
        .limit(1);

      if (!playlist) {
        return reply.status(404).send({ error: 'Playlist not found or not accessible' });
      }
    }

    // Build update object
    const updateData: Partial<{
      menuName: string;
      menuPosition: number;
      playlistId: number | null;
      updatedAt: Date;
    }> = { updatedAt: new Date() };

    if (menuName !== undefined) updateData.menuName = menuName;
    if (menuPosition !== undefined) updateData.menuPosition = menuPosition;
    if (playlistId !== undefined) updateData.playlistId = playlistId;

    const [updated] = await db
      .update(schema.userSoundMenus)
      .set(updateData)
      .where(eq(schema.userSoundMenus.id, menuId))
      .returning();

    return { success: true, menu: updated };
  });

  // DELETE /api/sounds/menus/:id - Delete a menu
  fastify.delete('/menus/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const menuId = parseInt(id, 10);

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    const result = await db
      .delete(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    return { success: true };
  });

  // POST /api/sounds/menus/:id/items - Add item to menu
  fastify.post('/menus/:id/items', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const menuId = parseInt(id, 10);
    const body = addMenuItemSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Verify menu exists, belongs to user, and is NOT playlist-backed
    const [menu] = await db
      .select({
        id: schema.userSoundMenus.id,
        playlistId: schema.userSoundMenus.playlistId,
      })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .limit(1);

    if (!menu) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    if (menu.playlistId) {
      return reply.status(400).send({ error: 'Cannot add items to a playlist-backed menu. Edit the playlist instead.' });
    }

    const { soundAlias, itemPosition, displayName } = body.data;

    // Check position isn't already taken
    const [positionTaken] = await db
      .select({ id: schema.userSoundMenuItems.id })
      .from(schema.userSoundMenuItems)
      .where(and(
        eq(schema.userSoundMenuItems.menuId, menuId),
        eq(schema.userSoundMenuItems.itemPosition, itemPosition)
      ))
      .limit(1);

    if (positionTaken) {
      return reply.status(409).send({ error: `Position ${itemPosition} is already in use` });
    }

    // Get user sound by alias
    const [userSound] = await db
      .select({ id: schema.userSounds.id })
      .from(schema.userSounds)
      .where(and(
        eq(schema.userSounds.guid, guid),
        eq(schema.userSounds.alias, soundAlias)
      ))
      .limit(1);

    if (!userSound) {
      return reply.status(404).send({ error: 'Sound not found in your library' });
    }

    const [item] = await db
      .insert(schema.userSoundMenuItems)
      .values({
        menuId,
        soundId: userSound.id,
        itemPosition,
        displayName: displayName || null,
      })
      .returning();

    return { success: true, item };
  });

  // PUT /api/sounds/menus/:id/items/:itemId - Update a menu item
  fastify.put('/menus/:id/items/:itemId', { preHandler: authenticate }, async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const menuId = parseInt(id, 10);
    const menuItemId = parseInt(itemId, 10);
    const body = updateMenuItemSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Verify menu exists and belongs to user
    const [menu] = await db
      .select({ id: schema.userSoundMenus.id, playlistId: schema.userSoundMenus.playlistId })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .limit(1);

    if (!menu) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    if (menu.playlistId) {
      return reply.status(400).send({ error: 'Cannot modify items in a playlist-backed menu' });
    }

    const { itemPosition, displayName } = body.data;

    // If changing position, check it's not taken
    if (itemPosition !== undefined) {
      const [positionTaken] = await db
        .select({ id: schema.userSoundMenuItems.id })
        .from(schema.userSoundMenuItems)
        .where(and(
          eq(schema.userSoundMenuItems.menuId, menuId),
          eq(schema.userSoundMenuItems.itemPosition, itemPosition),
          sql`${schema.userSoundMenuItems.id} != ${menuItemId}`
        ))
        .limit(1);

      if (positionTaken) {
        return reply.status(409).send({ error: `Position ${itemPosition} is already in use` });
      }
    }

    // Build update
    const updateData: Partial<{ itemPosition: number; displayName: string | null }> = {};
    if (itemPosition !== undefined) updateData.itemPosition = itemPosition;
    if (displayName !== undefined) updateData.displayName = displayName;

    const [updated] = await db
      .update(schema.userSoundMenuItems)
      .set(updateData)
      .where(and(
        eq(schema.userSoundMenuItems.id, menuItemId),
        eq(schema.userSoundMenuItems.menuId, menuId)
      ))
      .returning();

    if (!updated) {
      return reply.status(404).send({ error: 'Menu item not found' });
    }

    return { success: true, item: updated };
  });

  // DELETE /api/sounds/menus/:id/items/:itemId - Remove item from menu
  fastify.delete('/menus/:id/items/:itemId', { preHandler: authenticate }, async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const menuId = parseInt(id, 10);
    const menuItemId = parseInt(itemId, 10);

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Verify menu exists and belongs to user
    const [menu] = await db
      .select({ id: schema.userSoundMenus.id, playlistId: schema.userSoundMenus.playlistId })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .limit(1);

    if (!menu) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    if (menu.playlistId) {
      return reply.status(400).send({ error: 'Cannot remove items from a playlist-backed menu' });
    }

    const result = await db
      .delete(schema.userSoundMenuItems)
      .where(and(
        eq(schema.userSoundMenuItems.id, menuItemId),
        eq(schema.userSoundMenuItems.menuId, menuId)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Menu item not found' });
    }

    return { success: true };
  });

  // PUT /api/sounds/menus/:id/reorder - Reorder menu items
  fastify.put('/menus/:id/reorder', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const menuId = parseInt(id, 10);
    const body = reorderMenuItemsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Verify menu exists and belongs to user
    const [menu] = await db
      .select({ id: schema.userSoundMenus.id, playlistId: schema.userSoundMenus.playlistId })
      .from(schema.userSoundMenus)
      .where(and(
        eq(schema.userSoundMenus.id, menuId),
        eq(schema.userSoundMenus.userGuid, guid)
      ))
      .limit(1);

    if (!menu) {
      return reply.status(404).send({ error: 'Menu not found' });
    }

    if (menu.playlistId) {
      return reply.status(400).send({ error: 'Cannot reorder items in a playlist-backed menu' });
    }

    // Update positions based on new order (itemIds in order)
    const { itemIds } = body.data;
    for (let i = 0; i < itemIds.length && i < 9; i++) {
      await db
        .update(schema.userSoundMenuItems)
        .set({ itemPosition: i + 1 })
        .where(and(
          eq(schema.userSoundMenuItems.id, itemIds[i]),
          eq(schema.userSoundMenuItems.menuId, menuId)
        ));
    }

    return { success: true };
  });

  // GET /api/sounds/menus/for-game/:guid - Get menu data for in-game client (no auth required for game client)
  // This endpoint is called by the ETMan server to fetch menu data for a player
  fastify.get('/menus/for-game/:guid', async (request, reply) => {
    const { guid } = request.params as { guid: string };

    if (!guid || guid.length !== 32) {
      return reply.status(400).send({ error: 'Invalid GUID' });
    }

    // Get all menus for this GUID
    const menus = await db
      .select({
        id: schema.userSoundMenus.id,
        menuName: schema.userSoundMenus.menuName,
        menuPosition: schema.userSoundMenus.menuPosition,
        playlistId: schema.userSoundMenus.playlistId,
      })
      .from(schema.userSoundMenus)
      .where(eq(schema.userSoundMenus.userGuid, guid))
      .orderBy(asc(schema.userSoundMenus.menuPosition));

    // For each menu, get its items (either from playlist or manual items)
    const menusWithItems = await Promise.all(menus.map(async (menu) => {
      let items: { position: number; name: string; soundAlias: string }[] = [];

      if (menu.playlistId) {
        // Get first 9 from playlist
        const playlistItems = await db
          .select({
            alias: schema.userSounds.alias,
            orderNumber: schema.soundPlaylistItems.orderNumber,
          })
          .from(schema.soundPlaylistItems)
          .innerJoin(schema.userSounds, eq(schema.soundPlaylistItems.userSoundId, schema.userSounds.id))
          .where(eq(schema.soundPlaylistItems.playlistId, menu.playlistId))
          .orderBy(asc(schema.soundPlaylistItems.orderNumber))
          .limit(9);

        items = playlistItems.map((item, idx) => ({
          position: idx + 1,
          name: item.alias,
          soundAlias: item.alias,
        }));
      } else {
        // Get manual items
        const menuItems = await db
          .select({
            itemPosition: schema.userSoundMenuItems.itemPosition,
            displayName: schema.userSoundMenuItems.displayName,
            soundAlias: schema.userSounds.alias,
          })
          .from(schema.userSoundMenuItems)
          .innerJoin(schema.userSounds, eq(schema.userSoundMenuItems.soundId, schema.userSounds.id))
          .where(eq(schema.userSoundMenuItems.menuId, menu.id))
          .orderBy(asc(schema.userSoundMenuItems.itemPosition));

        items = menuItems.map(item => ({
          position: item.itemPosition,
          name: item.displayName || item.soundAlias,
          soundAlias: item.soundAlias,
        }));
      }

      return {
        position: menu.menuPosition,
        name: menu.menuName,
        isPlaylist: !!menu.playlistId,
        items,
      };
    }));

    return { menus: menusWithItems };
  });
};
