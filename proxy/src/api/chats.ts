import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../store.js';
import { contactJson, emitContact, emitMessage, getAccountKey, getContact, messageJson } from '../store.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { b64u } from '../lib/b64.js';
import { nextSeq, tx } from '../db/index.js';
import { sealJson } from '../crypto/seal.js';
import { parse, requireAuth } from './auth.js';
import { deliver, getIntegration } from '../integrations/index.js';
import type { ContactRow, IntegrationType, MessagePayload, MessageRow, Outgoing } from '../types.js';

const MB = 1024 * 1024;
export function uploadLimit(type: IntegrationType, kind: Outgoing['kind']): number {
  if (type === 'telegram') return 50 * MB;
  if (type === 'discord') return 10 * MB;
  return kind === 'image' ? 5 * MB : kind === 'file' ? 100 * MB : 16 * MB;
}

export function chatRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireAuth(ctx) };
  const own = (userId: string, id: string): ContactRow => {
    const c = getContact(ctx, id);
    if (!c || c.user_id !== userId) throw new ApiError('not_found', 'Contacto no encontrado');
    return c;
  };

  // ----- contactos -----
  app.get<{ Querystring: { since?: string } }>('/api/contacts', auth, async req => {
    const since = Number(req.query.since ?? 0) || 0;
    const rows = ctx.db.prepare('SELECT * FROM contacts WHERE user_id = ? AND seq > ? ORDER BY seq').all(req.auth.userId, since) as unknown as ContactRow[];
    return rows.map(contactJson);
  });

  app.patch<{ Params: { id: string } }>('/api/contacts/:id', auth, async req => {
    const c = own(req.auth.userId, req.params.id);
    const b = parse(z.object({
      status: z.enum(['pending', 'accepted', 'blocked', 'archived']).optional(),
      alias: z.string().max(2000).nullable().optional(),
      muted: z.boolean().optional(), hidePreview: z.boolean().optional(), read: z.literal(true).optional(),
    }), req.body);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (b.status) { sets.push('status = ?'); vals.push(b.status); }
    if (b.alias !== undefined) { sets.push('alias_env = ?'); vals.push(b.alias); }
    if (b.muted !== undefined) { sets.push('muted = ?'); vals.push(b.muted ? 1 : 0); }
    if (b.hidePreview !== undefined) { sets.push('hide_preview = ?'); vals.push(b.hidePreview ? 1 : 0); }
    if (b.read) sets.push('unread = 0');
    if (!sets.length) return contactJson(c);
    const row = tx(ctx.db, () => {
      const seq = nextSeq(ctx.db, c.user_id);
      ctx.db.prepare(`UPDATE contacts SET ${sets.join(', ')}, seq = ?, updated_at = ? WHERE id = ?`).run(...vals, seq, Date.now(), c.id);
      return getContact(ctx, c.id)!;
    });
    emitContact(ctx, row);
    return contactJson(row);
  });

  app.delete<{ Params: { id: string } }>('/api/contacts/:id', auth, async (req, reply) => {
    const c = own(req.auth.userId, req.params.id);
    const blobs = ctx.db.prepare('SELECT blob_id FROM messages WHERE contact_id = ? AND blob_id IS NOT NULL').all(c.id) as { blob_id: string }[];
    ctx.db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
    for (const b of blobs) ctx.blobs.delete(b.blob_id);
    ctx.hub.emit(c.user_id, { type: 'contact_deleted', id: c.id });
    reply.code(204);
  });

  // ----- mensajes -----
  app.get<{ Querystring: { since?: string; limit?: string } }>('/api/messages', auth, async req => {
    const since = Number(req.query.since ?? 0) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 500) || 500, 1), 1000);
    const rows = ctx.db.prepare('SELECT * FROM messages WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(req.auth.userId, since, limit + 1) as unknown as MessageRow[];
    return { messages: rows.slice(0, limit).map(messageJson), more: rows.length > limit };
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/api/contacts/:id/messages', auth, async req => {
    const c = own(req.auth.userId, req.params.id);
    const before = Number(req.query.before ?? 0) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = ctx.db.prepare('SELECT * FROM messages WHERE contact_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?')
      .all(c.id, before, limit) as unknown as MessageRow[];
    return rows.map(messageJson);
  });

  app.post<{ Params: { id: string } }>('/api/contacts/:id/messages', auth, async (req, reply) => {
    const c = own(req.auth.userId, req.params.id);
    if (c.status !== 'accepted' && c.status !== 'archived') throw new ApiError('forbidden', 'Acepta el contacto antes de escribirle');
    const integ = getIntegration(ctx, c.integration_id)!;
    const accountKey = getAccountKey(ctx, c.user_id)!;

    let clientId: string | null = null;
    let out: Outgoing;
    if (req.isMultipart()) {
      const fields: Record<string, string> = {};
      let file: Outgoing['file'] = null;
      for await (const part of req.parts({ limits: { fileSize: 100 * MB, files: 1 } })) {
        if (part.type === 'file') {
          const data = await part.toBuffer().catch(e => {
            throw new ApiError('too_large', `El archivo supera el máximo permitido (${String(e.message ?? e)})`);
          });
          file = { data, mime: part.mimetype || 'application/octet-stream', name: part.filename || 'archivo' };
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
      if (!file) throw new ApiError('bad_request', 'Falta el archivo');
      const kind = parse(z.enum(['image', 'video', 'audio', 'file']), fields.kind ?? 'file');
      const limit = uploadLimit(integ.type, kind);
      if (file.data.length > limit) throw new ApiError('too_large', `Máximo ${Math.round(limit / MB)} MB para ${integ.type}`);
      clientId = fields.clientId || null;
      out = { kind, text: fields.text?.trim() || null, file };
    } else {
      const b = parse(z.object({ clientId: z.string().max(64).optional(), text: z.string().min(1).max(4096) }), req.body);
      clientId = b.clientId ?? null;
      out = { kind: 'text', text: b.text, file: null };
    }

    if (clientId) {
      const dup = ctx.db.prepare('SELECT * FROM messages WHERE contact_id = ? AND client_id = ?').get(c.id, clientId) as MessageRow | undefined;
      if (dup) { reply.code(202); return messageJson(dup); }
    }

    let attachment: MessagePayload['attachment'] = null;
    if (out.file) {
      const stored = await ctx.blobs.put(c.user_id, out.file.data);
      attachment = { blobId: stored.blobId, fileKey: b64u.encode(stored.fileKey), mime: out.file.mime, name: out.file.name, size: stored.size };
    }
    const payload: MessagePayload = { v: 1, kind: out.kind, text: out.text, senderName: null, location: null, attachment };
    const id = newId('m');
    const now = Date.now();
    const { msg, contact } = tx(ctx.db, () => {
      const seq = nextSeq(ctx.db, c.user_id);
      ctx.db.prepare(`INSERT INTO messages (id, user_id, contact_id, direction, status, envelope, client_id, blob_id, seq, created_at, updated_at)
          VALUES (?, ?, ?, 'out', 'pending', ?, ?, ?, ?, ?, ?)`)
        .run(id, c.user_id, c.id, sealJson(payload, accountKey), clientId, attachment?.blobId ?? null, seq, now, now);
      const cseq = nextSeq(ctx.db, c.user_id);
      ctx.db.prepare("UPDATE contacts SET last_message_at = ?, status = 'accepted', seq = ?, updated_at = ? WHERE id = ?").run(now, cseq, now, c.id);
      return { msg: ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow, contact: getContact(ctx, c.id)! };
    });
    emitMessage(ctx, msg);
    emitContact(ctx, contact);
    void deliver(ctx, id, c.id, out);
    reply.code(202);
    return messageJson(msg);
  });

  app.get<{ Params: { id: string } }>('/api/blobs/:id', auth, async (req, reply) => {
    let b;
    try { b = ctx.blobs.open(req.auth.userId, req.params.id); } catch { b = null; }
    if (!b) throw new ApiError('not_found', 'Archivo no encontrado');
    reply.header('content-type', 'application/octet-stream').header('content-length', b.size).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(b.stream);
  });
}
