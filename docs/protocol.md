# Protocolo app ↔ proxy (v1)

Contrato común para la PWA (`web/`) y la app iOS (`ios/`). Todo JSON en UTF-8. Binarios en **base64url sin relleno** (`b64u`). Fechas: milisegundos Unix (`number`). IDs: strings opacos.

Base URL: `https://<dominio>` (en desarrollo `http://localhost:8787`). Todas las rutas de la API cuelgan de `/api`.

Autenticación: cabecera `Authorization: Bearer <accessToken>` en todo salvo `/api/auth/*` y `/api/health`.

Errores: código HTTP ≠ 2xx con cuerpo `{ "error": "<codigo>", "message": "<texto para mostrar>" }`.
Códigos: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `limit_reached`, `platform_error`, `too_large`, `internal`.

---

## 1. Cifrado

Ver [crypto.md](crypto.md). Resumen:
- `accountPublicKey`: X25519 crudo, 32 bytes, b64u.
- `envelope`: sobre sellado a la clave de cuenta, b64u. Al abrirlo da bytes UTF-8 de un JSON.
- Blobs (media): archivo cifrado por trozos con una `fileKey` que va dentro del sobre del mensaje.

---

## 2. Auth y dispositivos

### `POST /api/auth/register`
```json
{ "email": "a@b.c", "password": "min 8", "deviceName": "iPhone de Ana", "platform": "ios" | "web" }
```
→ `201` `Session`

### `POST /api/auth/login`
Mismo cuerpo → `200` `Session`. Credenciales malas → `401 unauthorized`.

### `POST /api/auth/refresh`
`{ "refreshToken": "..." }` → `200` `Session` (rota el refresh; el anterior deja de valer).

### `POST /api/auth/logout`
Con Bearer. Borra el dispositivo actual → `204`.

`Session`:
```json
{
  "accessToken": "…",          // vale 15 min
  "refreshToken": "…",         // vale 90 días, uno por dispositivo
  "user": { "id": "u_…", "email": "a@b.c", "accountPublicKey": "b64u" | null },
  "device": { "id": "d_…", "name": "…", "platform": "ios" }
}
```

Tras login, la app decide:
- `accountPublicKey == null` → es el primer dispositivo: genera la clave de cuenta y llama `PUT /api/account/key`.
- `accountPublicKey != null` y la app no tiene la privada → pantalla **Vincular** (sección 3) o **Importar clave de recuperación**.
- La app tiene la privada → comprueba que su pública coincide con `accountPublicKey`; si no coincide, se descarta y se vuelve a vincular.

### `PUT /api/account/key`
`{ "publicKey": "b64u" }` → `204`. Si ya hay clave: `409 conflict`.

### `GET /api/me`
→ `{ "user": User, "device": Device, "devices": Device[] }`

`Device`: `{ "id", "name", "platform", "createdAt", "lastSeenAt", "push": "apns" | "webpush" | null }`

### `DELETE /api/devices/:id`
Revoca otro dispositivo (o el propio) → `204`.

---

## 3. Vincular un dispositivo nuevo

1. Dispositivo nuevo (ya con sesión): genera par X25519 efímero `E`.
   `POST /api/link` `{ "ephemeralPublicKey": "b64u" }` → `{ "id": "l_…", "expiresAt": ms }` (10 min).
2. Muestra un QR con el texto `multichat-link:<id>:<ephemeralPublicKey>`. También muestra ese texto para copiar (la PWA en escritorio puede pegarlo).
3. Dispositivo ya vinculado: escanea o pega el texto. Llama `GET /api/link/:id` → `{ "id", "ephemeralPublicKey", "deviceName", "platform", "status": "pending"|"approved"|"expired" }`. **Comprueba que `ephemeralPublicKey` es igual al del QR**; si no, aborta. Pide confirmación al usuario mostrando `deviceName`.
4. Aprueba: `POST /api/link/:id/approve` `{ "sealedKey": seal(accountPrivateKeyRaw32, E.public) }` → `204`.
5. El dispositivo nuevo recibe por WebSocket `{ "type": "link", "id", "sealedKey" }` (o consulta `GET /api/link/:id`, que trae `sealedKey` cuando `status == "approved"` y lo pide el mismo dispositivo que lo creó). Abre con `E.private`, guarda la privada de cuenta y verifica que su pública coincide con `accountPublicKey`.

Clave de recuperación: la app puede mostrar la privada de cuenta como texto `multichat-key:<b64u 32 bytes>` (Ajustes → Clave de recuperación) e importarla en un dispositivo nuevo. No pasa por el proxy.

---

## 4. Integraciones

`Integration`:
```json
{
  "id": "i_…",
  "type": "telegram" | "discord" | "whatsapp",
  "name": "Bot de ventas",         // lo elige el usuario
  "color": "#3b82f6",              // lo elige el usuario
  "enabled": true,
  "status": "connected" | "connecting" | "error" | "disabled",
  "statusDetail": "texto" | null,  // mensaje de la plataforma si hay error
  "credentialHint": "…a1B2",       // últimos 4 caracteres del secreto principal
  "info": { … },                   // datos públicos devueltos por la plataforma (ver abajo)
  "config": { … },                 // ajustes no secretos (ver abajo)
  "webhookUrl": "https://…" | null,
  "createdAt": ms, "updatedAt": ms
}
```

Credenciales por tipo (solo de entrada; nunca se devuelven):
| type | `credentials` | `config` | `info` |
|---|---|---|---|
| telegram | `{ "botToken" }` | `{}` | `{ "botId", "username", "firstName" }` |
| discord | `{ "botToken" }` | `{ "channelIds": string[], "allowDMs": bool }` | `{ "botId", "username", "inviteUrl" }` |
| whatsapp | `{ "appId", "appSecret", "accessToken", "phoneNumberId", "wabaId" }` | `{ "verifyToken" }` (lo genera el proxy, solo lectura) | `{ "displayPhoneNumber", "verifiedName", "webhookRegistered": bool }` |

### `GET /api/integrations` → `Integration[]`
### `POST /api/integrations/test`
`{ "type", "credentials" }` → `200 { "ok": true, "info": {…} }` o `400 platform_error` con el mensaje de la plataforma. No guarda nada.
### `POST /api/integrations`
`{ "type", "name", "color", "credentials", "config"? }` → `201 Integration`. Valida contra la plataforma, guarda cifrado y arranca (Telegram: `setWebhook`; WhatsApp: registra el webhook; Discord: conecta al gateway). Límite por usuario → `403 limit_reached`.
### `PATCH /api/integrations/:id`
Cualquiera de `{ "name", "color", "enabled", "credentials", "config" }` → `200 Integration`. Cambiar `credentials` re-valida y reinicia.
### `DELETE /api/integrations/:id` → `204`
Para la integración, deshace el webhook y borra sus contactos y mensajes.
### `GET /api/integrations/:id/discord/channels`
→ `{ "guilds": [ { "id", "name", "channels": [ { "id", "name" } ] } ] }` (solo canales de texto que el bot ve).

Al activar un canal de Discord en `config.channelIds`, el proxy crea su contacto de grupo con estado `accepted`.

---

## 5. Contactos

`Contact`:
```json
{
  "id": "c_…",
  "integrationId": "i_…",
  "kind": "direct" | "group",
  "status": "pending" | "accepted" | "blocked" | "archived",
  "profile": "envelope",           // sellado por el proxy: ContactProfile
  "alias": "envelope" | null,      // sellado por la app: { "name": "…" }
  "muted": false,
  "hidePreview": false,
  "unread": 3,
  "lastMessageAt": ms | null,
  "lastInboundAt": ms | null,      // WhatsApp: si hace > 24 h, mostrar aviso de ventana cerrada
  "seq": 123,
  "createdAt": ms, "updatedAt": ms
}
```
`ContactProfile` (JSON dentro del sobre): `{ "name": "Ana", "username": "ana_99" | null, "phone": "+593…" | null, "platform": "telegram" }`.

Nombre a mostrar: `alias.name` si existe, si no `profile.name`.

Un contacto que escribe por primera vez a un bot nace `pending` (aparece en **Solicitudes**). Sus mensajes se guardan. Con `blocked`, el proxy descarta lo que llegue. `archived` sigue recibiendo y vuelve a la lista principal si llega algo.

### `GET /api/contacts?since=<seq>` → `Contact[]` con `seq > since` (sin `since`: todos)
### `PATCH /api/contacts/:id`
Cualquiera de `{ "status", "alias", "muted", "hidePreview", "read": true }` → `200 Contact`. `read: true` pone `unread = 0`.
### `DELETE /api/contacts/:id` → `204` (borra contacto e historial)

---

## 6. Mensajes

`Message`:
```json
{
  "id": "m_…",
  "contactId": "c_…",
  "direction": "in" | "out",
  "status": "received" | "pending" | "sent" | "delivered" | "read" | "failed",
  "error": "texto" | null,
  "envelope": "envelope",          // MessagePayload sellado
  "clientId": "uuid" | null,       // el que mandó la app al enviar
  "seq": 456,
  "createdAt": ms, "updatedAt": ms
}
```

`MessagePayload` (JSON dentro del sobre):
```json
{
  "v": 1,
  "kind": "text" | "image" | "video" | "audio" | "file" | "sticker" | "location" | "unsupported",
  "text": "hola" | null,                 // texto o pie de foto
  "senderName": "Pedro" | null,          // en grupos: quién lo dijo
  "location": { "lat": 0, "lon": 0 } | null,
  "attachment": {
    "blobId": "b_…",
    "fileKey": "b64u 32 bytes",
    "mime": "image/jpeg",
    "name": "foto.jpg",
    "size": 12345                        // tamaño en claro
  } | null
}
```

### `GET /api/messages?since=<seq>&limit=<n≤1000>`
→ `{ "messages": Message[], "more": bool }` ordenados por `seq`. Un cambio de estado reemite el mensaje con `seq` nuevo. La app sincroniza con el mayor `seq` visto (mensajes y contactos comparten el mismo contador por usuario).

### `GET /api/contacts/:id/messages?before=<createdAt>&limit=<n≤200>`
→ `Message[]` más recientes primero (para paginar hacia atrás).

### `POST /api/contacts/:id/messages`
- Texto: `application/json` `{ "clientId": "uuid", "text": "hola" }`
- Media: `multipart/form-data` con campos `clientId`, `text` (pie, opcional), `kind` (`image`|`video`|`audio`|`file`) y una parte `file` (con nombre y content-type).

→ `202 Message` con `status: "pending"`. El resultado (`sent` / `failed` + `error`) llega por WebSocket y por `GET /api/messages?since`. Solo contactos `accepted`.

Límites de subida: Telegram 50 MB, Discord 10 MB, WhatsApp 16 MB (video/audio), 5 MB imagen, 100 MB documento. Exceder → `413 too_large`.

### `GET /api/blobs/:id`
→ bytes cifrados (`application/octet-stream`, formato MCB1 de crypto.md). La app descifra con `attachment.fileKey`.

---

## 7. Tiempo real

`GET /api/ws?token=<accessToken>` (WebSocket). Mensajes del servidor (JSON):
```json
{ "type": "message", "message": Message }
{ "type": "contact", "contact": Contact }
{ "type": "contact_deleted", "id": "c_…" }
{ "type": "integration", "integration": Integration }
{ "type": "integration_deleted", "id": "i_…" }
{ "type": "link", "id": "l_…", "sealedKey": "envelope" }
{ "type": "pong" }
```
Cliente → servidor: `{ "type": "ping" }` cada 25 s. Al reconectar, la app llama `GET /api/contacts?since` y `GET /api/messages?since`.

---

## 8. Notificaciones push

### `GET /api/push/vapid` → `{ "publicKey": "b64u" | null }`
### `PUT /api/devices/me/push`
- iOS: `{ "kind": "apns", "token": "hex", "environment": "sandbox" | "production" }`
- PWA: `{ "kind": "webpush", "subscription": PushSubscriptionJSON }`
- Quitar: `{ "kind": null }`

→ `204`. El proxy manda push a cada dispositivo del usuario sin WebSocket abierto cuando entra un mensaje (contactos `accepted` y `pending`, no `muted`).

Payload APNs:
```json
{
  "aps": { "alert": { "title": "Multichat", "body": "Nuevo mensaje" }, "mutable-content": 1, "sound": "default", "thread-id": "c_…" },
  "mc": { "messageId": "m_…", "contactId": "c_…", "hidePreview": false, "profile": "envelope", "alias": "envelope"|null, "envelope": "envelope" | null }
}
```
`envelope` va `null` si el payload pasaría de 4 KB; la extensión lo baja con `GET /api/messages?since=<seq-1>` o muestra el texto genérico.

Web Push: el cuerpo es el objeto `mc` en JSON; el service worker lo descifra con la clave de IndexedDB.

---

## 9. Webhooks de plataformas (no los usa la app)

- `POST /wh/telegram/:integrationId` — cabecera `X-Telegram-Bot-Api-Secret-Token`.
- `GET /wh/whatsapp/:integrationId` — verificación `hub.mode/hub.verify_token/hub.challenge`.
- `POST /wh/whatsapp/:integrationId` — firma `X-Hub-Signature-256`.
- Discord no usa webhooks: el proxy mantiene una conexión gateway por bot.
