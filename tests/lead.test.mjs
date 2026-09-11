import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLead, sendLead } from '../src/lead.js';

const lead = { name: 'Анна', contact: 'anna@example.com', service: 'website', message: '', consent: true };
const settings = { form: { endpoint: '/api/leads', timeoutMs: 100 }, privacyUrl: '/privacy.pdf' };
test('valid email and phone contacts', () => {
  assert.deepEqual(validateLead(lead), {});
  assert.deepEqual(validateLead({ ...lead, contact: '+7 (900) 123-45-67' }), {});
});
test('requires name, contact, service and consent', () => {
  assert.deepEqual(Object.keys(validateLead({})), ['name', 'contact', 'service', 'consent']);
});
test('rejects invalid and oversized values', () => {
  for (const contact of ['a@b', '+1', 'letters1234567890', 'name @example.com', '1234567890123456']) assert.ok(validateLead({ ...lead, contact }).contact);
  assert.ok(validateLead({ ...lead, name: 'A'.repeat(81) }).name);
  assert.ok(validateLead({ ...lead, message: 'A'.repeat(3001) }).message);
  assert.ok(validateLead({ ...lead, service: 'unknown' }).service);
});
test('demo never makes network requests', async () => {
  assert.deepEqual(await sendLead(lead, { form: { endpoint: '' } }, () => { throw new Error('Must not fetch'); }), { demo: true });
});
test('blocks submission without privacy document', async () => {
  await assert.rejects(sendLead(lead, { ...settings, privacyUrl: '' }), /документ/);
});
test('blocks external submission endpoints', async () => {
  await assert.rejects(sendLead(lead, { ...settings, form: { endpoint: 'https://example.com/leads' } }), /этом же сайте/);
});
test('success only with explicit server confirmation', async () => {
  let payload;
  const result = await sendLead(lead, settings, async (_url, options) => {
    payload = JSON.parse(options.body);
    assert.equal(options.method, 'POST');
    return { ok: true, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(result, { demo: false });
  assert.deepEqual(payload, lead);
});
test('rejects HTTP errors, negative/missing/non-JSON confirmations', async () => {
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ ok: false }) },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => { throw new SyntaxError(); } },
  ]) await assert.rejects(sendLead(lead, settings, async () => response));
});
test('network failure has actionable message', async () => {
  await assert.rejects(sendLead(lead, settings, async () => { throw new TypeError('fetch failed'); }), /соединения/);
});
test('timeout aborts the request', async () => {
  const fetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { const error = new Error(); error.name = 'AbortError'; reject(error); });
  });
  await assert.rejects(sendLead(lead, { ...settings, form: { endpoint: '/api/leads', timeoutMs: 5 } }, fetcher), /вовремя/);
});
