import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, KeyObject } from 'node:crypto';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('X25519 private key must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublic(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI_PREFIX.length);
}

export function rawPrivate(key: KeyObject): Buffer {
  return (key.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(PKCS8_PREFIX.length);
}

export function generateRawKeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey } = generateKeyPairSync('x25519');
  return { privateKey: rawPrivate(privateKey), publicKey: rawPublic(privateKey) };
}

export function x25519(priv: Uint8Array, pub: Uint8Array): Buffer {
  return diffieHellman({ privateKey: privateKeyFromRaw(priv), publicKey: publicKeyFromRaw(pub) });
}

export function publicFromPrivate(priv: Uint8Array): Buffer {
  return rawPublic(privateKeyFromRaw(priv));
}
