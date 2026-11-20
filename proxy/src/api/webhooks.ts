import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../store.js';
import { credsOf, getIntegration } from '../integrations/index.js';
import { handleTelegramWebhook, type TelegramCreds } from '../integrations/telegram.js';
import { handleWhatsappWebhook, verifyWhatsappSignature, type WhatsappCreds } from '../integrations/whatsapp.js';
import type { IntegrationRow } from '../types.js';

function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function webhookRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post<{ Params: { id: string } }>('/wh/telegram/:id', async (req, reply) => {
    const integ = getIntegration(ctx, req.params.id);
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    if (!integ || integ.type !== 'telegram' || !safeEq(secret, integ.webhook_secret)) return reply.code(401).send();
    if (!integ.enabled) return reply.code(200).send();
    // responder rápido; Telegram reintenta si tardamos
    void handleTelegramWebhook(ctx, integ, credsOf<TelegramCreds>(ctx, integ), req.body)
      .catch(e => ctx.log.error({ err: String(e), integration: integ.id }, 'webhook de Telegram falló'));
    return reply.code(200).send();
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/wh/whatsapp/:id', async (req, reply) => {
    const integ = getIntegration(ctx, req.params.id);
    const q = req.query;
    const token = integ ? (JSON.parse(integ.config_json).verifyToken as string | undefined) : undefined;
    if (integ?.type === 'whatsapp' && q['hub.mode'] === 'subscribe' && token && safeEq(q['hub.verify_token'] ?? '', token)) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post<{ Params: { id: string } }>('/wh/whatsapp/:id', async (req, reply) => {
    const integ = getIntegration(ctx, req.params.id);
    if (!integ || integ.type !== 'whatsapp') return reply.code(404).send();
    const creds = credsOf<WhatsappCreds>(ctx, integ);
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifyWhatsappSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, creds.appSecret)) return reply.code(401).send();
    // Meta usa un solo callback por app: enrutar por phone_number_id entre las integraciones de la misma app.
    const resolve = (phoneNumberId: string) => {
      if (phoneNumberId === creds.phoneNumberId) return integ.enabled ? { integ, creds } : null;
      const rows = ctx.db.prepare("SELECT * FROM integrations WHERE type = 'whatsapp' AND lookup_key = ? AND enabled = 1").all(phoneNumberId) as unknown as IntegrationRow[];
      for (const r of rows) {
        const c = credsOf<WhatsappCreds>(ctx, r);
        if (c.appId === creds.appId) return { integ: r, creds: c };
      }
      return null;
    };
    void handleWhatsappWebhook(ctx, req.body, resolve)
      .catch(e => ctx.log.error({ err: String(e), integration: integ.id }, 'webhook de WhatsApp falló'));
    return reply.code(200).send();
  });
}
