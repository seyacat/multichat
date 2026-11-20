# Multichat

Bandeja única estilo WhatsApp para varias cuentas de mensajería: bots de Telegram, bots de Discord y números de WhatsApp Cloud API (modo pruebas). Varias cuentas de cada tipo por usuario.

| Parte | Carpeta | Stack |
|---|---|---|
| Proxy con dirección pública (webhooks, gateway de Discord, almacén cifrado, push) | `proxy/` | Node 24 + TypeScript, Fastify, `node:sqlite` |
| PWA de pruebas locales (misma funcionalidad que iOS) | `web/` | Vite + TypeScript + Preact |
| App iOS | `ios/` | Swift + SwiftUI (iOS 17+), XcodeGen |
| Despliegue | `deploy/` | Docker Compose + Caddy |

## Cifrado

El proxy sella cada mensaje entrante con la clave pública de la cuenta del usuario (X25519 + HKDF + AES-GCM). Solo los dispositivos del usuario tienen la privada. Ver [docs/crypto.md](docs/crypto.md).

Límites conocidos:
- El proxy ve el contenido saliente al reenviarlo a la plataforma, y el entrante en el momento de recibirlo. No lo guarda en claro.
- Las credenciales de los bots se guardan cifradas con la clave maestra del servidor, porque el proxy las necesita para enviar.

## Documentación

- [docs/protocol.md](docs/protocol.md) — API app ↔ proxy
- [docs/crypto.md](docs/crypto.md) — formato de sobres y blobs
- [docs/integrations.md](docs/integrations.md) — cómo crear cada bot/cuenta
- [docs/development.md](docs/development.md) — desarrollo local, túnel, compilación iOS

## Licencia

MIT
