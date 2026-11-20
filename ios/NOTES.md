# Notas de implementación iOS

Puntos donde `docs/protocol.md` no es explícito. No se cambió el protocolo: se eligió lo razonable.

## Push sin sobre (§8)
El `mc` del push no trae el `seq` del mensaje. Si `envelope` viene `null`, la extensión pide `GET /api/messages?since=<último seq sincronizado por la app>` (lo guarda la app en el App Group) y busca `messageId`, hasta 3 páginas de 200. Si no lo encuentra, deja el texto genérico. Proponer: añadir `seq` a `mc`.

## Rotación del refresh token entre app y extensión
`POST /api/auth/refresh` rota el token. Si la extensión refresca, guarda la sesión nueva en el Keychain compartido; la app, antes de refrescar, relee el Keychain y usa el token más nuevo. Sigue habiendo una carrera posible si ambas refrescan a la vez (una de las dos recibiría 401 y la app cerraría sesión).

## Sincronización (§5, §6)
Contactos y mensajes comparten contador, pero `GET /api/contacts?since` no pagina. Orden: integraciones → contactos `since` → mensajes `since` paginando con `more` → contactos otra vez desde el mayor `seq` de contacto visto (recoge los que cambiaron durante la paginación). Se guarda como último seq el máximo visto.

## Reintentar un envío fallido (§6)
- Si el POST nunca obtuvo `202` (error de red), se repite con el **mismo** `clientId`. Se asume que el proxy lo trata como idempotente o, al menos, que no pasa nada por un duplicado.
- Si el proxy devolvió el mensaje con `status: failed`, no hay endpoint para reintentar ni para borrar un mensaje suelto: se envía una copia nueva (nuevo `clientId`) y el original se oculta solo en este dispositivo.

## Alias (§5)
Quitar el alias = `PATCH { "alias": null }` (null explícito).

## `hidePreview`
Se aplica a las notificaciones (la extensión muestra «Nuevo mensaje») y también a la vista previa de la lista de chats.

## Cerrar sesión
Además de `POST /api/auth/logout` (y quitar el push), se borran del dispositivo la clave de cuenta, la sesión, la caché SwiftData y los blobs. Revocar el propio dispositivo desde Dispositivos hace lo mismo.

## Clave de cuenta
- Al generar (primer dispositivo) la privada se guarda en Keychain antes del `PUT /api/account/key`; si el PUT falla se borra. Con `409 conflict` se relee `/api/me` y se pasa a vincular.
- Importar una clave de recuperación en una cuenta sin clave pública sube esa pública con `PUT /api/account/key`.
- Aprobar un vínculo solo si `status == "pending"` y la `ephemeralPublicKey` coincide con la del QR.
- El dispositivo nuevo espera el evento `link` por WebSocket y, como respaldo, consulta `GET /api/link/:id` cada 3 s.

## WebSocket (§7)
El token va en la query y solo se valida al conectar (se asume). La app refresca el access token si tiene más de 13 min antes de cada conexión. La conexión se da por buena al recibir el primer mensaje (el `pong` del primer `ping`, que se envía nada más abrir).

## Integraciones (§4)
- Discord se crea con `config: { "channelIds": [], "allowDMs": true }`; los canales se eligen después en la ficha.
- `color` se manda como `#rrggbb` en minúsculas.
- `credentialHint` se muestra tal cual llega.
- WhatsApp: si `info.webhookRegistered` es `false` se muestran `webhookUrl` y `config.verifyToken` para configurarlo a mano en Meta.

## Envío de media (§6)
- Las fotos de la fototeca y la cámara se convierten a JPEG (HEIC no lo aceptan todas las plataformas).
- `kind` se deduce del tipo del archivo: imagen → `image`, video → `video`, audio → `audio`, resto → `file`.
- El texto escrito en la caja al adjuntar se envía como pie (`text`).
- El archivo enviado se guarda en el App Group (`outbox/`) para previsualizarlo sin bajar el blob y para reintentar.

## Ventana de 24 h de WhatsApp
Aviso si `lastInboundAt` es `null` o tiene más de 24 h. No bloquea el envío: el proxy devolverá `failed` si Meta lo rechaza.

## Mensajes antiguos
`GET /api/contacts/:id/messages?before=` usa el `createdAt` del mensaje más antiguo en caché (de los que ya tienen id del servidor).

## Stickers
Se muestran como imagen si iOS sabe decodificarla (WebP sí; los animados `.tgs`/`.webm` no).
