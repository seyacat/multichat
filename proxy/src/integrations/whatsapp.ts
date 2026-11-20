import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../store.js';
import { ingestInbound, updateStatusByPlatformId } from '../store.js';
import type { Inbound, IntegrationRow, MessageStatus } from '../types.js';
import { Driver, PlatformError, readJson, requireFields } from './driver.js';
import { randomToken } from '../lib/ids.js';

type Creds = { appId: string; appSecret: string; accessToken: string; phoneNumberId: string; wabaId: string };
const FIELDS = ['appId', 'appSecret', 'accessToken', 'phoneNumberId', 'wabaId'] as const;

function graph(ctx: Ctx, path: string) {
  return `https://graph.facebook.com/${ctx.config.graphVersion}/${path}`;
}

async function gfetch(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  const j = await readJson(res);
  if (!res.ok || j.error) throw new PlatformError(`WhatsApp: ${j.error?.message ?? res.statusText}`);
  return j;
}

export const whatsapp: Driver<Creds> = {
  parseCredentials: input => requireFields(input, FIELDS),
  hintSource: c => c.accessToken,

  async validate(ctx, c) {
    const j = await gfetch(graph(ctx, `${c.phoneNumberId}?fields=display_phone_number,verified_name`), c.accessToken);
    return { displayPhoneNumber: j.display_phone_number ?? null, verifiedName: j.verified_name ?? null };
  },

  async start(ctx, integ, c) {
    const info: Record<string, unknown> = await this.validate(ctx, c);
    const config = JSON.parse(integ.config_json) as { verifyToken?: string };
    const verifyToken = config.verifyToken ?? randomToken(18);
    // Meta llama al GET de verificación durante el registro: el token tiene que estar guardado antes.
    if (!config.verifyToken) {
      ctx.db.prepare('UPDATE integrations SET config_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...config, verifyToken }), integ.id);
    }
    let webhookRegistered = false;
    try {
      const body = new URLSearchParams({
        object: 'whatsapp_business_account',
        callback_url: `${ctx.config.publicUrl}/wh/whatsapp/${integ.id}`,
        verify_token: verifyToken,
        fields: 'messages',
        access_token: `${c.appId}|${c.appSecret}`,
      });
      const res = await fetch(graph(ctx, `${c.appId}/subscriptions`), { method: 'POST', body });
      const j = await readJson(res);
      if (!res.ok || j.error) throw new Error(j.error?.message ?? res.statusText);
      await gfetch(graph(ctx, `${c.wabaId}/subscribed_apps`), c.accessToken, { method: 'POST' });
      webhookRegistered = true;
    } catch (e) {
      ctx.log.warn({ integration: integ.id, err: String(e) }, 'registro automático del webhook de WhatsApp falló');
      info.webhookError = String((e as Error).message ?? e);
    }
    info.webhookRegistered = webhookRegistered;
    return { info, config: { verifyToken }, lookupKey: c.phoneNumberId };
  },

  async stop(ctx, _integ, c, { deleting }) {
    if (!deleting) return;
    await gfetch(graph(ctx, `${c.wabaId}/subscribed_apps`), c.accessToken, { method: 'DELETE' }).catch(() => undefined);
  },

  async send(ctx, _integ, c, contact, out) {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: contact.external_id };
    let body: Record<string, unknown>;
    if (!out.file) {
      body = { ...base, type: 'text', text: { body: out.text ?? '', preview_url: true } };
    } else {
      const fd = new FormData();
      fd.set('messaging_product', 'whatsapp');
      fd.set('type', out.file.mime);
      fd.set('file', new Blob([new Uint8Array(out.file.data)], { type: out.file.mime }), out.file.name);
      const up = await gfetch(graph(ctx, `${c.phoneNumberId}/media`), c.accessToken, { method: 'POST', body: fd });
      const type = out.kind === 'file' ? 'document' : out.kind;
      const media: Record<string, unknown> = { id: up.id };
      if (out.text && type !== 'audio') media.caption = out.text;
      if (type === 'document') media.filename = out.file.name;
      body = { ...base, type, [type]: media };
    }
    const j = await gfetch(graph(ctx, `${c.phoneNumberId}/messages`), c.accessToken, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
    return { platformMessageId: j.messages?.[0]?.id ?? null };
  },
};

export function verifyWhatsappSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'application/pdf': 'pdf',
};

export function parseWhatsappMessage(ctx: Ctx, c: Creds, msg: any, contacts: any[]): Inbound {
  const profileName = contacts.find(x => x.wa_id === msg.from)?.profile?.name ?? `+${msg.from}`;
  const inb: Inbound = {
    externalId: String(msg.from),
    kind: 'direct',
    profile: { name: profileName, username: null, phone: `+${msg.from}` },
    platformMessageId: msg.id ?? null,
    payloadKind: 'text',
    text: null,
    senderName: null,
  };
  const t = msg.type as string;
  if (t === 'text') inb.text = msg.text?.body ?? '';
  else if (['image', 'video', 'audio', 'document', 'sticker'].includes(t)) {
    const m = msg[t];
    const mime = String(m.mime_type ?? 'application/octet-stream').split(';')[0]!.trim();
    inb.payloadKind = t === 'document' ? 'file' : (t as Inbound['payloadKind']);
    inb.text = m.caption ?? null;
    const name = m.filename ?? `${t}_${String(msg.id).slice(-8)}.${EXT[mime] ?? 'bin'}`;
    inb.media = {
      mime, name,
      async fetch() {
        const meta = await gfetch(graph(ctx, m.id), c.accessToken);
        const res = await fetch(meta.url, { headers: { authorization: `Bearer ${c.accessToken}` } });
        if (!res.ok) throw new Error(`descarga ${res.status}`);
        return { data: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type ?? mime, name };
      },
    };
  } else if (t === 'location') {
    inb.payloadKind = 'location';
    inb.location = { lat: msg.location.latitude, lon: msg.location.longitude };
    inb.text = [msg.location.name, msg.location.address].filter(Boolean).join(' · ') || null;
  } else if (t === 'reaction') {
    inb.text = `Reaccionó ${msg.reaction?.emoji ?? ''}`.trim();
  } else if (t === 'button') {
    inb.text = msg.button?.text ?? null;
  } else if (t === 'interactive') {
    inb.text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '[Respuesta interactiva]';
  } else if (t === 'contacts') {
    inb.text = (msg.contacts ?? []).map((x: any) => `Contacto: ${x.name?.formatted_name ?? ''} ${x.phones?.[0]?.phone ?? ''}`.trim()).join('\n');
  } else {
    inb.payloadKind = 'unsupported';
    inb.text = '[Mensaje no soportado]';
  }
  return inb;
}

const STATUS_MAP: Record<string, MessageStatus> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/** Procesa un cuerpo de webhook. `resolve` devuelve integración + credenciales por phone_number_id. */
export async function handleWhatsappWebhook(
  ctx: Ctx, body: any,
  resolve: (phoneNumberId: string) => { integ: IntegrationRow; creds: Creds } | null,
) {
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value ?? {};
      const target = resolve(String(v.metadata?.phone_number_id ?? ''));
      if (!target) continue;
      for (const msg of v.messages ?? []) {
        await ingestInbound(ctx, target.integ, parseWhatsappMessage(ctx, target.creds, msg, v.contacts ?? []));
      }
      for (const st of v.statuses ?? []) {
        const s = STATUS_MAP[st.status];
        if (!s) continue;
        const err = st.errors?.[0] ? `${st.errors[0].title ?? ''} ${st.errors[0].message ?? st.errors[0].error_data?.details ?? ''}`.trim() : undefined;
        updateStatusByPlatformId(ctx, target.integ.id, String(st.id), s, err);
      }
    }
  }
}

export type { Creds as WhatsappCreds };
