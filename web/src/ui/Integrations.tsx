// Ajustes → Integraciones: lista, alta, edición, Discord y WhatsApp.
import { useEffect, useState } from 'preact/hooks';
import { engine } from '../lib/engine';
import { integrations, showError, showToast } from '../lib/store';
import type { Integration, Platform } from '../lib/types';
import { go } from '../router';
import { Confirm, CopyField, Empty, Header, Spinner, Toggle } from './common';
import { Icon, PLATFORM_COLOR, PLATFORM_NAME, PlatformIcon } from './icons';

interface FieldDef {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

const FIELDS: Record<Platform, FieldDef[]> = {
  telegram: [{ key: 'botToken', label: 'Token del bot', secret: true, placeholder: '123456789:AA…' }],
  discord: [{ key: 'botToken', label: 'Token del bot', secret: true }],
  whatsapp: [
    { key: 'appId', label: 'App ID' },
    { key: 'appSecret', label: 'App Secret', secret: true },
    { key: 'accessToken', label: 'Access token', secret: true, placeholder: 'EAAG…' },
    { key: 'phoneNumberId', label: 'Phone number ID' },
    { key: 'wabaId', label: 'WhatsApp Business Account ID' },
  ],
};

const HELP: Record<Platform, preact.JSX.Element> = {
  telegram: (
    <ol>
      <li>
        En Telegram abre <b>@BotFather</b> y envía <code>/newbot</code>.
      </li>
      <li>Elige nombre y usuario del bot.</li>
      <li>Copia el token que te devuelve y pégalo aquí.</li>
      <li>Para grupos: añade el bot al grupo y desactiva el modo privacidad con /setprivacy si quieres leer todo.</li>
    </ol>
  ),
  discord: (
    <ol>
      <li>
        Entra en <b>discord.com/developers/applications</b> → New Application.
      </li>
      <li>
        En <b>Bot</b>: «Reset Token» y copia el token. Activa <b>Message Content Intent</b>.
      </li>
      <li>Tras activarla, usa el enlace de invitación para meter el bot en tu servidor y elige los canales.</li>
    </ol>
  ),
  whatsapp: (
    <ol>
      <li>
        En <b>developers.facebook.com</b> crea una app de tipo Business y añade el producto WhatsApp.
      </li>
      <li>
        En <b>WhatsApp → API Setup</b> están el Phone number ID, el WhatsApp Business Account ID y un token temporal
        (24 h). Para uno permanente, crea un usuario del sistema en Business Settings.
      </li>
      <li>
        El App ID y el App Secret están en <b>Configuración de la app → Básica</b>.
      </li>
      <li>Con el número de prueba solo puedes escribir a 5 destinatarios verificados.</li>
    </ol>
  ),
};

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#64748b'];

const STATUS: Record<Integration['status'], string> = {
  connected: 'Conectada',
  connecting: 'Conectando',
  error: 'Error',
  disabled: 'Pausada',
};

export function IntegrationStatus({ i }: { i: Integration }) {
  return (
    <span class={`status-pill st-${i.status}`} title={i.statusDetail ?? undefined}>
      <span class="dot" />
      {STATUS[i.status]}
    </span>
  );
}

function infoLine(i: Pick<Integration, 'type' | 'info'>): string {
  const info = i.info as Record<string, string | boolean | undefined>;
  if (i.type === 'whatsapp') return [info.verifiedName, info.displayPhoneNumber].filter(Boolean).join(' · ');
  return info.username ? `@${String(info.username)}` : '';
}

export function IntegrationsList() {
  const list = integrations.value;
  return (
    <div class="pane">
      <Header title="Integraciones" backTo="/settings">
        <button class="icon-btn" onClick={() => go('/settings/integrations/new')} aria-label="Añadir integración" title="Añadir">
          <Icon name="plus" />
        </button>
      </Header>
      <div class="scroll">
        {list.length === 0 ? (
          <Empty icon="plug" title="Sin integraciones">
            Conecta un bot de Telegram o Discord, o un número de WhatsApp Cloud API.
          </Empty>
        ) : (
          <ul class="menu">
            {list.map(i => (
              <li>
                <a href={`#/settings/integrations/${encodeURIComponent(i.id)}`} class="menu-item">
                  <span class="integ-swatch" style={{ background: i.color }}>
                    <PlatformIcon type={i.type} size={22} />
                  </span>
                  <span class="menu-text">
                    <span>{i.name}</span>
                    <small>
                      {PLATFORM_NAME[i.type]}
                      {infoLine(i) && ` · ${infoLine(i)}`}
                    </small>
                  </span>
                  <IntegrationStatus i={i} />
                  <Icon name="chevron" size={18} class="muted" />
                </a>
              </li>
            ))}
          </ul>
        )}
        <div class="pad">
          <button class="btn primary block" onClick={() => go('/settings/integrations/new')}>
            <Icon name="plus" size={18} /> Añadir integración
          </button>
        </div>
      </div>
    </div>
  );
}

function CredentialFields({
  type,
  values,
  onChange,
}: {
  type: Platform;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  return (
    <>
      {FIELDS[type].map(f => (
        <label class="field">
          <span>{f.label}</span>
          <input
            type={(f.secret ? 'password' : 'text') as 'text'}
            autocomplete="off"
            spellcheck={false}
            required
            placeholder={f.placeholder}
            value={values[f.key] ?? ''}
            onInput={e => onChange({ ...values, [f.key]: e.currentTarget.value.trim() })}
          />
        </label>
      ))}
    </>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div class="colors" role="radiogroup" aria-label="Color">
      {COLORS.map(c => (
        <button
          type="button"
          class="swatch"
          role="radio"
          aria-checked={value === c}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={c}
        />
      ))}
      <label class="swatch custom" title="Otro color">
        <input type="color" value={value} onInput={e => onChange(e.currentTarget.value)} aria-label="Otro color" />
      </label>
    </div>
  );
}

export function NewIntegration() {
  const [type, setType] = useState<Platform | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [tested, setTested] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [allowDMs, setAllowDMs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const complete = type ? FIELDS[type].every(f => (creds[f.key] ?? '').length > 0) : false;

  async function test(e: Event) {
    e.preventDefault();
    if (!type) return;
    setBusy(true);
    setError('');
    try {
      const r = await engine.api.post<{ ok: boolean; info: Record<string, unknown> }>('/api/integrations/test', { type, credentials: creds });
      setTested(r.info);
      const suggested =
        type === 'whatsapp' ? String(r.info.verifiedName ?? r.info.displayPhoneNumber ?? '') : String(r.info.firstName ?? r.info.username ?? '');
      if (!name) setName(suggested || PLATFORM_NAME[type]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate(e: Event) {
    e.preventDefault();
    if (!type) return;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { type, name: name.trim(), color, credentials: creds };
      if (type === 'discord') body.config = { channelIds: [], allowDMs };
      const i = await engine.api.post<Integration>('/api/integrations', body);
      integrations.value = [...integrations.value.filter(x => x.id !== i.id), i];
      showToast('Integración activada');
      go(`/settings/integrations/${encodeURIComponent(i.id)}`, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="pane">
      <Header title="Nueva integración" backTo="/settings/integrations" />
      <div class="scroll pad stack">
        {!type && (
          <>
            <p class="muted">Elige la plataforma:</p>
            <div class="platform-grid">
              {(['telegram', 'discord', 'whatsapp'] as const).map(p => (
                <button class="platform-card" style={{ '--pc': PLATFORM_COLOR[p] }} onClick={() => setType(p)}>
                  <PlatformIcon type={p} size={40} />
                  <b>{PLATFORM_NAME[p]}</b>
                  <small>{p === 'telegram' ? 'Bot de Telegram' : p === 'discord' ? 'Bot de Discord' : 'Número de Cloud API'}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {type && !tested && (
          <form class="stack" onSubmit={test}>
            <div class="row gap-s">
              <PlatformIcon type={type} size={24} />
              <h2 class="h2">{PLATFORM_NAME[type]}</h2>
              <button type="button" class="link-btn small" onClick={() => setType(null)}>
                Cambiar
              </button>
            </div>
            <details class="help" open>
              <summary>Dónde conseguir las credenciales</summary>
              {HELP[type]}
            </details>
            <CredentialFields type={type} values={creds} onChange={setCreds} />
            {error && <div class="form-error">{error}</div>}
            <button class="btn primary block" disabled={busy || !complete}>
              {busy ? <Spinner /> : 'Probar'}
            </button>
          </form>
        )}

        {type && tested && (
          <form class="stack" onSubmit={activate}>
            <div class="notice ok">
              <Icon name="check" size={18} />
              <span>
                Credenciales válidas{infoLine({ type, info: tested }) && `: ${infoLine({ type, info: tested })}`}
              </span>
            </div>
            <label class="field">
              <span>Nombre</span>
              <input required maxLength={60} value={name} onInput={e => setName(e.currentTarget.value)} />
              <small>Cómo verás esta cuenta en la bandeja.</small>
            </label>
            <div class="field">
              <span>Color</span>
              <ColorPicker value={color} onChange={setColor} />
            </div>
            {type === 'discord' && (
              <Toggle label="Mensajes directos" hint="Recibir DMs enviados al bot" checked={allowDMs} onChange={setAllowDMs} />
            )}
            {type === 'whatsapp' && (
              <div class="notice warn">
                <Icon name="alert" size={18} />
                <span>Con el número de prueba de Meta solo puedes enviar a 5 destinatarios verificados.</span>
              </div>
            )}
            {error && <div class="form-error">{error}</div>}
            <div class="row gap">
              <button type="button" class="btn" onClick={() => setTested(null)}>
                Atrás
              </button>
              <button class="btn primary grow" disabled={busy || !name.trim()}>
                {busy ? <Spinner /> : 'Activar'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

interface Guild {
  id: string;
  name: string;
  channels: { id: string; name: string }[];
}

function DiscordChannels({ i }: { i: Integration }) {
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>((i.config.channelIds as string[] | undefined) ?? []);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    setGuilds(null);
    try {
      const r = await engine.api.get<{ guilds: Guild[] }>(`/api/integrations/${encodeURIComponent(i.id)}/discord/channels`);
      setGuilds(r.guilds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGuilds([]);
    }
  }
  useEffect(() => void load(), [i.id]);
  useEffect(() => setSelected((i.config.channelIds as string[] | undefined) ?? []), [i.updatedAt]);

  const current = (i.config.channelIds as string[] | undefined) ?? [];
  const dirty = current.length !== selected.length || current.some(x => !selected.includes(x));

  async function save() {
    setBusy(true);
    try {
      const r = await engine.api.patch<Integration>(`/api/integrations/${encodeURIComponent(i.id)}`, {
        config: { ...i.config, channelIds: selected },
      });
      integrations.value = integrations.value.map(x => (x.id === r.id ? r : x));
      showToast('Canales guardados');
      void engine.sync();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="group">
      <div class="group-title row space">
        <span>Canales</span>
        <button class="link-btn small" onClick={() => void load()}>
          <Icon name="retry" size={14} /> Recargar
        </button>
      </div>
      {guilds === null && <Spinner />}
      {error && <div class="form-error">{error}</div>}
      {guilds?.length === 0 && !error && (
        <p class="muted">El bot no está en ningún servidor. Invítalo con el enlace de arriba y recarga.</p>
      )}
      {guilds?.map(g => (
        <div class="guild">
          <div class="guild-name">{g.name}</div>
          {g.channels.map(ch => (
            <label class="check-row">
              <input
                type="checkbox"
                checked={selected.includes(ch.id)}
                onChange={e =>
                  setSelected(s => (e.currentTarget.checked ? [...s, ch.id] : s.filter(x => x !== ch.id)))
                }
              />
              <span># {ch.name}</span>
            </label>
          ))}
        </div>
      ))}
      {dirty && (
        <button class="btn primary" disabled={busy} onClick={() => void save()}>
          Guardar canales
        </button>
      )}
      <small class="muted">Cada canal activado aparece como chat de grupo.</small>
    </section>
  );
}

export function EditIntegration({ id }: { id: string }) {
  const i = integrations.value.find(x => x.id === id);
  const [name, setName] = useState(i?.name ?? '');
  const [color, setColor] = useState(i?.color ?? COLORS[0]!);
  const [rotating, setRotating] = useState(false);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (i) {
      setName(i.name);
      setColor(i.color);
    }
  }, [i?.id, i?.name, i?.color]);

  if (!i) {
    return (
      <div class="pane">
        <Header title="Integración" backTo="/settings/integrations" />
        <Empty icon="plug" title="Integración no encontrada" />
      </div>
    );
  }

  async function patch(body: Record<string, unknown>, ok?: string) {
    setBusy(true);
    try {
      const r = await engine.api.patch<Integration>(`/api/integrations/${encodeURIComponent(id)}`, body);
      integrations.value = integrations.value.map(x => (x.id === r.id ? r : x));
      if (ok) showToast(ok);
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const info = i.info as Record<string, unknown>;
  const fieldsComplete = FIELDS[i.type].every(f => (creds[f.key] ?? '').length > 0);

  return (
    <div class="pane">
      <Header title={i.name} backTo="/settings/integrations" sub={PLATFORM_NAME[i.type]} />
      <div class="scroll">
        <section class="group">
          <div class="kv-row">
            <span>Estado</span>
            <IntegrationStatus i={i} />
          </div>
          {i.statusDetail && <div class="form-error">{i.statusDetail}</div>}
          {infoLine(i) && (
            <div class="kv-row">
              <span>{i.type === 'whatsapp' ? 'Número' : 'Bot'}</span>
              <span>{infoLine(i)}</span>
            </div>
          )}
          <div class="kv-row">
            <span>Credencial</span>
            <code>…{i.credentialHint}</code>
          </div>
          <Toggle
            label="Activa"
            hint="Pausar deja de recibir y enviar por esta cuenta"
            checked={i.enabled}
            disabled={busy}
            onChange={v => void patch({ enabled: v }, v ? 'Reanudada' : 'Pausada')}
          />
        </section>

        {i.type === 'discord' && (
          <>
            <section class="group">
              <div class="group-title">Discord</div>
              {typeof info.inviteUrl === 'string' && (
                <a class="btn" href={info.inviteUrl} target="_blank" rel="noopener noreferrer">
                  <Icon name="plus" size={18} /> Invitar el bot a un servidor
                </a>
              )}
              <Toggle
                label="Mensajes directos"
                hint="Recibir DMs enviados al bot"
                checked={!!i.config.allowDMs}
                disabled={busy}
                onChange={v => void patch({ config: { ...i.config, allowDMs: v } })}
              />
            </section>
            <DiscordChannels i={i} />
          </>
        )}

        {i.type === 'whatsapp' && (
          <section class="group">
            <div class="group-title">WhatsApp</div>
            {info.webhookRegistered === false && (
              <>
                <div class="notice warn">
                  <Icon name="alert" size={18} />
                  <span>
                    No se pudo registrar el webhook automáticamente. En la app de Meta, ve a <b>WhatsApp → Configuration</b>, pega
                    esta URL y el token de verificación, y suscríbete al campo <code>messages</code>.
                  </span>
                </div>
                {i.webhookUrl && <CopyField label="URL del webhook" value={i.webhookUrl} />}
                {typeof i.config.verifyToken === 'string' && <CopyField label="Token de verificación" value={i.config.verifyToken} />}
              </>
            )}
            {info.webhookRegistered === true && (
              <div class="notice ok">
                <Icon name="check" size={18} /> Webhook registrado.
              </div>
            )}
            <div class="notice">
              <Icon name="alert" size={18} />
              <span>
                El número de prueba solo envía a 5 destinatarios verificados, y fuera de la ventana de 24 h desde el último mensaje
                del contacto, WhatsApp rechaza los mensajes libres.
              </span>
            </div>
          </section>
        )}

        <section class="group">
          <div class="group-title">Apariencia</div>
          <form
            class="stack"
            onSubmit={e => {
              e.preventDefault();
              void patch({ name: name.trim(), color }, 'Guardado');
            }}
          >
            <label class="field">
              <span>Nombre</span>
              <input required maxLength={60} value={name} onInput={e => setName(e.currentTarget.value)} />
            </label>
            <div class="field">
              <span>Color</span>
              <ColorPicker value={color} onChange={setColor} />
            </div>
            <button class="btn" disabled={busy || (name.trim() === i.name && color === i.color) || !name.trim()}>
              Guardar
            </button>
          </form>
        </section>

        <section class="group">
          <div class="group-title">Credenciales</div>
          {!rotating ? (
            <button class="btn" onClick={() => setRotating(true)}>
              <Icon name="key" size={18} /> Rotar credenciales
            </button>
          ) : (
            <form
              class="stack"
              onSubmit={async e => {
                e.preventDefault();
                if (await patch({ credentials: creds }, 'Credenciales actualizadas')) {
                  setRotating(false);
                  setCreds({});
                }
              }}
            >
              <details class="help">
                <summary>Dónde conseguirlas</summary>
                {HELP[i.type]}
              </details>
              <CredentialFields type={i.type} values={creds} onChange={setCreds} />
              <div class="row gap">
                <button type="button" class="btn" onClick={() => setRotating(false)}>
                  Cancelar
                </button>
                <button class="btn primary grow" disabled={busy || !fieldsComplete}>
                  {busy ? <Spinner /> : 'Validar y guardar'}
                </button>
              </div>
            </form>
          )}
        </section>

        <section class="group actions">
          <button class="action danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" /> Eliminar integración
          </button>
        </section>
      </div>
      {confirmDelete && (
        <Confirm
          title="Eliminar integración"
          text={`Se desconectará «${i.name}» y se borrarán todos sus contactos y mensajes. No se puede deshacer.`}
          confirm="Eliminar"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await engine.api.del(`/api/integrations/${encodeURIComponent(id)}`);
              await engine.onWsEvent({ type: 'integration_deleted', id });
              showToast('Integración eliminada');
              go('/settings/integrations', true);
            } catch (e) {
              showError(e);
            }
          }}
        />
      )}
    </div>
  );
}
