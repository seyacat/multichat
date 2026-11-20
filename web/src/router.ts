// Enrutado mínimo por hash.
import { signal } from '@preact/signals';

function current(): string {
  if (typeof location === 'undefined') return '/';
  const h = location.hash.replace(/^#/, '');
  return h || '/';
}

export const route = signal(current());

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => (route.value = current()));
}

export function go(path: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', `#${path}`);
    route.value = path;
  } else location.hash = path;
}

/** Devuelve los parámetros si la ruta encaja con el patrón (`/chat/:id`). */
export function match(pattern: string, path = route.value): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('?')[0]!.split('/');
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(':')) out[seg.slice(1)] = decodeURIComponent(a[i]!);
    else if (seg !== a[i]) return null;
  }
  return out;
}
