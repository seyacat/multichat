import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../store.js';
import { ApiError } from '../lib/errors.js';
import { newId, randomToken } from '../lib/ids.js';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { hashToken, signAccess, verifyAccess } from '../crypto/token.js';
import { tx } from '../db/index.js';

const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 90 * 24 * 3600 * 1000;

declare module 'fastify' {
  interface FastifyRequest { auth: { userId: string; deviceId: string } }
}

const Creds = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(256),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.enum(['ios', 'web']),
});

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError('bad_request', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

function session(ctx: Ctx, userId: string, deviceId: string, refreshToken: string) {
  const u = ctx.db.prepare('SELECT id, email, account_public_key FROM users WHERE id = ?').get(userId) as any;
  const d = ctx.db.prepare('SELECT id, name, platform FROM devices WHERE id = ?').get(deviceId) as any;
  return {
    accessToken: signAccess({ sub: userId, dev: deviceId, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL }, ctx.vault.jwtKey),
    refreshToken,
    user: { id: u.id, email: u.email, accountPublicKey: u.account_public_key },
    device: { id: d.id, name: d.name, platform: d.platform },
  };
}

function newDevice(ctx: Ctx, userId: string, name: string, platform: string) {
  const id = newId('d');
  const refresh = randomToken();
  const now = Date.now();
  ctx.db.prepare(`INSERT INTO devices (id, user_id, name, platform, refresh_hash, refresh_expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, name, platform, hashToken(refresh), now + REFRESH_TTL, now, now);
  return { id, refresh };
}

export function authenticate(ctx: Ctx, token: string | undefined): { userId: string; deviceId: string } | null {
  if (!token) return null;
  const c = verifyAccess(token, ctx.vault.jwtKey);
  if (!c) return null;
  const d = ctx.db.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?').get(c.dev, c.sub);
  return d ? { userId: c.sub, deviceId: c.dev } : null;
}

export function requireAuth(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const a = authenticate(ctx, h?.startsWith('Bearer ') ? h.slice(7) : undefined);
    if (!a) throw new ApiError('unauthorized', 'Sesión no válida');
    req.auth = a;
  };
}

/** Límite simple en memoria: N intentos por IP y ventana. */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return async (req: FastifyRequest) => {
    const now = Date.now();
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const h = hits.get(req.ip);
    if (!h || h.reset < now) { hits.set(req.ip, { n: 1, reset: now + windowMs }); return; }
    if (++h.n > max) throw new ApiError('limit_reached', 'Demasiados intentos; espera un minuto');
  };
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const limited = { preHandler: rateLimiter(Number(process.env.AUTH_RATE_LIMIT ?? 10), 60_000) };
  app.post('/api/auth/register', limited, async (req, reply) => {
    const b = parse(Creds, req.body);
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email)) throw new ApiError('conflict', 'Ese email ya está registrado');
    const hash = await hashPassword(b.password);
    const userId = newId('u');
    const dev = tx(ctx.db, () => {
      ctx.db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(userId, b.email, hash, Date.now());
      return newDevice(ctx, userId, b.deviceName, b.platform);
    });
    reply.code(201);
    return session(ctx, userId, dev.id, dev.refresh);
  });

  app.post('/api/auth/login', limited, async req => {
    const b = parse(Creds, req.body);
    const u = ctx.db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(b.email) as { id: string; password_hash: string } | undefined;
    if (!u || !(await verifyPassword(b.password, u.password_hash))) throw new ApiError('unauthorized', 'Email o contraseña incorrectos');
    const dev = newDevice(ctx, u.id, b.deviceName, b.platform);
    return session(ctx, u.id, dev.id, dev.refresh);
  });

  app.post('/api/auth/refresh', async req => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    const d = ctx.db.prepare('SELECT id, user_id, refresh_expires_at FROM devices WHERE refresh_hash = ?').get(hashToken(refreshToken)) as
      { id: string; user_id: string; refresh_expires_at: number } | undefined;
    if (!d || d.refresh_expires_at < Date.now()) throw new ApiError('unauthorized', 'Sesión caducada');
    const refresh = randomToken();
    const now = Date.now();
    ctx.db.prepare('UPDATE devices SET refresh_hash = ?, refresh_expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(hashToken(refresh), now + REFRESH_TTL, now, d.id);
    return session(ctx, d.user_id, d.id, refresh);
  });

  app.post('/api/auth/logout', { preHandler: requireAuth(ctx) }, async (req, reply) => {
    ctx.db.prepare('DELETE FROM devices WHERE id = ?').run(req.auth.deviceId);
    ctx.hub.closeDevice(req.auth.userId, req.auth.deviceId);
    reply.code(204);
  });
}
