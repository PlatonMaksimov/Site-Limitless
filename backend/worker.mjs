import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeAdminId } from './store.mjs';
import { createUpdateHandler, formatLead, notificationParams } from './telegram.mjs';

// Milliseconds; exported for deterministic tests without sleeping through backoff.
export function retryDelay(error, failures, base, maximum) {
  const exponential = Math.min(maximum, base * 2 ** Math.min(failures, 20));
  const retryAfter = Number.isSafeInteger(error?.retryAfter) && error.retryAfter > 0
    ? Math.min(error.retryAfter * 1000, 2_147_483_647) : 0;
  return Math.max(exponential, retryAfter);
}

async function pause(milliseconds, signal) {
  try {
    await sleep(milliseconds, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function fatalTelegramFailure(error) {
  return error?.statusCode === 401 || error?.statusCode === 403 || error?.statusCode === 409;
}

/**
 * Run ONE worker per bot/database. HTTP producers may use separate connections.
 * Delivery is at-least-once: Telegram has no sendMessage idempotency primitive.
 * The caller owns the store. Shutdown waits for an in-flight request (<=35s with
 * createTelegramClient); no new updates/deliveries start after abort.
 * Without ownerId, poll only for public ID commands and suspend all deliveries.
 */
export async function runWorker({
  store, telegram, ownerId, signal,
  retentionDays = 30,
  retryBaseMs = 1000,
  outboxIntervalMs = 1000,
  retentionIntervalMs = 3_600_000,
}) {
  ownerId = ownerId == null ? null : normalizeAdminId(ownerId);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 || retentionDays > 36_500) {
    throw new TypeError('Invalid retention days.');
  }
  for (const interval of [retryBaseMs, outboxIntervalMs, retentionIntervalMs]) {
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647) {
      throw new TypeError('Invalid worker interval.');
    }
  }
  const stop = new AbortController();
  const runningSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const handleUpdate = createUpdateHandler({ store, telegram, ownerId });
  if (runningSignal.aborted) return;

  // Never delete or replace an existing webhook.
  for (let failures = 0; !runningSignal.aborted;) {
    let info;
    try {
      info = await telegram.call('getWebhookInfo', {}, 10_000);
    } catch (error) {
      if (runningSignal.aborted) return;
      if (fatalTelegramFailure(error) || (error?.statusCode >= 400 && error.statusCode < 429)) {
        throw new Error('Telegram webhook check failed.');
      }
      await pause(retryDelay(error, failures++, retryBaseMs, 30_000), runningSignal);
      continue;
    }
    if (runningSignal.aborted) return;
    if (!info || typeof info.url !== 'string') throw new Error('Invalid Telegram webhook configuration.');
    if (info.url !== '') throw new Error('Telegram webhook is configured; polling was not started.');
    break;
  }
  if (runningSignal.aborted) return;
  if (ownerId !== null) store.setOwner(ownerId);

  async function poll() {
    let failures = 0;
    while (!runningSignal.aborted) {
      try {
        const updates = await telegram.call('getUpdates', {
          offset: store.getOffset(), timeout: 25, allowed_updates: ['message', 'callback_query'],
        }, 35_000);
        if (runningSignal.aborted) return;
        if (!Array.isArray(updates)) throw new Error('Invalid Telegram update batch.');
        const ordered = updates.filter(update => Number.isSafeInteger(update?.update_id)
          && update.update_id >= 0 && update.update_id < Number.MAX_SAFE_INTEGER)
          .sort((a, b) => a.update_id - b.update_id);
        for (const update of ordered) {
          if (runningSignal.aborted) return;
          if (update.update_id < store.getOffset()) continue;
          await handleUpdate(update);
          store.setOffset(update.update_id + 1);
        }
        failures = 0;
        // Real long polling normally waits; also avoid spinning on empty/malformed mocks or proxies.
        if (!ordered.length) await pause(retryBaseMs, runningSignal);
      } catch (error) {
        if (runningSignal.aborted) return;
        if (fatalTelegramFailure(error)) {
          throw new Error('Telegram polling authorization or conflict failure.');
        }
        await pause(retryDelay(error, failures++, retryBaseMs, 30_000), runningSignal);
      }
    }
  }

  async function deliver() {
    let nextPurgeAt = 0;
    while (!runningSignal.aborted) {
      if (Date.now() >= nextPurgeAt) {
        store.purgeExpired(retentionDays);
        nextPurgeAt = Date.now() + retentionIntervalMs;
      }
      const pending = ownerId === null ? [] : store.pendingDeliveries(10);
      for (const item of pending) {
        if (runningSignal.aborted) return;
        // A revoke and subsequent regrant must not resurrect an old cached delivery.
        const current = store.pendingDeliveries(10)
          .find(row => row.leadId === item.leadId && row.adminId === item.adminId);
        if (!current) continue;
        // Never trust authorization or PII cached before another asynchronous send.
        const admin = store.getAdmin(item.adminId);
        const lead = store.getLead(item.leadId);
        if (!admin || !admin.notifications || !lead) continue;
        try {
          await telegram.call('sendMessage', notificationParams(admin.id, formatLead(lead)));
        } catch (error) {
          if (error?.statusCode === 401 || error?.statusCode === 409) {
            throw new Error('Telegram delivery authorization or conflict failure.');
          }
          if (error?.statusCode === 403) store.setNotifications(admin.id, false);
          store.markRetry(item.leadId, admin.id,
            retryDelay(error, current.attempts, retryBaseMs, 300_000) / 1000);
          continue;
        }
        // Local persistence failures are fatal, not classified as Telegram errors.
        store.markDelivered(item.leadId, admin.id);
      }
      await pause(outboxIntervalMs, runningSignal);
    }
  }

  const loops = [poll(), deliver()];
  try {
    await Promise.all(loops);
  } finally {
    stop.abort();
    await Promise.allSettled(loops);
  }
}
