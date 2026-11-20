import { connect, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

export interface ApnsConfig { keyP8: string; keyId: string; teamId: string; topic: string }

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' } as const;

/** Cliente APNs mínimo: HTTP/2 + JWT ES256 (token renovado cada 50 min). */
export class Apns {
  private sessions = new Map<string, ClientHttp2Session>();
  private jwt: { token: string; at: number } | null = null;
  private readonly key;
  constructor(private readonly cfg: ApnsConfig) {
    this.key = createPrivateKey(cfg.keyP8);
  }
  private token(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.at < 50 * 60) return this.jwt.token;
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: this.cfg.teamId, iat: now })).toString('base64url');
    const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { token: `${h}.${p}.${s}`, at: now };
    return this.jwt.token;
  }
  private session(env: keyof typeof HOSTS): ClientHttp2Session {
    let s = this.sessions.get(env);
    if (!s || s.closed || s.destroyed) {
      s = connect(HOSTS[env]);
      s.on('error', () => this.sessions.delete(env));
      s.on('close', () => this.sessions.delete(env));
      s.unref();
      this.sessions.set(env, s);
    }
    return s;
  }
  /** Devuelve el código HTTP y la razón si falla. 410/400 BadDeviceToken = token muerto. */
  send(deviceToken: string, env: 'production' | 'sandbox', payload: unknown, opts: { collapseId?: string } = {}): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const req = this.session(env).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.token()}`,
        'apns-topic': this.cfg.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId } : {}),
      });
      let status = 0;
      let body = '';
      req.on('response', h => { status = Number(h[':status']); });
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let reason: string | undefined;
        try { reason = body ? JSON.parse(body).reason : undefined; } catch { /* vacío */ }
        resolve({ status, reason });
      });
      req.on('error', reject);
      req.end(JSON.stringify(payload));
    });
  }
  close() {
    for (const s of this.sessions.values()) s.close();
  }
}
