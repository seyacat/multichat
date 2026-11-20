import { Readable } from 'node:stream';
import type { Ctx } from '../store.js';
import { ingestInbound } from '../store.js';
import type { Inbound, IntegrationRow } from '../types.js';
import { Driver, PlatformError, readJson, requireFields } from './driver.js';

type Creds = { botToken: string };
const API = 'https://api.telegram.org';
const MAX_DOWNLOAD = 20 * 1024 * 1024; // límite de getFile de la Bot API

async function call(token: string, method: string, body?: Record<string, unknown> | FormData): Promise<any> {
  const init: RequestInit = { method: 'POST' };
  if (body instanceof FormData) init.body = body;
  else if (body) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' }; }
  const res = await fetch(`${API}/bot${token}/${method}`, init);
  const j = await readJson(res);
  if (!j.ok) throw new PlatformError(`Telegram: ${j.description ?? res.statusText}`);
  return j.result;
}

export const telegram: Driver<Creds> = {
  parseCredentials: input => requireFields(input, ['botToken'] as const),
  hintSource: c => c.botToken,

  async validate(_ctx, c) {
    const me = await call(c.botToken, 'getMe');
    return { botId: String(me.id), username: me.username ?? null, firstName: me.first_name ?? null };
  },

  async start(ctx, integ, c) {
    const info = await this.validate(ctx, c);
    await call(c.botToken, 'setWebhook', {
      url: `${ctx.config.publicUrl}/wh/telegram/${integ.id}`,
      secret_token: integ.webhook_secret,
      allowed_updates: ['message', 'channel_post'],
      drop_pending_updates: false,
    });
    return { info };
  },

  async stop(_ctx, _integ, c) {
    await call(c.botToken, 'deleteWebhook', { drop_pending_updates: false }).catch(() => undefined);
  },

  async send(_ctx, _integ, c, contact, out) {
    const chatId = contact.external_id;
    if (!out.file) {
      const r = await call(c.botToken, 'sendMessage', { chat_id: chatId, text: out.text ?? '' });
      return { platformMessageId: String(r.message_id) };
    }
    const [method, field] = {
      image: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], audio: ['sendAudio', 'audio'],
      file: ['sendDocument', 'document'], text: ['sendDocument', 'document'],
    }[out.kind] as [string, string];
    const fd = new FormData();
    fd.set('chat_id', chatId);
    if (out.text) fd.set('caption', out.text);
    fd.set(field, new Blob([new Uint8Array(out.file.data)], { type: out.file.mime }), out.file.name);
    const r = await call(c.botToken, method, fd);
    return { platformMessageId: String(r.message_id) };
  },
};

function displayName(u: any): string {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || u?.title || 'Desconocido';
}

/** Convierte un update de Telegram al formato común. */
export function parseTelegramUpdate(update: any, token: string): Inbound | null {
  const m = update.message ?? update.channel_post;
  if (!m || !m.chat) return null;
  const chat = m.chat;
  const isGroup = chat.type !== 'private';
  const from = m.from;
  const inb: Inbound = {
    externalId: String(chat.id),
    kind: isGroup ? 'group' : 'direct',
    profile: isGroup
      ? { name: chat.title ?? 'Grupo', username: chat.username ?? null, phone: null }
      : { name: displayName(from ?? chat), username: (from ?? chat).username ?? null, phone: null },
    platformMessageId: String(m.message_id),
    payloadKind: 'text',
    text: m.text ?? m.caption ?? null,
    senderName: isGroup && from ? displayName(from) : null,
  };

  const media = (fileId: string, size: number | undefined, mime: string, name: string, kind: Inbound['payloadKind']) => {
    inb.payloadKind = kind;
    if (size && size > MAX_DOWNLOAD) {
      inb.mediaError = `Archivo de ${(size / 1048576).toFixed(1)} MB: Telegram no permite a los bots descargar más de 20 MB`;
      return;
    }
    inb.media = {
      mime, name,
      async fetch() {
        const f = await call(token, 'getFile', { file_id: fileId });
        const res = await fetch(`${API}/file/bot${token}/${f.file_path}`);
        if (!res.ok || !res.body) throw new Error(`descarga ${res.status}`);
        const fromPath = String(f.file_path).split('/').pop();
        return { data: Readable.fromWeb(res.body as any), name: name || fromPath, mime };
      },
    };
  };

  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    media(p.file_id, p.file_size, 'image/jpeg', `foto_${m.message_id}.jpg`, 'image');
  } else if (m.video) {
    media(m.video.file_id, m.video.file_size, m.video.mime_type ?? 'video/mp4', m.video.file_name ?? `video_${m.message_id}.mp4`, 'video');
  } else if (m.animation) {
    media(m.animation.file_id, m.animation.file_size, m.animation.mime_type ?? 'video/mp4', m.animation.file_name ?? `gif_${m.message_id}.mp4`, 'video');
  } else if (m.video_note) {
    media(m.video_note.file_id, m.video_note.file_size, 'video/mp4', `videonota_${m.message_id}.mp4`, 'video');
  } else if (m.voice) {
    media(m.voice.file_id, m.voice.file_size, m.voice.mime_type ?? 'audio/ogg', `nota_${m.message_id}.ogg`, 'audio');
  } else if (m.audio) {
    media(m.audio.file_id, m.audio.file_size, m.audio.mime_type ?? 'audio/mpeg', m.audio.file_name ?? `audio_${m.message_id}.mp3`, 'audio');
  } else if (m.document) {
    media(m.document.file_id, m.document.file_size, m.document.mime_type ?? 'application/octet-stream', m.document.file_name ?? `archivo_${m.message_id}`, 'file');
  } else if (m.sticker) {
    const animated = m.sticker.is_animated || m.sticker.is_video;
    media(m.sticker.file_id, m.sticker.file_size, animated ? (m.sticker.is_video ? 'video/webm' : 'application/x-tgsticker') : 'image/webp',
      `sticker_${m.message_id}.${m.sticker.is_video ? 'webm' : animated ? 'tgs' : 'webp'}`, 'sticker');
    inb.text = inb.text ?? m.sticker.emoji ?? null;
  } else if (m.location) {
    inb.payloadKind = 'location';
    inb.location = { lat: m.location.latitude, lon: m.location.longitude };
  } else if (m.contact) {
    inb.text = `Contacto: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')} ${m.contact.phone_number ?? ''}`.trim();
  } else if (!inb.text) {
    inb.payloadKind = 'unsupported';
    inb.text = '[Mensaje no soportado]';
  }
  return inb;
}

export async function handleTelegramWebhook(ctx: Ctx, integ: IntegrationRow, creds: Creds, update: any) {
  const inb = parseTelegramUpdate(update, creds.botToken);
  if (inb) await ingestInbound(ctx, integ, inb);
}

export type { Creds as TelegramCreds };
