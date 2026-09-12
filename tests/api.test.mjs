import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApiServer, createRateLimiter, parseLead } from '../backend/api.mjs';
import { loadConfig, availability } from '../backend/config.mjs';

const lead = { name: 'Тест', contact: 'test@example.com', service: 'both', message: 'Тестовая заявка', consent: true };
const baseConfig = {
  ...loadConfig(), siteOrigin: 'https://example.test', secure: true, token: 'test-only',
  ownerId: 10, privacyUrl: '/privacy.pdf', privacyVersion: 'test-v1', leadsEnabled: true, rateLimit: 100, trustProxy: true,
};
function fakeStore() {
  const rows = new Map();
  return {
    activeAdmins: () => [{ id: 10, role: 'owner' }],
    getByKey: (key) => rows.get(key),
    stats: () => ({ pendingDeliveries: rows.size, notificationsEnabled: 1 }),
    enqueue: (_lead, { idempotencyKey, payloadHash }) => {
      const row = { id: randomUUID(), payloadHash };
      rows.set(idempotencyKey, row);
      return row;
    },
    rows,
  };
}
async function fixture(t, overrides = {}, store = fakeStore()) {
  const server = createApiServer({ config: { ...baseConfig, ...overrides }, store, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body = lead, headers = {}) => fetch(`${origin}/api/leads`, {
    method: 'POST',
    headers: { Origin: baseConfig.siteOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Forwarded-Proto': 'https', ...headers },
    body: JSON.stringify(body),
  });
  return { server, origin, post, store };
}
test('backend configuration rejects invalid values and does not enable HTTP collection', () => {
  assert.throws(() => loadConfig({ SITE_ORIGIN: 'https://example.test/path' }));
  assert.throws(() => loadConfig({ TELEGRAM_OWNER_ID: '-1' }));
  assert.throws(() => loadConfig({ RETENTION_DAYS: '0' }));
  assert.throws(() => loadConfig({ PRIVACY_URL: 'javascript:alert(1)' }));
  assert.equal(availability({ ...baseConfig, secure: false }, fakeStore()).available, false);
  assert.equal(availability({ ...baseConfig, privacyVersion: '' }, fakeStore()).available, false);
});
test('backend enforces types and field lengths independently of frontend', () => {
  assert.deepEqual(parseLead(lead), lead);
  for (const value of [null, [], 'text', { ...lead, name: 4 }, { ...lead, consent: 'true' }, { ...lead, message: null },
    { ...lead, name: 'x'.repeat(81) }, { ...lead, name: '\nТест' }, { ...lead, message: '\0' },
    { ...lead, contact: 'nope' }, { ...lead, service: 'all' }]) assert.equal(parseLead(value), null);
});
test('rate limiter recovers after the window and has bounded storage', () => {
  let clock = 1;
  const limited = createRateLimiter({ max: 2, windowMs: 10, capacity: 2, now: () => clock });
  assert.equal(limited('one'), true);
  assert.equal(limited('one'), true);
  assert.equal(limited('one'), false);
  assert.equal(limited('two'), true);
  assert.equal(limited('three'), false);
  clock += 11;
  assert.equal(limited('three'), true);
});
test('POST durably enqueues and repeats are idempotent', async (t) => {
  const { post, store } = await fixture(t);
  const headers = { 'Idempotency-Key': randomUUID() };
  const first = await post(lead, headers);
  assert.equal(first.status, 201);
  const saved = await first.json();
  assert.equal(saved.ok, true);
  const again = await post(lead, headers);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, saved.id);
  assert.equal(store.rows.size, 1);
  assert.equal((await post({ ...lead, message: 'Changed' }, headers)).status, 409);
});
test('POST rejects cross-origin, fetch metadata, media type, invalid payload and key', async (t) => {
  const { post } = await fixture(t);
  assert.equal((await post(lead, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post(lead, { Origin: '' })).status, 403);
  assert.equal((await post(lead, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(lead, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ ...lead, consent: false })).status, 422);
  assert.equal((await post(lead, { 'Idempotency-Key': '' })).status, 400);
  assert.equal((await post({ ...lead, message: 'x'.repeat(20000) })).status, 413);
});
test('malformed JSON, endpoint methods and unknown paths', async (t) => {
  const { origin } = await fixture(t);
  const malformed = await fetch(`${origin}/api/leads`, {
    method: 'POST',
    headers: { Origin: baseConfig.siteOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Forwarded-Proto': 'https' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(`${origin}/api/leads`)).status, 405);
  assert.equal((await fetch(`${origin}/.env`)).status, 404);
});
test('no success when durable storage fails', async (t) => {
  const store = fakeStore();
  store.enqueue = () => { throw new Error('sensitive internals'); };
  const { post } = await fixture(t, {}, store);
  const response = await post();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: 'internal_error' });
});
test('production gates prevent writes without HTTPS, policy, owner or subscribers', async (t) => {
  for (const override of [{ secure: false }, { privacyUrl: '' }, { privacyVersion: '' }, { ownerId: null }, { leadsEnabled: false }]) {
    const { post, store } = await fixture(t, override);
    assert.equal((await post()).status, 503);
    assert.equal(store.rows.size, 0);
  }
  const store = fakeStore();
  store.activeAdmins = () => [];
  const { post } = await fixture(t, {}, store);
  assert.equal((await post()).status, 503);
});
test('rate limit and queue capacity respond without saving', async (t) => {
  const { post } = await fixture(t, { rateLimit: 1 });
  assert.equal((await post()).status, 201);
  const blocked = await post();
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('Retry-After'));
  const full = await fixture(t, { maxQueue: 0 });
  assert.equal((await full.post()).status, 503);
  const store = fakeStore();
  store.stats = () => ({ pendingDeliveries: 9, notificationsEnabled: 3 });
  store.activeAdmins = () => [{ id: 1 }, { id: 2 }, { id: 3 }];
  const multiple = await fixture(t, { maxQueue: 10 }, store);
  assert.equal((await multiple.post()).status, 503);
  assert.equal(store.rows.size, 0);
});
test('runtime configuration contains public values only and no caching', async (t) => {
  const { origin } = await fixture(t, { token: 'TEST_NEVER_EXPOSE_THIS_TOKEN' });
  const response = await fetch(`${origin}/runtime-config.js`, { headers: { 'X-Forwarded-Proto': 'https' } });
  const text = await response.text();
  assert.match(text, /"endpoint":"\/api\/leads"/);
  assert.match(text, /"available":true/);
  assert.equal(text.includes('TEST_NEVER'), false);
  assert.equal(text.includes('ownerId'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('actual HTTP and untrusted proxy headers never enable collection', async (t) => {
  const { post, origin } = await fixture(t);
  assert.equal((await post(lead, { 'X-Forwarded-Proto': 'http' })).status, 503);
  assert.match(await (await fetch(`${origin}/runtime-config.js`)).text(), /"reason":"https"/);
  const untrusted = await fixture(t, { trustProxy: false });
  assert.equal((await untrusted.post()).status, 503);
});
test('notifications disabled while reading a slow request prevent acceptance', async (t) => {
  const store = fakeStore();
  let checks = 0;
  let beforeRead;
  const readStarted = new Promise((resolve) => { beforeRead = resolve; });
  store.stats = () => {
    checks++;
    beforeRead();
    return { pendingDeliveries: 0, notificationsEnabled: checks === 1 ? 1 : 0 };
  };
  const { origin } = await fixture(t, {}, store);
  const result = new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/leads`, {
      method: 'POST',
      headers: { Origin: baseConfig.siteOrigin, 'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https', 'Idempotency-Key': randomUUID() },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.write('{');
    readStarted.then(() => request.end(JSON.stringify(lead).slice(1)));
  });
  assert.equal(await result, 503);
  assert.equal(store.rows.size, 0);
});
