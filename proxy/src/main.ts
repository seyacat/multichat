import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { app } = await buildApp(config);
await app.listen({ port: config.port, host: config.host });
app.log.info(`URL pública para webhooks: ${config.publicUrl}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { void app.close().then(() => process.exit(0)); });
}
