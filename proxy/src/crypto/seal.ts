import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { generateRawKeyPair, publicFromPrivate, x25519 } from './x25519.js';
import { b64u } from '../lib/b64.js';

const VERSION = 0x01;
const INFO = Buffer.from('multichat/v1/envelope', 'utf8');
const HEADER = 1 + 32 + 12;

function deriveKey(shared: Buffer, ephPub: Uint8Array, recipientPub: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), INFO, 32));
}

export interface SealOptions { ephemeralPrivateKey?: Uint8Array; nonce?: Uint8Array }

export function sealBytes(plaintext: Uint8Array, recipientPub: Uint8Array, opts: SealOptions = {}): Buffer {
  const ephPriv = opts.ephemeralPrivateKey ?? generateRawKeyPair().privateKey;
  const ephPub = publicFromPrivate(ephPriv);
  const key = deriveKey(x25519(ephPriv, recipientPub), ephPub, recipientPub);
  const nonce = opts.nonce ?? randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), ephPub, nonce, ct, cipher.getAuthTag()]);
}

export function openBytes(envelope: Uint8Array, recipientPriv: Uint8Array): Buffer {
  const env = Buffer.from(envelope);
  if (env.length < HEADER + 16 || env[0] !== VERSION) throw new Error('invalid envelope');
  const ephPub = env.subarray(1, 33);
  const nonce = env.subarray(33, 45);
  const ct = env.subarray(45, env.length - 16);
  const tag = env.subarray(env.length - 16);
  const recipientPub = publicFromPrivate(recipientPriv);
  const key = deriveKey(x25519(recipientPriv, ephPub), ephPub, recipientPub);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Seal a JSON value to the account public key (b64u) and return a b64u envelope. */
export function sealJson(value: unknown, recipientPubB64u: string): string {
  return b64u.encode(sealBytes(Buffer.from(JSON.stringify(value), 'utf8'), b64u.decode(recipientPubB64u)));
}

export function openJson<T = unknown>(envelopeB64u: string, recipientPriv: Uint8Array): T {
  return JSON.parse(openBytes(b64u.decode(envelopeB64u), recipientPriv).toString('utf8')) as T;
}
