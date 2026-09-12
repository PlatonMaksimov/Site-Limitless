import { setTimeout as sleep } from 'node:timers/promises';

// Keep transient startup failures inside this process so a temporary network
// outage cannot exhaust systemd's restart limit and leave the bot stopped.
export async function verifyTelegram(telegram, { wait = sleep, logger = console } = {}) {
  let failures = 0;
  for (;;) {
    let me, webhook;
    try {
      me = await telegram.call('getMe', {});
      webhook = await telegram.call('getWebhookInfo', {});
    } catch (error) {
      if ([400, 401, 403, 404, 409].includes(error.statusCode)) throw new Error('telegram_configuration_failed');
      logger.error('telegram_startup_retry');
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
      const retryAfter = Number.isFinite(error.retryAfter) ? Math.min(3600000, error.retryAfter * 1000) : 0;
      await wait(Math.max(backoff, retryAfter));
      continue;
    }
    if (!me?.is_bot || typeof me.username !== 'string' || typeof webhook?.url !== 'string') {
      throw new Error('telegram_invalid_response');
    }
    if (webhook.url) throw new Error('telegram_existing_webhook');
    return me;
  }
}
