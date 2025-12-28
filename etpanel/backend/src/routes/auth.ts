import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { db, schema } from '../db/index.js';
import { eq, sql } from 'drizzle-orm';
import { authenticate, JwtPayload } from '../middleware/auth.js';
import { config } from '../config.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Game registration schemas
const verifyGameCodeSchema = z.object({
  code: z.string().length(6),
});

const gameRegisterSchema = z.object({
  code: z.string().length(6),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores'),
  password: z.string().min(6),
});

const loginUsernameSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Register
  fastify.post('/register', async (request, reply) => {
    const body = registerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const { email, password, displayName } = body.data;

    // Check if user exists
    const existing = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existing.length > 0) {
      return reply.status(409).send({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const [user] = await db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        displayName,
        role: 'user',
      })
      .returning();

    // Generate tokens
    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    const accessToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_EXPIRES_IN });
    const refreshToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_REFRESH_EXPIRES_IN });

    // Store refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await db.insert(schema.sessions).values({
      userId: user.id,
      refreshToken,
      expiresAt,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      accessToken,
      refreshToken,
    };
  });

  // Login
  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }

    const { email, password } = body.data;

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    const accessToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_EXPIRES_IN });
    const refreshToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_REFRESH_EXPIRES_IN });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await db.insert(schema.sessions).values({
      userId: user.id,
      refreshToken,
      expiresAt,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      accessToken,
      refreshToken,
    };
  });

  // Refresh token
  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (!refreshToken) {
      return reply.status(400).send({ error: 'Refresh token required' });
    }

    try {
      const decoded = fastify.jwt.verify<JwtPayload>(refreshToken);

      // Check if session exists
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.refreshToken, refreshToken))
        .limit(1);

      if (!session || session.expiresAt < new Date()) {
        return reply.status(401).send({ error: 'Invalid or expired refresh token' });
      }

      // Get fresh user data
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, decoded.userId))
        .limit(1);

      if (!user) {
        return reply.status(401).send({ error: 'User not found' });
      }

      const payload: JwtPayload = {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      };

      const newAccessToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_EXPIRES_IN });

      return { accessToken: newAccessToken };
    } catch (err) {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }
  });

  // Logout
  fastify.post('/logout', { preHandler: authenticate }, async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (refreshToken) {
      await db.delete(schema.sessions).where(eq(schema.sessions.refreshToken, refreshToken));
    }
    return { success: true };
  });

  // Get current user
  fastify.get('/me', { preHandler: authenticate }, async (request) => {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, request.user.userId))
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
    };
  });

  // ============================================================================
  // Game Registration (from in-game /etman register)
  // ============================================================================

  // Verify game code - check if code is valid and return player name
  fastify.post('/verify-game-code', async (request, reply) => {
    const body = verifyGameCodeSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid code format' });
    }

    const code = body.data.code.toUpperCase();

    // Find valid verification code
    const [verification] = await db
      .select()
      .from(schema.verificationCodes)
      .where(eq(schema.verificationCodes.code, code))
      .limit(1);

    if (!verification) {
      return reply.status(400).send({ error: 'Invalid verification code' });
    }

    if (verification.used) {
      return reply.status(400).send({ error: 'This code has already been used' });
    }

    if (verification.expiresAt < new Date()) {
      return reply.status(400).send({ error: 'This code has expired. Get a new one with /etman register' });
    }

    // Check if GUID is already registered
    const [existingUser] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.guid, verification.guid))
      .limit(1);

    if (existingUser) {
      return reply.status(409).send({ error: 'This game account is already registered. Use login instead.' });
    }

    return {
      valid: true,
      playerName: verification.playerName,
      guid: verification.guid.substring(0, 8) + '...', // Only show partial GUID
    };
  });

  // Register new account from game
  fastify.post('/game-register', async (request, reply) => {
    const body = gameRegisterSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const { code, username, password } = body.data;
    const upperCode = code.toUpperCase();

    // Find and validate verification code
    const [verification] = await db
      .select()
      .from(schema.verificationCodes)
      .where(eq(schema.verificationCodes.code, upperCode))
      .limit(1);

    if (!verification) {
      return reply.status(400).send({ error: 'Invalid verification code' });
    }

    if (verification.used) {
      return reply.status(400).send({ error: 'This code has already been used' });
    }

    if (verification.expiresAt < new Date()) {
      return reply.status(400).send({ error: 'This code has expired. Get a new one with /etman register' });
    }

    // Check if GUID is already registered
    const [existingGuid] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.guid, verification.guid))
      .limit(1);

    if (existingGuid) {
      return reply.status(409).send({ error: 'This game account is already registered' });
    }

    // Check if username already exists (case-insensitive)
    const [existingUsername] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`LOWER(${schema.users.displayName}) = LOWER(${username})`)
      .limit(1);

    if (existingUsername) {
      return reply.status(409).send({ error: 'Username already taken. Please choose a different one.' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user with GUID
    const [user] = await db
      .insert(schema.users)
      .values({
        guid: verification.guid,
        displayName: username, // username is stored as displayName
        passwordHash,
        role: 'user',
        // email is optional for game-registered users
      })
      .returning();

    // Mark verification code as used
    await db
      .update(schema.verificationCodes)
      .set({ used: true })
      .where(eq(schema.verificationCodes.id, verification.id));

    // Generate tokens
    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    const accessToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_EXPIRES_IN });
    const refreshToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_REFRESH_EXPIRES_IN });

    // Store refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await db.insert(schema.sessions).values({
      userId: user.id,
      refreshToken,
      expiresAt,
    });

    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        guid: user.guid,
        playerName: verification.playerName, // Original in-game name
      },
      accessToken,
      refreshToken,
    };
  });

  // Login with username (for game-registered users)
  fastify.post('/login-username', async (request, reply) => {
    const body = loginUsernameSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }

    const { username, password } = body.data;

    // Find user by displayName (username) - case-insensitive
    const [user] = await db
      .select()
      .from(schema.users)
      .where(sql`LOWER(${schema.users.displayName}) = LOWER(${username})`)
      .limit(1);

    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    const accessToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_EXPIRES_IN });
    const refreshToken = fastify.jwt.sign(payload, { expiresIn: config.JWT_REFRESH_EXPIRES_IN });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await db.insert(schema.sessions).values({
      userId: user.id,
      refreshToken,
      expiresAt,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        guid: user.guid,
      },
      accessToken,
      refreshToken,
    };
  });
};
