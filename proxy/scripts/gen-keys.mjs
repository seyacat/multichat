// Genera MASTER_KEY y claves VAPID para el .env. No los imprime en ningún otro sitio.
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
const v = webpush.generateVAPIDKeys();
console.log(`MASTER_KEY=${randomBytes(32).toString('hex')}`);
console.log(`VAPID_PUBLIC_KEY=${v.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${v.privateKey}`);
