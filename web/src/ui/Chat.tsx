// Conversación: burbujas, adjuntos, envío y avisos.
import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { engine } from '../lib/engine';
import { dayLabel, fileSize, sameDay, timeHM } from '../lib/format';
import { displayName, waWindowClosed } from '../lib/merge';
import { contacts, integrationById, messages, showError } from '../lib/store';
import type { Attachment, LocalContact, LocalMessage, MessageStatus } from '../lib/types';
import { go } from '../router';
import { Avatar, Empty, Modal, Spinner, hueFor } from './common';
import { Icon, PLATFORM_NAME } from './icons';

export function StatusTicks({ status }: { status: MessageStatus }) {
  switch (status) {
    case 'pending':
      return <Icon name="clock" size={14} class="tick" />;
    case 'sent':
      return <Icon name="check" size={15} class="tick" />;
    case 'delivered':
      return <Icon name="checks" size={15} class="tick" />;
    case 'read':
      return <Icon name="checks" size={15} class="tick read" />;
    case 'failed':
      return <Icon name="alert" size={14} class="tick failed" />;
    default:
      return null;
  }
}

const STATUS_LABEL: Record<MessageStatus, string> = {
  received: 'Recibido',
  pending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Falló',
};

export function Chat({ id }: { id: string }) {
  const c = contacts.value.get(id);
  const list = (messages.value.get(id) ?? []).filter(m => !m.dismissed);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [loadingOld, setLoadingOld] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);

  // abrir: marcar leído y registrar el chat abierto
  useEffect(() => {
    engine.openContactId = id;
    stick.current = true;
    setNoMore(false);
    void engine.markRead(id);
    const onVis = () => document.visibilityState === 'visible' && void engine.markRead(id);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (engine.openContactId === id) engine.openContactId = null;
    };
  }, [id]);

  useEffect(() => {
    if (c && c.unread > 0 && document.visibilityState === 'visible') void engine.markRead(id);
  }, [c?.unread]);

  // pegado al fondo cuando llegan mensajes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length, id, list[list.length - 1]?.progress]);

  if (!c) {
    return (
      <div class="pane">
        <Empty icon="inbox" title="Chat no encontrado" />
      </div>
    );
  }

  const integ = integrationById.value.get(c.integrationId);
  const platform = integ?.type ?? c.profileData?.platform;
  const name = displayName(c);
  const isGroup = c.kind === 'group';
  const canSend = c.status === 'accepted';

  async function loadOlder() {
    if (loadingOld || noMore) return;
    const el = scroller.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setLoadingOld(true);
    try {
      const n = await engine.loadOlder(id);
      if (n === 0) setNoMore(true);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop;
      });
    } catch (e) {
      showError(e);
    } finally {
      setLoadingOld(false);
    }
  }

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40) void loadOlder();
  }

  function addFiles(fl: FileList | File[] | null | undefined) {
    if (!fl || !canSend) return;
    const arr = Array.from(fl);
    if (arr.length) setFiles(f => [...f, ...arr]);
  }

  return (
    <div
      class={`pane chat ${dragging ? 'dragging' : ''}`}
      onDragOver={e => {
        if (!canSend || !e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer?.files);
      }}
    >
      <header class="bar chat-bar">
        <button class="icon-btn back-btn" onClick={() => go(c.status === 'pending' ? '/requests' : c.status === 'accepted' ? '/' : '/archived')} aria-label="Volver">
          <Icon name="back" />
        </button>
        <a class="chat-bar-who" href={`#/contact/${encodeURIComponent(id)}`}>
          <Avatar name={name} seed={c.id} platform={platform} size={38} group={isGroup} />
          <div class="bar-title">
            <h1>{name}</h1>
            <div class="bar-sub">
              {integ && (
                <span class="chat-integ inline" style={{ '--ic': integ.color }}>
                  <span class="integ-dot" />
                  {integ.name}
                </span>
              )}
              {platform && <span class="muted"> · {PLATFORM_NAME[platform]}</span>}
              {c.muted && <Icon name="bell-off" size={13} class="muted" />}
            </div>
          </div>
        </a>
        <div class="bar-actions">
          <button class="icon-btn" onClick={() => go(`/contact/${encodeURIComponent(id)}`)} aria-label="Información del contacto">
            <Icon name="more" />
          </button>
        </div>
      </header>

      <div class="messages" ref={scroller} onScroll={onScroll}>
        <div class="older">
          {loadingOld ? (
            <Spinner />
          ) : noMore ? (
            <span class="muted small">Inicio de la conversación</span>
          ) : (
            <button class="link-btn small" onClick={() => void loadOlder()}>
              Cargar anteriores
            </button>
          )}
        </div>
        {list.map((m, i) => {
          const prev = list[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
          const showSender =
            isGroup && m.direction === 'in' && !!m.payload?.senderName && (newDay || prev?.payload?.senderName !== m.payload.senderName || prev?.direction !== 'in');
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div class="day-sep">
                  <span>{dayLabel(m.createdAt)}</span>
                </div>
              )}
              <Bubble m={m} showSender={showSender} onOpenImage={(url, n) => setViewer({ url, name: n })} />
            </Fragment>
          );
        })}
        {list.length === 0 && <div class="muted center pad">Sin mensajes todavía</div>}
      </div>

      <ChatNotices c={c} platformIsWa={platform === 'whatsapp'} />

      {canSend ? (
        <Composer
          contactId={id}
          files={files}
          setFiles={setFiles}
          addFiles={addFiles}
        />
      ) : (
        <StatusBar c={c} />
      )}

      {dragging && (
        <div class="drop-hint">
          <Icon name="attach" size={32} />
          Suelta para adjuntar
        </div>
      )}
      {viewer && (
        <Modal title={viewer.name} onClose={() => setViewer(null)} wide>
          <div class="viewer">
            <img src={viewer.url} alt={viewer.name} />
            <a class="btn" href={viewer.url} download={viewer.name}>
              <Icon name="download" size={18} /> Descargar
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ChatNotices({ c, platformIsWa }: { c: LocalContact; platformIsWa: boolean }) {
  if (platformIsWa && c.status === 'accepted' && c.kind === 'direct' && waWindowClosed(c.lastInboundAt)) {
    return (
      <div class="notice warn">
        <Icon name="clock" size={18} />
        <span>
          Han pasado más de 24 h desde su último mensaje. WhatsApp solo permite responder dentro de esa ventana (fuera de ella
          hacen falta plantillas): es probable que el envío falle.
        </span>
      </div>
    );
  }
  return null;
}

function StatusBar({ c }: { c: LocalContact }) {
  if (c.status === 'pending') {
    return (
      <div class="status-bar">
        <span>Este contacto aún no está aceptado. Acéptalo para responder.</span>
        <div class="row gap">
          <button class="btn primary small" onClick={() => engine.patchContact(c.id, { status: 'accepted' }).catch(showError)}>
            Aceptar
          </button>
          <button class="btn danger small" onClick={() => engine.patchContact(c.id, { status: 'blocked' }).catch(showError)}>
            Bloquear
          </button>
        </div>
      </div>
    );
  }
  if (c.status === 'blocked') {
    return (
      <div class="status-bar">
        <span>Contacto bloqueado: lo que envíe se descarta.</span>
        <button class="btn small" onClick={() => engine.patchContact(c.id, { status: 'accepted' }).catch(showError)}>
          Desbloquear
        </button>
      </div>
    );
  }
  return (
    <div class="status-bar">
      <span>Chat archivado.</span>
      <button class="btn small" onClick={() => engine.patchContact(c.id, { status: 'accepted' }).catch(showError)}>
        Desarchivar
      </button>
    </div>
  );
}

function Bubble({ m, showSender, onOpenImage }: { m: LocalMessage; showSender: boolean; onOpenImage: (url: string, name: string) => void }) {
  const p = m.payload;
  const out = m.direction === 'out';
  const media = p && (p.kind === 'image' || p.kind === 'sticker' || p.kind === 'video') && p.attachment;
  return (
    <div class={`bubble-row ${out ? 'out' : 'in'}`}>
      <div class={`bubble ${media ? 'media' : ''} ${m.status === 'failed' ? 'failed' : ''} ${p?.kind === 'sticker' ? 'sticker' : ''}`}>
        {showSender && p?.senderName && (
          <div class="sender" style={{ color: `hsl(${hueFor(p.senderName)} 55% var(--sender-l))` }}>
            {p.senderName}
          </div>
        )}
        {m.decryptError ? (
          <div class="muted italic">
            <Icon name="alert" size={14} /> No se pudo descifrar este mensaje
          </div>
        ) : !p ? (
          <div class="muted italic">…</div>
        ) : (
          <>
            {p.attachment && <AttachmentView m={m} a={p.attachment} kind={p.kind} onOpenImage={onOpenImage} />}
            {p.kind === 'location' && p.location && (
              <a
                class="location"
                href={`https://www.openstreetmap.org/?mlat=${p.location.lat}&mlon=${p.location.lon}#map=16/${p.location.lat}/${p.location.lon}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="pin" size={22} />
                <span>
                  Ubicación
                  <small>
                    {p.location.lat.toFixed(5)}, {p.location.lon.toFixed(5)}
                  </small>
                </span>
              </a>
            )}
            {p.kind === 'unsupported' && <div class="muted italic">Mensaje no compatible con Multichat</div>}
            {p.text && <div class="text">{linkify(p.text)}</div>}
          </>
        )}
        <div class="meta">
          {m.local && m.progress !== undefined && m.status === 'pending' && (
            <span class="progress">{Math.round(m.progress * 100)}%</span>
          )}
          <span title={new Date(m.createdAt).toLocaleString('es')}>{timeHM(m.createdAt)}</span>
          {out && (
            <span title={STATUS_LABEL[m.status]}>
              <StatusTicks status={m.status} />
            </span>
          )}
        </div>
        {m.local && m.progress !== undefined && m.status === 'pending' && (
          <div class="upload-bar">
            <span style={{ width: `${Math.round(m.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {m.status === 'failed' && out && (
        <div class="fail-info">
          <span>{m.error || 'No se pudo enviar'}</span>
          <button class="link-btn small" onClick={() => engine.retry(m).catch(showError)}>
            <Icon name="retry" size={14} /> Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s<]+)/g);
  return parts.map((s, i) =>
    i % 2 === 1 ? (
      <a href={s} target="_blank" rel="noopener noreferrer">
        {s}
      </a>
    ) : (
      s
    ),
  );
}

const AUTO_DOWNLOAD = 8 * 1024 * 1024;

function useBlob(m: LocalMessage, a: Attachment, auto: boolean) {
  const localFile = m.clientId ? engine.localFiles.get(m.clientId) : undefined;
  const [url, setUrl] = useState<string | null>(() => (a.blobId ? engine.cachedBlobUrl(a.blobId) ?? null : null));
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!localFile) return;
    const u = URL.createObjectURL(localFile);
    setLocalUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [localFile]);

  async function load() {
    if (!a.blobId || state === 'loading') return null;
    setState('loading');
    try {
      const u = await engine.blobUrl(a.blobId, a.fileKey, a.mime);
      setUrl(u);
      setState('idle');
      return u;
    } catch {
      setState('error');
      return null;
    }
  }

  useEffect(() => {
    if (auto && !url && !localUrl && a.blobId && a.size <= AUTO_DOWNLOAD) void load();
  }, [a.blobId]);

  return { url: url ?? localUrl, state, load };
}

function AttachmentView({
  m,
  a,
  kind,
  onOpenImage,
}: {
  m: LocalMessage;
  a: Attachment;
  kind: string;
  onOpenImage: (url: string, name: string) => void;
}) {
  const visual = kind === 'image' || kind === 'sticker';
  const { url, state, load } = useBlob(m, a, visual || kind === 'audio');

  if (visual) {
    return (
      <div class="att-image" onClick={() => url && onOpenImage(url, a.name)}>
        {url ? (
          <img src={url} alt={a.name} loading="lazy" />
        ) : (
          <div class="att-placeholder">
            {state === 'loading' ? <Spinner /> : state === 'error' ? <button class="btn small" onClick={() => void load()}>Reintentar</button> : <button class="btn small" onClick={() => void load()}>Ver imagen ({fileSize(a.size)})</button>}
          </div>
        )}
      </div>
    );
  }
  if (kind === 'video') {
    return url ? (
      <video class="att-video" src={url} controls preload="metadata" />
    ) : (
      <div class="att-placeholder video" onClick={() => void load()}>
        {state === 'loading' ? <Spinner /> : <Icon name="play" size={36} />}
        <small>
          {a.name} · {fileSize(a.size)}
          {state === 'error' && ' · error, toca para reintentar'}
        </small>
      </div>
    );
  }
  if (kind === 'audio') {
    return url ? (
      <audio class="att-audio" src={url} controls preload="metadata" />
    ) : (
      <button class="att-file" onClick={() => void load()}>
        {state === 'loading' ? <Spinner /> : <Icon name="play" size={22} />}
        <span>
          Audio <small>{fileSize(a.size)}</small>
        </span>
      </button>
    );
  }
  // archivo
  return (
    <button
      class="att-file"
      onClick={async () => {
        const u = url ?? (await load());
        if (!u) return;
        const link = document.createElement('a');
        link.href = u;
        link.download = a.name || 'archivo';
        link.click();
      }}
    >
      {state === 'loading' ? <Spinner /> : <Icon name="file" size={24} />}
      <span>
        {a.name || 'Archivo'}
        <small>
          {fileSize(a.size)} · {a.mime || 'archivo'}
          {state === 'error' && ' · error al descargar'}
        </small>
      </span>
      <Icon name="download" size={18} />
    </button>
  );
}

function Composer({
  contactId,
  files,
  setFiles,
  addFiles,
}: {
  contactId: string;
  files: File[];
  setFiles: (f: File[]) => void;
  addFiles: (f: FileList | File[] | null | undefined) => void;
}) {
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    setText('');
    if (matchMedia('(pointer: fine)').matches) ta.current?.focus();
  }, [contactId]);

  function send() {
    const t = text.trim();
    if (files.length) {
      const [first, ...rest] = files;
      void engine.sendFile(contactId, first!, t);
      for (const f of rest) void engine.sendFile(contactId, f, '');
      setFiles([]);
      setText('');
      return;
    }
    if (!t) return;
    void engine.sendText(contactId, t);
    setText('');
  }

  return (
    <div class="composer-wrap">
      {files.length > 0 && (
        <div class="tray">
          {files.map((f, i) => (
            <FileChip f={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <div class="composer">
        <button class="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Adjuntar" title="Adjuntar">
          <Icon name="attach" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={e => {
            addFiles(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <textarea
          ref={ta}
          rows={1}
          placeholder={files.length ? 'Añade un pie (opcional)' : 'Escribe un mensaje'}
          value={text}
          onInput={e => setText(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={e => {
            const fl = e.clipboardData?.files;
            if (fl && fl.length) {
              e.preventDefault();
              addFiles(fl);
            }
          }}
        />
        <button class="send-btn" onClick={send} disabled={!text.trim() && files.length === 0} aria-label="Enviar">
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

function FileChip({ f, onRemove }: { f: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!f.type.startsWith('image/')) return;
    const u = URL.createObjectURL(f);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [f]);
  return (
    <div class="file-chip">
      {url ? <img src={url} alt="" /> : <Icon name="file" size={22} />}
      <span>
        {f.name}
        <small>{fileSize(f.size)}</small>
      </span>
      <button class="icon-btn small" onClick={onRemove} aria-label={`Quitar ${f.name}`}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
