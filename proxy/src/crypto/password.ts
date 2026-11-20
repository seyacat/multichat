import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 1 << 15, r = 8, p = 1, LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function run(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(pw.normalize('NFKC'), salt, LEN, { N, r, p, maxmem: MAXMEM }, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const k = await run(pw, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${k.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, , , , salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const k = await run(pw, Buffer.from(salt, 'base64url'));
  const h = Buffer.from(hash, 'base64url');
  return h.length === k.length && timingSafeEqual(h, k);
}
