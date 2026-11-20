# Cómo crear cada cuenta

Todo se configura desde la app (iOS o PWA): Ajustes → Integraciones → Añadir. Puedes añadir varias cuentas de cada tipo. El proxy valida las credenciales, las guarda cifradas y registra los webhooks solo.

## Telegram (bot)

1. En Telegram, abre @BotFather → `/newbot` → nombre y usuario.
2. Copia el token (`123456:ABC…`) y pégalo en la app.
3. El proxy llama `setWebhook` con su URL pública. No hay que copiar nada más.
4. Los contactos escriben al bot (`t.me/<usuario_bot>`). El primer mensaje crea una solicitud en la app.

Para que el bot lea mensajes en grupos: BotFather → `/setprivacy` → Disable.
Límites de la Bot API: los bots descargan hasta 20 MB y suben hasta 50 MB.

## Discord (bot)

1. https://discord.com/developers/applications → New Application.
2. Bot → Reset Token → copia el token.
3. Bot → Privileged Gateway Intents → activa **Message Content Intent**.
4. Pega el token en la app. Con el enlace de invitación que muestra la app, añade el bot a tu servidor.
5. En la app, elige qué canales escuchar y si acepta mensajes directos.
   - Cada canal elegido es un chat de grupo.
   - Cada usuario que escribe por DM al bot es un contacto 1:1 (empieza como solicitud).

Límite de adjuntos: 10 MB.

## WhatsApp Cloud API (pruebas)

1. https://developers.facebook.com → Crear app → tipo Business → añadir el producto WhatsApp.
2. WhatsApp → API Setup: ahí está el número de prueba, el **Phone Number ID** y el **WhatsApp Business Account ID** (WABA ID).
3. Token: el temporal de API Setup dura 24 h. Para uno duradero, crea un usuario del sistema en Business Settings con permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
4. App settings → Basic: **App ID** y **App Secret**.
5. Pega los cinco datos en la app. El proxy:
   - registra el webhook de la app (`/{app-id}/subscriptions`) con un verify token propio;
   - suscribe la app a la WABA (`/{waba-id}/subscribed_apps`).
   Si Meta rechaza el registro automático, la app muestra la URL del webhook y el verify token para pegarlos a mano en WhatsApp → Configuration.
6. Número de prueba: solo puede escribir a 5 números verificados (API Setup → To). El contacto debe escribir primero.
   - Fuera de la ventana de 24 h desde su último mensaje, WhatsApp solo acepta plantillas. La app muestra el aviso.

Meta usa una sola URL de webhook por app. Si añades varios números de la misma app de Meta, el proxy enruta por `phone_number_id`.
