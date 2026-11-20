# Multichat — PWA de pruebas

Cliente web con la misma funcionalidad que la app iOS. Vite + TypeScript + Preact, cifrado con WebCrypto nativo y datos en IndexedDB.

## Correr en local

```bash
cd web
npm install
npm run dev        # http://localhost:5173; reenvía /api (y el WebSocket /api/ws) y /wh a http://localhost:8787
```

- Proxy en otra máquina o puerto: `VITE_PROXY_TARGET=http://host:puerto npm run dev`.
- Cliente contra otro servidor sin pasar por el proxy de Vite: `VITE_API_BASE=https://servidor npm run dev` (el servidor debe permitir CORS).
- También se puede cambiar en la pantalla de entrada (campo «Servidor», se guarda en `localStorage`).

## Comandos

```bash
npm test           # Vitest: vectores de cifrado, fusión, sincronización y push
npm run build      # tsc + build de la app + build del service worker (dist/sw.js)
npm run preview    # sirve dist/ con el mismo proxy
```

El build usa rutas relativas: el proxy lo sirve en `/app/` con `SERVE_WEB_DIR=../web/dist`.

## Estructura

- `src/lib/crypto.ts` — X25519, sobres y blobs MCB1 (docs/crypto.md).
- `src/lib/engine.ts` — sesión, clave de cuenta, vínculo, sincronización, envío, blobs, push.
- `src/lib/api.ts`, `ws.ts`, `db.ts`, `merge.ts` — REST con refresco de token, WebSocket con ping y backoff, IndexedDB, fusión pura.
- `src/ui/` — pantallas. `src/sw.ts` — service worker (cache del shell y Web Push).
- `NOTES.md` — decisiones ante ambigüedades del protocolo.

Las notificaciones push necesitan HTTPS (o `localhost`) y que el proxy tenga claves VAPID.
