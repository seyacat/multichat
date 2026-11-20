// Motor de la app: sesión, clave de cuenta, sincronización, envío, blobs y vínculo de dispositivos.
import { batch } from '@preact/signals';
import { createApi, getServer, HttpError, wsUrl, type Api } from './api';
import { b64uDecode, b64uEncode, bytesEqual } from './b64u';
import {
  decryptBlob,
  generateKeyPair,
  openBytes,
  openJson,
  parseRecoveryText,
  publicFromPrivate,
  sealBytes,
  sealJson,
} from './crypto';
import * as db from './db';
import { contactIsNewer, kindForMime, localId, mergeMessage } from './merge';
import * as S from './store';
import type {
  Contact,
  ContactProfile,
  Device,
  Integration,
  LocalContact,
  LocalMessage,
  Message,
  MessagePayload,
  Session,
  User,
  WsEvent,
} from './types';
import { Socket } from './ws';

export const PAGE_LIMIT = 1000;

export interface EngineOptions {
  fetch?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  base?: () => string;
}

export interface LinkInfo {
  id: string;
  ephemeralPublicKey: string;
  deviceName: string;
  platform: string;
  status: 'pending' | 'approved' | 'expired';
  sealedKey?: string;
}

export class Engine {
  readonly api: Api;
  private socket: Socket;
  private syncRunning: Promise<void> | null = null;
  private syncAgain = false;
  private contactsSeq = 0;
  private messagesSeq = 0;
  private blobUrls = new Map<string, string>();
  private blobLoading = new Map<string, Promise<string>>();
  /** Archivos de envíos en curso, por clientId (vista previa y reintento). */
  readonly localFiles = new Map<string, File>();
  private linkPoll: ReturnType<typeof setInterval> | null = null;
  /** Cola de escrituras en IndexedDB: se aplican en el mismo orden que las fusiones en memoria. */
  private dbQueue: Promise<void> = Promise.resolve();
  /** Contacto abierto en pantalla (para marcar leído lo que llega). */
  openContactId: string | null = null;
  linkListeners = new Set<(ok: boolean, err?: string) => void>();

  constructor(opts: EngineOptions = {}) {
    this.api = createApi({
      base: opts.base ?? getServer,
      getSession: () => S.session.value,
      setSession: s => this.saveSession(s),
      onAuthLost: () => void this.localLogout('La sesión caducó. Vuelve a entrar.'),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.socket = new Socket({
      url: async () => {
        // asegura un token fresco (refresca en 401) antes de abrir el WS
        await this.refreshMe();
        const s = S.session.value;
        if (!s) throw new Error('sin sesión');
        return wsUrl((opts.base ?? getServer)(), s.accessToken);
      },
      onEvent: e => void this.onWsEvent(e),
      onOpen: () => void this.sync(),
      onState: st => (S.wsState.value = st),
      ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
    });
  }

  // ---------------- arranque y sesión ----------------

  async boot(): Promise<void> {
    try {
      const session = await db.kvGet('session');
      if (session) {
        S.session.value = session;
        const key = await db.kvGet('accountKey');
        if (key) S.accountKey.value = new Uint8Array(key);
        this.contactsSeq = (await db.kvGet('contactsSeq')) ?? 0;
        this.messagesSeq = (await db.kvGet('messagesSeq')) ?? 0;
        if (S.accountKey.value) await this.loadFromDb();
        this.socket.start();
        void this.refreshMe().catch(() => undefined);
        const pl = await db.kvGet('pendingLink');
        if (pl && !S.accountKey.value && pl.expiresAt > Date.now()) this.startLinkPolling(pl.id);
      }
    } finally {
      S.booted.value = true;
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.socket.kick());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.socket.kick();
      });
    }
  }

  private async saveSession(s: Session): Promise<void> {
    S.session.value = s;
    await db.kvSet('session', s);
  }

  private async setUser(u: User): Promise<void> {
    const s = S.session.value;
    if (!s) return;
    await this.saveSession({ ...s, user: u });
  }

  async auth(mode: 'login' | 'register', email: string, password: string, deviceName: string): Promise<void> {
    const s = await this.api.post<Session>(
      `/api/auth/${mode}`,
      { email, password, deviceName, platform: 'web' },
      false,
    );
    // otra cuenta en este navegador: limpiar todo lo local
    const prev = await db.kvGet('session');
    if (prev && prev.user.id !== s.user.id) await db.clearAll();
    await this.saveSession(s);
    this.contactsSeq = (await db.kvGet('contactsSeq')) ?? 0;
    this.messagesSeq = (await db.kvGet('messagesSeq')) ?? 0;
    const key = await db.kvGet('accountKey');
    if (key) await this.adoptKey(new Uint8Array(key), false);
    this.socket.start();
  }

  /** GET /api/me: actualiza usuario y dispositivos; comprueba que la clave local coincide. */
  async refreshMe(): Promise<void> {
    const me = await this.api.get<{ user: User; device: Device; devices: Device[] }>('/api/me');
    S.devices.value = me.devices;
    const s = S.session.value;
    if (s && (s.user.accountPublicKey !== me.user.accountPublicKey || s.device.name !== me.device.name)) {
      await this.saveSession({ ...s, user: me.user, device: me.device });
    }
    const key = S.accountKey.value;
    if (key && me.user.accountPublicKey) {
      const pub = b64uEncode(await publicFromPrivate(key));
      if (pub !== me.user.accountPublicKey) {
        // la clave local no es la de la cuenta: se descarta y se vuelve a vincular
        await this.discardKey();
        S.showToast('La clave de este dispositivo no coincide con la de la cuenta. Vincúlalo de nuevo.', 'error');
      }
    }
  }

  async logout(): Promise<void> {
    try {
      await this.disablePush().catch(() => undefined);
      await this.api.post('/api/auth/logout');
    } catch {
      /* aunque falle, se cierra en local */
    }
    await this.localLogout();
  }

  async localLogout(reason?: string): Promise<void> {
    this.socket.stop();
    this.stopLinkPolling();
    for (const u of this.blobUrls.values()) URL.revokeObjectURL(u);
    this.blobUrls.clear();
    this.contactsSeq = 0;
    this.messagesSeq = 0;
    await db.clearAll();
    S.resetStore();
    if (reason) S.showToast(reason, 'error');
  }

  // ---------------- clave de cuenta ----------------

  private async adoptKey(priv: Uint8Array, persist = true): Promise<void> {
    const user = S.session.value?.user;
    const pub = b64uEncode(await publicFromPrivate(priv));
    if (user?.accountPublicKey && user.accountPublicKey !== pub) {
      await db.kvDel('accountKey');
      throw new Error('La clave no corresponde a esta cuenta.');
    }
    if (persist) await db.kvSet('accountKey', new Uint8Array(priv));
    S.accountKey.value = new Uint8Array(priv);
    await this.loadFromDb();
    void this.sync();
  }

  private async discardKey(): Promise<void> {
    await db.kvDel('accountKey');
    await db.clearAll();
    const s = S.session.value;
    if (s) await db.kvSet('session', s);
    this.contactsSeq = 0;
    this.messagesSeq = 0;
    batch(() => {
      S.accountKey.value = null;
      S.contacts.value = new Map();
      S.messages.value = new Map();
    });
  }

  /** Primer dispositivo: genera la clave de cuenta y la sube. */
  async generateAccountKey(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair();
    const pub = b64uEncode(publicKey);
    try {
      await this.api.put('/api/account/key', { publicKey: pub });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        await this.refreshMe();
        throw new Error('La cuenta ya tiene clave. Vincula este dispositivo o importa la clave de recuperación.');
      }
      throw e;
    }
    const u = S.session.value!.user;
    await this.setUser({ ...u, accountPublicKey: pub });
    await this.adoptKey(privateKey);
  }

  async importRecovery(text: string): Promise<void> {
    const priv = parseRecoveryText(text);
    if (!priv) throw new Error('Formato no válido. Debe ser multichat-key:…');
    const u = S.session.value!.user;
    if (!u.accountPublicKey) {
      // cuenta sin clave: se sube la pública de la clave importada
      const pub = b64uEncode(await publicFromPrivate(priv));
      await this.api.put('/api/account/key', { publicKey: pub });
      await this.setUser({ ...u, accountPublicKey: pub });
    }
    await this.adoptKey(priv);
  }

  async accountPublicKey(): Promise<Uint8Array> {
    const k = S.accountKey.value;
    if (!k) throw new Error('Sin clave de cuenta');
    return publicFromPrivate(k);
  }

  // ---------------- vínculo de dispositivos ----------------

  /** Dispositivo nuevo: crea el vínculo y espera la clave. Devuelve id, pública efímera y caducidad. */
  async startLink(): Promise<{ id: string; ephemeralPublicKey: string; expiresAt: number }> {
    const { privateKey, publicKey } = await generateKeyPair();
    const ephemeralPublicKey = b64uEncode(publicKey);
    const r = await this.api.post<{ id: string; expiresAt: number }>('/api/link', { ephemeralPublicKey });
    await db.kvSet('pendingLink', { id: r.id, ephemeralPrivateKey: privateKey, ephemeralPublicKey, expiresAt: r.expiresAt });
    this.startLinkPolling(r.id);
    return { id: r.id, ephemeralPublicKey, expiresAt: r.expiresAt };
  }

  async currentLink(): Promise<{ id: string; ephemeralPublicKey: string; expiresAt: number } | null> {
    const pl = await db.kvGet('pendingLink');
    if (!pl || pl.expiresAt <= Date.now()) return null;
    return { id: pl.id, ephemeralPublicKey: pl.ephemeralPublicKey, expiresAt: pl.expiresAt };
  }

  private startLinkPolling(id: string): void {
    this.stopLinkPolling();
    this.linkPoll = setInterval(() => {
      void (async () => {
        try {
          const l = await this.api.get<LinkInfo>(`/api/link/${encodeURIComponent(id)}`);
          if (l.status === 'approved' && l.sealedKey) await this.completeLink(l.id, l.sealedKey);
          else if (l.status === 'expired') {
            this.stopLinkPolling();
            this.emitLink(false, 'El vínculo caducó. Genera otro código.');
          }
        } catch {
          /* se reintenta en el siguiente sondeo */
        }
      })();
    }, 3000);
  }

  stopLinkPolling(): void {
    if (this.linkPoll) clearInterval(this.linkPoll);
    this.linkPoll = null;
  }

  private emitLink(ok: boolean, err?: string): void {
    for (const l of this.linkListeners) l(ok, err);
  }

  async completeLink(id: string, sealedKey: string): Promise<void> {
    const pl = await db.kvGet('pendingLink');
    if (!pl || pl.id !== id || S.accountKey.value) return;
    this.stopLinkPolling();
    try {
      const priv = await openBytes(b64uDecode(sealedKey), new Uint8Array(pl.ephemeralPrivateKey));
      if (priv.length !== 32) throw new Error('Clave recibida no válida');
      await this.refreshMe().catch(() => undefined);
      await this.adoptKey(priv);
      await db.kvDel('pendingLink');
      this.emitLink(true);
    } catch (e) {
      this.emitLink(false, e instanceof Error ? e.message : String(e));
    }
  }

  /** Dispositivo ya vinculado: consulta el vínculo escaneado y comprueba la pública. */
  async inspectLink(id: string, ephemeralPublicKey: string): Promise<LinkInfo> {
    const l = await this.api.get<LinkInfo>(`/api/link/${encodeURIComponent(id)}`);
    if (l.ephemeralPublicKey !== ephemeralPublicKey) {
      throw new Error('La clave del código no coincide con la del servidor. Vínculo cancelado.');
    }
    if (l.status !== 'pending') throw new Error(l.status === 'expired' ? 'El vínculo caducó.' : 'El vínculo ya se usó.');
    return l;
  }

  async approveLink(id: string, ephemeralPublicKey: string): Promise<void> {
    const key = S.accountKey.value;
    if (!key) throw new Error('Sin clave de cuenta');
    const sealed = await sealBytes(key, b64uDecode(ephemeralPublicKey));
    await this.api.post(`/api/link/${encodeURIComponent(id)}/approve`, { sealedKey: b64uEncode(sealed) });
    void this.refreshMe().catch(() => undefined);
  }

  // ---------------- descifrado ----------------

  async decryptContact(c: Contact): Promise<LocalContact> {
    const key = S.accountKey.value!;
    let profileData: ContactProfile | null = null;
    let aliasName: string | null = null;
    try {
      profileData = await openJson<ContactProfile>(c.profile, key);
    } catch {
      profileData = null;
    }
    if (c.alias) {
      try {
        aliasName = (await openJson<{ name: string }>(c.alias, key)).name || null;
      } catch {
        aliasName = null;
      }
    }
    return { ...c, profileData, aliasName };
  }

  async decryptMessage(m: Message): Promise<LocalMessage> {
    try {
      const payload = await openJson<MessagePayload>(m.envelope, S.accountKey.value!);
      return { ...m, payload };
    } catch {
      return { ...m, payload: null, decryptError: !!m.envelope };
    }
  }

  // ---------------- carga y fusión ----------------

  async loadFromDb(): Promise<void> {
    const [cs, ms] = await Promise.all([db.getAll<LocalContact>('contacts'), db.getAll<LocalMessage>('messages')]);
    const cmap = new Map(cs.map(c => [c.id, c]));
    const byContact = new Map<string, LocalMessage[]>();
    const staleLocals: LocalMessage[] = [];
    for (const m0 of ms) {
      let m = m0;
      if (m.local && m.status === 'pending' && !this.localFiles.has(m.clientId ?? '')) {
        // el envío murió con la recarga
        m = { ...m, status: 'failed', error: 'Envío interrumpido', progress: undefined };
        staleLocals.push(m);
      }
      const arr = byContact.get(m.contactId) ?? [];
      arr.push(m);
      byContact.set(m.contactId, arr);
    }
    for (const arr of byContact.values()) arr.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    await db.saveMessages(staleLocals);
    batch(() => {
      S.contacts.value = cmap;
      S.messages.value = byContact;
    });
  }

  async applyContacts(list: Contact[]): Promise<void> {
    if (list.length === 0 || !S.accountKey.value) return;
    const cur = S.contacts.value;
    const fresh: LocalContact[] = [];
    for (const c of list) {
      if (!contactIsNewer(cur.get(c.id), c)) continue;
      fresh.push(await this.decryptContact(c));
    }
    if (fresh.length === 0) return;
    // re-comprobar tras los await: otro evento pudo traer una versión más nueva
    const next = new Map(S.contacts.value);
    const keep = fresh.filter(c => contactIsNewer(next.get(c.id), c));
    for (const c of keep) next.set(c.id, c);
    S.contacts.value = next;
    await this.enqueue(() => db.saveContacts(keep));
  }

  async applyMessages(list: Message[]): Promise<LocalMessage[]> {
    if (list.length === 0 || !S.accountKey.value) return [];
    const dec = await Promise.all(list.map(m => this.decryptMessage(m)));
    return this.applyLocalMessages(dec);
  }

  /** Fusiona mensajes ya descifrados (o locales) en memoria y en IndexedDB. */
  async applyLocalMessages(list: LocalMessage[]): Promise<LocalMessage[]> {
    const next = new Map(S.messages.value);
    const toSave: LocalMessage[] = [];
    const toRemove: string[] = [];
    const stored: LocalMessage[] = [];
    for (const m of list) {
      const r = mergeMessage(next.get(m.contactId) ?? [], m);
      next.set(m.contactId, r.list);
      toRemove.push(...r.removed);
      if (r.stored) {
        toSave.push(r.stored);
        stored.push(r.stored);
      }
    }
    S.messages.value = next;
    await this.enqueue(async () => {
      await db.deleteMany('messages', toRemove);
      await db.saveMessages(toSave);
    });
    return stored;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const p = this.dbQueue.then(fn);
    this.dbQueue = p.catch(() => undefined);
    return p;
  }

  private async setCursor(kind: 'contactsSeq' | 'messagesSeq', seq: number): Promise<void> {
    if (kind === 'contactsSeq') {
      if (seq <= this.contactsSeq) return;
      this.contactsSeq = seq;
    } else {
      if (seq <= this.messagesSeq) return;
      this.messagesSeq = seq;
    }
    await db.kvSet(kind, seq);
  }

  get cursors(): { contactsSeq: number; messagesSeq: number } {
    return { contactsSeq: this.contactsSeq, messagesSeq: this.messagesSeq };
  }

  /** Sincroniza contactos y mensajes desde el último seq visto. Coalesce llamadas concurrentes. */
  sync(): Promise<void> {
    if (!S.accountKey.value || !S.session.value) return Promise.resolve();
    if (this.syncRunning) {
      this.syncAgain = true;
      return this.syncRunning;
    }
    this.syncRunning = (async () => {
      S.syncing.value = true;
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 0)) console.warn('sync', e);
      } finally {
        S.syncing.value = false;
        this.syncRunning = null;
      }
    })();
    return this.syncRunning;
  }

  private async syncOnce(): Promise<void> {
    const [ints, cs] = await Promise.all([
      this.api.get<Integration[]>('/api/integrations'),
      this.api.get<Contact[]>(this.contactsSeq ? `/api/contacts?since=${this.contactsSeq}` : '/api/contacts'),
    ]);
    S.integrations.value = ints;
    await this.applyContacts(cs);
    await this.setCursor('contactsSeq', cs.reduce((n, c) => Math.max(n, c.seq), 0));

    let more = true;
    while (more) {
      const r = await this.api.get<{ messages: Message[]; more: boolean }>(
        `/api/messages?since=${this.messagesSeq}&limit=${PAGE_LIMIT}`,
      );
      await this.applyMessages(r.messages);
      const max = r.messages.reduce((n, m) => Math.max(n, m.seq), 0);
      await this.setCursor('messagesSeq', max);
      more = r.more && r.messages.length > 0;
    }
  }

  async onWsEvent(e: WsEvent): Promise<void> {
    switch (e.type) {
      case 'message': {
        if (!S.accountKey.value) return;
        await this.applyMessages([e.message]);
        await this.setCursor('messagesSeq', e.message.seq);
        if (e.message.direction === 'in' && this.openContactId === e.message.contactId && isVisible()) {
          void this.markRead(e.message.contactId, true);
        }
        break;
      }
      case 'contact':
        if (!S.accountKey.value) return;
        await this.applyContacts([e.contact]);
        await this.setCursor('contactsSeq', e.contact.seq);
        break;
      case 'contact_deleted':
        await this.removeContactLocal(e.id);
        break;
      case 'integration': {
        const list = S.integrations.value.filter(i => i.id !== e.integration.id);
        list.push(e.integration);
        list.sort((a, b) => a.createdAt - b.createdAt);
        S.integrations.value = list;
        break;
      }
      case 'integration_deleted': {
        S.integrations.value = S.integrations.value.filter(i => i.id !== e.id);
        const gone = [...S.contacts.value.values()].filter(c => c.integrationId === e.id);
        for (const c of gone) await this.removeContactLocal(c.id);
        break;
      }
      case 'link':
        await this.completeLink(e.id, e.sealedKey);
        break;
      case 'pong':
        break;
    }
  }

  // ---------------- contactos ----------------

  async removeContactLocal(id: string): Promise<void> {
    const c = new Map(S.contacts.value);
    c.delete(id);
    const m = new Map(S.messages.value);
    m.delete(id);
    batch(() => {
      S.contacts.value = c;
      S.messages.value = m;
    });
    await this.enqueue(async () => {
      await db.deleteMany('contacts', [id]);
      await db.deleteMessagesOfContact(id);
    });
  }

  async patchContact(
    id: string,
    body: Partial<{ status: Contact['status']; alias: string | null; muted: boolean; hidePreview: boolean; read: true }>,
  ): Promise<void> {
    const c = await this.api.patch<Contact>(`/api/contacts/${encodeURIComponent(id)}`, body);
    await this.applyContacts([c]);
  }

  async setAlias(id: string, name: string): Promise<void> {
    const clean = name.trim();
    const alias = clean ? await sealJson({ name: clean }, await this.accountPublicKey()) : null;
    await this.patchContact(id, { alias });
  }

  async markRead(id: string, force = false): Promise<void> {
    const c = S.contacts.value.get(id);
    if (!c || (!force && c.unread === 0)) return;
    try {
      await this.patchContact(id, { read: true });
    } catch {
      /* no crítico */
    }
  }

  async deleteContact(id: string): Promise<void> {
    await this.api.del(`/api/contacts/${encodeURIComponent(id)}`);
    await this.removeContactLocal(id);
  }

  /** Mensajes anteriores (paginación hacia atrás). Devuelve cuántos llegaron. */
  async loadOlder(contactId: string, limit = 50): Promise<number> {
    const list = S.messages.value.get(contactId) ?? [];
    const oldest = list.find(m => !m.local);
    const q = oldest ? `before=${oldest.createdAt}&limit=${limit}` : `limit=${limit}`;
    const r = await this.api.get<Message[]>(`/api/contacts/${encodeURIComponent(contactId)}/messages?${q}`);
    await this.applyMessages(r);
    return r.length;
  }

  // ---------------- envío ----------------

  private optimistic(contactId: string, clientId: string, payload: MessagePayload): LocalMessage {
    const now = Date.now();
    return {
      id: localId(clientId),
      contactId,
      direction: 'out',
      status: 'pending',
      error: null,
      envelope: '',
      clientId,
      seq: 0,
      createdAt: now,
      updatedAt: now,
      payload,
      local: true,
    };
  }

  async sendText(contactId: string, text: string): Promise<void> {
    const clientId = crypto.randomUUID();
    const opt = this.optimistic(contactId, clientId, {
      v: 1,
      kind: 'text',
      text,
      senderName: null,
      location: null,
      attachment: null,
    });
    await this.applyLocalMessages([opt]);
    try {
      const m = await this.api.post<Message>(`/api/contacts/${encodeURIComponent(contactId)}/messages`, { clientId, text });
      await this.applyServerReply(m, opt);
    } catch (e) {
      await this.failLocal(opt, e);
    }
  }

  async sendFile(contactId: string, file: File, caption = ''): Promise<void> {
    const clientId = crypto.randomUUID();
    const kind = kindForMime(file.type);
    this.localFiles.set(clientId, file);
    let opt = this.optimistic(contactId, clientId, {
      v: 1,
      kind,
      text: caption || null,
      senderName: null,
      location: null,
      attachment: { blobId: '', fileKey: '', mime: file.type || 'application/octet-stream', name: file.name, size: file.size },
    });
    opt.progress = 0;
    await this.applyLocalMessages([opt]);
    const form = new FormData();
    form.append('clientId', clientId);
    if (caption) form.append('text', caption);
    form.append('kind', kind);
    form.append('file', file, file.name);
    let lastPaint = 0;
    try {
      const m = await this.api.upload<Message>(`/api/contacts/${encodeURIComponent(contactId)}/messages`, form, {
        onProgress: f => {
          const now = Date.now();
          if (now - lastPaint < 100 && f < 1) return;
          lastPaint = now;
          const cur = (S.messages.value.get(contactId) ?? []).find(x => x.id === opt.id);
          if (!cur) return;
          opt = { ...cur, progress: f };
          const next = new Map(S.messages.value);
          next.set(
            contactId,
            (next.get(contactId) ?? []).map(x => (x.id === opt.id ? opt : x)),
          );
          S.messages.value = next;
        },
      });
      await this.applyServerReply(m, opt);
    } catch (e) {
      await this.failLocal(opt, e);
    }
  }

  private async applyServerReply(m: Message, opt: LocalMessage): Promise<void> {
    const dec = await this.decryptMessage(m);
    // si el 202 no trae sobre descifrable, conservar el payload optimista
    if (!dec.payload) {
      dec.payload = opt.payload;
      dec.decryptError = false;
    }
    await this.applyLocalMessages([dec]);
  }

  private async failLocal(opt: LocalMessage, e: unknown): Promise<void> {
    const cur = (S.messages.value.get(opt.contactId) ?? []).find(x => x.id === opt.id);
    if (!cur) return;
    await this.applyLocalMessages([
      { ...cur, status: 'failed', error: e instanceof Error ? e.message : String(e), progress: undefined },
    ]);
  }

  /** Reintenta un mensaje fallido: lo oculta y envía uno nuevo con el mismo contenido. */
  async retry(m: LocalMessage): Promise<void> {
    const p = m.payload;
    if (!p) throw new Error('No se puede reintentar: contenido desconocido');
    let file: File | undefined;
    if (p.attachment) {
      file = m.clientId ? this.localFiles.get(m.clientId) : undefined;
      if (!file && p.attachment.blobId) {
        const url = await this.blobUrl(p.attachment.blobId, p.attachment.fileKey, p.attachment.mime);
        const blob = await (await fetch(url)).blob();
        file = new File([blob], p.attachment.name, { type: p.attachment.mime });
      }
      if (!file) throw new Error('El archivo ya no está disponible. Adjúntalo de nuevo.');
    }
    // ocultar el fallido
    if (m.local) {
      void this.enqueue(() => db.deleteMany('messages', [m.id]));
      const next = new Map(S.messages.value);
      next.set(
        m.contactId,
        (next.get(m.contactId) ?? []).filter(x => x.id !== m.id),
      );
      S.messages.value = next;
    } else {
      await this.applyLocalMessages([{ ...m, dismissed: true }]);
    }
    if (m.clientId) this.localFiles.delete(m.clientId);
    if (file) await this.sendFile(m.contactId, file, p.text ?? '');
    else await this.sendText(m.contactId, p.text ?? '');
  }

  // ---------------- blobs ----------------

  cachedBlobUrl(blobId: string): string | undefined {
    return this.blobUrls.get(blobId);
  }

  /** Descarga, descifra (MCB1) y devuelve un objectURL. Cache en memoria e IndexedDB. */
  blobUrl(blobId: string, fileKey: string, mime: string): Promise<string> {
    const hit = this.blobUrls.get(blobId);
    if (hit) return Promise.resolve(hit);
    const inflight = this.blobLoading.get(blobId);
    if (inflight) return inflight;
    const p = (async () => {
      let rec = await db.getOne<db.BlobRecord>('blobs', blobId);
      if (!rec) {
        const enc = await this.api.bytes(`/api/blobs/${encodeURIComponent(blobId)}`);
        const plain = await decryptBlob(enc, b64uDecode(fileKey));
        rec = { blobId, mime, data: new Blob([plain], { type: mime || 'application/octet-stream' }) };
        await db.putMany('blobs', [rec]);
      }
      const url = URL.createObjectURL(rec.data);
      this.blobUrls.set(blobId, url);
      return url;
    })().finally(() => this.blobLoading.delete(blobId));
    this.blobLoading.set(blobId, p);
    return p;
  }

  // ---------------- push ----------------

  async enablePush(): Promise<void> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Este navegador no admite notificaciones push.');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permiso de notificaciones denegado.');
    const { publicKey } = await this.api.get<{ publicKey: string | null }>('/api/push/vapid');
    if (!publicKey) throw new Error('El servidor no tiene push configurado (sin clave VAPID).');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const want = b64uDecode(publicKey);
    if (sub) {
      const cur = sub.options.applicationServerKey;
      if (!cur || !bytesEqual(new Uint8Array(cur), want)) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    await this.api.put('/api/devices/me/push', { kind: 'webpush', subscription: sub.toJSON() });
    await db.kvSet('pushEnabled', true);
    void this.refreshMe().catch(() => undefined);
  }

  async disablePush(): Promise<void> {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe();
    }
    await this.api.put('/api/devices/me/push', { kind: null });
    await db.kvSet('pushEnabled', false);
    void this.refreshMe().catch(() => undefined);
  }
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export const engine = new Engine();
