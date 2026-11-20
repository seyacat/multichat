import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BlobEncryptor } from './crypto/blob.js';
import { newId } from './lib/ids.js';
import type { DB } from './db/index.js';

export interface StoredBlob { blobId: string; fileKey: Buffer; size: number }

export class BlobStore {
  private readonly dir: string;
  constructor(dataDir: string, private readonly db: DB) {
    this.dir = join(dataDir, 'blobs');
    mkdirSync(this.dir, { recursive: true });
  }
  path(id: string) {
    if (!/^b_[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad blob id');
    return join(this.dir, id);
  }
  /** Cifra y guarda. Devuelve la clave del archivo (va dentro del sobre del mensaje). */
  async put(userId: string, data: Buffer | Readable | AsyncIterable<Uint8Array>): Promise<StoredBlob> {
    const blobId = newId('b');
    const fileKey = randomBytes(32);
    const enc = new BlobEncryptor(fileKey);
    const src = Buffer.isBuffer(data) ? Readable.from([data]) : Readable.from(data as AsyncIterable<Uint8Array>);
    try {
      await pipeline(src, enc, createWriteStream(this.path(blobId)));
    } catch (e) {
      rmSync(this.path(blobId), { force: true });
      throw e;
    }
    this.db.prepare('INSERT INTO blobs (id, user_id, size, created_at) VALUES (?, ?, ?, ?)')
      .run(blobId, userId, enc.plainSize, Date.now());
    return { blobId, fileKey, size: enc.plainSize };
  }
  open(userId: string, id: string): { stream: Readable; size: number } | null {
    const row = this.db.prepare('SELECT user_id FROM blobs WHERE id = ?').get(id) as { user_id: string } | undefined;
    if (!row || row.user_id !== userId) return null;
    const p = this.path(id);
    return { stream: createReadStream(p), size: statSync(p).size };
  }
  delete(id: string) {
    rmSync(this.path(id), { force: true });
    this.db.prepare('DELETE FROM blobs WHERE id = ?').run(id);
  }
}
