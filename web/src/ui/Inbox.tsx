// Lista de chats, solicitudes y archivados con filtros y búsqueda local.
import { signal } from '@preact/signals';
import { useMemo } from 'preact/hooks';
import { engine } from '../lib/engine';
import { listTime } from '../lib/format';
import { displayName, lastVisible, previewText } from '../lib/merge';
import { contacts, integrationById, integrations, messages, showError, syncing, wsState } from '../lib/store';
import type { LocalContact, LocalMessage, Platform } from '../lib/types';
import { go, route } from '../router';
import { Avatar, Empty } from './common';
import { Icon, PLATFORM_COLOR, PLATFORM_NAME } from './icons';
import { Logo } from './Logo';
import { StatusTicks } from './Chat';

export type InboxView = 'chats' | 'requests' | 'archived';

const query = signal('');
const platformFilter = signal<Platform | 'all'>('all');
const integrationFilter = signal<string>('all');
export const lastView = signal<InboxView>('chats');

function sortKey(c: LocalContact, last: LocalMessage | undefined): number {
  return Math.max(c.lastMessageAt ?? 0, last?.createdAt ?? 0, c.createdAt);
}

export function Inbox({ view }: { view: InboxView }) {
  const all = [...contacts.value.values()];
  const msgs = messages.value;
  const ints = integrationById.value;
  const q = query.value.trim().toLowerCase();
  const pf = platformFilter.value;
  const inf = integrationFilter.value;
  const pendingCount = all.filter(c => c.status === 'pending').length;
  const openId = /^\/(chat|contact)\/(.+)$/.exec(route.value)?.[2];

  const rows = useMemo(() => {
    const want = view === 'chats' ? ['accepted'] : view === 'requests' ? ['pending'] : ['archived', 'blocked'];
    return all
      .filter(c => want.includes(c.status))
      .filter(c => {
        const integ = ints.get(c.integrationId);
        const plat = integ?.type ?? c.profileData?.platform;
        if (pf !== 'all' && plat !== pf) return false;
        if (inf !== 'all' && c.integrationId !== inf) return false;
        if (!q) return true;
        const last = lastVisible(msgs.get(c.id));
        const hay = [displayName(c), c.profileData?.username, c.profileData?.phone, c.profileData?.name, previewText(last)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .map(c => ({ c, last: lastVisible(msgs.get(c.id)) }))
      .sort((a, b) => {
        if (a.c.status !== b.c.status) return a.c.status === 'blocked' ? 1 : -1;
        return sortKey(b.c, b.last) - sortKey(a.c, a.last);
      });
  }, [all, msgs, ints, q, pf, inf, view]);

  const visibleInts = integrations.value.filter(i => pf === 'all' || i.type === pf);
  const platforms = [...new Set(integrations.value.map(i => i.type))];

  return (
    <div class="pane">
      <header class="bar inbox-bar">
        <Logo size={30} />
        <div class="bar-title">
          <h1>Multichat</h1>
          <div class="bar-sub">
            <span class={`dot ws-${wsState.value}`} />
            {wsState.value === 'open' ? (syncing.value ? 'Sincronizando…' : 'En línea') : wsState.value === 'connecting' ? 'Conectando…' : 'Sin conexión'}
          </div>
        </div>
        <div class="bar-actions">
          <button class="icon-btn" onClick={() => go('/settings')} aria-label="Ajustes" title="Ajustes">
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <nav class="tabs" role="tablist">
        <button role="tab" aria-selected={view === 'chats'} onClick={() => go('/')}>
          Chats
        </button>
        <button role="tab" aria-selected={view === 'requests'} onClick={() => go('/requests')}>
          Solicitudes {pendingCount > 0 && <span class="pill">{pendingCount}</span>}
        </button>
        <button role="tab" aria-selected={view === 'archived'} onClick={() => go('/archived')}>
          Archivados
        </button>
      </nav>

      <div class="filters">
        <label class="search">
          <Icon name="search" size={18} />
          <input
            type="search"
            placeholder="Buscar"
            value={query.value}
            onInput={e => (query.value = e.currentTarget.value)}
            aria-label="Buscar chats"
          />
        </label>
        {platforms.length > 0 && (
          <div class="chips" role="group" aria-label="Filtrar por plataforma">
            <button
              class="chip"
              aria-pressed={pf === 'all'}
              onClick={() => {
                platformFilter.value = 'all';
                integrationFilter.value = 'all';
              }}
            >
              Todas
            </button>
            {(['telegram', 'discord', 'whatsapp'] as const)
              .filter(p => platforms.includes(p))
              .map(p => (
                <button
                  class="chip"
                  aria-pressed={pf === p}
                  style={{ '--chip': PLATFORM_COLOR[p] }}
                  onClick={() => {
                    platformFilter.value = p;
                    integrationFilter.value = 'all';
                  }}
                >
                  {PLATFORM_NAME[p]}
                </button>
              ))}
            {visibleInts.length > 1 && (
              <select
                class="chip-select"
                value={inf}
                onChange={e => (integrationFilter.value = e.currentTarget.value)}
                aria-label="Filtrar por integración"
              >
                <option value="all">Todas las cuentas</option>
                {visibleInts.map(i => (
                  <option value={i.id}>{i.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      <ul class="chat-list" role="list">
        {rows.map(({ c, last }, i) => {
          const showBlockedHeader = view === 'archived' && c.status === 'blocked' && rows[i - 1]?.c.status !== 'blocked';
          return (
            <>
              {showBlockedHeader && <li class="list-sep">Bloqueados</li>}
              <ChatRow c={c} last={last} active={openId === c.id} request={view === 'requests'} />
            </>
          );
        })}
      </ul>
      {rows.length === 0 && (
        <>
          {q || pf !== 'all' || inf !== 'all' ? (
            <Empty icon="search" title="Sin resultados" />
          ) : view === 'requests' ? (
            <Empty icon="inbox" title="Sin solicitudes">
              Quien escriba por primera vez a uno de tus bots aparecerá aquí hasta que lo aceptes.
            </Empty>
          ) : view === 'archived' ? (
            <Empty icon="archive" title="Nada archivado" />
          ) : integrations.value.length === 0 ? (
            <Empty icon="plug" title="Conecta tu primera cuenta">
              <button class="btn primary" onClick={() => go('/settings/integrations/new')}>
                Añadir integración
              </button>
            </Empty>
          ) : (
            <Empty icon="inbox" title="Aún no hay chats">
              Los chats aceptados aparecen aquí. Revisa las solicitudes.
            </Empty>
          )}
        </>
      )}
    </div>
  );
}

function ChatRow({ c, last, active, request }: { c: LocalContact; last: LocalMessage | undefined; active: boolean; request: boolean }) {
  const integ = integrationById.value.get(c.integrationId);
  const name = displayName(c);
  const platform = integ?.type ?? c.profileData?.platform;
  const recent = request ? (messages.value.get(c.id) ?? []).filter(m => !m.dismissed).slice(-3) : [];

  return (
    <li class={`chat-row ${active ? 'active' : ''}`}>
      <a href={`#/chat/${encodeURIComponent(c.id)}`} class="chat-row-link">
        <Avatar name={name} seed={c.id} platform={platform} group={c.kind === 'group'} />
        <div class="chat-row-main">
          <div class="chat-row-top">
            <span class="chat-name">{name}</span>
            <span class={`chat-time ${c.unread > 0 ? 'unread' : ''}`}>{listTime(last?.createdAt ?? c.lastMessageAt)}</span>
          </div>
          {integ && (
            <div class="chat-integ" style={{ '--ic': integ.color }}>
              <span class="integ-dot" />
              {integ.name}
              {c.kind === 'group' && <span class="muted"> · grupo</span>}
            </div>
          )}
          <div class="chat-row-bottom">
            <span class="chat-preview">
              {last?.direction === 'out' && <StatusTicks status={last.status} />}
              {last?.payload?.senderName && c.kind === 'group' && <b>{last.payload.senderName}: </b>}
              {previewText(last)}
            </span>
            {c.muted && <Icon name="bell-off" size={14} class="muted" />}
            {c.unread > 0 && <span class={`badge ${c.muted ? 'quiet' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
          </div>
        </div>
      </a>
      {request && (
        <div class="request-extra">
          {recent.length > 0 && (
            <ul class="request-preview">
              {recent.map(m => (
                <li>{previewText(m)}</li>
              ))}
            </ul>
          )}
          <div class="row gap">
            <button
              class="btn small primary"
              onClick={() => engine.patchContact(c.id, { status: 'accepted' }).catch(showError)}
            >
              Aceptar
            </button>
            <button class="btn small danger" onClick={() => engine.patchContact(c.id, { status: 'blocked' }).catch(showError)}>
              Bloquear
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
