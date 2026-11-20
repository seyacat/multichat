import { describe, expect, it } from 'vitest';
import { generateKeyPair, sealJson } from '../src/lib/crypto';
import { buildNotification, GENERIC } from '../src/lib/push';
import type { PushPayload } from '../src/lib/types';

describe('notificación Web Push', async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const profile = await sealJson({ name: 'Ana', username: null, phone: null, platform: 'telegram' }, publicKey);
  const envelope = await sealJson(
    { v: 1, kind: 'text', text: 'hola', senderName: null, location: null, attachment: null },
    publicKey,
  );
  const base: PushPayload = { messageId: 'm_1', contactId: 'c_1', hidePreview: false, profile, alias: null, envelope };

  it('descifra nombre y texto', async () => {
    expect(await buildNotification(base, privateKey)).toEqual({ title: 'Ana', body: 'hola' });
  });

  it('prefiere el alias', async () => {
    const alias = await sealJson({ name: 'Anita' }, publicKey);
    expect((await buildNotification({ ...base, alias }, privateKey)).title).toBe('Anita');
  });

  it('hidePreview, sin clave o sin sobre: texto genérico', async () => {
    expect(await buildNotification({ ...base, hidePreview: true }, privateKey)).toEqual(GENERIC);
    expect(await buildNotification(base, undefined)).toEqual(GENERIC);
    expect(await buildNotification({ ...base, envelope: null }, privateKey)).toEqual({ title: 'Ana', body: GENERIC.body });
  });

  it('remitente en grupos y adjuntos', async () => {
    const env = await sealJson(
      { v: 1, kind: 'image', text: null, senderName: 'Pedro', location: null, attachment: { blobId: 'b', fileKey: 'k', mime: 'image/jpeg', name: 'a.jpg', size: 1 } },
      publicKey,
    );
    expect((await buildNotification({ ...base, envelope: env }, privateKey)).body).toBe('Pedro: 📷 Foto');
  });
});
