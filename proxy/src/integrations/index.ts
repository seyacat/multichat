import type { Ctx } from '../store.js';
import { getContact, integrationJson, updateMessageStatus } from '../store.js';
import type { ContactRow, IntegrationRow, IntegrationType, Outgoing } from '../types.js';
import { ApiError } from '../lib/errors.js';
import { newId, randomToken } from '../lib/ids.js';
import { Driver, PlatformError } from './driver.js';
import { telegram } from './telegram.js';
import { whatsapp } from './whatsapp.js';
import { discord } from './discord.js';

export const drivers: Record<IntegrationType, Driver<any>> = { telegram, whatsapp, discord };

export function isType(t: unknown): t is IntegrationType {
  return t === 'telegram' || t === 'discord' || t === 'whatsapp';
}

function asApi(e: unknown): never {
  if (e instanceof PlatformError) throw new ApiError('platform_error', e.message);
  throw e;
}

export function getIntegration(ctx: Ctx, id: string): IntegrationRow | undefined {
  return ctx.db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
}

export function credsOf<T = any>(ctx: Ctx, integ: IntegrationRow): T {
  return ctx.vault.decrypt<T>(integ.credentials_enc);
}

function setState(ctx: Ctx, id: string, fields: Partial<Pick<IntegrationRow, 'status' | 'status_detail' | 'info_json' | 'config_json' | 'lookup_key'>>) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  ctx.db.prepare(`UPDATE integrations SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => fields[k] ?? null), Date.now(), id);
  const row = getIntegration(ctx, id);
  if (row) ctx.hub.emit(row.user_id, { type: 'integration', integration: integrationJson(ctx, row) });
}

export async function startIntegration(ctx: Ctx, integ: IntegrationRow): Promise<void> {
  if (!integ.enabled) return;
  setState(ctx, integ.id, { status: 'connecting', status_detail: null });
  try {
    const r = await drivers[integ.type].start(ctx, integ, credsOf(ctx, integ));
    const current = getIntegration(ctx, integ.id);
    if (!current) return;
    setState(ctx, integ.id, {
      status: 'connected', status_detail: null,
      info_json: JSON.stringify({ ...JSON.parse(current.info_json), ...(r.info ?? {}) }),
      ...(r.config ? { config_json: JSON.stringify({ ...JSON.parse(current.config_json), ...r.config }) } : {}),
      ...(r.lookupKey !== undefined ? { lookup_key: r.lookupKey } : {}),
    });
  } catch (e) {
    ctx.log.warn({ integration: integ.id, err: String(e) }, 'no se pudo iniciar la integración');
    setState(ctx, integ.id, { status: 'error', status_detail: e instanceof Error ? e.message : String(e) });
  }
}

export async function stopIntegration(ctx: Ctx, integ: IntegrationRow, deleting = false) {
  try {
    await drivers[integ.type].stop(ctx, integ, credsOf(ctx, integ), { deleting });
  } catch (e) {
    ctx.log.warn({ integration: integ.id, err: String(e) }, 'error al parar integración');
  }
}

export async function startAll(ctx: Ctx) {
  const rows = ctx.db.prepare('SELECT * FROM integrations WHERE enabled = 1').all() as unknown as IntegrationRow[];
  await Promise.all(rows.map(r => startIntegration(ctx, r)));
}

export async function stopAll(ctx: Ctx) {
  const rows = ctx.db.prepare("SELECT * FROM integrations WHERE type = 'discord' AND enabled = 1").all() as unknown as IntegrationRow[];
  await Promise.all(rows.map(r => drivers.discord.stop(ctx, r, credsOf(ctx, r), { deleting: false }).catch(() => undefined)));
}

function hint(s: string) {
  return s.length > 4 ? `…${s.slice(-4)}` : '…';
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

function cleanConfig(type: IntegrationType, input: unknown, prev: Record<string, unknown> = {}): Record<string, unknown> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (type === 'discord') {
    return {
      channelIds: Array.isArray(o.channelIds) ? o.channelIds.map(String) : (prev.channelIds ?? []),
      allowDMs: typeof o.allowDMs === 'boolean' ? o.allowDMs : (prev.allowDMs ?? true),
    };
  }
  if (type === 'whatsapp') return { verifyToken: prev.verifyToken }; // solo lectura
  return {};
}

export async function testCredentials(ctx: Ctx, type: IntegrationType, credentials: unknown) {
  const d = drivers[type];
  try {
    return await d.validate(ctx, d.parseCredentials(credentials));
  } catch (e) { asApi(e); }
}

export async function createIntegration(ctx: Ctx, userId: string, input: {
  type: IntegrationType; name: string; color: string; credentials: unknown; config?: unknown;
}) {
  const user = ctx.db.prepare('SELECT max_integrations, account_public_key FROM users WHERE id = ?').get(userId) as { max_integrations: number | null; account_public_key: string | null };
  if (!user.account_public_key) throw new ApiError('conflict', 'Configura la clave de la cuenta antes de añadir integraciones');
  const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM integrations WHERE user_id = ?').get(userId) as { n: number }).n;
  if (count >= (user.max_integrations ?? ctx.config.maxIntegrationsPerUser)) throw new ApiError('limit_reached', 'Llegaste al máximo de integraciones');
  if (!input.name?.trim()) throw new ApiError('bad_request', 'Falta el nombre');
  const color = COLOR.test(input.color ?? '') ? input.color : '#64748b';
  const d = drivers[input.type];
  let creds: Record<string, string>;
  let info: Record<string, unknown>;
  try {
    creds = d.parseCredentials(input.credentials);
    info = await d.validate(ctx, creds);
  } catch (e) { asApi(e); }
  const now = Date.now();
  const id = newId('i');
  ctx.db.prepare(`INSERT INTO integrations (id, user_id, type, name, color, enabled, status, credentials_enc, credential_hint,
      webhook_secret, config_json, info_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'connecting', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, input.type, input.name.trim(), color, ctx.vault.encrypt(creds), hint(d.hintSource(creds)),
      randomToken(24), JSON.stringify(cleanConfig(input.type, input.config)), JSON.stringify(info), now, now);
  await startIntegration(ctx, getIntegration(ctx, id)!);
  return getIntegration(ctx, id)!;
}

export async function patchIntegration(ctx: Ctx, integ: IntegrationRow, input: {
  name?: string; color?: string; enabled?: boolean; credentials?: unknown; config?: unknown;
}) {
  const d = drivers[integ.type];
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  let restart = false;
  if (typeof input.name === 'string' && input.name.trim()) { sets.push('name = ?'); vals.push(input.name.trim()); }
  if (typeof input.color === 'string' && COLOR.test(input.color)) { sets.push('color = ?'); vals.push(input.color); }
  if (input.credentials !== undefined) {
    let creds: Record<string, string>;
    try {
      // Los campos vacíos o ausentes conservan su valor actual (p. ej. cambiar solo el token).
      const sent = Object.fromEntries(Object.entries((input.credentials ?? {}) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
      creds = d.parseCredentials({ ...credsOf<Record<string, string>>(ctx, integ), ...sent });
      await d.validate(ctx, creds);
    } catch (e) { asApi(e); }
    sets.push('credentials_enc = ?', 'credential_hint = ?');
    vals.push(ctx.vault.encrypt(creds), hint(d.hintSource(creds)));
    restart = true;
  }
  let configChanged = false;
  if (input.config !== undefined) {
    sets.push('config_json = ?');
    vals.push(JSON.stringify(cleanConfig(integ.type, input.config, JSON.parse(integ.config_json))));
    configChanged = true;
  }
  const wasEnabled = !!integ.enabled;
  if (typeof input.enabled === 'boolean' && input.enabled !== wasEnabled) {
    sets.push('enabled = ?');
    vals.push(input.enabled ? 1 : 0);
    restart = true;
  }
  if (restart && wasEnabled) await stopIntegration(ctx, integ);
  if (sets.length) {
    ctx.db.prepare(`UPDATE integrations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), integ.id);
  }
  const row = getIntegration(ctx, integ.id)!;
  if (restart && row.enabled) await startIntegration(ctx, row);
  else if (!row.enabled) setState(ctx, row.id, { status: 'disabled', status_detail: null });
  else {
    if (configChanged && row.type === 'discord') await discord.reconfigure(ctx, row);
    ctx.hub.emit(row.user_id, { type: 'integration', integration: integrationJson(ctx, row) });
  }
  return getIntegration(ctx, integ.id)!;
}

export async function deleteIntegration(ctx: Ctx, integ: IntegrationRow) {
  await stopIntegration(ctx, integ, true);
  const blobs = ctx.db.prepare(`SELECT m.blob_id FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE c.integration_id = ? AND m.blob_id IS NOT NULL`).all(integ.id) as { blob_id: string }[];
  ctx.db.prepare('DELETE FROM integrations WHERE id = ?').run(integ.id);
  for (const b of blobs) ctx.blobs.delete(b.blob_id);
  ctx.hub.emit(integ.user_id, { type: 'integration_deleted', id: integ.id });
}

/** Envío en segundo plano: el mensaje ya está guardado como pending. */
export async function deliver(ctx: Ctx, messageId: string, contactId: string, out: Outgoing) {
  const contact = getContact(ctx, contactId) as ContactRow;
  const integ = getIntegration(ctx, contact.integration_id);
  if (!integ || !integ.enabled) {
    updateMessageStatus(ctx, messageId, 'failed', { error: 'La integración está pausada o no existe' });
    return;
  }
  try {
    const r = await drivers[integ.type].send(ctx, integ, credsOf(ctx, integ), contact, out);
    updateMessageStatus(ctx, messageId, 'sent', { platformMessageId: r.platformMessageId });
  } catch (e) {
    ctx.log.warn({ integration: integ.id, err: String(e) }, 'envío falló');
    updateMessageStatus(ctx, messageId, 'failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
