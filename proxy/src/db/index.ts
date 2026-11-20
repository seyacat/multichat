import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    account_public_key TEXT,
    max_integrations INTEGER,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    refresh_hash TEXT NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    push_kind TEXT,
    push_data TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE UNIQUE INDEX devices_refresh ON devices(refresh_hash);
  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'connecting',
    status_detail TEXT,
    credentials_enc TEXT NOT NULL,
    credential_hint TEXT NOT NULL,
    webhook_secret TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    info_json TEXT NOT NULL DEFAULT '{}',
    lookup_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX integrations_user ON integrations(user_id);
  CREATE INDEX integrations_lookup ON integrations(type, lookup_key);
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    profile_env TEXT NOT NULL,
    profile_mac TEXT NOT NULL,
    alias_env TEXT,
    muted INTEGER NOT NULL DEFAULT 0,
    hide_preview INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    last_inbound_at INTEGER,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(integration_id, external_id)
  );
  CREATE INDEX contacts_user_seq ON contacts(user_id, seq);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    envelope TEXT NOT NULL,
    platform_message_id TEXT,
    client_id TEXT,
    blob_id TEXT,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX messages_user_seq ON messages(user_id, seq);
  CREATE INDEX messages_contact_time ON messages(contact_id, created_at);
  CREATE INDEX messages_platform ON messages(contact_id, platform_message_id);
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE link_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    ephemeral_public_key TEXT NOT NULL,
    sealed_key TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Sin solicitudes: los contactos nuevos se aceptan solos (pedido del cliente).
  `UPDATE contacts SET status = 'accepted' WHERE status = 'pending';`,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function nextSeq(db: DB, userId: string): number {
  const r = db.prepare('UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq').get(userId) as { seq: number };
  return r.seq;
}
