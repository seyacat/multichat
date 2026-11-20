import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessClaims { sub: string; dev: string; exp: number }

export function signAccess(claims: AccessClaims, key: Buffer): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

export function verifyAccess(token: string, key: Buffer, now = Date.now()): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const expect = createHmac('sha256', key).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as AccessClaims;
    if (typeof c.exp !== 'number' || c.exp * 1000 < now) return null;
    return c;
  } catch {
    return null;
  }
}

export function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('base64url');
}
