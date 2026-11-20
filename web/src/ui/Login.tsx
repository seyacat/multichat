import { useState } from 'preact/hooks';
import { defaultServer, getServer, setServer } from '../lib/api';
import { engine } from '../lib/engine';
import { Spinner } from './common';
import { Logo } from './Logo';

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Navegador';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return `${browser}${os ? ` en ${os}` : ''}`;
}

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(guessDeviceName);
  const [server, setServerField] = useState(getServer);
  const [showServer, setShowServer] = useState(getServer() !== defaultServer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: Event) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    try {
      new URL(server);
    } catch {
      setError('La dirección del servidor no es válida.');
      return;
    }
    setServer(server);
    setBusy(true);
    try {
      await engine.auth(mode, email.trim(), password, deviceName.trim() || 'PWA');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="auth">
      <form class="card auth-card" onSubmit={submit}>
        <div class="auth-brand">
          <Logo size={56} />
          <h1>Multichat</h1>
          <p>Tus bots de Telegram, Discord y WhatsApp en una sola bandeja, cifrada de extremo a tu dispositivo.</p>
        </div>
        <div class="seg" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
            Entrar
          </button>
          <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')}>
            Crear cuenta
          </button>
        </div>
        <label class="field">
          <span>Correo</span>
          <input type="email" required autocomplete="username" value={email} onInput={e => setEmail(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Contraseña</span>
          <input
            type="password"
            required
            minLength={mode === 'register' ? 8 : undefined}
            autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onInput={e => setPassword(e.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>Nombre de este dispositivo</span>
          <input required value={deviceName} onInput={e => setDeviceName(e.currentTarget.value)} />
        </label>
        {showServer ? (
          <label class="field">
            <span>Servidor</span>
            <input type="url" required value={server} onInput={e => setServerField(e.currentTarget.value)} />
            <small>Por defecto: {defaultServer()}</small>
          </label>
        ) : (
          <button type="button" class="link-btn" onClick={() => setShowServer(true)}>
            Servidor: {server}
          </button>
        )}
        {error && <div class="form-error">{error}</div>}
        <button class="btn primary block" disabled={busy}>
          {busy ? <Spinner /> : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </button>
      </form>
    </div>
  );
}
