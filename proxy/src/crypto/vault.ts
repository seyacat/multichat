import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** Server-side at-rest encryption for integration credentials (not end-to-end). */
export class Vault {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;
  readonly jwtKey: Buffer;
  constructor(masterKey: Buffer) {
    if (masterKey.length < 32) throw new Error('MASTER_KEY must be at least 32 bytes');
    const d = (info: string) => Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
    this.encKey = d('multichat/vault/enc');
    this.macKey = d('multichat/vault/mac');
    this.jwtKey = d('multichat/jwt');
  }
  encrypt(value: unknown): string {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey, nonce);
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url');
  }
  decrypt<T = unknown>(s: string): T {
    const b = Buffer.from(s, 'base64url');
    const d = createDecipheriv('aes-256-gcm', this.encKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')) as T;
  }
  /** Keyed hash to detect changes (e.g. contact name) without storing plaintext. */
  mac(value: string): string {
    return createHmac('sha256', this.macKey).update(value).digest('base64url');
  }
}
