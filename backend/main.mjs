import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createApiServer } from './api.mjs';
import { Store } from './store.mjs';
import { createTelegramClient } from './telegram.mjs';
import { runWorker } from './worker.mjs';
import { verifyTelegram } from './startup.mjs';

process.umask(0o077);
const config = loadConfig();
await mkdir(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
const store = new Store(config.databasePath);
if (config.ownerId) store.setOwner(config.ownerId);
const abort = new AbortController();
let botReady = false;
let worker;
if (config.token) {
  const telegram = createTelegramClient(config.token);
  // Validate token and prevent an accidentally duplicated polling deployment.
  try {
    const me = await verifyTelegram(telegram);
    console.log(`telegram_ready @${me.username}`);
    botReady = true;
    worker = runWorker({ store, telegram, ownerId: config.ownerId, signal: abort.signal, retentionDays: config.retentionDays });
    worker.catch(() => {
      botReady = false;
      console.error('telegram_worker_stopped');
      shutdown().finally(() => { process.exitCode = 1; });
    });
  } catch {
    console.error('telegram_startup_failed_check_token_or_webhook');
    store.close();
    process.exit(1);
  }
}
const server = createApiServer({ config, store, readiness: () => botReady });
server.listen(config.port, config.host, () => console.log(`limitless_api ${config.host}:${config.port}`));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  abort.abort();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (worker) await worker.catch(() => {});
  store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('error', () => { console.error('api_listen_failed'); shutdown().finally(() => { process.exitCode = 1; }); });
