import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { nextSeq, tx } from './db/index.js';
import type { Vault } from './crypto/vault.js';
import type { Hub } from './hub.js';
import type { BlobStore } from './blobs.js';
import type { Push } from './push/index.js';
import { sealJson } from './crypto/seal.js';
import { newId } from './lib/ids.js';
import { b64u } from './lib/b64.js';
import type {
  ContactProfile, ContactRow, Inbound, IntegrationRow, MessagePayload, MessageRow, MessageStatus,
} from './types.js';

export interface Ctx {
  config: Config;
  db: DB;
  vault: Vault;
  hub: Hub;
  blobs: BlobStore;
  push: Push;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

// ---------- mapeo a JSON de la API ----------

export function integrationJson(ctx: Ctx, r: IntegrationRow) {
  const config = JSON.parse(r.config_json);
  return {
    id: r.id, type: r.type, name: r.name, color: r.color, enabled: !!r.enabled,
    status: r.enabled ? r.status : 'disabled',
    statusDetail: r.status_detail,
    credentialHint: r.credential_hint,
    info: JSON.parse(r.info_json),
    config,
    webhookUrl: r.type === 'discord' ? null : `${ctx.config.publicUrl}/wh/${r.type}/${r.id}`,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function contactJson(r: ContactRow) {
  return {
    id: r.id, integrationId: r.integration_id, kind: r.kind, status: r.status,
    profile: r.profile_env, alias: r.alias_env, muted: !!r.muted, hidePreview: !!r.hide_preview,
    unread: r.unread, lastMessageAt: r.last_message_at, lastInboundAt: r.last_inbound_at,
    seq: r.seq, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function messageJson(r: MessageRow) {
  return {
    id: r.id, contactId: r.contact_id, direction: r.direction, status: r.status, error: r.error,
    envelope: r.envelope, clientId: r.client_id, seq: r.seq, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------- lecturas ----------

export function getAccountKey(ctx: Ctx, userId: string): string | null {
  const r = ctx.db.prepare('SELECT account_public_key FROM users WHERE id = ?').get(userId) as { account_public_key: string | null } | undefined;
  return r?.account_public_key ?? null;
}

export function getContact(ctx: Ctx, id: string): ContactRow | undefined {
  return ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
}

export function getMessage(ctx: Ctx, id: string): MessageRow | undefined {
  return ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export function emitContact(ctx: Ctx, c: ContactRow) {
  ctx.hub.emit(c.user_id, { type: 'contact', contact: contactJson(c) });
}

export function emitMessage(ctx: Ctx, m: MessageRow) {
  ctx.hub.emit(m.user_id, { type: 'message', message: messageJson(m) });
}

// ---------- contactos ----------

export function sealProfile(ctx: Ctx, accountKey: string, p: ContactProfile) {
  return { env: sealJson(p, accountKey), mac: ctx.vault.mac(JSON.stringify(p)) };
}

/** Crea o actualiza un contacto. Devuelve la fila y si es nuevo. */
export function upsertContact(
  ctx: Ctx, integ: IntegrationRow, externalId: string, kind: 'direct' | 'group',
  profile: ContactProfile, initialStatus: 'pending' | 'accepted' = 'accepted',
): { contact: ContactRow; created: boolean } {
  const accountKey = getAccountKey(ctx, integ.user_id);
  if (!accountKey) throw new Error('la cuenta no tiene clave pública');
  const existing = ctx.db.prepare('SELECT * FROM contacts WHERE integration_id = ? AND external_id = ?')
    .get(integ.id, externalId) as ContactRow | undefined;
  const mac = ctx.vault.mac(JSON.stringify(profile));
  const now = Date.now();
  if (existing) {
    if (existing.profile_mac === mac) return { contact: existing, created: false };
    const env = sealJson(profile, accountKey);
    const seq = nextSeq(ctx.db, integ.user_id);
    ctx.db.prepare('UPDATE contacts SET profile_env = ?, profile_mac = ?, seq = ?, updated_at = ? WHERE id = ?')
      .run(env, mac, seq, now, existing.id);
    return { contact: getContact(ctx, existing.id)!, created: false };
  }
  const id = newId('c');
  const seq = nextSeq(ctx.db, integ.user_id);
  ctx.db.prepare(`INSERT INTO contacts (id, user_id, integration_id, external_id, kind, status, profile_env, profile_mac,
      seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, integ.user_id, integ.id, externalId, kind, initialStatus, sealJson(profile, accountKey), mac, seq, now, now);
  return { contact: getContact(ctx, id)!, created: true };
}

// ---------- entrada ----------

/** Guarda un mensaje entrante: contacto pending si es nuevo, media cifrada, sobre sellado, WS y push. */
export async function ingestInbound(ctx: Ctx, integ: IntegrationRow, inb: Inbound): Promise<MessageRow | null> {
  const accountKey = getAccountKey(ctx, integ.user_id);
  if (!accountKey) {
    ctx.log.warn({ integration: integ.id }, 'mensaje descartado: la cuenta no tiene clave');
    return null;
  }
  const profile: ContactProfile = { ...inb.profile, platform: integ.type };
  const { contact } = tx(ctx.db, () => upsertContact(ctx, integ, inb.externalId, inb.kind, profile));
  if (contact.status === 'blocked') return null;

  if (inb.platformMessageId) {
    const dup = ctx.db.prepare('SELECT id FROM messages WHERE contact_id = ? AND platform_message_id = ? AND direction = ?')
      .get(contact.id, inb.platformMessageId, 'in');
    if (dup) return null; // reintento de webhook
  }

  let attachment: MessagePayload['attachment'] = null;
  let text = inb.text;
  let kind = inb.payloadKind;
  if (inb.media) {
    try {
      const got = await inb.media.fetch();
      const stored = await ctx.blobs.put(integ.user_id, got.data);
      attachment = {
        blobId: stored.blobId, fileKey: b64u.encode(stored.fileKey),
        mime: got.mime ?? inb.media.mime, name: got.name ?? inb.media.name, size: stored.size,
      };
    } catch (e) {
      ctx.log.warn({ err: String(e), integration: integ.id }, 'no se pudo descargar el adjunto');
      text = [text, `[Adjunto no disponible: ${inb.media.name}]`].filter(Boolean).join('\n');
      kind = 'unsupported';
    }
  } else if (inb.mediaError) {
    text = [text, `[${inb.mediaError}]`].filter(Boolean).join('\n');
  }

  const payload: MessagePayload = {
    v: 1, kind, text, senderName: inb.senderName, location: inb.location ?? null, attachment,
  };
  const now = Date.now();
  const id = newId('m');
  const { msg, contactRow } = tx(ctx.db, () => {
    const seq = nextSeq(ctx.db, integ.user_id);
    ctx.db.prepare(`INSERT INTO messages (id, user_id, contact_id, direction, status, envelope, platform_message_id,
        blob_id, seq, created_at, updated_at) VALUES (?, ?, ?, 'in', 'received', ?, ?, ?, ?, ?, ?)`)
      .run(id, integ.user_id, contact.id, sealJson(payload, accountKey), inb.platformMessageId, attachment?.blobId ?? null, seq, now, now);
    const cseq = nextSeq(ctx.db, integ.user_id);
    const newStatus = contact.status === 'archived' ? 'accepted' : contact.status;
    ctx.db.prepare(`UPDATE contacts SET unread = unread + 1, last_message_at = ?, last_inbound_at = ?, status = ?,
        seq = ?, updated_at = ? WHERE id = ?`).run(now, now, newStatus, cseq, now, contact.id);
    return { msg: getMessage(ctx, id)!, contactRow: getContact(ctx, contact.id)! };
  });
  emitContact(ctx, contactRow);
  emitMessage(ctx, msg);
  if (!contactRow.muted) void ctx.push.notifyMessage(contactRow, msg).catch(e => ctx.log.warn({ err: String(e) }, 'push falló'));
  return msg;
}

// ---------- salida ----------

export function updateMessageStatus(ctx: Ctx, id: string, status: MessageStatus, extra: { error?: string | null; platformMessageId?: string | null } = {}) {
  const m = getMessage(ctx, id);
  if (!m) return;
  const order: MessageStatus[] = ['pending', 'sent', 'delivered', 'read'];
  // no retroceder (p. ej. un "delivered" que llega después de "read")
  if (status !== 'failed' && order.indexOf(status) >= 0 && order.indexOf(status) < order.indexOf(m.status)) return;
  const updated = tx(ctx.db, () => {
    const seq = nextSeq(ctx.db, m.user_id);
    ctx.db.prepare(`UPDATE messages SET status = ?, error = ?, platform_message_id = COALESCE(?, platform_message_id),
        seq = ?, updated_at = ? WHERE id = ?`)
      .run(status, extra.error ?? null, extra.platformMessageId ?? null, seq, Date.now(), id);
    return getMessage(ctx, id)!;
  });
  emitMessage(ctx, updated);
}

/** Estado reportado por la plataforma (WhatsApp) usando su id de mensaje. */
export function updateStatusByPlatformId(ctx: Ctx, integrationId: string, platformMessageId: string, status: MessageStatus, error?: string) {
  const m = ctx.db.prepare(`SELECT m.id FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE c.integration_id = ? AND m.platform_message_id = ? AND m.direction = 'out'`).get(integrationId, platformMessageId) as { id: string } | undefined;
  if (m) updateMessageStatus(ctx, m.id, status, { error: error ?? null });
}
