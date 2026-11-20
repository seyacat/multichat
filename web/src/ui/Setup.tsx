// Configurar la clave de cuenta tras el login (protocol.md §2 y §3).
import { useEffect, useState } from 'preact/hooks';
import { linkText } from '../lib/crypto';
import { kvDel } from '../lib/db';
import { engine } from '../lib/engine';
import { user } from '../lib/store';
import { CopyField, QrCode, Spinner } from './common';
import { Icon } from './icons';
import { Logo } from './Logo';

type Mode = 'choose' | 'link' | 'import';

export function Setup() {
  const u = user.value!;
  const hasKey = !!u.accountPublicKey;
  const [mode, setMode] = useState<Mode>(hasKey ? 'link' : 'choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setBusy(true);
    setError('');
    try {
      await engine.generateAccountKey();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (user.value?.accountPublicKey) setMode('link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="auth">
      <div class="card auth-card setup">
        <div class="auth-brand small">
          <Logo size={40} />
          <h1>{hasKey ? 'Vincula este dispositivo' : 'Crea la clave de tu cuenta'}</h1>
          <p class="muted">{u.email}</p>
        </div>

        {!hasKey && mode === 'choose' && (
          <>
            <p>
              Es el primer dispositivo de la cuenta. Se generará una clave privada que solo vive en tus dispositivos: el
              servidor guarda tus mensajes cifrados con ella y no puede leerlos.
            </p>
            <button class="btn primary block" onClick={generate} disabled={busy}>
              {busy ? <Spinner /> : 'Generar clave de cuenta'}
            </button>
            <button class="btn block" onClick={() => setMode('import')}>
              Ya tengo una clave de recuperación
            </button>
          </>
        )}

        {hasKey && (
          <div class="seg" role="tablist">
            <button role="tab" aria-selected={mode === 'link'} onClick={() => setMode('link')}>
              Vincular
            </button>
            <button role="tab" aria-selected={mode === 'import'} onClick={() => setMode('import')}>
              Clave de recuperación
            </button>
          </div>
        )}

        {mode === 'link' && hasKey && <LinkPanel />}
        {mode === 'import' && <ImportPanel onBack={hasKey ? undefined : () => setMode('choose')} />}

        {error && <div class="form-error">{error}</div>}

        <button class="link-btn center" onClick={() => void engine.logout()}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

function LinkPanel() {
  const [link, setLink] = useState<{ id: string; ephemeralPublicKey: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  async function create() {
    setError('');
    setLink(null);
    try {
      setLink((await engine.currentLink()) ?? (await engine.startLink()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void create();
    const l = (ok: boolean, err?: string) => {
      if (!ok) setError(err ?? 'No se pudo vincular');
    };
    engine.linkListeners.add(l);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      engine.linkListeners.delete(l);
      clearInterval(t);
    };
  }, []);

  const expired = link ? link.expiresAt <= now : false;
  const left = link ? Math.max(0, Math.round((link.expiresAt - now) / 1000)) : 0;
  const text = link ? linkText(link.id, link.ephemeralPublicKey) : '';

  return (
    <div class="link-panel">
      <ol class="steps">
        <li>Abre Multichat en un dispositivo que ya tenga la clave.</li>
        <li>
          Ve a <b>Ajustes → Dispositivos → Vincular otro dispositivo</b>.
        </li>
        <li>Escanea este código o pega el texto de abajo, y aprueba.</li>
      </ol>
      {!link && !error && (
        <div class="center pad">
          <Spinner size={28} />
        </div>
      )}
      {link && !expired && (
        <>
          <div class="qr-wrap">
            <QrCode text={text} />
          </div>
          <CopyField value={text} label="Texto del vínculo" />
          <p class="muted center">
            <Spinner size={12} /> Esperando aprobación · caduca en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </p>
        </>
      )}
      {link && expired && (
        <div class="notice">
          <Icon name="clock" /> El código caducó.
        </div>
      )}
      {(expired || error) && (
        <button
          class="btn block"
          onClick={async () => {
            await kvDel('pendingLink');
            await create();
          }}
        >
          Generar otro código
        </button>
      )}
      {error && <div class="form-error">{error}</div>}
    </div>
  );
}

function ImportPanel({ onBack }: { onBack?: (() => void) | undefined }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      class="stack"
      onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await engine.importRecovery(text);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label class="field">
        <span>Clave de recuperación</span>
        <textarea
          rows={3}
          placeholder="multichat-key:…"
          spellcheck={false}
          autocomplete="off"
          value={text}
          onInput={e => setText(e.currentTarget.value)}
        />
        <small>La encuentras en otro dispositivo en Ajustes → Clave de recuperación. No pasa por el servidor.</small>
      </label>
      {error && <div class="form-error">{error}</div>}
      <button class="btn primary block" disabled={busy || !text.trim()}>
        {busy ? <Spinner /> : 'Importar clave'}
      </button>
      {onBack && (
        <button type="button" class="btn block" onClick={onBack}>
          Volver
        </button>
      )}
    </form>
  );
}
