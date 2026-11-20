import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { b64uDecode, b64uEncode, hexEncode } from '../src/lib/b64u';
import {
  decryptBlob,
  encryptBlob,
  generateKeyPair,
  linkText,
  openBytes,
  openJson,
  parseLinkText,
  parseRecoveryText,
  publicFromPrivate,
  recoveryText,
  sealBytes,
  sealJson,
} from '../src/lib/crypto';

interface Vectors {
  x25519: { privateKey: string; publicKey: string }[];
  envelope: {
    recipientPrivateKey: string;
    recipientPublicKey: string;
    ephemeralPrivateKey: string;
    nonce: string;
    plaintextUtf8: string;
    envelope: string;
  }[];
  blob: {
    fileKey: string;
    baseNonce: string;
    plaintextSize: number;
    plaintextSha256: string;
    plaintextHex?: string;
    plaintextRecipe: string;
    blob: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../shared/crypto-vectors/vectors.json', import.meta.url), 'utf8'),
) as Vectors;

/** Receta de plaintextRecipe: concat sha256(label + ":" + n) para n=0,1,2… truncado a size. */
function recipe(label: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (let n = 0; off < size; n++) {
    const h = createHash('sha256').update(`${label}:${n}`).digest();
    const take = Math.min(h.length, size - off);
    out.set(h.subarray(0, take), off);
    off += take;
  }
  return out;
}

const sha256hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('x25519', () => {
  it.each(vectors.x25519.map((v, i) => [i, v] as const))('vector %i: pública de la privada', async (_i, v) => {
    expect(b64uEncode(await publicFromPrivate(b64uDecode(v.privateKey)))).toBe(v.publicKey);
  });

  it('genera pares coherentes', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    expect(privateKey.length).toBe(32);
    expect(publicKey.length).toBe(32);
    expect(b64uEncode(await publicFromPrivate(privateKey))).toBe(b64uEncode(publicKey));
  });
});

describe('sobres', () => {
  it.each(vectors.envelope.map((v, i) => [i, v] as const))('vector %i: abre y reproduce byte a byte', async (_i, v) => {
    const priv = b64uDecode(v.recipientPrivateKey);
    expect(b64uEncode(await publicFromPrivate(priv))).toBe(v.recipientPublicKey);
    const pt = await openBytes(b64uDecode(v.envelope), priv);
    expect(new TextDecoder().decode(pt)).toBe(v.plaintextUtf8);
    const sealed = await sealBytes(new TextEncoder().encode(v.plaintextUtf8), b64uDecode(v.recipientPublicKey), {
      ephemeralPrivateKey: b64uDecode(v.ephemeralPrivateKey),
      nonce: b64uDecode(v.nonce),
    });
    expect(b64uEncode(sealed)).toBe(v.envelope);
  });

  it('ida y vuelta JSON con clave nueva', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const env = await sealJson({ name: 'Ana ñ 👋' }, publicKey);
    expect(await openJson(env, privateKey)).toEqual({ name: 'Ana ñ 👋' });
  });

  it('rechaza sobres manipulados', async () => {
    const v = vectors.envelope[1]!;
    const env = b64uDecode(v.envelope);
    env[env.length - 1] ^= 1;
    await expect(openBytes(env, b64uDecode(v.recipientPrivateKey))).rejects.toThrow();
    const bad = b64uDecode(v.envelope);
    bad[0] = 2;
    await expect(openBytes(bad, b64uDecode(v.recipientPrivateKey))).rejects.toThrow();
  });
});

describe('blobs MCB1', () => {
  it.each(vectors.blob.map((v, i) => [i, v] as const))('vector %i: descifra y reproduce', async (i, v) => {
    const plain = recipe(`plain-${i}`, v.plaintextSize);
    expect(sha256hex(plain)).toBe(v.plaintextSha256);
    if (v.plaintextHex !== undefined) expect(hexEncode(plain)).toBe(v.plaintextHex);

    const key = b64uDecode(v.fileKey);
    const dec = await decryptBlob(b64uDecode(v.blob), key);
    expect(dec.length).toBe(v.plaintextSize);
    expect(sha256hex(dec)).toBe(v.plaintextSha256);

    const enc = await encryptBlob(plain, key, b64uDecode(v.baseNonce));
    expect(b64uEncode(enc)).toBe(v.blob);
  });

  it('detecta truncado', async () => {
    const v = vectors.blob[4]!;
    const blob = b64uDecode(v.blob);
    // quitar el último trozo entero: el penúltimo pasa a ser "último" y su AAD no valida
    const truncated = blob.slice(0, 16 + 2 * (65536 + 16));
    await expect(decryptBlob(truncated, b64uDecode(v.fileKey))).rejects.toThrow();
  });
});

describe('textos de vínculo y recuperación', () => {
  it('ida y vuelta', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    expect(parseRecoveryText(recoveryText(privateKey))).toEqual(privateKey);
    const t = linkText('l_abc', b64uEncode(publicKey));
    expect(parseLinkText(t)).toEqual({ id: 'l_abc', ephemeralPublicKey: b64uEncode(publicKey) });
    expect(parseLinkText('multichat-link:x')).toBeNull();
    expect(parseRecoveryText('multichat-key:abc')).toBeNull();
  });
});
