import { afterEach, beforeEach, expect, it } from 'vitest';
import { json, mockFetch, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });
afterEach(async () => { await t.close(); });

it('WebSocket: rechaza token malo y recibe eventos de contacto y mensaje', async () => {
  mockFetch([u => {
    if (u.pathname.endsWith('/getMe')) return json({ ok: true, result: { id: 1, username: 'b' } });
    if (u.pathname.endsWith('/setWebhook')) return json({ ok: true, result: true });
  }]);
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.address() as { port: number }).port;

  const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=nope`);
  const code = await new Promise<number>(r => bad.addEventListener('close', e => r(e.code)));
  expect(code).toBe(4401);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${t.session.accessToken}`);
  const events: any[] = [];
  ws.addEventListener('message', e => events.push(JSON.parse(String(e.data))));
  await new Promise(r => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ type: 'ping' }));

  const integ = (await t.app.inject({ method: 'POST', url: '/api/integrations', headers: t.auth,
    payload: { type: 'telegram', name: 'B', credentials: { botToken: '1:abc' } } })).json();
  const secret = (t.ctx.db.prepare('SELECT webhook_secret FROM integrations WHERE id = ?').get(integ.id) as any).webhook_secret;
  await t.app.inject({ method: 'POST', url: `/wh/telegram/${integ.id}`, headers: { 'x-telegram-bot-api-secret-token': secret },
    payload: { message: { message_id: 1, chat: { id: 9, type: 'private' }, from: { id: 9, first_name: 'Z' }, text: 'hey' } } });

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !events.some(e => e.type === 'message')) await new Promise(r => setTimeout(r, 20));
  ws.close();
  const types = events.map(e => e.type);
  expect(types).toContain('pong');
  expect(types).toContain('integration');
  expect(types).toContain('contact');
  expect(types).toContain('message');
});
