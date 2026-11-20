// Componentes compartidos: avatar, cabecera, diálogo, aviso, QR, copiar.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { initials } from '../lib/merge';
import { showToast, toast } from '../lib/store';
import type { Platform } from '../lib/types';
import { go } from '../router';
import { Icon, PlatformIcon } from './icons';

/** Color estable a partir de un texto. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Avatar({
  name,
  seed,
  platform,
  size = 48,
  group,
}: {
  name: string;
  seed: string;
  platform?: Platform | undefined;
  size?: number;
  group?: boolean;
}) {
  const hue = hueFor(seed);
  return (
    <div class="avatar" style={{ width: size, height: size, '--h': hue }} aria-hidden="true">
      <span style={{ fontSize: size * 0.38 }}>{group ? <Icon name="users" size={size * 0.45} /> : initials(name)}</span>
      {platform && (
        <span class="avatar-badge">
          <PlatformIcon type={platform} size={Math.max(14, size * 0.36)} />
        </span>
      )}
    </div>
  );
}

export function Header({
  title,
  backTo,
  children,
  sub,
}: {
  title: ComponentChildren;
  backTo?: string;
  children?: ComponentChildren;
  sub?: ComponentChildren;
}) {
  return (
    <header class="bar">
      {backTo !== undefined && (
        <button class="icon-btn back-btn" onClick={() => go(backTo)} aria-label="Volver">
          <Icon name="back" />
        </button>
      )}
      <div class="bar-title">
        <h1>{title}</h1>
        {sub && <div class="bar-sub">{sub}</div>}
      </div>
      <div class="bar-actions">{children}</div>
    </header>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('input,textarea,button.primary')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div class="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  confirm,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  text: ComponentChildren;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div class="confirm-text">{text}</div>
      <div class="row end gap">
        <button class="btn" onClick={onClose}>
          Cancelar
        </button>
        <button
          class={`btn ${danger ? 'danger' : 'primary'}`}
          onClick={async () => {
            await onConfirm();
            onClose();
          }}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

export function Toast() {
  const t = toast.value;
  if (!t) return null;
  return (
    <div class={`toast ${t.kind}`} role="status" onClick={() => (toast.value = null)}>
      {t.text}
    </div>
  );
}

export function QrCode({ text, size = 240 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return { d, dim: n + quiet * 2 };
  }, [text]);
  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${svg.dim} ${svg.dim}`} role="img" aria-label="Código QR">
      <rect width={svg.dim} height={svg.dim} fill="#fff" />
      <path d={svg.d} fill="#111" shape-rendering="crispEdges" />
    </svg>
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copiado');
  } catch {
    showToast('No se pudo copiar. Selecciona el texto y cópialo a mano.', 'error');
  }
}

export function CopyField({ value, label, secret }: { value: string; label?: string; secret?: boolean }) {
  return (
    <div class="copy-field">
      {label && <div class="field-label">{label}</div>}
      <div class="copy-row">
        <code class={secret ? 'secret' : ''}>{value}</code>
        <button class="icon-btn" onClick={() => void copyText(value)} aria-label="Copiar" title="Copiar">
          <Icon name="copy" />
        </button>
      </div>
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span class="spinner" style={{ width: size, height: size }} aria-label="Cargando" />;
}

export function Empty({ icon, title, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} size={40} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ComponentChildren;
  hint?: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <label class={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span class="toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="switch" aria-hidden="true" />
    </label>
  );
}
