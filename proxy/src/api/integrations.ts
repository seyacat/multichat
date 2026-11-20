import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../store.js';
import { integrationJson } from '../store.js';
import { ApiError } from '../lib/errors.js';
import { parse, requireAuth } from './auth.js';
import { createIntegration, deleteIntegration, getIntegration, patchIntegration, testCredentials } from '../integrations/index.js';
import { discord } from '../integrations/discord.js';
import type { IntegrationRow } from '../types.js';
import { PlatformError } from '../integrations/driver.js';

const Type = z.enum(['telegram', 'discord', 'whatsapp']);

export function integrationRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireAuth(ctx) };
  const own = (userId: string, id: string): IntegrationRow => {
    const i = getIntegration(ctx, id);
    if (!i || i.user_id !== userId) throw new ApiError('not_found', 'Integración no encontrada');
    return i;
  };

  app.get('/api/integrations', auth, async req => {
    const rows = ctx.db.prepare('SELECT * FROM integrations WHERE user_id = ? ORDER BY created_at').all(req.auth.userId) as unknown as IntegrationRow[];
    return rows.map(r => integrationJson(ctx, r));
  });

  app.post('/api/integrations/test', auth, async req => {
    const b = parse(z.object({ type: Type, credentials: z.record(z.string(), z.unknown()) }), req.body);
    return { ok: true, info: await testCredentials(ctx, b.type, b.credentials) };
  });

  app.post('/api/integrations', auth, async (req, reply) => {
    const b = parse(z.object({
      type: Type, name: z.string().trim().min(1).max(60), color: z.string().default('#64748b'),
      credentials: z.record(z.string(), z.unknown()), config: z.record(z.string(), z.unknown()).optional(),
    }), req.body);
    const row = await createIntegration(ctx, req.auth.userId, b);
    reply.code(201);
    return integrationJson(ctx, row);
  });

  app.patch<{ Params: { id: string } }>('/api/integrations/:id', auth, async req => {
    const integ = own(req.auth.userId, req.params.id);
    const b = parse(z.object({
      name: z.string().max(60).optional(), color: z.string().optional(), enabled: z.boolean().optional(),
      credentials: z.record(z.string(), z.unknown()).optional(), config: z.record(z.string(), z.unknown()).optional(),
    }), req.body);
    return integrationJson(ctx, await patchIntegration(ctx, integ, b));
  });

  app.delete<{ Params: { id: string } }>('/api/integrations/:id', auth, async (req, reply) => {
    await deleteIntegration(ctx, own(req.auth.userId, req.params.id));
    reply.code(204);
  });

  app.get<{ Params: { id: string } }>('/api/integrations/:id/discord/channels', auth, async req => {
    const integ = own(req.auth.userId, req.params.id);
    if (integ.type !== 'discord') throw new ApiError('bad_request', 'No es una integración de Discord');
    try {
      return await discord.channels(integ);
    } catch (e) {
      if (e instanceof PlatformError) throw new ApiError('platform_error', e.message);
      throw e;
    }
  });
}
