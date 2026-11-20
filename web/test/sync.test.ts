import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { b64uEncode } from '../src/lib/b64u';
import { encryptBlob, generateKeyPair, openBytes, sealJson } from '../src/lib/crypto';
import * as db from '../src/lib/db';
import { Engine } from '../src/lib/engine';
import { localId } from '../src/lib/merge';
import * as S from '../src/lib/store';
import type { Contact, Message, MessagePayload, Session } from '../src/lib/types';

/** Proxy falso en memoria con lo justo del protocolo. */
class FakeServer {
  seq = 0;
  contacts: Contact[] = [];
  messages: Message[] = [];
  blobs = new Map<string, Uint8Array>();
  access = 'at-1';
  refresh = 'rt-1';
  calls: string[] = [];
  pageSize = 1000;
  failNextAuth = false;
  pub!: Uint8Array;

  async addContact(name: string, status: Contact['status'] = 'accepted'): Promise<Contact> {
    const c: Contact = {
      id: `c_${this.contacts.length + 1}`,
      integrationId: 'i_1',
      kind: 'direct',
      status,
      profile: await sealJson({ name, username: null, phone: null, platform: 'telegram' }, this.pub),
      alias: null,
      muted: false,
      hidePreview: false,
      unread: 0,
      lastMessageAt: null,
      lastInboundAt: null,
      seq: ++this.seq,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.contacts.push(c);
    return c;
  }

  async addMessage(contactId: string, payload: Partial<MessagePayload>, extra: Partial<Message> = {}): Promise<Message> {
    const full: MessagePayload = { v: 1, kind: 'text', text: null, senderName: null, location: null, attachment: null, ...payload };
    const m: Message = {
      id: `m_${this.messages.length + 1}`,
      contactId,
      direction: 'in',
      status: 'received',
      error: null,
      envelope: await sealJson(full, this.pub),
      clientId: null,
      seq: ++this.seq,
      createdAt: Date.now() + this.messages.length,
      updatedAt: Date.now(),
      ...extra,
    };
    this.messages.push(m);
    const c = this.contacts.find(x => x.id === contactId)!;
    if (m.direction === 'in') {
      c.unread++;
      c.seq = ++this.seq;
    }
    return m;
  }

  json(status: number, body?: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    this.calls.push(`${method} ${path}${url.search}`);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;

    if (path === '/api/auth/refresh') {
      const body = JSON.parse(String(init?.body)) as { refreshToken: string };
      if (body.refreshToken !== this.refresh) return this.json(401, { error: 'unauthorized', message: 'no' });
      this.access = `at-${Math.random()}`;
      this.refresh = `rt-${Math.random()}`;
      return this.json(200, session(this.access, this.refresh, b64uEncode(this.pub)));
    }
    if (this.failNextAuth) {
      this.failNextAuth = false;
      return this.json(401, { error: 'unauthorized', message: 'caducado' });
    }
    if (auth !== `Bearer ${this.access}`) return this.json(401, { error: 'unauthorized', message: 'token' });

    if (path === '/api/integrations') return this.json(200, []);
    if (path === '/api/contacts' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return this.json(200, this.contacts.filter(c => c.seq > since));
    }
    if (path === '/api/messages') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), this.pageSize);
      const all = this.messages.filter(m => m.seq > since).sort((a, b) => a.seq - b.seq);
      return this.json(200, { messages: all.slice(0, limit), more: all.length > limit });
    }
    let m = /^\/api\/contacts\/([^/]+)$/.exec(path);
    if (m && method === 'PATCH') {
      const c = this.contacts.find(x => x.id === m![1])!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.read) c.unread = 0;
      for (const k of ['status', 'alias', 'muted', 'hidePreview'] as const) if (k in body) (c as unknown as Record<string, unknown>)[k] = body[k];
      c.seq = ++this.seq;
      return this.json(200, c);
    }
    m = /^\/api\/contacts\/([^/]+)\/messages$/.exec(path);
    if (m && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { clientId: string; text: string };
      const msg = await this.addMessage(m[1]!, { text: body.text }, { direction: 'out', status: 'pending', clientId: body.clientId });
      return this.json(202, msg);
    }
    m = /^\/api\/blobs\/([^/]+)$/.exec(path);
    if (m) return new Response(this.blobs.get(m[1]!) as BodyInit, { status: 200 });
    return this.json(404, { error: 'not_found', message: path });
  };
}

function session(access: string, refresh: string, pub: string | null): Session {
  return {
    accessToken: access,
    refreshToken: refresh,
    user: { id: 'u_1', email: 'a@b.c', accountPublicKey: pub },
    device: { id: 'd_1', name: 'Pruebas', platform: 'web' },
  };
}

let server: FakeServer;
let engine: Engine;
let priv: Uint8Array;

beforeEach(async () => {
  await db.clearAll();
  S.resetStore();
  const kp = await generateKeyPair();
  priv = kp.privateKey;
  server = new FakeServer();
  server.pub = kp.publicKey;
  engine = new Engine({ fetch: server.fetch as typeof fetch, base: () => 'http://proxy.test' });
  S.session.value = session(server.access, server.refresh, b64uEncode(kp.publicKey));
  S.accountKey.value = priv;
});

afterEach(() => {
  S.resetStore();
});

describe('sync', () => {
  it('trae contactos y mensajes descifrados y pagina con more', async () => {
    const c = await server.addContact('Ana');
    for (let i = 0; i < 5; i++) await server.addMessage(c.id, { text: `m${i}` });
    server.pageSize = 2;
    await engine.sync();

    const lc = S.contacts.value.get(c.id)!;
    expect(lc.profileData?.name).toBe('Ana');
    expect(lc.unread).toBe(5);
    const list = S.messages.value.get(c.id)!;
    expect(list.map(m => m.payload?.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(server.calls.filter(x => x.startsWith('GET /api/messages')).length).toBe(3);

    // persistido
    expect((await db.getAll('messages')).length).toBe(5);
    expect(await db.kvGet('messagesSeq')).toBe(engine.cursors.messagesSeq);

    // la siguiente sync pide desde el último seq visto
    server.calls = [];
    const lastMsgSeq = server.messages.at(-1)!.seq;
    expect(engine.cursors.messagesSeq).toBe(lastMsgSeq);
    await server.addMessage(c.id, { text: 'nuevo' });
    await engine.sync();
    const call = server.calls.find(x => x.startsWith('GET /api/messages'))!;
    expect(call).toContain(`since=${lastMsgSeq}&`);
    expect(S.messages.value.get(c.id)!.at(-1)!.payload?.text).toBe('nuevo');
  });

  it('refresca el token en 401 y reintenta', async () => {
    await server.addContact('Ana');
    server.failNextAuth = true;
    await engine.sync();
    expect(server.calls).toContain('POST /api/auth/refresh');
    expect(S.contacts.value.size).toBe(1);
    expect(S.session.value?.accessToken).toBe(server.access);
    expect((await db.kvGet('session'))?.refreshToken).toBe(server.refresh);
  });

  it('un cambio de estado reemitido sustituye al mensaje', async () => {
    const c = await server.addContact('Ana');
    const m = await server.addMessage(c.id, { text: 'hola' }, { direction: 'out', status: 'pending' });
    await engine.sync();
    await engine.onWsEvent({ type: 'message', message: { ...m, status: 'read', seq: ++server.seq } });
    expect(S.messages.value.get(c.id)!.map(x => x.status)).toEqual(['read']);
  });

  it('envío de texto: optimista sustituido por el del proxy', async () => {
    const c = await server.addContact('Ana');
    await engine.sync();
    await engine.sendText(c.id, 'qué tal');
    const list = S.messages.value.get(c.id)!;
    expect(list.length).toBe(1);
    expect(list[0]!.id).toMatch(/^m_/);
    expect(list[0]!.payload?.text).toBe('qué tal');
    expect(list[0]!.local).toBeUndefined();
    expect(await db.getOne('messages', localId(list[0]!.clientId!))).toBeUndefined();
  });

  it('envío fallido por red queda failed y se puede reintentar', async () => {
    const c = await server.addContact('Ana');
    await engine.sync();
    const orig = server.fetch;
    server.fetch = async () => {
      throw new TypeError('red caída');
    };
    const broken = new Engine({ fetch: ((...a: Parameters<typeof fetch>) => server.fetch(...a)) as typeof fetch, base: () => 'http://proxy.test' });
    await broken.sendText(c.id, 'hola');
    const failed = S.messages.value.get(c.id)![0]!;
    expect(failed.status).toBe('failed');
    expect(failed.local).toBe(true);
    server.fetch = orig;
    await broken.retry(failed);
    const list = S.messages.value.get(c.id)!;
    expect(list.length).toBe(1);
    expect(list[0]!.status).toBe('pending');
    expect(list[0]!.id).toMatch(/^m_/);
  });

  it('marcar leído y alias sellado con la pública de cuenta', async () => {
    const c = await server.addContact('Ana');
    await server.addMessage(c.id, { text: 'hola' });
    await engine.sync();
    await engine.markRead(c.id);
    expect(S.contacts.value.get(c.id)!.unread).toBe(0);
    await engine.setAlias(c.id, 'Anita');
    const lc = S.contacts.value.get(c.id)!;
    expect(lc.aliasName).toBe('Anita');
    const raw = new TextDecoder().decode(await openBytes(Uint8Array.from(atob(lc.alias!.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (lc.alias!.length % 4)) % 4)), ch => ch.charCodeAt(0)), priv));
    expect(JSON.parse(raw)).toEqual({ name: 'Anita' });
  });

  it('contact_deleted borra contacto e historial', async () => {
    const c = await server.addContact('Ana');
    await server.addMessage(c.id, { text: 'hola' });
    await engine.sync();
    await engine.onWsEvent({ type: 'contact_deleted', id: c.id });
    expect(S.contacts.value.has(c.id)).toBe(false);
    expect(S.messages.value.has(c.id)).toBe(false);
    expect((await db.messagesByContact(c.id)).length).toBe(0);
  });

  it('descarga y descifra blobs con cache', async () => {
    const c = await server.addContact('Ana');
    const fileKey = crypto.getRandomValues(new Uint8Array(32));
    const plain = new TextEncoder().encode('contenido del archivo');
    server.blobs.set('b_1', await encryptBlob(plain, fileKey));
    await engine.sync();
    const url = await engine.blobUrl('b_1', b64uEncode(fileKey), 'text/plain');
    const text = await (await fetch(url)).text();
    expect(text).toBe('contenido del archivo');
    server.calls = [];
    await engine.blobUrl('b_1', b64uEncode(fileKey), 'text/plain');
    expect(server.calls.length).toBe(0);
    expect(c.id).toBe('c_1');
  });

  it('loadFromDb recupera el estado y marca fallidos los envíos interrumpidos', async () => {
    const c = await server.addContact('Ana');
    await engine.sync();
    await engine.applyLocalMessages([
      {
        id: localId('zz'),
        contactId: c.id,
        direction: 'out',
        status: 'pending',
        error: null,
        envelope: '',
        clientId: 'zz',
        seq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: { v: 1, kind: 'text', text: 'x', senderName: null, location: null, attachment: null },
        local: true,
      },
    ]);
    S.contacts.value = new Map();
    S.messages.value = new Map();
    const fresh = new Engine({ fetch: server.fetch as typeof fetch, base: () => 'http://proxy.test' });
    await fresh.loadFromDb();
    expect(S.contacts.value.get(c.id)?.profileData?.name).toBe('Ana');
    expect(S.messages.value.get(c.id)![0]!.status).toBe('failed');
  });
});
