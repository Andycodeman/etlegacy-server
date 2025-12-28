import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { requireAdmin } from '../middleware/auth.js';

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(100),
  role: z.enum(['admin', 'moderator', 'user']).default('user'),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  displayName: z.string().min(2).max(100).optional(),
  role: z.enum(['admin', 'moderator', 'user']).optional(),
  password: z.string().min(8).optional(),
  adminLevel: z.number().int().min(0).max(5).optional(),
});

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // List all users (admin only) - includes ET admin level info
  fastify.get('/', { preHandler: requireAdmin }, async () => {
    const users = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.users.role,
        guid: schema.users.guid,
        createdAt: schema.users.createdAt,
        updatedAt: schema.users.updatedAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt));

    // Enrich with admin level for users with linked GUIDs
    const enrichedUsers = await Promise.all(
      users.map(async (user) => {
        if (!user.guid) {
          return { ...user, adminLevel: null, adminLevelName: null };
        }

        const [adminPlayer] = await db
          .select({
            levelNum: schema.adminLevels.level,
            levelName: schema.adminLevels.name,
          })
          .from(schema.adminPlayers)
          .leftJoin(schema.adminLevels, eq(schema.adminPlayers.levelId, schema.adminLevels.id))
          .where(eq(schema.adminPlayers.guid, user.guid))
          .limit(1);

        return {
          ...user,
          adminLevel: adminPlayer?.levelNum ?? null,
          adminLevelName: adminPlayer?.levelName ?? null,
        };
      })
    );

    return { users: enrichedUsers };
  });

  // Get single user (admin only)
  fastify.get('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);

    if (isNaN(userId)) {
      return reply.status(400).send({ error: 'Invalid user ID' });
    }

    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
        updatedAt: schema.users.updatedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    return user;
  });

  // Create user (admin only)
  fastify.post('/', { preHandler: requireAdmin }, async (request, reply) => {
    const body = createUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const { email, password, displayName, role } = body.data;

    // Check if email exists
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
        role,
      })
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      });

    fastify.log.info({ adminId: request.user.userId, newUserId: user.id }, 'User created by admin');

    return user;
  });

  // Update user (admin only)
  fastify.put('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);

    if (isNaN(userId)) {
      return reply.status(400).send({ error: 'Invalid user ID' });
    }

    const body = updateUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    // Check user exists
    const [existing] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Build update object
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (body.data.email) {
      // Check if new email is taken by another user
      const emailTaken = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, body.data.email))
        .limit(1);

      if (emailTaken.length > 0 && emailTaken[0].id !== userId) {
        return reply.status(409).send({ error: 'Email already in use' });
      }
      updates.email = body.data.email;
    }

    if (body.data.displayName) {
      updates.displayName = body.data.displayName;
    }

    if (body.data.role) {
      // Prevent demoting yourself
      if (userId === request.user.userId && body.data.role !== 'admin') {
        return reply.status(400).send({ error: 'Cannot demote yourself' });
      }
      updates.role = body.data.role;
    }

    if (body.data.password) {
      updates.passwordHash = await bcrypt.hash(body.data.password, 12);
    }

    // Handle admin level change (requires user to have linked GUID)
    if (body.data.adminLevel !== undefined && existing.guid) {
      // Get the level ID for the requested level number
      const [levelRow] = await db
        .select()
        .from(schema.adminLevels)
        .where(eq(schema.adminLevels.level, body.data.adminLevel))
        .limit(1);

      if (levelRow) {
        // Check if admin_player record exists
        const [adminPlayer] = await db
          .select()
          .from(schema.adminPlayers)
          .where(eq(schema.adminPlayers.guid, existing.guid))
          .limit(1);

        if (adminPlayer) {
          // Update existing
          await db
            .update(schema.adminPlayers)
            .set({ levelId: levelRow.id })
            .where(eq(schema.adminPlayers.guid, existing.guid));
        } else {
          // Create new admin_player record
          await db.insert(schema.adminPlayers).values({
            guid: existing.guid,
            levelId: levelRow.id,
          });
        }

        fastify.log.info(
          { adminId: request.user.userId, targetUserId: userId, newLevel: body.data.adminLevel },
          'ET admin level changed via Users page'
        );
      }
    }

    const [user] = await db
      .update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, userId))
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.users.role,
        updatedAt: schema.users.updatedAt,
      });

    fastify.log.info({ adminId: request.user.userId, updatedUserId: userId }, 'User updated by admin');

    return user;
  });

  // Delete user (admin only)
  fastify.delete('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);

    if (isNaN(userId)) {
      return reply.status(400).send({ error: 'Invalid user ID' });
    }

    // Prevent deleting yourself
    if (userId === request.user.userId) {
      return reply.status(400).send({ error: 'Cannot delete yourself' });
    }

    // Check user exists
    const [existing] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Delete user (sessions cascade automatically)
    await db.delete(schema.users).where(eq(schema.users.id, userId));

    fastify.log.info({ adminId: request.user.userId, deletedUserId: userId }, 'User deleted by admin');

    return { success: true };
  });
};
