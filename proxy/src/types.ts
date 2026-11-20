import type { Readable } from 'node:stream';

export type IntegrationType = 'telegram' | 'discord' | 'whatsapp';
export type ContactStatus = 'pending' | 'accepted' | 'blocked' | 'archived';
export type MessageStatus = 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type PayloadKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'unsupported';

export interface ContactProfile { name: string; username: string | null; phone: string | null; platform: IntegrationType }

export interface MessagePayload {
  v: 1;
  kind: PayloadKind;
  text: string | null;
  senderName: string | null;
  location: { lat: number; lon: number } | null;
  attachment: { blobId: string; fileKey: string; mime: string; name: string; size: number } | null;
}

export interface MediaSource {
  /** Descarga del archivo de la plataforma. */
  fetch(): Promise<{ data: Buffer | Readable | AsyncIterable<Uint8Array>; mime?: string; name?: string }>;
  mime: string;
  name: string;
}

/** Mensaje entrante normalizado por cada driver. */
export interface Inbound {
  externalId: string;
  kind: 'direct' | 'group';
  profile: Omit<ContactProfile, 'platform'>;
  platformMessageId: string | null;
  payloadKind: PayloadKind;
  text: string | null;
  senderName: string | null;
  location?: { lat: number; lon: number } | null;
  media?: MediaSource | null;
  /** Texto a mostrar si el adjunto no se pudo descargar (p. ej. supera el límite de la plataforma). */
  mediaError?: string | null;
}

export interface Outgoing {
  kind: 'text' | 'image' | 'video' | 'audio' | 'file';
  text: string | null;
  file: { data: Buffer; mime: string; name: string } | null;
}

export interface IntegrationRow {
  id: string; user_id: string; type: IntegrationType; name: string; color: string;
  enabled: number; status: string; status_detail: string | null;
  credentials_enc: string; credential_hint: string; webhook_secret: string;
  config_json: string; info_json: string; lookup_key: string | null;
  created_at: number; updated_at: number;
}

export interface ContactRow {
  id: string; user_id: string; integration_id: string; external_id: string; kind: 'direct' | 'group';
  status: ContactStatus; profile_env: string; profile_mac: string; alias_env: string | null;
  muted: number; hide_preview: number; unread: number;
  last_message_at: number | null; last_inbound_at: number | null;
  seq: number; created_at: number; updated_at: number;
}

export interface MessageRow {
  id: string; user_id: string; contact_id: string; direction: 'in' | 'out'; status: MessageStatus;
  error: string | null; envelope: string; platform_message_id: string | null; client_id: string | null;
  blob_id: string | null; seq: number; created_at: number; updated_at: number;
}
