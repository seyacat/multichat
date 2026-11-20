import { describe, expect, it } from 'vitest';
import {
  contactIsNewer,
  displayName,
  initials,
  kindForMime,
  lastVisible,
  localId,
  mergeMessage,
  previewText,
  waWindowClosed,
} from '../src/lib/merge';
import type { LocalContact, LocalMessage, MessagePayload } from '../src/lib/types';

const text = (t: string): MessagePayload => ({ v: 1, kind: 'text', text: t, senderName: null, location: null, attachment: null });

function msg(p: Partial<LocalMessage> & { id: string }): LocalMessage {
  return {
    contactId: 'c_1',
    direction: 'in',
    status: 'received',
    error: null,
    envelope: 'x',
    clientId: null,
    seq: 1,
    createdAt: 1000,
    updatedAt: 1000,
    payload: text('hola'),
    ...p,
  };
}

describe('mergeMessage', () => {
  it('inserta ordenado por createdAt', () => {
    let list: LocalMessage[] = [];
    list = mergeMessage(list, msg({ id: 'm_2', createdAt: 2000, seq: 2 })).list;
    list = mergeMessage(list, msg({ id: 'm_1', createdAt: 1000, seq: 3 })).list;
    list = mergeMessage(list, msg({ id: 'm_3', createdAt: 3000, seq: 4 })).list;
    expect(list.map(m => m.id)).toEqual(['m_1', 'm_2', 'm_3']);
  });

  it('sustituye al optimista con el mismo clientId', () => {
    const opt = msg({ id: localId('u1'), clientId: 'u1', direction: 'out', status: 'pending', seq: 0, local: true });
    const srv = msg({ id: 'm_9', clientId: 'u1', direction: 'out', status: 'pending', seq: 10 });
    const r = mergeMessage([opt], srv);
    expect(r.list.map(m => m.id)).toEqual(['m_9']);
    expect(r.removed).toEqual([localId('u1')]);
  });

  it('conserva el payload optimista si el del proxy no se pudo descifrar', () => {
    const opt = msg({ id: localId('u1'), clientId: 'u1', direction: 'out', seq: 0, local: true, payload: text('mío') });
    const srv = msg({ id: 'm_9', clientId: 'u1', direction: 'out', seq: 10, payload: null });
    expect(mergeMessage([opt], srv).list[0]!.payload?.text).toBe('mío');
  });

  it('un cambio de estado con seq mayor sustituye; uno viejo se descarta', () => {
    const a = msg({ id: 'm_1', direction: 'out', status: 'pending', seq: 5 });
    let r = mergeMessage([a], { ...a, status: 'sent', seq: 7 });
    expect(r.list[0]!.status).toBe('sent');
    r = mergeMessage(r.list, { ...a, status: 'pending', seq: 6 });
    expect(r.stored).toBeNull();
    expect(r.list[0]!.status).toBe('sent');
  });

  it('mantiene la marca dismissed', () => {
    const a = msg({ id: 'm_1', status: 'failed', seq: 5, dismissed: true });
    const r = mergeMessage([a], { ...a, dismissed: undefined, seq: 8 });
    expect(r.list[0]!.dismissed).toBe(true);
    expect(lastVisible(r.list)).toBeUndefined();
  });
});

describe('utilidades', () => {
  it('contactIsNewer', () => {
    expect(contactIsNewer(undefined, { seq: 1 })).toBe(true);
    expect(contactIsNewer({ seq: 5 } as LocalContact, { seq: 4 })).toBe(false);
    expect(contactIsNewer({ seq: 5 } as LocalContact, { seq: 5 })).toBe(true);
  });

  it('displayName prioriza alias', () => {
    const c = { aliasName: null, profileData: { name: 'Ana', username: null, phone: null, platform: 'telegram' } } as LocalContact;
    expect(displayName(c)).toBe('Ana');
    expect(displayName({ ...c, aliasName: 'Anita' })).toBe('Anita');
  });

  it('initials', () => {
    expect(initials('Ana María López')).toBe('AL');
    expect(initials('ñandú')).toBe('ÑA');
    expect(initials('')).toBe('#');
  });

  it('previewText', () => {
    expect(previewText(msg({ id: 'a' }))).toBe('hola');
    expect(previewText(msg({ id: 'a', payload: { ...text(''), kind: 'location', text: null } }))).toBe('📍 Ubicación');
    expect(previewText(msg({ id: 'a', payload: null, decryptError: true }))).toBe('No se pudo descifrar');
  });

  it('ventana de 24 h de WhatsApp', () => {
    const now = 10 * 24 * 3600_000;
    expect(waWindowClosed(null, now)).toBe(true);
    expect(waWindowClosed(now - 3600_000, now)).toBe(false);
    expect(waWindowClosed(now - 25 * 3600_000, now)).toBe(true);
  });

  it('kindForMime', () => {
    expect(kindForMime('image/png')).toBe('image');
    expect(kindForMime('video/mp4')).toBe('video');
    expect(kindForMime('audio/ogg')).toBe('audio');
    expect(kindForMime('application/pdf')).toBe('file');
    expect(kindForMime('')).toBe('file');
  });
});
