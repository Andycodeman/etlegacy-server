import { FastifyRequest, FastifyReply } from 'fastify';

export interface JwtPayload {
  userId: number;
  email: string | null;
  displayName: string;
  role: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await authenticate(request, reply);
  if (reply.sent) return;

  if (request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Forbidden: Admin access required' });
  }
}

export async function requireModerator(request: FastifyRequest, reply: FastifyReply) {
  await authenticate(request, reply);
  if (reply.sent) return;

  if (!['admin', 'moderator'].includes(request.user.role)) {
    reply.status(403).send({ error: 'Forbidden: Moderator access required' });
  }
}
