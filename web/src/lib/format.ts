// Formato de fechas y tamaños (es).

const dayMs = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function timeHM(t: number): string {
  return new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

/** Hora para la lista de chats: hoy → hh:mm, ayer, día de la semana o fecha corta. */
export function listTime(t: number | null, now = Date.now()): string {
  if (!t) return '';
  const diff = startOfDay(now) - startOfDay(t);
  if (diff <= 0) return timeHM(t);
  if (diff === dayMs) return 'Ayer';
  if (diff < 7 * dayMs) return new Date(t).toLocaleDateString('es', { weekday: 'long' });
  return new Date(t).toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Etiqueta del separador de día en el chat. */
export function dayLabel(t: number, now = Date.now()): string {
  const diff = startOfDay(now) - startOfDay(t);
  if (diff <= 0) return 'Hoy';
  if (diff === dayMs) return 'Ayer';
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return new Date(t).toLocaleDateString('es', {
    weekday: diff < 7 * dayMs ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  });
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function dateTime(t: number | undefined): string {
  if (!t) return '—';
  return new Date(t).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}
