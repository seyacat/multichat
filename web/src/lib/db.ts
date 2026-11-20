// Envoltura mínima de IndexedDB. La usan la app y el service worker.
import type { LocalContact, LocalMessage, Session } from './types';

const DB_NAME = 'multichat';
const DB_VERSION = 1;

export type StoreName = 'kv' | 'contacts' | 'messages' | 'blobs';

export interface BlobRecord {
  blobId: string;
  mime: string;
  data: Blob;
}

/** Claves de `kv`. */
export interface KvMap {
  session: Session;
  accountKey: Uint8Array; // privada de cuenta, 32 bytes
  contactsSeq: number;
  messagesSeq: number;
  pendingLink: { id: string; ephemeralPrivateKey: Uint8Array; ephemeralPublicKey: string; expiresAt: number };
  pushEnabled: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('contactId', 'contactId');
        s.createIndex('clientId', 'clientId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'blobId' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

/** Cierra la conexión (para pruebas). */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

export async function kvGet<K extends keyof KvMap>(key: K): Promise<KvMap[K] | undefined> {
  const db = await openDb();
  return req(db.transaction('kv').objectStore('kv').get(key)) as Promise<KvMap[K] | undefined>;
}

export async function kvSet<K extends keyof KvMap>(key: K, value: KvMap[K]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  await txDone(tx);
}

export async function kvDel(key: keyof KvMap): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').delete(key);
  await txDone(tx);
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return req(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  return req(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const v of values) s.put(v);
  await txDone(tx);
}

export async function deleteMany(store: StoreName, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const k of keys) s.delete(k);
  await txDone(tx);
}

export async function messagesByContact(contactId: string): Promise<LocalMessage[]> {
  const db = await openDb();
  return req(db.transaction('messages').objectStore('messages').index('contactId').getAll(contactId)) as Promise<
    LocalMessage[]
  >;
}

export async function deleteMessagesOfContact(contactId: string): Promise<void> {
  const msgs = await messagesByContact(contactId);
  await deleteMany(
    'messages',
    msgs.map(m => m.id),
  );
}

export const saveContacts = (cs: LocalContact[]) => putMany('contacts', cs);
export const saveMessages = (ms: LocalMessage[]) => putMany('messages', ms);

export async function clearAll(): Promise<void> {
  const db = await openDb();
  const stores: StoreName[] = ['kv', 'contacts', 'messages', 'blobs'];
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  await txDone(tx);
}
