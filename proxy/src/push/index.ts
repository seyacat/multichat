import * as webpush from 'web-push';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { Hub } from '../hub.js';
import type { ContactRow, MessageRow } from '../types.js';
import { Apns } from './apns.js';

const APNS_MAX = 4096;

interface DeviceRow { id: string; push_kind: string | null; push_data: string | null }

export class Push {
  private apns: Apns | null;
  constructor(private readonly config: Config, private readonly db: DB, private readonly hub: Hub,
              private readonly log: { warn: (...a: unknown[]) => void }) {
    this.apns = config.apns ? new Apns(config.apns) : null;
    if (config.vapid) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  }

  get vapidPublicKey() { return this.config.vapid?.publicKey ?? null; }

  private clear(deviceId: string) {
    this.db.prepare('UPDATE devices SET push_kind = NULL, push_data = NULL WHERE id = ?').run(deviceId);
  }

  async notifyMessage(contact: ContactRow, msg: MessageRow) {
    const online = this.hub.connectedDevices(contact.user_id);
    const devices = (this.db.prepare('SELECT id, push_kind, push_data FROM devices WHERE user_id = ? AND push_kind IS NOT NULL')
      .all(contact.user_id) as unknown as DeviceRow[]).filter(d => !online.has(d.id));
    if (!devices.length) return;
    const mc = {
      messageId: msg.id, contactId: contact.id, seq: msg.seq, hidePreview: !!contact.hide_preview,
      profile: contact.profile_env, alias: contact.alias_env, envelope: msg.envelope as string | null,
    };
    await Promise.all(devices.map(async d => {
      try {
        const data = JSON.parse(d.push_data!);
        if (d.push_kind === 'apns' && this.apns) {
          const body = (env: string | null) => ({
            aps: { alert: { title: 'Multichat', body: contact.status === 'pending' ? 'Nueva solicitud de chat' : 'Nuevo mensaje' },
                   'mutable-content': 1, sound: 'default', 'thread-id': contact.id },
            mc: { ...mc, envelope: env },
          });
          let payload = body(mc.envelope);
          if (Buffer.byteLength(JSON.stringify(payload)) > APNS_MAX) payload = body(null);
          const r = await this.apns.send(data.token, data.environment === 'production' ? 'production' : 'sandbox', payload);
          if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') this.clear(d.id);
          else if (r.status !== 200) this.log.warn({ device: d.id, status: r.status, reason: r.reason }, 'APNs rechazó el push');
        } else if (d.push_kind === 'webpush' && this.config.vapid) {
          await webpush.sendNotification(data.subscription, JSON.stringify(mc), { TTL: 86400, urgency: 'high', topic: contact.id.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') });
        }
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) this.clear(d.id);
        else this.log.warn({ device: d.id, err: String(e) }, 'push falló');
      }
    }));
  }

  close() { this.apns?.close(); }
}
