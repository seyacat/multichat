// Service worker: cache del shell y Web Push con descifrado local (protocol.md §8).
import { kvGet } from './lib/db';
import { buildNotification } from './lib/push';
import type { PushPayload } from './lib/types';

declare const __SW_VERSION__: string | undefined;

const sw = self as unknown as ServiceWorkerGlobalScope;
const VERSION = typeof __SW_VERSION__ !== 'undefined' ? __SW_VERSION__ : 'dev';
const CACHE = `multichat-shell-${VERSION}`;
// Rutas relativas al ámbito del SW (en despliegue la PWA vive en /app/).
const scoped = (p: string) => new URL(p, sw.registration.scope).toString();
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg'];
const DEV = VERSION === 'dev';

sw.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      if (!DEV) {
        const cache = await caches.open(CACHE);
        await cache.addAll(SHELL.map(scoped)).catch(() => undefined);
      }
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('multichat-shell-') && k !== CACHE) await caches.delete(k);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', event => {
  const req = event.request;
  if (DEV || req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/wh')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE);
          void cache.put(scoped('index.html'), res.clone());
          return res;
        } catch {
          return (await caches.match(scoped('index.html'))) ?? (await caches.match(scoped('./'))) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // recursos estáticos: cache primero (los de /assets llevan hash)
  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && url.href.startsWith(sw.registration.scope) && /\/(assets|icons)\//.test(url.pathname)) {
        const cache = await caches.open(CACHE);
        void cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});

sw.addEventListener('push', event => {
  event.waitUntil(
    (async () => {
      let mc: PushPayload | null = null;
      try {
        const data = event.data?.json() as PushPayload | { mc: PushPayload } | undefined;
        mc = data && 'mc' in data ? data.mc : (data as PushPayload | undefined) ?? null;
      } catch {
        mc = null;
      }
      const n = mc ? await buildNotification(mc, await kvGet('accountKey').catch(() => undefined)) : { title: 'Multichat', body: 'Nuevo mensaje' };
      await sw.registration.showNotification(n.title, {
        body: n.body,
        icon: scoped('icons/icon-192.png'),
        badge: scoped('icons/badge-96.png'),
        tag: mc?.contactId ?? 'multichat',
        data: { contactId: mc?.contactId ?? null },
      });
    })(),
  );
});

sw.addEventListener('notificationclick', event => {
  event.notification.close();
  const contactId = (event.notification.data as { contactId?: string | null } | null)?.contactId ?? null;
  const target = scoped(contactId ? `./#/chat/${encodeURIComponent(contactId)}` : './');
  event.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = all[0];
      if (client) {
        await client.focus();
        if (contactId) client.postMessage({ type: 'open-chat', contactId });
        return;
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
