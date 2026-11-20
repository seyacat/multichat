// Tipos del protocolo (docs/protocol.md) y sus formas descifradas locales.

export type Platform = 'telegram' | 'discord' | 'whatsapp';

export interface User {
  id: string;
  email: string;
  accountPublicKey: string | null;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  createdAt?: number;
  lastSeenAt?: number;
  push?: 'apns' | 'webpush' | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: User;
  device: Device;
}

export interface Integration {
  id: string;
  type: Platform;
  name: string;
  color: string;
  enabled: boolean;
  status: 'connected' | 'connecting' | 'error' | 'disabled';
  statusDetail: string | null;
  credentialHint: string;
  info: Record<string, unknown>;
  config: Record<string, unknown>;
  webhookUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ContactStatus = 'pending' | 'accepted' | 'blocked' | 'archived';

export interface Contact {
  id: string;
  integrationId: string;
  kind: 'direct' | 'group';
  status: ContactStatus;
  profile: string;
  alias: string | null;
  muted: boolean;
  hidePreview: boolean;
  unread: number;
  lastMessageAt: number | null;
  lastInboundAt: number | null;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContactProfile {
  name: string;
  username: string | null;
  phone: string | null;
  platform: Platform;
}

/** Contacto con perfil y alias ya descifrados. */
export interface LocalContact extends Contact {
  profileData: ContactProfile | null;
  aliasName: string | null;
}

export type MessageStatus = 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  contactId: string;
  direction: 'in' | 'out';
  status: MessageStatus;
  error: string | null;
  envelope: string;
  clientId: string | null;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export type PayloadKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'unsupported';

export interface Attachment {
  blobId: string;
  fileKey: string;
  mime: string;
  name: string;
  size: number;
}

export interface MessagePayload {
  v: 1;
  kind: PayloadKind;
  text: string | null;
  senderName: string | null;
  location: { lat: number; lon: number } | null;
  attachment: Attachment | null;
}

/** Mensaje con payload descifrado. Los optimistas tienen id `local:<clientId>`. */
export interface LocalMessage extends Message {
  payload: MessagePayload | null;
  /** Error al descifrar, si lo hubo. */
  decryptError?: boolean;
  /** Mensaje creado en este dispositivo y aún no confirmado por el proxy. */
  local?: boolean;
  /** Progreso de subida 0..1 (solo optimistas con adjunto). */
  progress?: number;
  /** Fallido sustituido por un reintento: no se muestra. */
  dismissed?: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}

export type WsEvent =
  | { type: 'message'; message: Message }
  | { type: 'contact'; contact: Contact }
  | { type: 'contact_deleted'; id: string }
  | { type: 'integration'; integration: Integration }
  | { type: 'integration_deleted'; id: string }
  | { type: 'link'; id: string; sealedKey: string }
  | { type: 'pong' };

export interface PushPayload {
  messageId: string;
  contactId: string;
  hidePreview: boolean;
  profile: string;
  alias: string | null;
  envelope: string | null;
}
