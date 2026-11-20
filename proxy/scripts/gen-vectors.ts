// Genera shared/crypto-vectors/vectors.json con valores deterministas.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { publicFromPrivate } from '../src/crypto/x25519.js';
import { sealBytes } from '../src/crypto/seal.js';
import { encryptBlob } from '../src/crypto/blob.js';
import { b64u } from '../src/lib/b64.js';

const det = (label: string, n: number) => {
  const out = Buffer.alloc(n);
  let off = 0, i = 0;
  while (off < n) {
    const h = createHash('sha256').update(`${label}:${i++}`).digest();
    off += h.copy(out, off);
  }
  return out;
};

const x25519 = [0, 1, 2].map(i => {
  const priv = det(`x25519-${i}`, 32);
  return { privateKey: b64u.encode(priv), publicKey: b64u.encode(publicFromPrivate(priv)) };
});

const texts = ['', 'hola', JSON.stringify({ v: 1, kind: 'text', text: 'Hola 👋 ñandú', senderName: null, location: null, attachment: null })];
const envelope = texts.map((t, i) => {
  const rp = det(`recipient-${i}`, 32);
  const ep = det(`ephemeral-${i}`, 32);
  const nonce = det(`nonce-${i}`, 12);
  const env = sealBytes(Buffer.from(t, 'utf8'), publicFromPrivate(rp), { ephemeralPrivateKey: ep, nonce });
  return {
    recipientPrivateKey: b64u.encode(rp),
    recipientPublicKey: b64u.encode(publicFromPrivate(rp)),
    ephemeralPrivateKey: b64u.encode(ep),
    nonce: b64u.encode(nonce),
    plaintextUtf8: t,
    envelope: b64u.encode(env),
  };
});

const sizes = [0, 5, 65536, 65537, 140000];
const blob = sizes.map((size, i) => {
  const key = det(`filekey-${i}`, 32);
  const base = det(`basenonce-${i}`, 12);
  const plain = det(`plain-${i}`, size);
  return {
    fileKey: b64u.encode(key),
    baseNonce: b64u.encode(base),
    plaintextSize: size,
    plaintextSha256: createHash('sha256').update(plain).digest('hex'),
    plaintextHex: size <= 64 ? plain.toString('hex') : undefined,
    plaintextRecipe: `sha256 counter stream: concat sha256("plain-${i}:" + n) for n=0,1,2…, truncated to ${size} bytes`,
    blob: b64u.encode(encryptBlob(plain, key, base)),
  };
});

const out = { version: 1, generatedBy: 'proxy/scripts/gen-vectors.ts', x25519, envelope, blob };
const path = new URL('../../shared/crypto-vectors/vectors.json', import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', path.pathname);
