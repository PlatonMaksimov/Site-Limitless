import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTelegramClient, createUpdateHandler, formatLead } from '../backend/telegram.mjs';
import { Store } from '../backend/store.mjs';
import { runWorker, retryDelay } from '../backend/worker.mjs';

// Deliberately synthetic; every request is injected and never reaches the network.
const token = '123:UNIT_TEST_NOT_A_REAL_TOKEN';
const lead = { name: 'Анна', contact: 'private@example.test', service: 'website', message: 'Private lead contents', consent: true };
const metadata = { idempotencyKey: 'request', payloadHash: 'hash', privacyVersion: 'v1' };

function setup(t, { owner = true } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  if (owner) store.setOwner(100);
  const calls = [];
  const telegram = { call: async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return true;
  } };
  const handler = createUpdateHandler({ store, telegram, ownerId: 100 });
  return { store, telegram, calls, handler };
}

function message(id, text, updateId = 1) {
  return { update_id: updateId, message: {
    from: { id, is_bot: false }, chat: { id, type: 'private' }, date: Math.floor(Date.now() / 1000), text,
  } };
}

function callback(id, data, updateId = 1) {
  return { update_id: updateId, callback_query: {
    id: `callback-${updateId}`, from: { id, is_bot: false }, data,
    message: { chat: { id, type: 'private' } },
  } };
}

function apiError(statusCode, retryAfter) {
  return Object.assign(new Error('Synthetic API failure'), { statusCode, retryAfter });
}

async function worker(t, store, call, options = {}) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 1500);
  t.after(() => {
    clearTimeout(deadline);
    controller.abort();
  });
  await runWorker({
    store, telegram: { call: (method, params, timeoutMs) => call(method, params, timeoutMs, controller) },
    ownerId: 100, signal: controller.signal,
    retryBaseMs: 1, outboxIntervalMs: 1, retentionIntervalMs: 20,
    ...options,
  });
  clearTimeout(deadline);
}

test('client posts JSON, verifies Telegram ok and disables redirects', async () => {
  let called = false;
  const client = createTelegramClient(token, { fetcher: async (url, options) => {
    called = true;
    assert.equal(url, `https://api.telegram.org/bot${token}/sendMessage`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { chat_id: 100, text: 'test' });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 5 } }) };
  } });
  assert.deepEqual(await client.call('sendMessage', { chat_id: 100, text: 'test' }), { message_id: 5 });
  assert.ok(called);
});

test('client errors never expose URLs, tokens, response descriptions or nested causes', async () => {
  const unsafe = `https://api.telegram.org/bot${token}/getUpdates sensitive-contact`;
  const cases = [
    { fetcher: async () => { throw new Error(unsafe); } },
    { fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new Error(unsafe); } }) },
    { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error_code: 403, description: unsafe }) }), statusCode: 403 },
    { fetcher: async () => ({ ok: false, status: 429, json: async () => ({
      ok: false, description: unsafe, parameters: { retry_after: 17 },
    }) }), statusCode: 429, retryAfter: 17 },
    { fetcher: async () => ({ ok: false, status: 502, json: async () => { throw new Error(unsafe); } }), statusCode: 502 },
    { fetcher: async () => ({ ok: false, status: 500, json: async () => ({ ok: true, result: true }) }), statusCode: 500 },
    { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ ok: 'true', result: true }) }) },
    { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) },
    { fetcher: async () => ({ ok: true, status: 200, json: async () => null }) },
    { fetcher: async () => ({ ok: true, status: 200, json: async () => ({
      ok: false, error_code: unsafe, parameters: { retry_after: unsafe },
    }) }) },
  ];
  for (const scenario of cases) {
    const client = createTelegramClient(token, { fetcher: scenario.fetcher });
    await assert.rejects(client.call('getUpdates'), error => {
      assert.equal(error.message, 'Telegram request failed.');
      assert.equal(error.statusCode, scenario.statusCode);
      assert.equal(error.retryAfter, scenario.retryAfter);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.keys(error).sort(),
        ['statusCode', 'retryAfter'].filter(key => scenario[key] !== undefined).sort());
      const serialized = `${error.stack} ${JSON.stringify(error)}`;
      assert.ok(!serialized.includes(token));
      assert.ok(!serialized.includes('https://'));
      assert.ok(!serialized.includes('sensitive-contact'));
      return true;
    });
  }
});

test('client enforces timeout even when injected fetch ignores abort, including response body timeout', async () => {
  for (const bodyOnly of [false, true]) {
    let signal;
    const never = () => new Promise(() => {});
    const client = createTelegramClient(token, { fetcher: async (_url, options) => {
      signal = options.signal;
      return bodyOnly ? { ok: true, status: 200, json: never } : never();
    } });
    await assert.rejects(client.call('getUpdates', {}, 5), { message: 'Telegram request failed.' });
    assert.equal(signal.aborted, true);
  }
});

test('client rejects unsafe method names and configuration before any fetch', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('must not fetch'); };
  for (const invalid of ['', 'token', '123:token/path', '123:token?query', '123:token\n']) {
    assert.throws(() => createTelegramClient(invalid, { fetcher }), /Invalid Telegram/);
  }
  const client = createTelegramClient(token, { fetcher });
  for (const method of ['../getUpdates', 'getUpdates?token=foo', 'https://example.test', '', null]) {
    await assert.rejects(client.call(method), /Telegram request failed/);
  }
  for (const timeout of [0, -1, Infinity, '100']) await assert.rejects(client.call('getMe', {}, timeout));
  const circular = {};
  circular.self = circular;
  await assert.rejects(client.call('getMe', circular), /Telegram request failed/);
  assert.equal(calls, 0);
});

test('/start and /id are public ID-only commands; even owner /start does not create an owner', async t => {
  const { store, handler, calls } = setup(t, { owner: false });
  for (const id of [100, 200]) {
    await handler(message(id, '/start'));
    await handler(message(id, '/id'));
  }
  assert.deepEqual(calls.map(call => [call.params.chat_id, call.params.text]),
    [[100, '100'], [100, '100'], [200, '200'], [200, '200']]);
  assert.deepEqual(store.activeAdmins(), []);
  await handler(message(100, '/add_admin 200'));
  assert.deepEqual(store.activeAdmins(), []);
  assert.equal(calls.at(-1).params.text, 'Нет доступа.');
});

test('null/omitted ownerId permits public IDs but denies protected commands even to persisted admins', async t => {
  const { store, telegram, calls } = setup(t, { owner: false });
  for (const ownerId of [null, undefined]) {
    const handler = createUpdateHandler({ store, telegram, ownerId });
    await handler(message(100, '/start'));
    await handler(message(200, '/id'));
    assert.deepEqual(calls.slice(-2).map(call => call.params.text), ['100', '200']);
    assert.deepEqual(store.activeAdmins(), []);
  }
  store.setOwner(100);
  store.addAdmin(200);
  const { id } = store.enqueue(lead, metadata);
  for (const ownerId of [null, undefined]) {
    const handler = createUpdateHandler({ store, telegram, ownerId });
    const first = calls.length;
    for (const sender of [100, 200, 999]) {
      for (const command of ['/admin', `/lead ${id}`, '/test', '/admins', '/add_admin 300', '/remove_admin 200']) {
        await handler(message(sender, command));
      }
      for (const data of ['admin:recent', 'admin:status', 'admin:notifications:off', 'admin:notifications:on']) {
        await handler(callback(sender, data));
      }
    }
    assert.ok(calls.slice(first).every(call => call.params.text === 'Нет доступа.'));
    assert.equal(store.getAdmin(300), null);
    assert.equal(store.getAdmin(200).notifications, true);
  }
});

test('bots, groups, mismatched chat/user IDs and malformed or unknown updates are ignored', async t => {
  const { handler, calls } = setup(t);
  const updates = [null, {}, { update_id: 1 }, { message: null }, { edited_message: message(100, '/admin').message }];
  for (const build of [() => message(100, '/admin'), () => callback(100, 'admin:recent')]) {
    for (const mutation of [
      item => { item.from.is_bot = true; },
      item => { item.from.is_bot = undefined; },
      item => { item.from.id = 200; },
      item => { item.from.id = '100'; },
      item => { item.chat.type = 'group'; },
      item => { item.chat.id = -100; },
    ]) {
      const update = build();
      const content = update.message || { from: update.callback_query.from, chat: update.callback_query.message.chat };
      mutation(content);
      updates.push(update);
    }
  }
  updates.push({ callback_query: { id: 'inline', from: { id: 100, is_bot: false }, inline_message_id: 'inline', data: 'admin:recent' } });
  updates.push(message(100, '/unknown'), message(100, 'hello'));
  const senderChat = message(100, '/start');
  senderChat.message.sender_chat = { id: 100 };
  updates.push(senderChat);
  for (const update of updates) await handler(update);
  assert.deepEqual(calls, []);
});

test('unauthorized messages and every callback cannot read leads or admin data', async t => {
  const { store, handler, calls } = setup(t);
  const { id } = store.enqueue(lead, metadata);
  for (const method of ['getLead', 'recentLeads', 'stats', 'activeAdmins']) {
    t.mock.method(store, method, () => { throw new Error(`Unauthorized read: ${method}`); });
  }
  for (const command of ['/admin', `/lead ${id}`, '/test', '/admins', '/add_admin 200', '/remove_admin 100']) {
    await handler(message(999, command));
  }
  for (const action of ['admin:status', 'admin:recent', 'admin:notifications:on', 'admin:notifications:off', 'forged']) {
    await handler(callback(999, action));
  }
  assert.ok(calls.every(call => call.params.text === 'Нет доступа.'));
  assert.ok(!JSON.stringify(calls).includes(lead.contact));
  assert.equal(store.getAdmin(999), null);
});

test('only configured persisted owner can add/remove/list admins, and owner cannot be removed', async t => {
  const { store, handler, calls } = setup(t);
  store.addAdmin(200);
  for (const command of ['/add_admin 300', '/remove_admin 100', '/admins']) {
    await handler(message(200, command));
    assert.match(calls.at(-1).params.text, /Только владелец/);
  }
  assert.equal(store.getAdmin(300), null);
  await handler(message(100, '/add_admin 300'));
  assert.equal(store.getAdmin(300).role, 'admin');
  assert.match(calls.at(-1).params.text, /\/start/);
  assert.equal(calls.at(-1).params.chat_id, 100, 'adding does not contact the recipient');
  await handler(message(100, '/admins'));
  assert.match(calls.at(-1).params.text, /100 — owner/);
  assert.match(calls.at(-1).params.text, /300 — admin/);
  await handler(message(100, '/remove_admin 100'));
  assert.equal(store.getAdmin(100).role, 'owner');
  await handler(message(100, '/remove_admin 300'));
  assert.equal(store.getAdmin(300), null);
  for (const invalid of ['-1', '0', '1.5', '200 300', '9007199254740992']) {
    await handler(message(100, `/add_admin ${invalid}`));
    assert.match(calls.at(-1).params.text, /Формат/);
  }
  store.setOwner(200);
  await handler(message(200, '/add_admin 400'));
  assert.equal(store.getAdmin(400), null, 'persisted role alone cannot override configured owner ID');
});

test('access commands queued through an outage expire after five minutes and malformed dates fail closed', async t => {
  const { store, handler, calls } = setup(t);
  store.addAdmin(200);
  const now = Math.floor(Date.now() / 1000);
  for (const date of [now - 301, now + 120, undefined, null, String(now), Infinity]) {
    for (const command of ['/add_admin 300', '/remove_admin 200']) {
      const update = message(100, command);
      update.message.date = date;
      await handler(update);
      assert.match(calls.at(-1).params.text, /устарела/);
      assert.equal(store.getAdmin(300), null);
      assert.equal(store.getAdmin(200).role, 'admin');
    }
  }
  await handler(message(100, '/add_admin 300'));
  assert.equal(store.getAdmin(300).role, 'admin');
});

test('replaying an access command rechecks persisted owner authority and preserves existing preferences', async t => {
  const { store, handler, telegram } = setup(t);
  const command = message(100, '/add_admin 200');
  telegram.call = async () => { throw apiError(503); };
  await assert.rejects(handler(command), { statusCode: 503 });
  assert.equal(store.getAdmin(200).role, 'admin');
  store.setNotifications(200, false);
  telegram.call = async () => true;
  await handler(command);
  assert.equal(store.getAdmin(200).notifications, false, 'duplicate grant never resets preferences');
  store.setOwner(300);
  store.revokeAdmin(200);
  await handler(command);
  assert.equal(store.getAdmin(200), null, 'old owner cannot replay a grant after revocation');
});

test('/admins splits long lists below Telegram limits and rechecks owner between pages', async t => {
  const { store, handler, calls, telegram } = setup(t);
  for (let id = 1000; id < 1200; id++) store.addAdmin(id);
  await handler(message(100, '/admins'));
  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => call.params.text.length <= 4096));
  assert.ok(calls.at(-1).params.text.includes('1199 — admin'));
  let pages = 0;
  telegram.call = async () => {
    pages++;
    store.setOwner(999);
  };
  await handler(message(100, '/admins'));
  assert.equal(pages, 1, 'no further page after owner revocation while the first send is in flight');
});

test('admin panel callbacks show status, at most five summaries, details and reversible notifications', async t => {
  const { store, handler, calls } = setup(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now++);
  let lastId;
  for (let index = 0; index < 7; index++) {
    lastId = store.enqueue({ ...lead, name: `Lead ${index}` },
      { ...metadata, idempotencyKey: `lead-${index}` }).id;
  }
  await handler(message(100, '/admin'));
  const buttons = calls.at(-1).params.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(button => button.callback_data),
    ['admin:status', 'admin:recent', 'admin:notifications:off']);
  await handler(callback(100, 'admin:status'));
  assert.match(calls.at(-1).params.text, /Заявок: 7/);
  await handler(callback(100, 'admin:recent'));
  const summaries = calls.at(-1).params.text;
  assert.equal((summaries.match(/\/lead /g) || []).length, 5);
  assert.ok(summaries.length <= 4096);
  assert.match(summaries, /Lead 6/);
  assert.ok(!summaries.includes('Lead 1'));
  assert.ok(!summaries.includes(lead.message));
  await handler(message(100, `/lead ${lastId.toUpperCase()}`));
  assert.ok(calls.at(-1).params.text.includes(lead.message));
  assert.ok(calls.at(-1).params.text.includes(lead.contact));
  assert.equal(calls.at(-1).params.parse_mode, undefined);
  await handler(callback(100, 'admin:notifications:off'));
  assert.equal(store.getAdmin(100).notifications, false);
  assert.deepEqual(store.pendingDeliveries(), []);
  await handler(message(100, '/admin'));
  assert.equal(store.getAdmin(100).notifications, false, '/admin never resets the preference');
  assert.equal(calls.at(-1).params.reply_markup.inline_keyboard[2][0].callback_data, 'admin:notifications:on');
  await handler(callback(100, 'admin:notifications:on'));
  assert.equal(store.getAdmin(100).notifications, true);
  assert.equal(store.pendingDeliveries().length, 7);
  await handler(message(100, '/lead invalid'));
  assert.match(calls.at(-1).params.text, /Формат/);
  await handler(message(100, '/lead 00000000-0000-4000-8000-000000000000'));
  assert.match(calls.at(-1).params.text, /не найдена/);
});

test('revoked users cannot reuse old callbacks, including revocation while acknowledgement is in flight', async t => {
  const { store, handler, calls, telegram } = setup(t);
  store.addAdmin(200);
  store.enqueue(lead, metadata);
  await handler(message(200, '/admin'));
  store.revokeAdmin(200);
  const start = calls.length;
  for (const action of ['admin:recent', 'admin:status', 'admin:notifications:on']) {
    await handler(callback(200, action));
  }
  assert.ok(calls.slice(start).every(call => call.params.text === 'Нет доступа.'));
  store.addAdmin(200);
  telegram.call = async method => {
    assert.equal(method, 'answerCallbackQuery');
    store.revokeAdmin(200);
  };
  await handler(callback(200, 'admin:recent'));
  assert.equal(store.getAdmin(200), null);
});

test('/test is a dummy notification only for the invoking admin, without reading or enqueuing a form', async t => {
  const { store, handler, calls } = setup(t);
  store.addAdmin(200);
  store.enqueue(lead, metadata);
  for (const method of ['getLead', 'recentLeads', 'enqueue']) {
    t.mock.method(store, method, () => { throw new Error('Real forms must not be used'); });
  }
  await handler(message(200, '/test'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.chat_id, 200);
  assert.match(calls[0].params.text, /Тестовое/);
  assert.ok(!calls[0].params.text.includes(lead.contact));
  assert.equal(store.stats().totalLeads, 1);
});

test('lead formatting keeps maximum contact intact, uses plain text and safely truncates Unicode', async t => {
  const { store, handler, calls } = setup(t);
  const contact = `${'x'.repeat(147)}@example.test`;
  assert.equal(contact.length, 160);
  const { id } = store.enqueue({
    ...lead, contact, name: '😀'.repeat(40), service: 'x'.repeat(80), message: '😀'.repeat(1500),
  }, metadata);
  await handler(message(100, `/lead ${id}`));
  const params = calls.at(-1).params;
  assert.ok(params.text.length <= 4096);
  assert.ok(params.text.includes(contact));
  assert.ok(params.text.includes('😀'.repeat(1500)));
  assert.equal(params.parse_mode, undefined);
  assert.equal(params.protect_content, true);
  assert.deepEqual(params.link_preview_options, { is_disabled: true });
  const oversized = formatLead({ ...store.getLead(id), message: '😀'.repeat(5000) });
  assert.ok(oversized.length <= 4096);
  assert.ok(oversized.includes(contact));
  assert.ok(oversized.endsWith('…'));
  assert.ok(oversized.isWellFormed());
});

test('handler tolerates expired callback acknowledgements and disables notifications on send 403', async t => {
  const { store, handler, telegram } = setup(t);
  let sent = 0;
  telegram.call = async method => {
    if (method === 'answerCallbackQuery') throw apiError(400);
    sent++;
    throw apiError(403);
  };
  await handler(callback(100, 'admin:status'));
  assert.equal(sent, 1);
  assert.equal(store.getAdmin(100).notifications, false);
  telegram.call = async () => { throw apiError(500); };
  await assert.rejects(handler(message(100, '/admin')), { statusCode: 500 });
});

test('worker refuses a webhook safely without deleting it or starting polling/deliveries', async t => {
  const { store } = setup(t, { owner: false });
  const methods = [];
  await assert.rejects(runWorker({
    store, ownerId: 100,
    telegram: { call: async method => {
      methods.push(method);
      return { url: `https://secret.example.test/${token}` };
    } },
  }), error => {
    assert.match(error.message, /webhook is configured/);
    assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes('https://'));
    return true;
  });
  assert.deepEqual(methods, ['getWebhookInfo']);
  assert.deepEqual(store.activeAdmins(), []);
});

test('worker retries startup and polling failures with bounded exponential delay and honors retry_after', async t => {
  const { store } = setup(t);
  const delays = [];
  let webhookCalls = 0;
  let polls = 0;
  let lastPollAt;
  await worker(t, store, async (method, _params, _timeout, controller) => {
    if (method === 'getWebhookInfo') {
      if (++webhookCalls === 1) throw apiError(503);
      return { url: '' };
    }
    assert.equal(method, 'getUpdates');
    if (lastPollAt !== undefined) delays.push(performance.now() - lastPollAt);
    lastPollAt = performance.now();
    polls++;
    if (polls === 1) throw apiError(429, 1);
    if (polls === 2) throw apiError(503);
    controller.abort();
    return [];
  }, { retryBaseMs: 2 });
  assert.equal(webhookCalls, 2);
  assert.equal(polls, 3);
  assert.ok(delays[0] >= 900, '429 retry_after takes priority over exponential delay');
  assert.ok(delays[1] >= 2, 'subsequent transient errors back off');
});

test('exponential backoff is capped at thirty seconds for poll and five minutes for outbox', () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, failures) => retryDelay({}, failures, 1000, 30_000)),
    [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  assert.equal(retryDelay({}, 100_000, 1000, 300_000), 300_000);
  assert.equal(retryDelay(apiError(429, 90), 0, 1000, 30_000), 90_000, 'server deadline is honored above the cap');
  assert.equal(retryDelay(apiError(429, Number.MAX_SAFE_INTEGER), 0, 1000, 30_000), 2_147_483_647);
  for (const retryAfter of [-1, NaN, Infinity, '60']) {
    assert.equal(retryDelay({ retryAfter }, 0, 1000, 30_000), 1000);
  }
});

test('polling orders updates and commits offset only after each successfully handled or skipped update', async t => {
  const { store } = setup(t);
  let polls = 0;
  let sends = 0;
  const offsets = [];
  await worker(t, store, async (method, params, timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      assert.equal(params.timeout, 25);
      assert.equal(timeout, 35_000);
      assert.deepEqual(params.allowed_updates, ['message', 'callback_query']);
      offsets.push(params.offset);
      if (++polls === 3) {
        assert.equal(store.getOffset(), 13);
        controller.abort();
        return [];
      }
      return [message(100, '/id', 12), null, { update_id: -1 }, { update_id: '8' },
        { update_id: 10, unsupported: true }, message(100, '/id', 11)];
    }
    assert.equal(method, 'sendMessage');
    sends++;
    if (sends === 1) {
      assert.equal(store.getOffset(), 11, 'unknown update was safely acknowledged');
      throw apiError(503);
    }
    return true;
  });
  assert.deepEqual(offsets, [0, 11, 13]);
  assert.equal(sends, 3);
  assert.equal(store.getOffset(), 13);
});

test('outbox progresses independently while long polling is waiting', async t => {
  const { store } = setup(t);
  store.enqueue(lead, metadata);
  let pollInFlight = false;
  let releasePoll;
  let delivered = 0;
  await worker(t, store, async (method, params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      pollInFlight = true;
      return new Promise(resolve => { releasePoll = resolve; });
    }
    assert.equal(method, 'sendMessage');
    assert.equal(pollInFlight, true);
    assert.equal(params.chat_id, 100);
    assert.ok(params.text.includes(lead.contact));
    delivered++;
    controller.abort();
    releasePoll([]);
    return true;
  });
  assert.equal(delivered, 1);
  assert.equal(store.stats().deliveredDeliveries, 1);
});

test('outbox persists retries and later delivers, 403 pauses recipient without blocking others', async t => {
  const { store } = setup(t);
  store.addAdmin(200);
  store.addAdmin(300);
  const { id } = store.enqueue(lead, metadata);
  const recipients = [];
  let ownerAttempts = 0;
  await worker(t, store, async (method, params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      if (store.stats().deliveredDeliveries === 2) controller.abort();
      await sleep(1);
      return [];
    }
    assert.equal(method, 'sendMessage');
    recipients.push(params.chat_id);
    if (params.chat_id === 100 && ++ownerAttempts === 1) throw apiError(503);
    if (params.chat_id === 200) throw apiError(403);
    return true;
  });
  assert.equal(ownerAttempts, 2);
  assert.equal(recipients.filter(id => id === 200).length, 1);
  assert.equal(store.getAdmin(200).notifications, false);
  assert.equal(store.stats().deliveredDeliveries, 2);
  assert.equal(store.stats().pendingDeliveries, 1);
  store.setNotifications(200, true);
  await sleep(3);
  assert.equal(store.pendingDeliveries()[0].leadId, id);
  assert.equal(store.pendingDeliveries()[0].attempts, 1);
});

test('outbox honors retry_after without immediate resend', async t => {
  const { store } = setup(t);
  store.enqueue(lead, metadata);
  let sends = 0;
  const before = Date.now();
  await worker(t, store, async (method, _params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      await sleep(1);
      return [];
    }
    sends++;
    controller.abort();
    throw apiError(429, 60);
  });
  assert.equal(sends, 1);
  assert.equal(store.pendingDeliveries().length, 0);
  t.mock.method(Date, 'now', () => before + 61_000);
  const pending = store.pendingDeliveries()[0];
  assert.equal(pending.attempts, 1);
  assert.ok(pending.nextAttemptAt >= before + 60_000);
});

test('outbox rechecks authorization after every await and cannot deliver a cached batch to a revoked admin', async t => {
  const { store } = setup(t);
  store.addAdmin(200);
  store.enqueue(lead, metadata);
  const recipients = [];
  await worker(t, store, async (method, params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      if (store.stats().deliveredDeliveries === 1) controller.abort();
      await sleep(1);
      return [];
    }
    recipients.push(params.chat_id);
    store.revokeAdmin(200);
    return true;
  });
  assert.deepEqual(recipients, [100]);
  assert.equal(store.stats().pendingDeliveries, 0);
});

test('revoking and regranting an admin does not resurrect a delivery in an in-flight batch', async t => {
  const { store } = setup(t);
  store.addAdmin(200);
  store.enqueue(lead, metadata);
  const recipients = [];
  await worker(t, store, async (method, params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      if (store.stats().deliveredDeliveries === 1) controller.abort();
      await sleep(1);
      return [];
    }
    recipients.push(params.chat_id);
    store.revokeAdmin(200);
    store.addAdmin(200);
    return true;
  });
  assert.deepEqual(recipients, [100]);
  assert.equal(store.getAdmin(200).role, 'admin');
  assert.equal(store.stats().pendingDeliveries, 0);
});

test('worker purges expired leads before sending and runs retention periodically', async t => {
  const { store } = setup(t);
  const realNow = Date.now.bind(Date);
  let current = realNow() - 31 * 86_400_000;
  t.mock.method(Date, 'now', () => current);
  const { id } = store.enqueue(lead, metadata);
  current = realNow();
  let purges = 0;
  const originalPurge = store.purgeExpired.bind(store);
  t.mock.method(store, 'purgeExpired', days => {
    purges++;
    assert.equal(days, 30);
    return originalPurge(days);
  });
  await worker(t, store, async (method, _params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    assert.equal(method, 'getUpdates', 'expired leads must not be sent');
    if (purges >= 2) controller.abort();
    current += 100;
    await sleep(1);
    return [];
  });
  assert.ok(purges >= 2);
  assert.equal(store.getLead(id), null);
});

test('worker shutdown does not start work on an aborted signal or process updates received after abort', async t => {
  const { store } = setup(t, { owner: false });
  const controller = new AbortController();
  controller.abort();
  await runWorker({
    store, ownerId: 100, signal: controller.signal,
    telegram: { call: async () => { throw new Error('must not call'); } },
  });
  assert.deepEqual(store.activeAdmins(), []);
  await worker(t, store, async (method, _params, _timeout, stop) => {
    if (method === 'getWebhookInfo') return { url: '' };
    assert.equal(method, 'getUpdates');
    stop.abort();
    return [message(100, '/id', 50)];
  });
  assert.equal(store.getOffset(), 0);
  assert.equal(store.getAdmin(100).role, 'owner', 'worker explicitly provisions configured owner');
});

test('worker runs without ownerId so /id can be discovered, without creating an owner', async t => {
  const { store } = setup(t, { owner: false });
  let polls = 0;
  const messages = [];
  await worker(t, store, async (method, params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      if (++polls === 1) {
        return [message(100, '/start', 1), message(200, '/id', 2), message(100, '/admin', 3)];
      }
      controller.abort();
      return [];
    }
    assert.equal(method, 'sendMessage');
    messages.push([params.chat_id, params.text]);
    return true;
  }, { ownerId: null });
  assert.deepEqual(messages, [[100, '100'], [200, '200'], [100, 'Нет доступа.']]);
  assert.equal(store.getOffset(), 4);
  assert.deepEqual(store.activeAdmins(), []);
});

test('null ownerId suspends delivery of persisted outbox and denies persisted owner commands', async t => {
  const { store } = setup(t);
  store.enqueue(lead, metadata);
  let polls = 0;
  const messages = [];
  await worker(t, store, async (method, params, _timeout, controller) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') {
      if (++polls === 1) return [message(100, '/admin', 1), message(100, '/id', 2)];
      await sleep(5);
      controller.abort();
      return [];
    }
    assert.equal(method, 'sendMessage');
    messages.push(params.text);
    return true;
  }, { ownerId: null });
  assert.deepEqual(messages, ['Нет доступа.', '100']);
  assert.equal(store.stats().pendingDeliveries, 1);
  assert.equal(store.stats().deliveredDeliveries, 0);
  assert.equal(store.getAdmin(100).role, 'owner', 'missing config does not delete persisted roles');
});

test('worker safely stops on credential errors and invalid webhook configuration', async t => {
  const { store } = setup(t);
  for (const result of [null, {}, { url: 1 }]) {
    await assert.rejects(runWorker({
      store, ownerId: 100, telegram: { call: async () => result },
    }), /Invalid Telegram webhook configuration/);
  }
  for (const statusCode of [401, 403, 409]) {
    for (const stage of ['getWebhookInfo', 'getUpdates']) {
      let failedCalls = 0;
      await assert.rejects(runWorker({
        store, ownerId: 100,
        telegram: { call: async method => {
          if (method === stage) {
            failedCalls++;
            throw apiError(statusCode);
          }
          return { url: '' };
        } },
      }), /Telegram/);
      assert.equal(failedCalls, 1, 'permanent authorization/conflict failures must reject without retry');
    }
  }
});

test('delivery 401/409 rejects runWorker, stops polling, and leaves the lead queued', async t => {
  const { store } = setup(t);
  store.enqueue(lead, metadata);
  for (const statusCode of [401, 409]) {
    let sends = 0;
    let polls = 0;
    await assert.rejects(runWorker({
      store, ownerId: 100, retryBaseMs: 1, outboxIntervalMs: 1,
      telegram: { call: async method => {
        if (method === 'getWebhookInfo') return { url: '' };
        if (method === 'getUpdates') {
          polls++;
          await sleep(10);
          return [];
        }
        sends++;
        throw apiError(statusCode);
      } },
    }), /Telegram delivery/);
    assert.equal(sends, 1);
    assert.equal(polls, 1, 'the independent poll loop has stopped before rejection settles');
    assert.equal(store.stats().pendingDeliveries, 1);
    assert.equal(store.pendingDeliveries()[0].attempts, 0);
  }
});
