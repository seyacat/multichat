// Cifrado v1 (docs/crypto.md) con WebCrypto nativo: X25519 + HKDF-SHA256 + AES-256-GCM.
import { b64uDecode, b64uEncode, bytesEqual, concatBytes, hexDecode } from './b64u';

type Bytes = Uint8Array<ArrayBuffer>;

const PKCS8_PREFIX = hexDecode('302e020100300506032b656e04220420');
const SPKI_PREFIX = hexDecode('302a300506032b656e032100');
const INFO = new TextEncoder().encode('multichat/v1/envelope');
const VERSION = 0x01;
const HEADER = 1 + 32 + 12;
const TAG = 16;

export const BLOB_MAGIC = new TextEncoder().encode('MCB1');
export const BLOB_CHUNK = 65536;
const ENC_CHUNK = BLOB_CHUNK + TAG;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

function u8(b: Uint8Array): Bytes {
  return (b.buffer instanceof ArrayBuffer && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? b
    : new Uint8Array(b)) as Bytes;
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ---------- X25519 ----------

async function importPriv(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('La clave privada X25519 debe tener 32 bytes');
  return subtle().importKey('pkcs8', concatBytes(PKCS8_PREFIX, raw), { name: 'X25519' }, extractable, ['deriveBits']);
}

async function importPub(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('La clave pública X25519 debe tener 32 bytes');
  return subtle().importKey('spki', concatBytes(SPKI_PREFIX, raw), { name: 'X25519' }, true, []);
}

/** Deriva la pública cruda (32 bytes) de la privada cruda. */
export async function publicFromPrivate(priv: Uint8Array): Promise<Bytes> {
  const key = await importPriv(priv, true);
  const jwk = await subtle().exportKey('jwk', key);
  if (!jwk.x) throw new Error('No se pudo derivar la clave pública');
  return b64uDecode(jwk.x);
}

export async function generateKeyPair(): Promise<{ privateKey: Bytes; publicKey: Bytes }> {
  const pair = (await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pkcs8.slice(pkcs8.length - 32), publicKey: pub };
}

export async function x25519(priv: Uint8Array, pub: Uint8Array): Promise<Bytes> {
  const bits = await subtle().deriveBits({ name: 'X25519', public: await importPub(pub) }, await importPriv(priv), 256);
  return new Uint8Array(bits);
}

// ---------- Sobres ----------

async function deriveKey(shared: Bytes, ephPub: Uint8Array, recipientPub: Uint8Array): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: concatBytes(ephPub, recipientPub), info: INFO },
    ikm,
    256,
  );
  return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface SealOptions {
  ephemeralPrivateKey?: Uint8Array;
  nonce?: Uint8Array;
}

export async function sealBytes(plaintext: Uint8Array, recipientPub: Uint8Array, opts: SealOptions = {}): Promise<Bytes> {
  const ephPriv = opts.ephemeralPrivateKey ?? (await generateKeyPair()).privateKey;
  const ephPub = await publicFromPrivate(ephPriv);
  const key = await deriveKey(await x25519(ephPriv, recipientPub), ephPub, recipientPub);
  const nonce = u8(opts.nonce ?? randomBytes(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, u8(plaintext)));
  return concatBytes(new Uint8Array([VERSION]), ephPub, nonce, ct);
}

export async function openBytes(envelope: Uint8Array, recipientPriv: Uint8Array): Promise<Bytes> {
  if (envelope.length < HEADER + TAG || envelope[0] !== VERSION) throw new Error('Sobre no válido');
  const ephPub = envelope.slice(1, 33);
  const nonce = envelope.slice(33, 45);
  const ct = envelope.slice(45);
  const recipientPub = await publicFromPrivate(recipientPriv);
  const key = await deriveKey(await x25519(recipientPriv, ephPub), ephPub, recipientPub);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
}

export async function sealJson(value: unknown, recipientPub: Uint8Array): Promise<string> {
  return b64uEncode(await sealBytes(new TextEncoder().encode(JSON.stringify(value)), recipientPub));
}

export async function openJson<T>(envelopeB64u: string, recipientPriv: Uint8Array): Promise<T> {
  const bytes = await openBytes(b64uDecode(envelopeB64u), recipientPriv);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------- Blobs MCB1 ----------

function chunkNonce(base: Uint8Array, i: number): Bytes {
  const n = new Uint8Array(base);
  const view = new DataView(n.buffer);
  view.setUint32(8, (view.getUint32(8) ^ i) >>> 0);
  return n;
}

async function importFileKey(fileKey: Uint8Array): Promise<CryptoKey> {
  if (fileKey.length !== 32) throw new Error('fileKey debe tener 32 bytes');
  return subtle().importKey('raw', u8(fileKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBlob(plain: Uint8Array, fileKey: Uint8Array, baseNonce?: Uint8Array): Promise<Bytes> {
  const key = await importFileKey(fileKey);
  const base = u8(baseNonce ?? randomBytes(12));
  const parts: Uint8Array[] = [BLOB_MAGIC, base];
  let i = 0;
  let off = 0;
  do {
    const end = Math.min(off + BLOB_CHUNK, plain.length);
    const last = end >= plain.length;
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv: chunkNonce(base, i), additionalData: new Uint8Array([last ? 1 : 0]) },
      key,
      plain.slice(off, end),
    );
    parts.push(new Uint8Array(ct));
    i++;
    off = end;
  } while (off < plain.length);
  return concatBytes(...parts);
}

export async function decryptBlob(blob: Uint8Array, fileKey: Uint8Array): Promise<Bytes> {
  if (blob.length < 16 + TAG || !bytesEqual(blob.subarray(0, 4), BLOB_MAGIC)) throw new Error('Blob no válido');
  const key = await importFileKey(fileKey);
  const base = blob.slice(4, 16);
  const bodyLen = blob.length - 16;
  const out = new Uint8Array(Math.max(0, bodyLen - Math.ceil(bodyLen / ENC_CHUNK) * TAG));
  let written = 0;
  let i = 0;
  for (let off = 0; ; off += ENC_CHUNK) {
    const end = Math.min(off + ENC_CHUNK, bodyLen);
    const last = end >= bodyLen;
    const chunk = blob.slice(16 + off, 16 + end);
    if (chunk.length < TAG) throw new Error('Trozo de blob demasiado corto');
    const pt = new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: chunkNonce(base, i), additionalData: new Uint8Array([last ? 1 : 0]) },
        key,
        chunk,
      ),
    );
    out.set(pt, written);
    written += pt.length;
    i++;
    if (last) break;
  }
  return out.subarray(0, written) as Bytes;
}

// ---------- Textos de vinculación / recuperación ----------

export function recoveryText(priv: Uint8Array): string {
  return `multichat-key:${b64uEncode(priv)}`;
}

export function parseRecoveryText(text: string): Bytes | null {
  const m = /^multichat-key:([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m) return null;
  const raw = b64uDecode(m[1]!);
  return raw.length === 32 ? raw : null;
}

export function linkText(id: string, ephemeralPublicKey: string): string {
  return `multichat-link:${id}:${ephemeralPublicKey}`;
}

export function parseLinkText(text: string): { id: string; ephemeralPublicKey: string } | null {
  const m = /^multichat-link:([^:\s]+):([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m) return null;
  return { id: m[1]!, ephemeralPublicKey: m[2]! };
}
