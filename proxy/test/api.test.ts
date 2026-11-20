import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flush, json, mockFetch, setup } from './helpers.js';
import { openJson, sealBytes } from '../src/crypto/seal.js';
import { decryptBlob } from '../src/crypto/blob.js';
import { generateRawKeyPair, publicFromPrivate } from '../src/crypto/x25519.js';
import { openBytes } from '../src/crypto/seal.js';
import { b64u } from '../src/lib/b64.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });
afterEach(async () => { await t.close(); });

const TG_TOKEN = '123456:ABCdefSECRETtoken';
const PHOTO = Buffer.from('fake-jpeg-bytes-'.repeat(100));

function telegramMock() {
  return mockFetch([
    (u, init) => {
      if (u.hostname !== 'api.telegram.org') return;
      if (u.pathname.endsWith('/getMe')) return json({ ok: true, result: { id: 42, username: 'ventas_bot', first_name: 'Ventas' } });
      if (u.pathname.endsWith('/setWebhook')) return json({ ok: true, result: true });
      if (u.pathname.endsWith('/getFile')) return json({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
      if (u.pathname.includes('/file/bot')) return new Response(PHOTO);
      if (u.pathname.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 900 } });
      if (u.pathname.endsWith('/sendPhoto')) {
        expect(init.body).toBeInstanceOf(FormData);
        return json({ ok: true, result: { message_id: 901 } });
      }
    },
  ]);
}

async function createTelegram() {
  const r = await t.app.inject({
    method: 'POST', url: '/api/integrations', headers: t.auth,
    payload: { type: 'telegram', name: 'Ventas', color: '#2299dd', credentials: { botToken: TG_TOKEN } },
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}

describe('auth', () => {
  it('login, refresh rota el token, logout', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ANA@example.com', password: 'contraseña1', deviceName: 'otro', platform: 'ios' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.accountPublicKey).toBe(b64u.encode(t.keys.publicKey));
    const r1 = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: login.json().refreshToken } });
    expect(r1.statusCode).toBe(200);
    const again = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: login.json().refreshToken } });
    expect(again.statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.com', password: 'malamala1', deviceName: 'x', platform: 'web' } });
    expect(bad.json()).toMatchObject({ error: 'unauthorized' });
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth });
    expect(me.json().devices).toHaveLength(2);
    const second = await t.app.inject({ method: 'PUT', url: '/api/account/key', headers: t.auth, payload: { publicKey: b64u.encode(t.keys.publicKey) } });
    expect(second.statusCode).toBe(409);
  });

  it('sin token: 401', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/integrations' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('unauthorized');
  });
});

describe('vincular dispositivo', () => {
  it('flujo completo', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.com', password: 'contraseña1', deviceName: 'iPhone', platform: 'ios' } });
    const newAuth = { authorization: `Bearer ${login.json().accessToken}` };
    const eph = generateRawKeyPair();
    const created = await t.app.inject({ method: 'POST', url: '/api/link', headers: newAuth, payload: { ephemeralPublicKey: b64u.encode(eph.publicKey) } });
    const id = created.json().id;
    const seen = await t.app.inject({ method: 'GET', url: `/api/link/${id}`, headers: t.auth });
    expect(seen.json()).toMatchObject({ status: 'pending', deviceName: 'iPhone', ephemeralPublicKey: b64u.encode(eph.publicKey) });
    const sealedKey = b64u.encode(sealBytes(t.keys.privateKey, b64u.decode(seen.json().ephemeralPublicKey)));
    const ok = await t.app.inject({ method: 'POST', url: `/api/link/${id}/approve`, headers: t.auth, payload: { sealedKey } });
    expect(ok.statusCode).toBe(204);
    const done = await t.app.inject({ method: 'GET', url: `/api/link/${id}`, headers: newAuth });
    expect(done.json().status).toBe('approved');
    const priv = openBytes(b64u.decode(done.json().sealedKey), eph.privateKey);
    expect(publicFromPrivate(priv).equals(t.keys.publicKey)).toBe(true);
  });
});

describe('telegram', () => {
  it('crear integración registra el webhook y no devuelve el token', async () => {
    const calls = telegramMock();
    const integ = await createTelegram();
    expect(integ).toMatchObject({ type: 'telegram', status: 'connected', credentialHint: '…oken', info: { username: 'ventas_bot' } });
    expect(JSON.stringify(integ)).not.toContain(TG_TOKEN);
    const wh = calls.find(c => c.url.endsWith('/setWebhook'))!;
    const body = JSON.parse(String(wh.init.body));
    expect(body.url).toBe(`https://proxy.test/wh/telegram/${integ.id}`);
    expect(body.secret_token).toBeTruthy();
  });

  it('mensaje entrante → contacto aceptado y sellado; responder', async () => {
    const calls = telegramMock();
    const integ = await createTelegram();
    const secret = (t.ctx.db.prepare('SELECT webhook_secret FROM integrations WHERE id = ?').get(integ.id) as any).webhook_secret;

    const bad = await t.app.inject({ method: 'POST', url: `/wh/telegram/${integ.id}`, headers: { 'x-telegram-bot-api-secret-token': 'nope' }, payload: {} });
    expect(bad.statusCode).toBe(401);

    const update = (id: number, extra: object) => ({
      update_id: id, message: { message_id: id, date: 1, chat: { id: 777, type: 'private', first_name: 'Pedro' }, from: { id: 777, first_name: 'Pedro', username: 'pedro' }, ...extra },
    });
    for (const u of [update(1, { text: 'Hola secreto123' }), update(2, { photo: [{ file_id: 'a', file_size: 10 }, { file_id: 'b', file_size: 1600 }], caption: 'mira' }), update(1, { text: 'Hola secreto123' })]) {
      const r = await t.app.inject({ method: 'POST', url: `/wh/telegram/${integ.id}`, headers: { 'x-telegram-bot-api-secret-token': secret }, payload: u });
      expect(r.statusCode).toBe(200);
      await flush();
    }

    const contacts = (await t.app.inject({ method: 'GET', url: '/api/contacts', headers: t.auth })).json();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ status: 'accepted', kind: 'direct', unread: 2 });
    expect(openJson(contacts[0].profile, t.keys.privateKey)).toEqual({ name: 'Pedro', username: 'pedro', phone: null, platform: 'telegram' });

    const { messages } = (await t.app.inject({ method: 'GET', url: '/api/messages?since=0', headers: t.auth })).json();
    expect(messages).toHaveLength(2); // el duplicado se descarta
    const p1 = openJson<any>(messages[0].envelope, t.keys.privateKey);
    expect(p1).toMatchObject({ v: 1, kind: 'text', text: 'Hola secreto123' });
    const p2 = openJson<any>(messages[1].envelope, t.keys.privateKey);
    expect(p2).toMatchObject({ kind: 'image', text: 'mira', attachment: { mime: 'image/jpeg', size: PHOTO.length } });
    const blob = await t.app.inject({ method: 'GET', url: `/api/blobs/${p2.attachment.blobId}`, headers: t.auth });
    expect(decryptBlob(blob.rawPayload, b64u.decode(p2.attachment.fileKey)).equals(PHOTO)).toBe(true);
    expect(calls.some(c => c.url.includes('/getFile') && JSON.parse(String(c.init.body)).file_id === 'b')).toBe(true);

    // un contacto puesto en pending a mano no recibe envíos
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${contacts[0].id}`, headers: t.auth, payload: { status: 'pending' } });
    const forbidden = await t.app.inject({ method: 'POST', url: `/api/contacts/${contacts[0].id}/messages`, headers: t.auth, payload: { text: 'hola' } });
    expect(forbidden.statusCode).toBe(403);

    const acc = await t.app.inject({ method: 'PATCH', url: `/api/contacts/${contacts[0].id}`, headers: t.auth, payload: { status: 'accepted', read: true } });
    expect(acc.json()).toMatchObject({ status: 'accepted', unread: 0 });

    const sent = await t.app.inject({ method: 'POST', url: `/api/contacts/${contacts[0].id}/messages`, headers: t.auth, payload: { clientId: 'c1', text: 'Respuesta' } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().status).toBe('pending');
    await flush();
    const sendCall = calls.find(c => c.url.endsWith('/sendMessage'))!;
    expect(JSON.parse(String(sendCall.init.body))).toMatchObject({ chat_id: '777', text: 'Respuesta' });
    const after = (await t.app.inject({ method: 'GET', url: `/api/messages?since=${sent.json().seq}`, headers: t.auth })).json();
    expect(after.messages.find((m: any) => m.id === sent.json().id)).toMatchObject({ status: 'sent', clientId: 'c1' });

    // reintento con el mismo clientId no duplica
    const dup = await t.app.inject({ method: 'POST', url: `/api/contacts/${contacts[0].id}/messages`, headers: t.auth, payload: { clientId: 'c1', text: 'Respuesta' } });
    expect(dup.json().id).toBe(sent.json().id);

    // multipart con foto
    const boundary = '----mc';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientId"\r\n\r\nc2\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      PHOTO, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await t.app.inject({ method: 'POST', url: `/api/contacts/${contacts[0].id}/messages`, headers: { ...t.auth, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode).toBe(202);
    await flush();
    expect(calls.some(c => c.url.endsWith('/sendPhoto'))).toBe(true);
    expect(openJson<any>(up.json().envelope, t.keys.privateKey)).toMatchObject({ kind: 'image', attachment: { name: 'x.jpg' } });

    // nada en claro en disco
    const files = [join(t.dir, 'multichat.sqlite'), join(t.dir, 'multichat.sqlite-wal'),
      ...readdirSync(join(t.dir, 'blobs')).map(f => join(t.dir, 'blobs', f))];
    for (const f of files) {
      let data: Buffer;
      try { data = readFileSync(f); } catch { continue; }
      for (const needle of ['secreto123', 'Pedro', 'Respuesta', 'fake-jpeg-bytes', TG_TOKEN]) {
        expect(data.includes(Buffer.from(needle)), `${needle} en ${f}`).toBe(false);
      }
    }
  });

  it('bloqueado: descarta mensajes', async () => {
    telegramMock();
    const integ = await createTelegram();
    const secret = (t.ctx.db.prepare('SELECT webhook_secret FROM integrations WHERE id = ?').get(integ.id) as any).webhook_secret;
    const send = (id: number) => t.app.inject({ method: 'POST', url: `/wh/telegram/${integ.id}`, headers: { 'x-telegram-bot-api-secret-token': secret },
      payload: { message: { message_id: id, chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'X' }, text: 'hola' } } });
    await send(1); await flush();
    const [c] = (await t.app.inject({ method: 'GET', url: '/api/contacts', headers: t.auth })).json();
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${c.id}`, headers: t.auth, payload: { status: 'blocked' } });
    await send(2); await flush();
    const { messages } = (await t.app.inject({ method: 'GET', url: '/api/messages', headers: t.auth })).json();
    expect(messages).toHaveLength(1);
  });

  it('límite de integraciones', async () => {
    telegramMock();
    for (let i = 0; i < 5; i++) await createTelegram();
    const r = await t.app.inject({ method: 'POST', url: '/api/integrations', headers: t.auth,
      payload: { type: 'telegram', name: 'X', credentials: { botToken: TG_TOKEN } } });
    expect(r.json().error).toBe('limit_reached');
  });

  it('token inválido → platform_error', async () => {
    mockFetch([u => (u.hostname === 'api.telegram.org' ? json({ ok: false, description: 'Unauthorized' }, 401) : undefined)]);
    const r = await t.app.inject({ method: 'POST', url: '/api/integrations/test', headers: t.auth, payload: { type: 'telegram', credentials: { botToken: 'x' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'platform_error', message: 'Telegram: Unauthorized' });
  });
});

describe('whatsapp', () => {
  const creds = { appId: '111', appSecret: 'appsecret', accessToken: 'EAAtokenWXYZ', phoneNumberId: '555', wabaId: '999' };
  it('verificación, firma, mensaje entrante y estados', async () => {
    const calls = mockFetch([
      (u, init) => {
        if (u.hostname !== 'graph.facebook.com') return;
        if (u.pathname === '/v23.0/555' && (init.method ?? 'GET') === 'GET') return json({ display_phone_number: '+1 555', verified_name: 'Test' });
        if (u.pathname === '/v23.0/111/subscriptions') return json({ success: true });
        if (u.pathname === '/v23.0/999/subscribed_apps') return json({ success: true });
        if (u.pathname === '/v23.0/555/messages') return json({ messages: [{ id: 'wamid.OUT1' }] });
      },
    ]);
    const r = await t.app.inject({ method: 'POST', url: '/api/integrations', headers: t.auth, payload: { type: 'whatsapp', name: 'WA', color: '#22aa55', credentials: creds } });
    const integ = r.json();
    expect(integ).toMatchObject({ status: 'connected', info: { webhookRegistered: true, displayPhoneNumber: '+1 555' } });
    const verifyToken = integ.config.verifyToken;
    const subCall = calls.find(c => c.url.includes('/subscriptions'))!;
    expect(String(subCall.init.body)).toContain(encodeURIComponent(`https://proxy.test/wh/whatsapp/${integ.id}`));

    const ok = await t.app.inject({ method: 'GET', url: `/wh/whatsapp/${integ.id}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=abc` });
    expect(ok.body).toBe('abc');
    const no = await t.app.inject({ method: 'GET', url: `/wh/whatsapp/${integ.id}?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=abc` });
    expect(no.statusCode).toBe(403);

    const post = (body: object, secret = 'appsecret') => {
      const raw = JSON.stringify(body);
      const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
      return t.app.inject({ method: 'POST', url: `/wh/whatsapp/${integ.id}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, payload: raw });
    };
    const inbound = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '555' }, contacts: [{ wa_id: '593999', profile: { name: 'Lucía' } }],
      messages: [{ from: '593999', id: 'wamid.IN1', type: 'text', text: { body: 'buenas' } }] } }] }] };
    expect((await post(inbound, 'otro')).statusCode).toBe(401);
    expect((await post(inbound)).statusCode).toBe(200);
    await flush();
    const [c] = (await t.app.inject({ method: 'GET', url: '/api/contacts', headers: t.auth })).json();
    expect(openJson(c.profile, t.keys.privateKey)).toMatchObject({ name: 'Lucía', phone: '+593999' });
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${c.id}`, headers: t.auth, payload: { status: 'accepted' } });
    const sent = await t.app.inject({ method: 'POST', url: `/api/contacts/${c.id}/messages`, headers: t.auth, payload: { text: 'hola' } });
    await flush();
    const status = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '555' }, statuses: [{ id: 'wamid.OUT1', status: 'read' }] } }] }] };
    await post(status); await flush();
    const late = { ...status, entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555' }, statuses: [{ id: 'wamid.OUT1', status: 'delivered' }] } }] }] };
    await post(late); await flush();
    const { messages } = (await t.app.inject({ method: 'GET', url: '/api/messages', headers: t.auth })).json();
    expect(messages.find((m: any) => m.id === sent.json().id).status).toBe('read');

    // cambiar solo el token conserva el resto de credenciales
    const p = await t.app.inject({ method: 'PATCH', url: `/api/integrations/${integ.id}`, headers: t.auth, payload: { credentials: { accessToken: 'EAAnuevo9876', appSecret: '' } } });
    expect(p.statusCode).toBe(200);
    expect(p.json().credentialHint).toBe('…9876');
    const stored = t.ctx.vault.decrypt<any>((t.ctx.db.prepare('SELECT credentials_enc FROM integrations WHERE id = ?').get(integ.id) as any).credentials_enc);
    expect(stored).toEqual({ ...creds, accessToken: 'EAAnuevo9876' });
  });
});
