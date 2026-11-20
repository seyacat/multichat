import type { Ctx } from '../store.js';
import type { ContactRow, IntegrationRow, Outgoing } from '../types.js';

export class PlatformError extends Error {}

export interface StartResult { info?: Record<string, unknown>; config?: Record<string, unknown>; lookupKey?: string | null }

export interface Driver<C = Record<string, string>> {
  /** Comprueba credenciales contra la plataforma y devuelve datos públicos. */
  validate(ctx: Ctx, creds: C): Promise<Record<string, unknown>>;
  /** Extrae el secreto principal para mostrar los últimos 4 caracteres. */
  hintSource(creds: C): string;
  /** Normaliza credenciales de entrada (lanza PlatformError si faltan campos). */
  parseCredentials(input: unknown): C;
  start(ctx: Ctx, integ: IntegrationRow, creds: C): Promise<StartResult>;
  stop(ctx: Ctx, integ: IntegrationRow, creds: C, opts: { deleting: boolean }): Promise<void>;
  send(ctx: Ctx, integ: IntegrationRow, creds: C, contact: ContactRow, out: Outgoing): Promise<{ platformMessageId: string | null }>;
}

export function requireFields<T extends string>(input: unknown, fields: readonly T[]): Record<T, string> {
  if (!input || typeof input !== 'object') throw new PlatformError('Faltan las credenciales');
  const o = input as Record<string, unknown>;
  const out = {} as Record<T, string>;
  for (const f of fields) {
    const v = o[f];
    if (typeof v !== 'string' || !v.trim()) throw new PlatformError(`Falta el campo ${f}`);
    out[f] = v.trim();
  }
  return out;
}

export async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
