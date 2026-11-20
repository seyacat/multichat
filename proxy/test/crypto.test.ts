import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicFromPrivate, generateRawKeyPair } from '../src/crypto/x25519.js';
import { openBytes, sealBytes, sealJson, openJson } from '../src/crypto/seal.js';
import { BlobEncryptor, decryptBlob, encryptBlob } from '../src/crypto/blob.js';
import { Vault } from '../src/crypto/vault.js';
import { hashPassword, verifyPassword } from '../src/crypto/password.js';
import { signAccess, verifyAccess } from '../src/crypto/token.js';
import { b64u } from '../src/lib/b64.js';
import { Readable } from 'node:stream';

const V = JSON.parse(readFileSync(new URL('../../shared/crypto-vectors/vectors.json', import.meta.url), 'utf8'));

function recipe(i: number, size: number) {
  const out = Buffer.alloc(size);
  let off = 0, n = 0;
  while (off < size) off += createHash('sha256').update(`plain-${i}:${n++}`).digest().copy(out, off);
  return out;
}

describe('vectores compartidos', () => {
  it('x25519', () => {
    for (const v of V.x25519) expect(b64u.encode(publicFromPrivate(b64u.decode(v.privateKey)))).toBe(v.publicKey);
  });
  it('sobres: abrir y reproducir', () => {
    for (const v of V.envelope) {
      expect(openBytes(b64u.decode(v.envelope), b64u.decode(v.recipientPrivateKey)).toString('utf8')).toBe(v.plaintextUtf8);
      const again = sealBytes(Buffer.from(v.plaintextUtf8, 'utf8'), b64u.decode(v.recipientPublicKey),
        { ephemeralPrivateKey: b64u.decode(v.ephemeralPrivateKey), nonce: b64u.decode(v.nonce) });
      expect(b64u.encode(again)).toBe(v.envelope);
    }
  });
  it('blobs: descifrar y reproducir', () => {
    V.blob.forEach((v: any, i: number) => {
      const plain = recipe(i, v.plaintextSize);
      expect(createHash('sha256').update(plain).digest('hex')).toBe(v.plaintextSha256);
      expect(decryptBlob(b64u.decode(v.blob), b64u.decode(v.fileKey)).equals(plain)).toBe(true);
      expect(b64u.encode(encryptBlob(plain, b64u.decode(v.fileKey), b64u.decode(v.baseNonce)))).toBe(v.blob);
    });
  });
});

describe('cripto', () => {
  it('sobre manipulado falla', () => {
    const k = generateRawKeyPair();
    const env = sealBytes(Buffer.from('x'), k.publicKey);
    env[env.length - 1]! ^= 1;
    expect(() => openBytes(env, k.privateKey)).toThrow();
  });
  it('JSON sellado', () => {
    const k = generateRawKeyPair();
    expect(openJson(sealJson({ a: 1 }, b64u.encode(k.publicKey)), k.privateKey)).toEqual({ a: 1 });
  });
  it('blob en streaming = blob en memoria, y detecta truncado', async () => {
    const key = Buffer.alloc(32, 7), base = Buffer.alloc(12, 9);
    const plain = recipe(99, 200_000);
    const enc = new BlobEncryptor(key, base);
    const parts: Buffer[] = [];
    for await (const p of Readable.from([plain.subarray(0, 1000), plain.subarray(1000, 131072), plain.subarray(131072)]).pipe(enc)) parts.push(p);
    const streamed = Buffer.concat(parts);
    expect(streamed.equals(encryptBlob(plain, key, base))).toBe(true);
    expect(() => decryptBlob(streamed.subarray(0, 16 + 65552), key)).toThrow();
  });
  it('vault, contraseña y token', async () => {
    const v = new Vault(Buffer.alloc(32, 1));
    expect(v.decrypt(v.encrypt({ t: 'abc' }))).toEqual({ t: 'abc' });
    const h = await hashPassword('secreto123');
    expect(await verifyPassword('secreto123', h)).toBe(true);
    expect(await verifyPassword('otro', h)).toBe(false);
    const tok = signAccess({ sub: 'u', dev: 'd', exp: Math.floor(Date.now() / 1000) + 60 }, v.jwtKey);
    expect(verifyAccess(tok, v.jwtKey)?.sub).toBe('u');
    expect(verifyAccess(tok + 'x', v.jwtKey)).toBeNull();
    expect(verifyAccess(signAccess({ sub: 'u', dev: 'd', exp: 1 }, v.jwtKey), v.jwtKey)).toBeNull();
  });
});
