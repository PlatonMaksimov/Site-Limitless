import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../backend/store.mjs';

const lead = { name: 'Анна', contact: 'anna@example.test', service: 'website', message: 'Нужен сайт', consent: true };
const metadata = { idempotencyKey: 'request-1', payloadHash: 'hash-1', privacyVersion: 'v1' };

function memory(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

function disk(t) {
  const directory = mkdtempSync(join(tmpdir(), 'limitless-store-'));
  const databasePath = join(directory, 'test.sqlite');
  const stores = [];
  const open = () => {
    const store = new Store(databasePath);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(databasePath + suffix, { force: true });
    rmdirSync(directory);
  });
  return { databasePath, open };
}

test('empty store has no implicit owner and cannot enqueue without admins', t => {
  const store = memory(t);
  assert.deepEqual(store.activeAdmins(), []);
  assert.equal(store.getAdmin(1), null);
  assert.equal(store.getOffset(), 0);
  assert.throws(() => store.enqueue(lead, metadata), /No active/);
  assert.equal(store.getByKey(metadata.idempotencyKey), null);
  assert.deepEqual(store.stats(), {
    totalLeads: 0, pendingDeliveries: 0, deliveredDeliveries: 0, admins: 0, notificationsEnabled: 0,
  });
  store.close();
  store.close();
});

test('enqueue snapshots all admins atomically and exposes only the documented lead fields', t => {
  const store = memory(t);
  store.setOwner('100');
  store.addAdmin(200);
  store.setNotifications(200, false);
  const before = Date.now();
  const result = store.enqueue({ ...lead, ip: 'must not be retained', userAgent: 'ignored' }, metadata);
  assert.equal(result.duplicate, false);
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const saved = store.getLead(result.id);
  assert.ok(saved.createdAt >= before && saved.createdAt <= Date.now());
  assert.deepEqual(saved, { ...lead, id: result.id, createdAt: saved.createdAt, privacyVersion: 'v1' });
  assert.deepEqual(store.activeAdmins(), [{ id: 100, role: 'owner' }, { id: 200, role: 'admin' }]);
  assert.equal(store.stats().pendingDeliveries, 2);
  assert.deepEqual(store.pendingDeliveries().map(item => item.adminId), [100]);
  store.setNotifications(200, true);
  const deliveries = store.pendingDeliveries();
  assert.deepEqual(deliveries.map(item => item.adminId), [100, 200]);
  assert.deepEqual(deliveries[0], {
    ...saved, leadId: saved.id, adminId: 100, attempts: 0, nextAttemptAt: saved.createdAt,
  });
  store.addAdmin(300);
  assert.equal(store.pendingDeliveries().length, 2, 'adding an admin does not expose historical outbox');
});

test('idempotency is persistent across connections and conflicting payloads fail without PII in errors', t => {
  const fixture = disk(t);
  const first = fixture.open();
  const second = fixture.open();
  first.setOwner(100);
  const initial = first.enqueue(lead, metadata);
  assert.deepEqual(second.enqueue(lead, metadata), { id: initial.id, duplicate: true });
  assert.deepEqual(second.getByKey('request-1'), { id: initial.id, payloadHash: 'hash-1' });
  assert.throws(() => second.enqueue(lead, { ...metadata, payloadHash: 'changed' }), error => {
    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
    assert.ok(!error.message.includes(lead.contact));
    return true;
  });
  assert.equal(first.stats().totalLeads, 1);
  assert.equal(first.stats().pendingDeliveries, 1);
  first.close();
  second.close();
  const reopened = fixture.open();
  assert.deepEqual(reopened.enqueue(lead, metadata), { id: initial.id, duplicate: true });
  assert.equal(reopened.getByKey('missing'), null);
  assert.equal(reopened.getLead(initial.id).contact, lead.contact);
});

test('a failed outbox insert rolls back the lead and every earlier recipient', t => {
  const fixture = disk(t);
  const store = fixture.open();
  store.setOwner(100);
  store.addAdmin(200);
  const sql = new DatabaseSync(fixture.databasePath);
  try {
    sql.exec(`CREATE TRIGGER reject_test_delivery BEFORE INSERT ON deliveries
      WHEN NEW.admin_id = 200 BEGIN SELECT RAISE(ABORT, 'test rejection'); END;`);
    assert.throws(() => store.enqueue(lead, metadata), /test rejection/);
    assert.equal(store.stats().totalLeads, 0);
    assert.equal(store.stats().pendingDeliveries, 0);
    assert.equal(store.getByKey('request-1'), null);
    sql.exec('DROP TRIGGER reject_test_delivery');
    store.enqueue(lead, metadata);
    assert.equal(store.stats().pendingDeliveries, 2);
  } finally {
    sql.close();
  }
});

test('prepared statements preserve injection-shaped data and optional keys create distinct requests', t => {
  const store = memory(t);
  store.setOwner(100);
  const input = { ...lead, name: "Robert'); DROP TABLE admins; --", message: "'; DELETE FROM leads; --" };
  const meta = { ...metadata, idempotencyKey: "' OR 1=1; --" };
  const saved = store.enqueue(input, meta);
  assert.equal(store.getLead(saved.id).name, input.name);
  assert.equal(store.getLead(saved.id).message, input.message);
  assert.equal(store.getByKey(meta.idempotencyKey).id, saved.id);
  assert.equal(store.activeAdmins().length, 1);
  assert.equal(store.getLead("' OR 1=1 --"), null);
  const { idempotencyKey, ...withoutKey } = metadata;
  assert.notEqual(store.enqueue(lead, withoutKey).id, store.enqueue(lead, withoutKey).id);
});

test('admin roles cannot self-elevate or revoke owner; owner replacement removes the old outbox', t => {
  const store = memory(t);
  store.setOwner(100);
  store.addAdmin(200);
  store.addAdmin(100);
  assert.equal(store.getAdmin(100).role, 'owner');
  assert.throws(() => store.revokeAdmin(100), /owner/);
  store.enqueue(lead, metadata);
  assert.equal(store.revokeAdmin(200), true);
  assert.equal(store.revokeAdmin(200), false);
  assert.equal(store.getAdmin(200), null);
  assert.equal(store.stats().pendingDeliveries, 1);
  store.addAdmin(200);
  assert.equal(store.stats().pendingDeliveries, 1, 'revoked deliveries do not reappear after regrant');
  store.setOwner(200);
  assert.equal(store.getAdmin(100), null);
  assert.deepEqual(store.activeAdmins(), [{ id: 200, role: 'owner' }]);
  assert.equal(store.stats().pendingDeliveries, 0);
  store.setNotifications(200, false);
  store.setOwner(200);
  store.addAdmin(200);
  assert.equal(store.getAdmin(200).notifications, false, 'startup does not reset a pause or a 403');
  assert.equal(store.setNotifications(999, true), false, 'preferences cannot create an admin');
});

test('retry, delivery acknowledgements, notification pauses and offsets survive reopening', t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const fixture = disk(t);
  let store = fixture.open();
  store.setOwner(100);
  store.addAdmin(200);
  const { id } = store.enqueue(lead, metadata);
  store.markDelivered(id, 100);
  store.markRetry(id, 200, 10);
  store.setOffset(42);
  store.setOffset(10);
  store.close();
  store = fixture.open();
  assert.equal(store.getOffset(), 42);
  assert.deepEqual(store.pendingDeliveries(), []);
  now += 10_000;
  assert.equal(store.pendingDeliveries()[0].attempts, 1);
  store.markRetry(id, 200, 0.5);
  now += 500;
  assert.equal(store.pendingDeliveries()[0].attempts, 2);
  store.setNotifications(200, false);
  assert.deepEqual(store.pendingDeliveries(), []);
  store.close();
  store = fixture.open();
  assert.equal(store.getAdmin(200).notifications, false);
  store.setNotifications(200, true);
  store.markDelivered(id, 200);
  store.markDelivered(id, 200);
  store.markRetry(id, 200, 0);
  assert.deepEqual(store.pendingDeliveries(), []);
  assert.equal(store.stats().deliveredDeliveries, 2);
  assert.equal(store.stats().pendingDeliveries, 0);
});

test('retention removes expired PII, idempotency keys and pending/delivered outbox, not admins or offset', t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const fixture = disk(t);
  const store = fixture.open();
  store.setOwner(100);
  store.addAdmin(200);
  const old = store.enqueue(lead, metadata);
  store.markDelivered(old.id, 100);
  store.setOffset(99);
  now += 31 * 86_400_000;
  const fresh = store.enqueue(lead, { ...metadata, idempotencyKey: 'fresh' });
  assert.equal(store.purgeExpired(30), 1);
  assert.equal(store.purgeExpired(30), 0);
  assert.equal(store.getLead(old.id), null);
  assert.equal(store.getByKey('request-1'), null);
  assert.equal(store.getLead(fresh.id).id, fresh.id);
  assert.equal(store.pendingDeliveries().length, 2);
  assert.equal(store.stats().deliveredDeliveries, 0);
  assert.equal(store.getOffset(), 99);
  assert.equal(store.activeAdmins().length, 2);
  assert.equal(store.enqueue(lead, metadata).duplicate, false);
  const sql = new DatabaseSync(fixture.databasePath);
  try {
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE lead_id = ?').get(old.id).n, 0);
    assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    sql.close();
  }
});

test('recentLeads is newest first with a default of five and bounded query limits', t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now++);
  const store = memory(t);
  store.setOwner(100);
  for (let index = 0; index < 7; index++) {
    store.enqueue({ ...lead, name: `Name ${index}` }, { ...metadata, idempotencyKey: `key-${index}` });
  }
  assert.deepEqual(store.recentLeads().map(item => item.name), ['Name 6', 'Name 5', 'Name 4', 'Name 3', 'Name 2']);
  assert.equal(store.recentLeads(1).length, 1);
  assert.equal(store.pendingDeliveries(2).length, 2);
  assert.equal(store.getLead(null), null);
  for (const value of [0, -1, 1.5, '5', NaN]) {
    assert.throws(() => store.recentLeads(value), /limit/);
    assert.throws(() => store.pendingDeliveries(value), /limit/);
  }
});

test('store validates consent, text bounds, metadata, IDs and state without retaining extra fields', t => {
  const store = memory(t);
  store.setOwner(100);
  for (const patch of [
    { consent: false }, { consent: 1 }, { name: '' }, { name: 'x'.repeat(81) },
    { contact: '' }, { contact: 'x'.repeat(161) }, { service: 'x'.repeat(81) },
    { message: 'x'.repeat(3001) }, { message: null }, { message: '\0' },
  ]) assert.throws(() => store.enqueue({ ...lead, ...patch }, metadata), TypeError);
  for (const patch of [
    { payloadHash: undefined }, { payloadHash: '' }, { privacyVersion: '' },
    { idempotencyKey: '' }, { idempotencyKey: 'x'.repeat(201) },
  ]) assert.throws(() => store.enqueue(lead, { ...metadata, ...patch }), TypeError);
  for (const id of [0, -1, '0', '-100', '1.5', '1e3', ' 100', 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => store.addAdmin(id), TypeError);
    assert.throws(() => store.setOwner(id), TypeError);
  }
  for (const offset of [-1, 1.5, '1', Infinity]) assert.throws(() => store.setOffset(offset), TypeError);
  for (const days of [0, -1, NaN, Infinity, '30']) assert.throws(() => store.purgeExpired(days), TypeError);
  for (const delay of [-1, NaN, Infinity, '1']) assert.throws(() => store.markRetry('id', 100, delay), TypeError);
  assert.throws(() => store.setNotifications(100, 1), TypeError);
  const saved = store.enqueue({
    ...lead, name: 'x'.repeat(80), contact: 'x'.repeat(160), message: 'x'.repeat(3000),
  }, metadata);
  assert.equal(store.getLead(saved.id).message.length, 3000);
});
