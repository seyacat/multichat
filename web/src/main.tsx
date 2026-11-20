import { render } from 'preact';
import { App } from './app';
import { engine } from './lib/engine';
import './styles.css';

render(<App />, document.getElementById('app')!);
void engine.boot();

if ('serviceWorker' in navigator) {
  // En desarrollo se sirve el TS como módulo; en producción, el IIFE compilado.
  const url = import.meta.env.DEV ? '/src/sw.ts' : '/sw.js';
  navigator.serviceWorker
    .register(url, { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' })
    .catch(e => console.warn('No se pudo registrar el service worker', e));
  // al tocar una notificación con la app abierta
  navigator.serviceWorker.addEventListener('message', ev => {
    const d = ev.data as { type?: string; contactId?: string } | null;
    if (d?.type === 'open-chat' && d.contactId) location.hash = `/chat/${encodeURIComponent(d.contactId)}`;
  });
}
