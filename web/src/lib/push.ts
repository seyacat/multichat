// Texto de la notificación Web Push a partir del objeto `mc` (protocol.md §8). Lo usa el service worker.
import { openJson } from './crypto';
import { previewText } from './merge';
import type { ContactProfile, LocalMessage, MessagePayload, PushPayload } from './types';

export const GENERIC = { title: 'Multichat', body: 'Nuevo mensaje' };

export async function buildNotification(
  mc: PushPayload,
  key: Uint8Array | undefined | null,
): Promise<{ title: string; body: string }> {
  const generic = GENERIC;
  if (mc.hidePreview) return generic;
  if (!key) return generic;
  const priv = new Uint8Array(key);
  let title = generic.title;
  try {
    if (mc.alias) title = (await openJson<{ name: string }>(mc.alias, priv)).name || title;
    else if (mc.profile) {
      const p = await openJson<ContactProfile>(mc.profile, priv);
      title = p.name || p.username || p.phone || title;
    }
  } catch {
    /* sin nombre */
  }
  let body = generic.body;
  if (mc.envelope) {
    try {
      const payload = await openJson<MessagePayload>(mc.envelope, priv);
      const text = previewText({ payload } as LocalMessage);
      body = payload.senderName ? `${payload.senderName}: ${text}` : text || body;
    } catch {
      /* texto genérico */
    }
  }
  return { title, body };
}
