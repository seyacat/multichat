// Estado global de la app (señales).
import { computed, signal } from '@preact/signals';
import type { Device, Integration, LocalContact, LocalMessage, Session, User } from './types';

export const booted = signal(false);
export const session = signal<Session | null>(null);
export const accountKey = signal<Uint8Array | null>(null);
export const devices = signal<Device[]>([]);
export const contacts = signal<ReadonlyMap<string, LocalContact>>(new Map());
export const messages = signal<ReadonlyMap<string, LocalMessage[]>>(new Map());
export const integrations = signal<Integration[]>([]);
export const wsState = signal<'off' | 'connecting' | 'open'>('off');
export const syncing = signal(false);
export const toast = signal<{ text: string; kind: 'error' | 'info'; id: number } | null>(null);

export const user = computed<User | null>(() => session.value?.user ?? null);

export const phase = computed<'boot' | 'login' | 'setup' | 'ready'>(() => {
  if (!booted.value) return 'boot';
  if (!session.value) return 'login';
  if (!accountKey.value) return 'setup';
  return 'ready';
});

export const integrationById = computed(() => new Map(integrations.value.map(i => [i.id, i])));

let toastSeq = 0;
export function showToast(text: string, kind: 'error' | 'info' = 'info'): void {
  const id = ++toastSeq;
  toast.value = { text, kind, id };
  setTimeout(() => {
    if (toast.value?.id === id) toast.value = null;
  }, kind === 'error' ? 6000 : 3000);
}

export function showError(e: unknown): void {
  showToast(e instanceof Error ? e.message : String(e), 'error');
}

export function resetStore(): void {
  session.value = null;
  accountKey.value = null;
  devices.value = [];
  contacts.value = new Map();
  messages.value = new Map();
  integrations.value = [];
  wsState.value = 'off';
}
