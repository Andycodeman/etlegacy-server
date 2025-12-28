import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, desc, and, gte, lte } from 'drizzle-orm';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const eventSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  eventType: z.enum(['config_change', 'map_rotation', 'custom']),
  configJson: z.record(z.string(), z.string()),
  cronExpression: z.string().optional(),
  oneTimeAt: z.string().datetime().optional(),
  isActive: z.boolean().default(true),
});

const reservationSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  configJson: z.record(z.string(), z.string()).optional(),
});

const reservationUpdateSchema = z.object({
  status: z.enum(['pending', 'approved', 'active', 'completed', 'rejected']),
});

export const scheduleRoutes: FastifyPluginAsync = async (fastify) => {
  // === Scheduled Events ===

  // List scheduled events
  fastify.get('/events', { preHandler: authenticate }, async () => {
    const events = await db
      .select({
        id: schema.scheduledEvents.id,
        name: schema.scheduledEvents.name,
        description: schema.scheduledEvents.description,
        eventType: schema.scheduledEvents.eventType,
        configJson: schema.scheduledEvents.configJson,
        cronExpression: schema.scheduledEvents.cronExpression,
        oneTimeAt: schema.scheduledEvents.oneTimeAt,
        isActive: schema.scheduledEvents.isActive,
        createdAt: schema.scheduledEvents.createdAt,
        createdBy: schema.users.displayName,
      })
      .from(schema.scheduledEvents)
      .leftJoin(schema.users, eq(schema.scheduledEvents.createdBy, schema.users.id))
      .orderBy(desc(schema.scheduledEvents.createdAt));

    return events;
  });

  // Create scheduled event (admin only)
  fastify.post('/events', { preHandler: requireAdmin }, async (request, reply) => {
    const body = eventSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    if (!body.data.cronExpression && !body.data.oneTimeAt) {
      return reply.status(400).send({ error: 'Either cronExpression or oneTimeAt is required' });
    }

    const [event] = await db
      .insert(schema.scheduledEvents)
      .values({
        ...body.data,
        oneTimeAt: body.data.oneTimeAt ? new Date(body.data.oneTimeAt) : null,
        createdBy: request.user.userId,
      })
      .returning();

    fastify.log.info({ user: request.user.email, eventId: event.id }, 'Scheduled event created');

    return event;
  });

  // Update scheduled event (admin only)
  fastify.put('/events/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const eventId = parseInt(id);

    if (isNaN(eventId)) {
      return reply.status(400).send({ error: 'Invalid event ID' });
    }

    const body = eventSchema.partial().safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const [event] = await db
      .update(schema.scheduledEvents)
      .set({
        ...body.data,
        oneTimeAt: body.data.oneTimeAt ? new Date(body.data.oneTimeAt) : undefined,
      })
      .where(eq(schema.scheduledEvents.id, eventId))
      .returning();

    if (!event) {
      return reply.status(404).send({ error: 'Event not found' });
    }

    return event;
  });

  // Delete scheduled event (admin only)
  fastify.delete('/events/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const eventId = parseInt(id);

    if (isNaN(eventId)) {
      return reply.status(400).send({ error: 'Invalid event ID' });
    }

    await db.delete(schema.scheduledEvents).where(eq(schema.scheduledEvents.id, eventId));

    return { success: true };
  });

  // === Reservations ===

  // List reservations
  fastify.get('/reservations', { preHandler: authenticate }, async (request) => {
    const { from, to } = request.query as { from?: string; to?: string };

    let query = db
      .select({
        id: schema.reservations.id,
        title: schema.reservations.title,
        description: schema.reservations.description,
        startTime: schema.reservations.startTime,
        endTime: schema.reservations.endTime,
        configJson: schema.reservations.configJson,
        status: schema.reservations.status,
        createdAt: schema.reservations.createdAt,
        user: schema.users.displayName,
      })
      .from(schema.reservations)
      .leftJoin(schema.users, eq(schema.reservations.userId, schema.users.id))
      .orderBy(desc(schema.reservations.startTime));

    // TODO: Add date filtering if from/to provided

    return await query;
  });

  // Create reservation (any authenticated user)
  fastify.post('/reservations', { preHandler: authenticate }, async (request, reply) => {
    const body = reservationSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input', details: body.error.flatten() });
    }

    const startTime = new Date(body.data.startTime);
    const endTime = new Date(body.data.endTime);

    if (startTime >= endTime) {
      return reply.status(400).send({ error: 'End time must be after start time' });
    }

    if (startTime < new Date()) {
      return reply.status(400).send({ error: 'Start time must be in the future' });
    }

    // Check for overlapping reservations
    const overlapping = await db
      .select()
      .from(schema.reservations)
      .where(
        and(
          eq(schema.reservations.status, 'approved'),
          lte(schema.reservations.startTime, endTime),
          gte(schema.reservations.endTime, startTime)
        )
      )
      .limit(1);

    if (overlapping.length > 0) {
      return reply.status(409).send({ error: 'Time slot conflicts with existing reservation' });
    }

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: request.user.userId,
        title: body.data.title,
        description: body.data.description,
        startTime,
        endTime,
        configJson: body.data.configJson,
        status: 'pending',
      })
      .returning();

    fastify.log.info(
      { user: request.user.email, reservationId: reservation.id },
      'Reservation created'
    );

    return reservation;
  });

  // Update reservation status (admin only)
  fastify.put('/reservations/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const reservationId = parseInt(id);

    if (isNaN(reservationId)) {
      return reply.status(400).send({ error: 'Invalid reservation ID' });
    }

    const body = reservationUpdateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }

    const [reservation] = await db
      .update(schema.reservations)
      .set({
        status: body.data.status,
        approvedBy: ['approved', 'rejected'].includes(body.data.status)
          ? request.user.userId
          : undefined,
      })
      .where(eq(schema.reservations.id, reservationId))
      .returning();

    if (!reservation) {
      return reply.status(404).send({ error: 'Reservation not found' });
    }

    fastify.log.info(
      { user: request.user.email, reservationId, status: body.data.status },
      'Reservation updated'
    );

    return reservation;
  });

  // Delete reservation (owner or admin)
  fastify.delete('/reservations/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const reservationId = parseInt(id);

    if (isNaN(reservationId)) {
      return reply.status(400).send({ error: 'Invalid reservation ID' });
    }

    const [reservation] = await db
      .select()
      .from(schema.reservations)
      .where(eq(schema.reservations.id, reservationId))
      .limit(1);

    if (!reservation) {
      return reply.status(404).send({ error: 'Reservation not found' });
    }

    // Only owner or admin can delete
    if (reservation.userId !== request.user.userId && request.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Not authorized to delete this reservation' });
    }

    await db.delete(schema.reservations).where(eq(schema.reservations.id, reservationId));

    return { success: true };
  });
};
