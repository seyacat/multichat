// Lógica pura de fusión de contactos y mensajes (sin E/S). Se prueba aparte.
import type { LocalContact, LocalMessage } from './types';

export const localId = (clientId: string) => `local:${clientId}`;

function byTime(a: LocalMessage, b: LocalMessage): number {
  return a.createdAt - b.createdAt || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface MergeResult {
  list: LocalMessage[];
  /** Mensaje finalmente guardado, o null si el entrante era más viejo y se descartó. */
  stored: LocalMessage | null;
  /** Ids que hay que borrar del almacén (optimistas sustituidos). */
  removed: string[];
}

/**
 * Fusiona un mensaje del proxy en la lista (ordenada) de su contacto.
 * - Sustituye al optimista con el mismo clientId.
 * - Un mismo id solo se sobrescribe si el seq entrante es >= al guardado (los cambios de estado reemiten con seq nuevo).
 * - Conserva la marca local `dismissed`.
 */
export function mergeMessage(list: LocalMessage[], incoming: LocalMessage): MergeResult {
  const removed: string[] = [];
  let next = list;
  let carried: Partial<LocalMessage> = {};

  if (incoming.clientId && !incoming.local) {
    const lid = localId(incoming.clientId);
    const opt = next.find(m => m.id === lid);
    if (opt) {
      removed.push(lid);
      next = next.filter(m => m.id !== lid);
      // si el proxy aún no trae el payload descifrable, mantener el optimista
      if (!incoming.payload && opt.payload) carried.payload = opt.payload;
    }
  }

  const idx = next.findIndex(m => m.id === incoming.id);
  if (idx >= 0) {
    const cur = next[idx]!;
    if (!incoming.local && !cur.local && incoming.seq < cur.seq) {
      return { list: next === list ? list : next, stored: null, removed };
    }
    if (cur.dismissed) carried.dismissed = true;
    if (!incoming.payload && cur.payload) carried.payload = cur.payload;
    const merged = { ...incoming, ...carried };
    const copy = next.slice();
    copy[idx] = merged;
    copy.sort(byTime);
    return { list: copy, stored: merged, removed };
  }

  const merged = { ...incoming, ...carried };
  const copy = next.slice();
  // inserción ordenada (lo normal es que vaya al final)
  let pos = copy.length;
  while (pos > 0 && byTime(copy[pos - 1]!, merged) > 0) pos--;
  copy.splice(pos, 0, merged);
  return { list: copy, stored: merged, removed };
}

/** true si el contacto entrante debe sustituir al guardado. */
export function contactIsNewer(cur: LocalContact | undefined, incoming: { seq: number }): boolean {
  return !cur || incoming.seq >= cur.seq;
}

export function displayName(c: LocalContact): string {
  return c.aliasName || c.profileData?.name || c.profileData?.username || c.profileData?.phone || 'Sin nombre';
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '#';
  const first = parts[0]!;
  if (parts.length === 1) return [...first].slice(0, 2).join('').toUpperCase();
  return ([...first][0]! + [...parts[parts.length - 1]!][0]!).toUpperCase();
}

/** Último mensaje visible de la lista. */
export function lastVisible(list: LocalMessage[] | undefined): LocalMessage | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (!list[i]!.dismissed) return list[i];
  return undefined;
}

export function previewText(m: LocalMessage | undefined): string {
  if (!m) return '';
  if (m.decryptError) return 'No se pudo descifrar';
  const p = m.payload;
  if (!p) return '';
  const cap = p.text ? ` ${p.text}` : '';
  switch (p.kind) {
    case 'text':
      return p.text ?? '';
    case 'image':
      return `📷 Foto${cap}`;
    case 'video':
      return `🎬 Video${cap}`;
    case 'audio':
      return `🎤 Audio${cap}`;
    case 'file':
      return `📄 ${p.attachment?.name ?? 'Archivo'}${cap}`;
    case 'sticker':
      return 'Sticker';
    case 'location':
      return '📍 Ubicación';
    default:
      return 'Mensaje no compatible';
  }
}

export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** WhatsApp: la ventana de 24 h está cerrada si el último entrante es más viejo (o no hay). */
export function waWindowClosed(lastInboundAt: number | null, now = Date.now()): boolean {
  return lastInboundAt === null || now - lastInboundAt > WA_WINDOW_MS;
}

export function kindForMime(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}
