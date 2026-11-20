import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';

export const MAGIC = Buffer.from('MCB1', 'ascii');
export const CHUNK = 65536;
const TAG = 16;
const ENC_CHUNK = CHUNK + TAG;

function chunkNonce(base: Buffer, i: number): Buffer {
  const n = Buffer.from(base);
  const tail = n.readUInt32BE(8) ^ i;
  n.writeUInt32BE(tail >>> 0, 8);
  return n;
}

function encChunk(key: Buffer, base: Buffer, i: number, data: Buffer, last: boolean): Buffer {
  const c = createCipheriv('aes-256-gcm', key, chunkNonce(base, i));
  c.setAAD(Buffer.from([last ? 1 : 0]));
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

function decChunk(key: Buffer, base: Buffer, i: number, data: Buffer, last: boolean): Buffer {
  if (data.length < TAG) throw new Error('blob chunk too short');
  const d = createDecipheriv('aes-256-gcm', key, chunkNonce(base, i));
  d.setAAD(Buffer.from([last ? 1 : 0]));
  d.setAuthTag(data.subarray(data.length - TAG));
  return Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]);
}

/** Streaming encryptor. Output = MAGIC ‖ baseNonce ‖ chunks. */
export class BlobEncryptor extends Transform {
  private buf = Buffer.alloc(0);
  private i = 0;
  private readonly base: Buffer;
  public plainSize = 0;
  constructor(private readonly key: Buffer, baseNonce?: Buffer) {
    super();
    if (key.length !== 32) throw new Error('fileKey must be 32 bytes');
    this.base = baseNonce ?? randomBytes(12);
    this.push(Buffer.concat([MAGIC, this.base]));
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.plainSize += chunk.length;
    this.buf = Buffer.concat([this.buf, chunk]);
    // keep at least one full chunk buffered so we know which one is last
    while (this.buf.length > CHUNK) {
      this.push(encChunk(this.key, this.base, this.i++, this.buf.subarray(0, CHUNK), false));
      this.buf = this.buf.subarray(CHUNK);
    }
    cb();
  }
  override _flush(cb: TransformCallback) {
    this.push(encChunk(this.key, this.base, this.i++, this.buf, true));
    cb();
  }
}

export function encryptBlob(plain: Buffer, key: Buffer, baseNonce?: Buffer): Buffer {
  const base = baseNonce ?? randomBytes(12);
  const parts: Buffer[] = [MAGIC, base];
  let i = 0;
  let off = 0;
  do {
    const end = Math.min(off + CHUNK, plain.length);
    parts.push(encChunk(key, base, i++, plain.subarray(off, end), end >= plain.length));
    off = end;
  } while (off < plain.length);
  return Buffer.concat(parts);
}

export function decryptBlob(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 16 + TAG || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('invalid blob');
  const base = blob.subarray(4, 16);
  const body = blob.subarray(16);
  const out: Buffer[] = [];
  let i = 0;
  for (let off = 0; off < body.length || i === 0; off += ENC_CHUNK) {
    const end = Math.min(off + ENC_CHUNK, body.length);
    out.push(decChunk(key, base, i++, body.subarray(off, end), end >= body.length));
    if (end >= body.length) break;
  }
  return Buffer.concat(out);
}
