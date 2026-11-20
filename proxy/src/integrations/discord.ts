import { ChannelType, Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { Ctx } from '../store.js';
import { emitContact, ingestInbound, upsertContact } from '../store.js';
import { tx } from '../db/index.js';
import type { Inbound, IntegrationRow } from '../types.js';
import { Driver, PlatformError, requireFields } from './driver.js';

type Creds = { botToken: string };
type Config = { channelIds: string[]; allowDMs: boolean };

const PERMISSIONS = 1024 + 2048 + 32768 + 65536; // ver canal, enviar, adjuntar, leer historial
const clients = new Map<string, Client>();

function config(integ: IntegrationRow): Config {
  const c = JSON.parse(integ.config_json) as Partial<Config>;
  return { channelIds: Array.isArray(c.channelIds) ? c.channelIds.map(String) : [], allowDMs: c.allowDMs !== false };
}

function explain(e: unknown): PlatformError {
  const msg = String((e as Error)?.message ?? e);
  if (/disallowed intents/i.test(msg) || (e as { code?: number })?.code === 4014)
    return new PlatformError('Discord: activa "Message Content Intent" en el portal de desarrolladores (Bot → Privileged Gateway Intents)');
  if (/invalid token|TokenInvalid/i.test(msg)) return new PlatformError('Discord: token inválido');
  return new PlatformError(`Discord: ${msg}`);
}

async function login(token: string): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message],
  });
  const ready = new Promise<void>((res, rej) => {
    client.once(Events.ClientReady, () => res());
    client.once(Events.Error, rej);
    setTimeout(() => rej(new Error('tiempo de espera agotado al conectar')), 20000).unref();
  });
  try {
    await client.login(token);
    await ready;
  } catch (e) {
    void client.destroy();
    throw explain(e);
  }
  return client;
}

function infoOf(client: Client) {
  const id = client.user!.id;
  return {
    botId: id,
    username: client.user!.username,
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${PERMISSIONS}`,
  };
}

function toInbound(m: Message, attachmentIndex: number): Inbound {
  const isDM = m.channel.type === ChannelType.DM;
  const author = m.author;
  const authorName = m.member?.displayName ?? author.globalName ?? author.username;
  const att = [...m.attachments.values()][attachmentIndex];
  const inb: Inbound = {
    externalId: isDM ? `dm:${author.id}` : `ch:${m.channelId}`,
    kind: isDM ? 'direct' : 'group',
    profile: isDM
      ? { name: author.globalName ?? author.username, username: author.username, phone: null }
      : { name: `#${'name' in m.channel ? m.channel.name : m.channelId} · ${m.guild?.name ?? ''}`.trim(), username: null, phone: null },
    platformMessageId: attachmentIndex === 0 ? m.id : `${m.id}:${attachmentIndex}`,
    payloadKind: 'text',
    text: attachmentIndex === 0 ? (m.content || null) : null,
    senderName: isDM ? null : authorName,
  };
  if (att) {
    const mime = att.contentType?.split(';')[0] ?? 'application/octet-stream';
    inb.payloadKind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    inb.media = {
      mime, name: att.name,
      async fetch() {
        const res = await fetch(att.url);
        if (!res.ok) throw new Error(`descarga ${res.status}`);
        return { data: Buffer.from(await res.arrayBuffer()), mime, name: att.name };
      },
    };
  } else if (!inb.text) {
    if (m.stickers.size) inb.text = `[Sticker: ${m.stickers.first()!.name}]`;
    else if (m.embeds.length) inb.text = m.embeds.map(e => e.url ?? e.title ?? '').filter(Boolean).join('\n') || '[Embed]';
    else return { ...inb, payloadKind: 'unsupported', text: '[Mensaje no soportado]' };
  }
  return inb;
}

/** Contactos de grupo para los canales elegidos (nacen aceptados). */
async function syncChannelContacts(ctx: Ctx, integ: IntegrationRow, client: Client) {
  for (const id of config(integ).channelIds) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || !('name' in ch) || !('guild' in ch)) continue;
    const { contact, created } = tx(ctx.db, () => upsertContact(ctx, integ, `ch:${id}`, 'group',
      { name: `#${ch.name} · ${ch.guild.name}`, username: null, phone: null, platform: 'discord' }, 'accepted'));
    if (created) emitContact(ctx, contact);
  }
}

export const discord: Driver<Creds> & {
  channels(integ: IntegrationRow): Promise<{ guilds: { id: string; name: string; channels: { id: string; name: string }[] }[] }>;
  reconfigure(ctx: Ctx, integ: IntegrationRow): Promise<void>;
} = {
  parseCredentials: input => requireFields(input, ['botToken'] as const),
  hintSource: c => c.botToken,

  async validate(_ctx, c) {
    const client = await login(c.botToken);
    const info = infoOf(client);
    await client.destroy();
    return info;
  },

  async start(ctx, integ, c) {
    clients.get(integ.id)?.destroy();
    clients.delete(integ.id);
    const client = await login(c.botToken);
    clients.set(integ.id, client);
    // la fila puede cambiar (config) mientras corre: leerla en cada mensaje
    const current = () => ctx.db.prepare('SELECT * FROM integrations WHERE id = ?').get(integ.id) as IntegrationRow | undefined;
    client.on(Events.MessageCreate, async m => {
      try {
        if (m.author.bot || m.author.id === client.user?.id) return;
        const row = current();
        if (!row || !row.enabled) return;
        const cfg = config(row);
        const isDM = m.channel.type === ChannelType.DM;
        if (isDM ? !cfg.allowDMs : !cfg.channelIds.includes(m.channelId)) return;
        const n = Math.max(1, m.attachments.size);
        for (let i = 0; i < n; i++) await ingestInbound(ctx, row, toInbound(m, i));
      } catch (e) {
        ctx.log.error({ err: String(e), integration: integ.id }, 'error procesando mensaje de Discord');
      }
    });
    client.on(Events.Error, e => ctx.log.warn({ err: String(e), integration: integ.id }, 'discord error'));
    client.on(Events.ShardDisconnect, () => ctx.log.warn({ integration: integ.id }, 'discord desconectado'));
    await syncChannelContacts(ctx, integ, client);
    return { info: infoOf(client) };
  },

  async stop(_ctx, integ) {
    const c = clients.get(integ.id);
    clients.delete(integ.id);
    await c?.destroy();
  },

  async send(_ctx, integ, _c, contact, out) {
    const client = clients.get(integ.id);
    if (!client) throw new PlatformError('Discord: el bot no está conectado');
    const [kind, id] = contact.external_id.split(':') as ['dm' | 'ch', string];
    const target = kind === 'dm'
      ? await (await client.users.fetch(id)).createDM()
      : await client.channels.fetch(id);
    if (!target || !('send' in target)) throw new PlatformError('Discord: no se puede escribir en este canal');
    try {
      const sent = await target.send({
        content: out.text || undefined,
        files: out.file ? [{ attachment: out.file.data, name: out.file.name }] : undefined,
      });
      return { platformMessageId: sent.id };
    } catch (e) {
      throw new PlatformError(`Discord: ${(e as Error).message}`);
    }
  },

  async channels(integ) {
    const client = clients.get(integ.id);
    if (!client) throw new PlatformError('Discord: el bot no está conectado');
    const guilds = [];
    for (const g of client.guilds.cache.values()) {
      const chans = await g.channels.fetch();
      guilds.push({
        id: g.id, name: g.name,
        channels: [...chans.values()]
          .filter(ch => ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
            && ch.permissionsFor(client.user!)?.has(['ViewChannel', 'SendMessages']))
          .map(ch => ({ id: ch!.id, name: ch!.name })),
      });
    }
    return { guilds };
  },

  async reconfigure(ctx, integ) {
    const client = clients.get(integ.id);
    if (client) await syncChannelContacts(ctx, integ, client);
  },
};

export type { Creds as DiscordCreds };
