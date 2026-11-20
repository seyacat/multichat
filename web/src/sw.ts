// Service worker: cache del shell y Web Push con descifrado local (protocol.md §8).
import { openJson } from './lib/crypto';
import { kvGet } from './lib/db';
import { previewText } from './lib/merge';
import type { ContactProfile, LocalMessage, MessagePayload, PushPayload } from './lib/types';

declare const __SW_VERSION__: string | undefined;

const sw = self as unknown as ServiceWorkerGlobalScope;
const VERSION = typeof __SW_VERSION__ !== 'undefined' ? __SW_VERSION__ : 'dev';
const CACHE = `multichat-shell-${VERSION}`;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg'];
const DEV = VERSION === 'dev';

sw.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      if (!DEV) {
        const cache = await caches.open(CACHE);
        await cache.addAll(SHELL).catch(() => undefined);
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
          void cache.put('/index.html', res.clone());
          return res;
        } catch {
          return (await caches.match('/index.html')) ?? (await caches.match('/')) ?? Response.error();
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
      if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) {
        const cache = await caches.open(CACHE);
        void cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});

async function buildNotification(mc: PushPayload): Promise<{ title: string; body: string }> {
  const generic = { title: 'Multichat', body: 'Nuevo mensaje' };
  if (mc.hidePreview) return generic;
  const key = await kvGet('accountKey').catch(() => undefined);
  if (!key) return generic;
  const priv = new Uint8Array(key);
  let title = generic.title;
  try {
    if (mc.alias) title = (await openJson<{ name: string }>(mc.alias, priv)).name || title;
    else if (mc.profile) {
      const p = await openJson<ContactProfile>(mc.profile, priv);
      title = p.name || p.username || p.phone || title;
    }
  } catch {
    /* sin nombre */
  }
  let body = generic.body;
  if (mc.envelope) {
    try {
      const payload = await openJson<MessagePayload>(mc.envelope, priv);
      const text = previewText({ payload } as LocalMessage);
      body = payload.senderName ? `${payload.senderName}: ${text}` : text || body;
    } catch {
      /* texto genérico */
    }
  }
  return { title, body };
}

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
      const n = mc ? await buildNotification(mc) : { title: 'Multichat', body: 'Nuevo mensaje' };
      await sw.registration.showNotification(n.title, {
        body: n.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: mc?.contactId ?? 'multichat',
        data: { contactId: mc?.contactId ?? null },
      });
    })(),
  );
});

sw.addEventListener('notificationclick', event => {
  event.notification.close();
  const contactId = (event.notification.data as { contactId?: string | null } | null)?.contactId ?? null;
  const target = contactId ? `/#/chat/${encodeURIComponent(contactId)}` : '/';
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
