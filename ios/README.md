# Multichat iOS

App nativa (Swift 6 + SwiftUI, iOS 17+) de Multichat. Misma funcionalidad que la PWA de `web/`. Contrato: [docs/protocol.md](../docs/protocol.md) y [docs/crypto.md](../docs/crypto.md).

## Compilar

```sh
cd ios
xcodegen generate            # crea Multichat.xcodeproj (no se versiona)
xcodebuild test -project Multichat.xcodeproj -scheme Multichat \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' CODE_SIGNING_ALLOWED=NO
```

Sin dependencias externas: CryptoKit, SwiftData, URLSession, AVFoundation, MapKit, QuickLook.

## Targets

| Target | Qué es |
|---|---|
| `Multichat` | La app. Bundle `com.dotrino.multichat`. |
| `MultichatNotificationService` | Extensión que descifra el objeto `mc` del push (protocol.md §8). |
| `MultichatTests` | XCTest: vectores de cripto (`shared/crypto-vectors/vectors.json`, por referencia) y codificación del protocolo. |

## Estructura

- `Shared/` — compartido por app y extensión: cripto (sobres X25519/HKDF/AES-GCM y blobs MCB1), tipos del protocolo, Keychain y App Group.
- `Multichat/Core/` — `APIClient` (REST, refresh en 401, subida multipart con progreso), `WebSocketClient` (ping 25 s, backoff), `AppModel` (estado, sync, envío), `Persistence` (SwiftData), `BlobStore` (caché de blobs descifrados).
- `Multichat/Views/` — pantallas SwiftUI.

## Firma y capacidades (dispositivo)

Equipo `P7G853375S`, firma automática. El perfil necesita:
- App Group `group.com.dotrino.multichat` (caché SwiftData, blobs, URL del servidor, último seq).
- Keychain access group `$(AppIdentifierPrefix)com.dotrino.multichat.shared` (clave de cuenta y sesión, legibles por la extensión).
- Push Notifications (`aps-environment`). La app registra el token con `environment: sandbox` en Debug y `production` en Release.

En el simulador sin firma (`CODE_SIGNING_ALLOWED=NO`) el Keychain y el contenedor caen a los de la app; funciona igual, pero sin push.

## Servidor

La URL del proxy se edita en la pantalla de entrada (por defecto `http://localhost:8787`). ATS solo permite HTTP en red local (`NSAllowsLocalNetworking`); para cualquier otro host hace falta HTTPS (p. ej. un túnel).

Decisiones ante ambigüedades del protocolo: [NOTES.md](NOTES.md).
