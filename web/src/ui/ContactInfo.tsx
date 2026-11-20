// Ficha de contacto: alias, silenciar, ocultar vista previa, archivar, bloquear, borrar.
import { useEffect, useState } from 'preact/hooks';
import { engine } from '../lib/engine';
import { dateTime } from '../lib/format';
import { displayName } from '../lib/merge';
import { contacts, integrationById, showError, showToast } from '../lib/store';
import { go } from '../router';
import { Avatar, Confirm, Empty, Header, Toggle } from './common';
import { Icon, PLATFORM_NAME, PlatformIcon } from './icons';

const STATUS_TEXT = { pending: 'Solicitud pendiente', accepted: 'Aceptado', blocked: 'Bloqueado', archived: 'Archivado' };

export function ContactInfo({ id }: { id: string }) {
  const c = contacts.value.get(id);
  const [alias, setAlias] = useState(c?.aliasName ?? '');
  const [confirm, setConfirm] = useState<null | 'delete' | 'block'>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setAlias(c?.aliasName ?? ''), [c?.aliasName, id]);

  if (!c) {
    return (
      <div class="pane">
        <Header title="Contacto" backTo="/" />
        <Empty icon="users" title="Contacto no encontrado" />
      </div>
    );
  }
  const integ = integrationById.value.get(c.integrationId);
  const platform = integ?.type ?? c.profileData?.platform;
  const name = displayName(c);

  const run = async (f: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try {
      await f();
      if (ok) showToast(ok);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="pane">
      <Header title="Información" backTo={`/chat/${encodeURIComponent(id)}`} />
      <div class="scroll">
        <section class="profile-head">
          <Avatar name={name} seed={c.id} platform={platform} size={96} group={c.kind === 'group'} />
          <h2>{name}</h2>
          {c.aliasName && c.profileData?.name && <div class="muted">Nombre en la plataforma: {c.profileData.name}</div>}
          <div class="profile-tags">
            {c.profileData?.username && <span>@{c.profileData.username}</span>}
            {c.profileData?.phone && <span>{c.profileData.phone}</span>}
            <span>{c.kind === 'group' ? 'Grupo / canal' : 'Directo'}</span>
            <span>{STATUS_TEXT[c.status]}</span>
          </div>
        </section>

        <section class="group">
          <div class="group-title">Cuenta</div>
          <div class="kv-row">
            <span>Plataforma</span>
            <span class="row gap-s">
              {platform && <PlatformIcon type={platform} />} {platform ? PLATFORM_NAME[platform] : '—'}
            </span>
          </div>
          <div class="kv-row">
            <span>Integración</span>
            <span class="chat-integ inline" style={{ '--ic': integ?.color ?? '#888' }}>
              <span class="integ-dot" />
              {integ?.name ?? 'Eliminada'}
            </span>
          </div>
          <div class="kv-row">
            <span>Desde</span>
            <span>{dateTime(c.createdAt)}</span>
          </div>
        </section>

        <section class="group">
          <div class="group-title">Alias</div>
          <form
            class="row gap"
            onSubmit={e => {
              e.preventDefault();
              void run(() => engine.setAlias(id, alias), alias.trim() ? 'Alias guardado' : 'Alias quitado');
            }}
          >
            <input
              class="grow"
              placeholder={c.profileData?.name ?? 'Alias'}
              value={alias}
              maxLength={80}
              onInput={e => setAlias(e.currentTarget.value)}
              aria-label="Alias"
            />
            <button class="btn" disabled={busy || alias.trim() === (c.aliasName ?? '')}>
              Guardar
            </button>
          </form>
          <small class="muted">Se cifra en este dispositivo con la clave de tu cuenta; el servidor no lo ve.</small>
        </section>

        <section class="group">
          <div class="group-title">Notificaciones</div>
          <Toggle
            label="Silenciar"
            hint="No enviar push por este chat"
            checked={c.muted}
            disabled={busy}
            onChange={v => void run(() => engine.patchContact(id, { muted: v }))}
          />
          <Toggle
            label="Ocultar vista previa"
            hint="La notificación muestra un texto genérico"
            checked={c.hidePreview}
            disabled={busy}
            onChange={v => void run(() => engine.patchContact(id, { hidePreview: v }))}
          />
        </section>

        <section class="group actions">
          {c.status === 'pending' && (
            <button class="action" disabled={busy} onClick={() => void run(() => engine.patchContact(id, { status: 'accepted' }), 'Contacto aceptado')}>
              <Icon name="check" /> Aceptar solicitud
            </button>
          )}
          {c.status === 'accepted' && (
            <button class="action" disabled={busy} onClick={() => void run(() => engine.patchContact(id, { status: 'archived' }), 'Chat archivado')}>
              <Icon name="archive" /> Archivar
            </button>
          )}
          {c.status === 'archived' && (
            <button class="action" disabled={busy} onClick={() => void run(() => engine.patchContact(id, { status: 'accepted' }), 'Chat desarchivado')}>
              <Icon name="archive" /> Desarchivar
            </button>
          )}
          {c.status === 'blocked' ? (
            <button class="action" disabled={busy} onClick={() => void run(() => engine.patchContact(id, { status: 'accepted' }), 'Contacto desbloqueado')}>
              <Icon name="check" /> Desbloquear
            </button>
          ) : (
            <button class="action danger" disabled={busy} onClick={() => setConfirm('block')}>
              <Icon name="alert" /> Bloquear
            </button>
          )}
          <button class="action danger" disabled={busy} onClick={() => setConfirm('delete')}>
            <Icon name="trash" /> Borrar historial y contacto
          </button>
        </section>
      </div>

      {confirm === 'block' && (
        <Confirm
          title="Bloquear contacto"
          text={`Lo que envíe ${name} se descartará en el servidor. Puedes desbloquearlo después desde Archivados.`}
          confirm="Bloquear"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => run(() => engine.patchContact(id, { status: 'blocked' }), 'Contacto bloqueado')}
        />
      )}
      {confirm === 'delete' && (
        <Confirm
          title="Borrar historial"
          text={`Se borrarán ${name} y todos sus mensajes del servidor y de tus dispositivos. Si vuelve a escribir, aparecerá como solicitud nueva.`}
          confirm="Borrar"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            run(async () => {
              await engine.deleteContact(id);
              go('/');
            }, 'Contacto borrado')
          }
        />
      )}
    </div>
  );
}
