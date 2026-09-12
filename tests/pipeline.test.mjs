import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../backend/store.mjs';
import { createApiServer } from '../backend/api.mjs';
import { loadConfig } from '../backend/config.mjs';
import { runWorker } from '../backend/worker.mjs';

test('API → real SQLite → restart → Telegram worker delivers to authorized admins only', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'limitless-pipeline-'));
  const filename = path.join(directory, 'leads.sqlite');
  let store = new Store(filename);
  let server;
  const stop = new AbortController();
  t.after(async () => {
    stop.abort();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.setOwner(101);
  store.addAdmin(202);
  const config = {
    ...loadConfig(), secure: true, siteOrigin: 'https://limitless.test', token: 'mock-only',
    ownerId: 101, leadsEnabled: true, privacyUrl: '/test-privacy.pdf', privacyVersion: 'TEST-ONLY', trustProxy: true,
  };
  server = createApiServer({ config, store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const key = randomUUID();
  const headers = { Origin: config.siteOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Forwarded-Proto': 'https' };
  const body = { name: 'Тестовая заявка', contact: 'test@example.com', service: 'website', message: 'Тест, не реальные данные.', consent: true };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leads`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(store.stats().pendingDeliveries, 2);
  // Simulate an actual process restart between accepted POST and Telegram.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  store = new Store(filename);
  assert.equal(store.getLead(result.id).contact, 'test@example.com');
  assert.equal(store.getByKey(key).id, result.id);
  store.revokeAdmin(202);
  const sent = [];
  const telegram = {
    async call(method, params) {
      if (method === 'getWebhookInfo') return { url: '' };
      if (method === 'getUpdates') {
        if (!stop.signal.aborted) await once(stop.signal, 'abort');
        return [];
      }
      if (method === 'sendMessage') {
        sent.push(params);
        stop.abort();
        return { message_id: 1 };
      }
      throw new Error(`Unexpected mock method ${method}`);
    },
  };
  await runWorker({ store, telegram, ownerId: 101, signal: stop.signal, outboxIntervalMs: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 101);
  assert.match(sent[0].text, /test@example\.com/);
  assert.ok(sent[0].text.includes(result.id));
  assert.equal(store.stats().pendingDeliveries, 0);
  assert.equal(store.stats().deliveredDeliveries, 1);
});
