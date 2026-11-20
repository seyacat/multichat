import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import type { Config } from './config.js';
import { openDb } from './db/index.js';
import { Vault } from './crypto/vault.js';
import { Hub } from './hub.js';
import { BlobStore } from './blobs.js';
import { Push } from './push/index.js';
import type { Ctx } from './store.js';
import { ApiError } from './lib/errors.js';
import { authenticate, authRoutes } from './api/auth.js';
import { accountRoutes, linkRoutes } from './api/account.js';
import { integrationRoutes } from './api/integrations.js';
import { chatRoutes } from './api/chats.js';
import { webhookRoutes } from './api/webhooks.js';
import { startAll, stopAll } from './integrations/index.js';

export async function buildApp(config: Config, opts: { logger?: boolean; dbPath?: string; startIntegrations?: boolean } = {}):
    Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  const db = openDb(opts.dbPath ?? join(config.dataDir, 'multichat.sqlite'));
  const hub = new Hub();
  const log = {
    info: (...a: unknown[]) => (app.log.info as any)(...a),
    warn: (...a: unknown[]) => (app.log.warn as any)(...a),
    error: (...a: unknown[]) => (app.log.error as any)(...a),
  };
  const ctx: Ctx = {
    config, db, hub, log,
    vault: new Vault(config.masterKey),
    blobs: new BlobStore(config.dataDir, db),
    push: new Push(config, db, hub, log),
  };

  // JSON guardando el cuerpo crudo (firma de WhatsApp)
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try { done(null, JSON.parse((body as Buffer).toString('utf8'))); }
    catch { done(new ApiError('bad_request', 'JSON inválido'), undefined); }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.statusCode === 413) return reply.code(413).send({ error: 'too_large', message: 'Archivo demasiado grande' });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Error interno' });
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/api/health', async () => ({ ok: true }));
  authRoutes(app, ctx);
  accountRoutes(app, ctx);
  linkRoutes(app, ctx);
  integrationRoutes(app, ctx);
  chatRoutes(app, ctx);
  webhookRoutes(app, ctx);

  app.get<{ Querystring: { token?: string } }>('/api/ws', { websocket: true }, (socket, req) => {
    const a = authenticate(ctx, req.query.token);
    if (!a) { socket.close(4401, 'unauthorized'); return; }
    const s = { deviceId: a.deviceId, send: (d: string) => socket.send(d), close: () => socket.close(4401, 'revoked') };
    hub.add(a.userId, s);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), a.deviceId);
    socket.on('message', (raw: Buffer) => {
      try {
        if (JSON.parse(raw.toString()).type === 'ping') socket.send('{"type":"pong"}');
      } catch { /* ignorar */ }
    });
    socket.on('close', () => hub.remove(a.userId, s));
  });

  if (config.serveWeb) {
    await app.register(fastifyStatic, { root: config.serveWeb, prefix: '/app/' });
    app.get('/', (_req, reply) => reply.redirect('/app/'));
  }

  app.addHook('onClose', async () => {
    await stopAll(ctx);
    ctx.push.close();
    db.close();
  });

  if (opts.startIntegrations !== false) app.addHook('onReady', async () => { void startAll(ctx); });
  return { app, ctx };
}
