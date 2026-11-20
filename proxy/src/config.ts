import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function env(name: string, def?: string): string {
  const v = process.env[name] ?? def;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export interface Config {
  port: number;
  host: string;
  publicUrl: string;          // URL pública para webhooks, sin barra final
  dataDir: string;
  masterKey: Buffer;
  maxIntegrationsPerUser: number;
  serveWeb: string | null;    // carpeta del build de la PWA, servida en /app
  graphVersion: string;
  apns: { keyP8: string; keyId: string; teamId: string; topic: string } | null;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  corsOrigins: string[] | true;
}

export function loadConfig(): Config {
  const mk = env('MASTER_KEY');
  const masterKey = Buffer.from(mk, /^[0-9a-f]{64,}$/i.test(mk) ? 'hex' : 'base64url');
  const apnsKey = process.env.APNS_KEY_P8 ?? (process.env.APNS_KEY_FILE ? require_file(process.env.APNS_KEY_FILE) : undefined);
  return {
    port: Number(env('PORT', '8787')),
    host: env('HOST', '0.0.0.0'),
    publicUrl: env('PUBLIC_URL', 'http://localhost:8787').replace(/\/+$/, ''),
    dataDir: resolve(env('DATA_DIR', './data')),
    masterKey,
    maxIntegrationsPerUser: Number(env('MAX_INTEGRATIONS_PER_USER', '20')),
    serveWeb: process.env.SERVE_WEB_DIR ? resolve(process.env.SERVE_WEB_DIR) : null,
    graphVersion: env('WHATSAPP_GRAPH_VERSION', 'v23.0'),
    apns: apnsKey && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID
      ? { keyP8: apnsKey, keyId: process.env.APNS_KEY_ID, teamId: process.env.APNS_TEAM_ID, topic: env('APNS_TOPIC', 'com.dotrino.multichat') }
      : null,
    vapid: process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: env('VAPID_SUBJECT', 'mailto:admin@example.com') }
      : null,
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : true,
  };
}

function require_file(p: string): string {
  return readFileSync(p, 'utf8');
}
