# Cifrado (v1)

Primitivas: X25519, HKDF-SHA256, AES-256-GCM (tag de 16 bytes). Disponibles en `node:crypto`, WebCrypto y CryptoKit.

Codificación de transporte: base64url sin relleno (`b64u`).

## Clave de cuenta

- Par X25519 generado por el primer dispositivo de la cuenta.
- Privada: 32 bytes crudos (`rawRepresentation` en CryptoKit). Se guarda en Keychain (iOS) o IndexedDB (PWA). Nunca va al proxy en claro.
- Pública: 32 bytes crudos, subida con `PUT /api/account/key`.

Para importar claves crudas donde la API pide DER (Node, WebCrypto):
- PKCS#8 privada = `302e020100300506032b656e04220420` ‖ priv(32)
- SPKI pública   = `302a300506032b656e032100` ‖ pub(32)

## Sobre sellado (`envelope`)

`seal(plaintext, recipientPub)`:
1. `e` = par X25519 efímero nuevo.
2. `shared` = X25519(`e.priv`, `recipientPub`) (32 bytes).
3. `key` = HKDF-SHA256(ikm=`shared`, salt=`e.pub ‖ recipientPub` (64 bytes), info=`"multichat/v1/envelope"` (UTF-8), L=32).
4. `nonce` = 12 bytes aleatorios.
5. `ct ‖ tag` = AES-256-GCM(`key`, `nonce`, `plaintext`, sin AAD).
6. Sobre = `0x01` ‖ `e.pub` (32) ‖ `nonce` (12) ‖ `ct` ‖ `tag` (16). Se transporta en b64u.

`open(envelope, recipientPriv)`: comprobar versión `0x01` y longitud ≥ 61, derivar igual (la `recipientPub` se calcula de la privada), descifrar. Fallo de tag → error.

El texto en claro de los sobres de la API es JSON UTF-8 (ver protocol.md). La excepción es `sealedKey` del vínculo de dispositivos, que son los 32 bytes de la privada de cuenta.

## Blobs de media (formato MCB1)

Clave: `fileKey` = 32 bytes aleatorios por archivo, viaja dentro del `MessagePayload`.

Archivo cifrado:
```
"MCB1" (4 bytes ASCII) ‖ baseNonce (12) ‖ chunk_0 ‖ chunk_1 ‖ … ‖ chunk_n
```
- Texto en claro partido en trozos de 65536 bytes; el último puede ser más corto (o vacío si el archivo está vacío; siempre hay al menos un trozo).
- `chunk_i` = AES-256-GCM(`fileKey`, `nonce_i`, `trozo_i`, AAD = `[0x01]` si es el último, `[0x00]` si no) = ct ‖ tag (65552 bytes salvo el último).
- `nonce_i` = `baseNonce` con sus últimos 4 bytes XOR `i` como entero big-endian de 32 bits.
- Para descifrar: leer trozos de 65552 bytes; el último trozo es el que termina el archivo y debe validar con AAD `[0x01]`. Esto detecta truncado y reordenado.

## Vectores de prueba

`shared/crypto-vectors/vectors.json` (generados por `proxy/scripts/gen-vectors.ts`). Cada implementación debe:
- `x25519`: derivar `publicKey` de `privateKey`.
- `envelope`: con `recipientPrivateKey` abrir `envelope` y obtener `plaintextUtf8`; y, sellando con `ephemeralPrivateKey` y `nonce` fijos, reproducir `envelope` byte a byte.
- `blob`: con `fileKey` descifrar `blob` y obtener los bytes `plaintextHex`; y con `baseNonce` fijo reproducir `blob`.
