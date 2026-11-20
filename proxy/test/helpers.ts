import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { generateRawKeyPair } from '../src/crypto/x25519.js';
import { b64u } from '../src/lib/b64.js';

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/** Sustituye fetch global por un enrutador de respuestas simuladas. */
export function mockFetch(routes: Route[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    throw new Error(`fetch no simulado: ${url}`);
  });
  return calls;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-test-'));
  const config: Config = {
    port: 0, host: '127.0.0.1', publicUrl: 'https://proxy.test', dataDir: dir,
    masterKey: Buffer.alloc(32, 3), maxIntegrationsPerUser: 5, serveWeb: null, graphVersion: 'v23.0',
    apns: null, vapid: null, corsOrigins: true,
  };
  const { app, ctx } = await buildApp(config, { logger: false, startIntegrations: false });
  await app.ready();

  const keys = generateRawKeyPair();
  const reg = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'ana@example.com', password: 'contraseña1', deviceName: 'test', platform: 'web' },
  });
  const session = reg.json();
  const auth = { authorization: `Bearer ${session.accessToken}` };
  await app.inject({ method: 'PUT', url: '/api/account/key', headers: auth, payload: { publicKey: b64u.encode(keys.publicKey) } });

  return {
    app, ctx, dir, keys, session, auth,
    async close() { await app.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); },
  };
}

export const flush = () => new Promise(r => setTimeout(r, 30));
