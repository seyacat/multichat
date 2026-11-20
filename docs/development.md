# Desarrollo local

## Proxy

```bash
cd proxy
npm install
node scripts/gen-keys.mjs > .env.local     # MASTER_KEY y VAPID de desarrollo
set -a; . ./.env.local; set +a
PUBLIC_URL=https://<tu-túnel> npm run dev   # escucha en :8787
npm test
```

Los webhooks de Telegram y WhatsApp necesitan una URL pública con HTTPS. En desarrollo se usa el túnel de Dotrino, que da una URL fija por aparato:

```bash
npx @dotrino/tunnel 8787 --name multichat
# imprime https://r.dotrino.com/<llave>  → úsala como PUBLIC_URL
```

- La dirección sale de la llave del aparato `multichat` (`~/.dotrino/agent/tunnel/multichat/`): no cambia entre reinicios.
- Cambia solo si se empareja con una bóveda (`dotrino-tunnel enroll`). Entonces hay que pausar y reactivar cada integración desde la app para que vuelva a registrar el webhook.
- Tope de 50 MB por petición. Los webhooks son JSON pequeños; las descargas de media las hace el proxy hacia fuera, no pasan por el túnel.
- Discord no necesita túnel: el proxy abre la conexión hacia Discord.

## PWA

```bash
cd web
npm install
npm run dev          # Vite reenvía /api y /wh a localhost:8787
```

## iOS (Mac de Dotrino)

El código llega a la Mac solo por git.

```bash
git push
ssh dotrino-mac 'cd ~/src/multichat && git pull && cd ios && ~/tools/xcodegen/bin/xcodegen && \
  xcodebuild test -project Multichat.xcodeproj -scheme Multichat \
  -destination "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5" -derivedDataPath ~/dd-multichat CODE_SIGNING_ALLOWED=NO'
```

Para instalar en el iPhone hay que desbloquear el llavero por SSH antes de firmar (`security unlock-keychain`) y compilar para `generic/platform=iOS`.

## Despliegue

```bash
cd deploy
cp .env.example .env    # rellenar
cp /ruta/AuthKey_XXXX.p8 secrets/apns.p8
(cd ../web && npm ci && npm run build)
docker compose up -d --build
```
