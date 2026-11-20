# Notas de implementación de la PWA

Puntos del protocolo (docs/protocol.md) ambiguos o sin especificar, y lo que hace la PWA. No se ha cambiado el protocolo.

1. **Cursor de sincronización.** El protocolo dice que contactos y mensajes comparten contador y que se sincroniza «con el mayor `seq` visto». Si se usa un solo cursor, un contacto que cambia entre la llamada a `/api/contacts` y la de `/api/messages` puede quedar atrás. La PWA guarda dos cursores (`contactsSeq` y `messagesSeq`), cada uno con el mayor `seq` visto de su tipo.

2. **Reintentar un envío fallido.** No existe un endpoint de reintento. La PWA oculta el fallido (marca local `dismissed`, no se borra en el servidor) y envía uno nuevo con otro `clientId`. Si es media y ya no tiene el archivo en memoria, descarga y descifra el blob y lo vuelve a subir.

3. **Respuesta 202 frente al WebSocket.** El `sent` puede llegar por WS antes que la respuesta 202 (`pending`). La PWA nunca sustituye un mensaje por otro con `seq` menor y sustituye el optimista por `clientId`.

4. **«Borrar historial».** Solo existe `DELETE /api/contacts/:id`, que borra contacto e historial. La ficha lo presenta como «Borrar historial y contacto». No hay forma de vaciar mensajes conservando el contacto.

5. **`hidePreview`.** Se aplica solo a las notificaciones (push con título y texto genéricos). La lista de chats muestra la vista previa siempre, porque está en el propio dispositivo descifrada.

6. **Desbloquear y desarchivar.** No hay estado previo guardado: ambos ponen `status: "accepted"`.

7. **Selección de canales de Discord.** `GET /api/integrations/:id/discord/channels` requiere que la integración exista, así que en el alta solo se elige el interruptor de DMs (`config: { channelIds: [], allowDMs }`) y los canales se eligen después, en la ficha de la integración.

8. **Importar clave en una cuenta sin clave.** Si `accountPublicKey` es `null` y el usuario importa una clave de recuperación, la PWA sube su pública con `PUT /api/account/key`.

9. **Aviso de 24 h de WhatsApp.** Se muestra en chats directos `accepted` de WhatsApp si `lastInboundAt` es `null` o tiene más de 24 h. El envío no se bloquea.

10. **Token del WebSocket.** El token va en la query y caduca a los 15 min. La PWA no cierra el WS al caducar; antes de cada (re)conexión llama a `GET /api/me`, que refresca el token si hace falta.

11. **Ruta del build.** El proxy sirve la PWA en `/app/` (`SERVE_WEB_DIR`). El build usa rutas relativas y el service worker controla su carpeta (`/app/`), no la raíz.

12. **Payload de Web Push.** El service worker acepta el objeto `mc` directo (lo que manda el proxy) o envuelto en `{ "mc": … }`. Si `envelope` es `null`, muestra el nombre del contacto y «Nuevo mensaje».

13. **Envíos interrumpidos.** Un mensaje optimista que seguía `pending` al recargar la página pasa a `failed` («Envío interrumpido») y se puede reintentar.
