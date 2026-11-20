import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../store.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { b64u } from '../lib/b64.js';
import { parse, requireAuth } from './auth.js';

const B64U32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'clave X25519 de 32 bytes en base64url');

function deviceJson(d: any) {
  return { id: d.id, name: d.name, platform: d.platform, createdAt: d.created_at, lastSeenAt: d.last_seen_at, push: d.push_kind ?? null };
}

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireAuth(ctx) };

  app.put('/api/account/key', auth, async (req, reply) => {
    const { publicKey } = parse(z.object({ publicKey: B64U32 }), req.body);
    if (b64u.decode(publicKey).length !== 32) throw new ApiError('bad_request', 'clave inválida');
    const r = ctx.db.prepare('UPDATE users SET account_public_key = ? WHERE id = ? AND account_public_key IS NULL').run(publicKey, req.auth.userId);
    if (r.changes === 0) throw new ApiError('conflict', 'La cuenta ya tiene clave');
    reply.code(204);
  });

  app.get('/api/me', auth, async req => {
    const u = ctx.db.prepare('SELECT id, email, account_public_key FROM users WHERE id = ?').get(req.auth.userId) as any;
    const devices = ctx.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(req.auth.userId) as any[];
    ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), req.auth.deviceId);
    return {
      user: { id: u.id, email: u.email, accountPublicKey: u.account_public_key },
      device: deviceJson(devices.find(d => d.id === req.auth.deviceId)),
      devices: devices.map(deviceJson),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', auth, async (req, reply) => {
    const r = ctx.db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(req.params.id, req.auth.userId);
    if (!r.changes) throw new ApiError('not_found', 'Dispositivo no encontrado');
    ctx.hub.closeDevice(req.auth.userId, req.params.id);
    reply.code(204);
  });

  app.put('/api/devices/me/push', auth, async (req, reply) => {
    const b = parse(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('apns'), token: z.string().regex(/^[0-9a-fA-F]{32,200}$/), environment: z.enum(['sandbox', 'production']) }),
      z.object({ kind: z.literal('webpush'), subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).passthrough() }),
      z.object({ kind: z.null() }),
    ]), req.body);
    const data = b.kind === 'apns' ? { token: b.token, environment: b.environment } : b.kind === 'webpush' ? { subscription: b.subscription } : null;
    ctx.db.prepare('UPDATE devices SET push_kind = ?, push_data = ? WHERE id = ?')
      .run(b.kind, data ? JSON.stringify(data) : null, req.auth.deviceId);
    reply.code(204);
  });

  app.get('/api/push/vapid', auth, async () => ({ publicKey: ctx.push.vapidPublicKey }));
}

export function linkRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireAuth(ctx) };
  const TTL = 10 * 60 * 1000;

  app.post('/api/link', auth, async req => {
    const { ephemeralPublicKey } = parse(z.object({ ephemeralPublicKey: B64U32 }), req.body);
    const id = newId('l');
    const now = Date.now();
    ctx.db.prepare('DELETE FROM link_requests WHERE expires_at < ?').run(now);
    ctx.db.prepare('INSERT INTO link_requests (id, user_id, device_id, ephemeral_public_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.auth.userId, req.auth.deviceId, ephemeralPublicKey, now + TTL, now);
    return { id, expiresAt: now + TTL };
  });

  app.get<{ Params: { id: string } }>('/api/link/:id', auth, async req => {
    const l = ctx.db.prepare('SELECT * FROM link_requests WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId) as any;
    if (!l) throw new ApiError('not_found', 'Solicitud no encontrada');
    const d = ctx.db.prepare('SELECT name, platform FROM devices WHERE id = ?').get(l.device_id) as any;
    const status = l.sealed_key ? 'approved' : l.expires_at < Date.now() ? 'expired' : 'pending';
    return {
      id: l.id, ephemeralPublicKey: l.ephemeral_public_key, deviceName: d?.name ?? '?', platform: d?.platform ?? '?', status,
      ...(status === 'approved' && l.device_id === req.auth.deviceId ? { sealedKey: l.sealed_key } : {}),
    };
  });

  app.post<{ Params: { id: string } }>('/api/link/:id/approve', auth, async (req, reply) => {
    const { sealedKey } = parse(z.object({ sealedKey: z.string().min(80).max(200) }), req.body);
    const l = ctx.db.prepare('SELECT * FROM link_requests WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId) as any;
    if (!l) throw new ApiError('not_found', 'Solicitud no encontrada');
    if (l.expires_at < Date.now()) throw new ApiError('conflict', 'La solicitud caducó');
    if (l.device_id === req.auth.deviceId) throw new ApiError('bad_request', 'No puedes aprobarte a ti mismo');
    ctx.db.prepare('UPDATE link_requests SET sealed_key = ? WHERE id = ?').run(sealedKey, l.id);
    ctx.hub.emit(req.auth.userId, { type: 'link', id: l.id, sealedKey }, l.device_id);
    reply.code(204);
  });
}
