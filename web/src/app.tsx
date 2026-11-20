import { useEffect } from 'preact/hooks';
import { phase } from './lib/store';
import { match, route } from './router';
import { Chat } from './ui/Chat';
import { Spinner, Toast } from './ui/common';
import { ContactInfo } from './ui/ContactInfo';
import { Inbox, lastView, type InboxView } from './ui/Inbox';
import { EditIntegration, IntegrationsList, NewIntegration } from './ui/Integrations';
import { Login } from './ui/Login';
import { Logo } from './ui/Logo';
import { Devices, Notifications, Recovery, SettingsMenu } from './ui/Settings';
import { Setup } from './ui/Setup';

function Main() {
  const r = route.value.split('?')[0]!;
  const views: Record<string, InboxView> = { '/': 'chats', '/requests': 'requests', '/archived': 'archived' };
  const listView = views[r];
  useEffect(() => {
    if (listView) lastView.value = listView;
  }, [listView]);

  let side = <Inbox view={listView ?? lastView.value} />;
  let detail: preact.JSX.Element | null = null;
  let p: Record<string, string> | null;

  if (r.startsWith('/settings')) {
    side = <SettingsMenu />;
    if (r === '/settings/integrations') detail = <IntegrationsList />;
    else if (r === '/settings/integrations/new') detail = <NewIntegration />;
    else if ((p = match('/settings/integrations/:id', r))) detail = <EditIntegration id={p.id!} />;
    else if (r === '/settings/devices') detail = <Devices />;
    else if (r === '/settings/recovery') detail = <Recovery />;
    else if (r === '/settings/notifications') detail = <Notifications />;
  } else if ((p = match('/chat/:id', r))) detail = <Chat id={p.id!} />;
  else if ((p = match('/contact/:id', r))) detail = <ContactInfo id={p.id!} />;

  return (
    <div class="layout" data-detail={detail ? 'yes' : 'no'}>
      <aside class="side">{side}</aside>
      <main class="detail">
        {detail ?? (
          <div class="placeholder">
            <Logo size={64} />
            <p>Elige un chat para empezar</p>
          </div>
        )}
      </main>
    </div>
  );
}

export function App() {
  const ph = phase.value;
  return (
    <>
      {ph === 'boot' && (
        <div class="boot">
          <Spinner size={32} />
        </div>
      )}
      {ph === 'login' && <Login />}
      {ph === 'setup' && <Setup />}
      {ph === 'ready' && <Main />}
      <Toast />
    </>
  );
}
