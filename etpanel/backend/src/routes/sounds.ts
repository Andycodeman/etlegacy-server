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
} from '../utils/audio.js';

// Validation schemas
const addSoundSchema = z.object({
  alias: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores allowed'),
  visibility: z.enum(['private', 'shared', 'public']).optional().default('private'),
});

const renameSoundSchema = z.object({
  newAlias: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores allowed'),
});

const visibilitySchema = z.object({
  visibility: z.enum(['private', 'shared', 'public']),
});

const createPlaylistSchema = z.object({
  name: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores allowed'),
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
  alias: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores allowed'),
});

const verifyCodeSchema = z.object({
  code: z.string().length(6),
});

const uploadFromUrlSchema = z.object({
  url: z.string().url(),
  alias: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores allowed'),
});

const tempUploadFromUrlSchema = z.object({
  url: z.string().url(),
});

const saveClipSchema = z.object({
  tempId: z.string().uuid(),
  alias: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores allowed'),
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
        CASE WHEN EXISTS (
          SELECT 1 FROM sound_playlist_items spi
          JOIN sound_playlists sp ON sp.id = spi.playlist_id
          WHERE spi.user_sound_id = us.id AND sp.is_public = true
        ) THEN true ELSE false END as "inPublicPlaylist"
      FROM user_sounds us
      INNER JOIN sound_files sf ON sf.id = us.sound_file_id
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
    const body = visibilitySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid visibility value' });
    }

    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account' });
    }

    // Get sound file ID
    const [sound] = await db
      .select({ soundFileId: schema.userSounds.soundFileId })
      .from(schema.userSounds)
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)))
      .limit(1);

    if (!sound) {
      return reply.status(404).send({ error: 'Sound not found' });
    }

    // Update user_sounds visibility
    await db
      .update(schema.userSounds)
      .set({ visibility: body.data.visibility, updatedAt: new Date() })
      .where(and(eq(schema.userSounds.guid, guid), eq(schema.userSounds.alias, alias)));

    // If making public, update sound_files.is_public
    if (body.data.visibility === 'public') {
      await db
        .update(schema.soundFiles)
        .set({ isPublic: true })
        .where(eq(schema.soundFiles.id, sound.soundFileId));
    }

    return { success: true, visibility: body.data.visibility };
  });

  // ============================================================================
  // Upload / Import Sounds
  // ============================================================================

  // Upload MP3 file directly
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

    if (!alias || !/^[a-zA-Z0-9_]+$/.test(alias)) {
      fastify.log.warn({ fields: data.fields, aliasField }, 'Invalid alias field');
      return reply.status(400).send({ error: 'Invalid alias. Only letters, numbers, and underscores allowed.' });
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

    // Validate file type
    const ext = extname(data.filename).toLowerCase();
    if (ext !== '.mp3') {
      return reply.status(400).send({ error: 'Only MP3 files are allowed' });
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

    // Generate unique filename
    const uniqueFilename = `${randomUUID()}.mp3`;
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

  // Upload MP3 file to temp storage for editing
  fastify.post('/upload-temp', { preHandler: authenticate }, async (request, reply) => {
    const guid = await getUserGuid(request.user.userId);
    if (!guid) {
      return reply.status(400).send({ error: 'No GUID linked to account. Use /etman register in-game.' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Validate file type
    const ext = extname(data.filename).toLowerCase();
    if (ext !== '.mp3') {
      return reply.status(400).send({ error: 'Only MP3 files are allowed' });
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

    // Generate temp file ID
    const tempId = randomUUID();
    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);

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
      return reply.status(400).send({ error: 'Could not read audio file. Make sure it is a valid MP3.' });
    }

    return {
      success: true,
      tempId,
      durationSeconds,
      fileSize: buffer.length,
      originalName: data.filename,
      maxClipDuration: MAX_CLIP_DURATION_SECONDS,
    };
  });

  // Import MP3 from URL to temp storage for editing
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
      if (!contentType.includes('audio/mpeg') && !contentType.includes('audio/mp3')) {
        // Also allow if URL ends with .mp3
        if (!url.toLowerCase().endsWith('.mp3')) {
          return reply.status(400).send({ error: 'URL does not point to an MP3 file' });
        }
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

      // Generate temp file ID
      const tempId = randomUUID();
      const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);

      // Extract original filename from URL
      const urlPath = new URL(url).pathname;
      const originalName = urlPath.split('/').pop() || 'downloaded.mp3';

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
        return reply.status(400).send({ error: 'Could not read audio file. Make sure the URL points to a valid MP3.' });
      }

      return {
        success: true,
        tempId,
        durationSeconds,
        fileSize: buffer.length,
        originalName,
        maxClipDuration: MAX_CLIP_DURATION_SECONDS,
      };
    } catch (err) {
      fastify.log.error({ err }, 'URL temp import error');
      return reply.status(500).send({ error: 'Failed to download file from URL' });
    }
  });

  // Stream temp file for preview
  fastify.get('/temp/:tempId', { preHandler: authenticate }, async (request, reply) => {
    const { tempId } = request.params as { tempId: string };

    // Validate tempId is a valid UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempId)) {
      return reply.status(400).send({ error: 'Invalid temp file ID' });
    }

    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);

    if (!existsSync(tempFilePath)) {
      return reply.status(404).send({ error: 'Temp file not found or expired' });
    }

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
      reply.header('Content-Type', 'audio/mpeg');

      return reply.send(createReadStream(tempFilePath, { start, end }));
    }

    reply.header('Content-Length', stats.size);
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Accept-Ranges', 'bytes');

    return reply.send(createReadStream(tempFilePath));
  });

  // Get waveform data for temp file
  fastify.get('/temp/:tempId/waveform', { preHandler: authenticate }, async (request, reply) => {
    const { tempId } = request.params as { tempId: string };

    // Validate tempId is a valid UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempId)) {
      return reply.status(400).send({ error: 'Invalid temp file ID' });
    }

    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);

    if (!existsSync(tempFilePath)) {
      return reply.status(404).send({ error: 'Temp file not found or expired' });
    }

    try {
      const peaks = await generateWaveformPeaks(tempFilePath, 200);
      return { peaks };
    } catch (err) {
      fastify.log.error({ err }, 'Failed to generate waveform');
      // Return flat waveform on error
      return { peaks: new Array(200).fill(0.1) };
    }
  });

  // Save clipped audio as permanent sound
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

    // Check temp file exists
    const tempFilePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);
    if (!existsSync(tempFilePath)) {
      return reply.status(404).send({ error: 'Temp file not found or expired. Please upload again.' });
    }

    // Ensure sounds directory exists
    if (!existsSync(SOUNDS_DIR)) {
      mkdirSync(SOUNDS_DIR, { recursive: true });
    }

    // Generate unique filename for permanent storage
    const uniqueFilename = `${randomUUID()}.mp3`;
    const permanentFilePath = join(SOUNDS_DIR, uniqueFilename);

    try {
      // Clip and convert the audio
      const { duration, fileSize } = await clipAndConvertAudio(
        tempFilePath,
        permanentFilePath,
        startTime,
        endTime
      );

      // Check final file size
      if (fileSize > MAX_FILE_SIZE) {
        // Clean up the clipped file
        unlinkSync(permanentFilePath);
        return reply.status(400).send({
          error: 'Clipped audio exceeds 2MB. Try selecting a shorter portion.',
        });
      }

      // Create sound file record
      const [soundFile] = await db
        .insert(schema.soundFiles)
        .values({
          filename: uniqueFilename,
          originalName: `${alias}.mp3`,
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
    const limit = 25;
    const offset = pageNum * limit;

    // Use raw SQL to get DISTINCT sounds that are either:
    // 1. Marked as public in sound_files (isPublic = true), OR
    // 2. Part of a public playlist (via user_sounds -> sound_playlist_items -> sound_playlists where isPublic = true)
    const searchCondition = search ? `AND sf.original_name ILIKE '%${search.replace(/'/g, "''")}%'` : '';

    const query = sql`
      SELECT DISTINCT ON (sf.id)
        sf.id as "soundFileId",
        sf.original_name as "originalName",
        sf.file_size as "fileSize",
        sf.duration_seconds as "durationSeconds",
        sf.added_by_guid as "addedByGuid",
        sf.created_at as "createdAt"
      FROM sound_files sf
      LEFT JOIN user_sounds us ON us.sound_file_id = sf.id
      LEFT JOIN sound_playlist_items spi ON spi.user_sound_id = us.id
      LEFT JOIN sound_playlists sp ON sp.id = spi.playlist_id
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
        COALESCE(u.display_name, 'Unknown') as "ownerName"
      FROM sound_playlists sp
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
  // MP3 Streaming
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
      reply.header('Content-Type', 'audio/mpeg');

      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', stats.size);
    reply.header('Content-Type', 'audio/mpeg');
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
      reply.header('Content-Type', 'audio/mpeg');

      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', stats.size);
    reply.header('Content-Type', 'audio/mpeg');
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

  // Admin: Delete a public sound file
  fastify.delete('/admin/public/:soundFileId', { preHandler: requireAdmin }, async (request, reply) => {
    const { soundFileId } = request.params as { soundFileId: string };
    const fileId = parseInt(soundFileId, 10);

    // Check sound exists and is public
    const [existing] = await db
      .select({ id: schema.soundFiles.id, filePath: schema.soundFiles.filePath })
      .from(schema.soundFiles)
      .where(and(eq(schema.soundFiles.id, fileId), eq(schema.soundFiles.isPublic, true)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Public sound not found' });
    }

    // Delete pending shares first
    await db
      .delete(schema.soundShares)
      .where(eq(schema.soundShares.soundFileId, fileId));

    // Delete all user_sounds references (cascades to playlist items)
    await db
      .delete(schema.userSounds)
      .where(eq(schema.userSounds.soundFileId, fileId));

    // Delete the sound file record (the actual file stays on disk for now)
    await db
      .delete(schema.soundFiles)
      .where(eq(schema.soundFiles.id, fileId));

    return { success: true };
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
};
