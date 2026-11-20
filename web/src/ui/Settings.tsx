// Ajustes: menú, dispositivos, clave de recuperación, notificaciones.
import { useEffect, useRef, useState } from 'preact/hooks';
import { HttpError, getServer } from '../lib/api';
import { parseLinkText, recoveryText } from '../lib/crypto';
import { kvGet } from '../lib/db';
import { engine, type LinkInfo } from '../lib/engine';
import { dateTime } from '../lib/format';
import { accountKey, devices, integrations, session, showError, showToast } from '../lib/store';
import type { Device } from '../lib/types';
import { route } from '../router';
import { Confirm, CopyField, Header, Modal, Spinner } from './common';
import { Icon } from './icons';

export function SettingsMenu() {
  const s = session.value!;
  const r = route.value;
  const errs = integrations.value.filter(i => i.status === 'error').length;
  const item = (path: string, icon: Parameters<typeof Icon>[0]['name'], label: string, sub?: string) => (
    <li>
      <a href={`#${path}`} class={`menu-item ${r.startsWith(path) ? 'active' : ''}`}>
        <span class="menu-icon">
          <Icon name={icon} />
        </span>
        <span class="menu-text">
          <span>{label}</span>
          {sub && <small>{sub}</small>}
        </span>
        <Icon name="chevron" size={18} class="muted" />
      </a>
    </li>
  );
  return (
    <div class="pane">
      <Header title="Ajustes" backTo="/" />
      <div class="scroll">
        <div class="account-card">
          <div>
            <b>{s.user.email}</b>
            <small>
              {s.device.name} · {getServer()}
            </small>
          </div>
        </div>
        <ul class="menu">
          {item(
            '/settings/integrations',
            'plug',
            'Integraciones',
            `${integrations.value.length} cuenta${integrations.value.length === 1 ? '' : 's'}${errs ? ` · ${errs} con error` : ''}`,
          )}
          {item('/settings/devices', 'devices', 'Dispositivos', `${devices.value.length || 1} vinculado${devices.value.length === 1 ? '' : 's'}`)}
          {item('/settings/recovery', 'key', 'Clave de recuperación')}
          {item('/settings/notifications', 'bell', 'Notificaciones')}
        </ul>
        <div class="pad">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}

function LogoutButton() {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button class="btn danger block" onClick={() => setAsk(true)}>
        <Icon name="logout" size={18} /> Cerrar sesión
      </button>
      {ask && (
        <Confirm
          title="Cerrar sesión"
          text="Se borrarán de este navegador la clave de cuenta, los mensajes descifrados y la sesión. Para volver necesitarás otro dispositivo vinculado o la clave de recuperación."
          confirm="Cerrar sesión"
          danger
          onClose={() => setAsk(false)}
          onConfirm={() => engine.logout()}
        />
      )}
    </>
  );
}

export function Devices() {
  const me = session.value!.device.id;
  const [revoke, setRevoke] = useState<Device | null>(null);
  const [linking, setLinking] = useState(false);
  useEffect(() => void engine.refreshMe().catch(showError), []);
  const list = devices.value.length ? devices.value : [session.value!.device];
  return (
    <div class="pane">
      <Header title="Dispositivos" backTo="/settings" />
      <div class="scroll">
        <ul class="menu">
          {list.map(d => (
            <li class="menu-item static">
              <span class="menu-icon">
                <Icon name="devices" />
              </span>
              <span class="menu-text">
                <span>
                  {d.name} {d.id === me && <span class="pill">Este</span>}
                </span>
                <small>
                  {d.platform === 'ios' ? 'iOS' : d.platform === 'web' ? 'Web' : d.platform}
                  {d.push ? ` · push ${d.push === 'apns' ? 'APNs' : 'web'}` : ''} · visto {dateTime(d.lastSeenAt)}
                </small>
              </span>
              <button class="btn small danger" onClick={() => setRevoke(d)}>
                Revocar
              </button>
            </li>
          ))}
        </ul>
        <div class="pad">
          <button class="btn primary block" onClick={() => setLinking(true)}>
            <Icon name="camera" size={18} /> Vincular otro dispositivo
          </button>
        </div>
      </div>
      {revoke && (
        <Confirm
          title="Revocar dispositivo"
          text={
            revoke.id === me
              ? 'Es este dispositivo: se cerrará la sesión y se borrarán sus datos locales.'
              : `«${revoke.name}» perderá el acceso a la cuenta.`
          }
          confirm="Revocar"
          danger
          onClose={() => setRevoke(null)}
          onConfirm={async () => {
            try {
              await engine.api.del(`/api/devices/${encodeURIComponent(revoke.id)}`);
              if (revoke.id === me) await engine.localLogout();
              else {
                devices.value = devices.value.filter(d => d.id !== revoke.id);
                showToast('Dispositivo revocado');
              }
            } catch (e) {
              showError(e);
            }
          }}
        />
      )}
      {linking && <LinkDevice onClose={() => setLinking(false)} />}
    </div>
  );
}

interface BarcodeDetectorLike {
  detect(src: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
  }
}

function LinkDevice({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [info, setInfo] = useState<(LinkInfo & { scanned: string }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState<'off' | 'on' | 'unsupported'>(window.BarcodeDetector ? 'off' : 'unsupported');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  function stopCamera() {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
  }
  useEffect(() => stopCamera, []);

  async function check(raw: string) {
    setError('');
    const parsed = parseLinkText(raw);
    if (!parsed) {
      setError('El texto no es un código de vínculo válido (multichat-link:…).');
      return;
    }
    setBusy(true);
    try {
      const l = await engine.inspectLink(parsed.id, parsed.ephemeralPublicKey);
      setInfo({ ...l, scanned: parsed.ephemeralPublicKey });
    } catch (e) {
      setError(e instanceof HttpError && e.status === 404 ? 'Vínculo no encontrado o caducado.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startCamera() {
    setError('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.current = s;
      setCamera('on');
      requestAnimationFrame(async () => {
        const v = video.current;
        if (!v) return;
        v.srcObject = s;
        await v.play();
        const det = new window.BarcodeDetector!({ formats: ['qr_code'] });
        const tick = async () => {
          if (!stream.current) return;
          try {
            const codes = await det.detect(v);
            const hit = codes.find(c => c.rawValue.startsWith('multichat-link:'));
            if (hit) {
              stopCamera();
              setCamera('off');
              setText(hit.rawValue);
              await check(hit.rawValue);
              return;
            }
          } catch {
            /* fotograma no listo */
          }
          setTimeout(() => void tick(), 250);
        };
        void tick();
      });
    } catch {
      setError('No se pudo abrir la cámara. Pega el texto del vínculo.');
      setCamera('unsupported');
    }
  }

  return (
    <Modal title="Vincular otro dispositivo" onClose={onClose}>
      {!info ? (
        <div class="stack">
          <p class="muted">En el dispositivo nuevo, entra con tu cuenta y elige «Vincular». Escanea su QR o pega el texto que muestra.</p>
          {camera === 'on' && <video ref={video} class="scanner" playsInline muted />}
          {camera === 'off' && (
            <button class="btn block" onClick={() => void startCamera()}>
              <Icon name="camera" size={18} /> Escanear con la cámara
            </button>
          )}
          <form
            class="stack"
            onSubmit={e => {
              e.preventDefault();
              void check(text);
            }}
          >
            <label class="field">
              <span>Texto del vínculo</span>
              <textarea rows={2} spellcheck={false} placeholder="multichat-link:…" value={text} onInput={e => setText(e.currentTarget.value)} />
            </label>
            {error && <div class="form-error">{error}</div>}
            <button class="btn primary block" disabled={busy || !text.trim()}>
              {busy ? <Spinner /> : 'Continuar'}
            </button>
          </form>
        </div>
      ) : (
        <div class="stack">
          <div class="notice warn">
            <Icon name="alert" size={18} />
            <span>
              Vas a darle la clave de tu cuenta a <b>{info.deviceName}</b> ({info.platform === 'ios' ? 'iOS' : info.platform}). Podrá leer
              todos tus mensajes. Apruébalo solo si es tuyo.
            </span>
          </div>
          {error && <div class="form-error">{error}</div>}
          <div class="row gap end">
            <button class="btn" onClick={onClose}>
              Cancelar
            </button>
            <button
              class="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await engine.approveLink(info.id, info.scanned);
                  showToast(`«${info.deviceName}» vinculado`);
                  onClose();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : 'Aprobar'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Recovery() {
  const [shown, setShown] = useState(false);
  const key = accountKey.value!;
  return (
    <div class="pane">
      <Header title="Clave de recuperación" backTo="/settings" />
      <div class="scroll pad stack">
        <div class="notice warn">
          <Icon name="alert" size={18} />
          <span>
            Quien tenga este texto puede leer todos los mensajes de tu cuenta. Guárdalo en un gestor de contraseñas y no lo compartas.
            Sirve para entrar desde un dispositivo nuevo si no tienes otro a mano.
          </span>
        </div>
        {shown ? (
          <CopyField value={recoveryText(key)} secret />
        ) : (
          <button class="btn block" onClick={() => setShown(true)}>
            <Icon name="key" size={18} /> Mostrar clave
          </button>
        )}
      </div>
    </div>
  );
}

export function Notifications() {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!supported) return setEnabled(false);
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setEnabled(!!sub && (await kvGet('pushEnabled')) === true);
    })();
  }, []);

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      if (on) await engine.enablePush();
      else await engine.disablePush();
      setEnabled(on);
      showToast(on ? 'Notificaciones activadas' : 'Notificaciones desactivadas');
    } catch (e) {
      showError(e);
    } finally {
      setPerm(supported ? Notification.permission : 'denied');
      setBusy(false);
    }
  }

  return (
    <div class="pane">
      <Header title="Notificaciones" backTo="/settings" />
      <div class="scroll pad stack">
        {!supported ? (
          <div class="notice warn">
            <Icon name="alert" size={18} /> Este navegador no admite Web Push. En iOS, instala la PWA en la pantalla de inicio.
          </div>
        ) : (
          <>
            <p class="muted">
              El servidor envía un push a este navegador cuando llega un mensaje y la app no está abierta. El contenido viaja cifrado y se
              descifra aquí con la clave de tu cuenta. Los chats silenciados no notifican; los que tienen la vista previa oculta muestran
              un texto genérico.
            </p>
            {perm === 'denied' && <div class="form-error">El permiso de notificaciones está bloqueado en el navegador.</div>}
            {enabled === null ? (
              <Spinner />
            ) : (
              <button class={`btn block ${enabled ? '' : 'primary'}`} disabled={busy} onClick={() => void toggle(!enabled)}>
                {busy ? <Spinner /> : enabled ? 'Desactivar notificaciones' : 'Activar notificaciones'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
