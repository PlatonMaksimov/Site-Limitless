import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTelegram } from '../backend/startup.mjs';

test('temporary Telegram startup failures back off within the process then recover', async () => {
  let tries = 0;
  const waits = [];
  const me = { is_bot: true, username: 'test_bot' };
  const telegram = { async call(method) {
    if (method === 'getMe' && tries++ < 7) throw Object.assign(new Error('network failure'), { statusCode: 502 });
    return method === 'getMe' ? me : { url: '' };
  } };
  assert.equal(await verifyTelegram(telegram, { wait: async (delay) => waits.push(delay), logger: { error() {} } }), me);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});
test('startup respects retry_after and fails fast for invalid credentials or existing webhook', async () => {
  const waits = [];
  let attempt = 0;
  await verifyTelegram({ async call(method) {
    if (attempt++ === 0) throw { statusCode: 429, retryAfter: 60 };
    return method === 'getMe' ? { is_bot: true, username: 'test_bot' } : { url: '' };
  } }, { wait: async (delay) => waits.push(delay), logger: { error() {} } });
  assert.deepEqual(waits, [60000]);
  await assert.rejects(verifyTelegram({ async call() { throw { statusCode: 401 }; } }), /configuration_failed/);
  await assert.rejects(verifyTelegram({ async call(method) {
    return method === 'getMe' ? { is_bot: true, username: 'test_bot' } : { url: 'https://existing.test' };
  } }), /existing_webhook/);
});
