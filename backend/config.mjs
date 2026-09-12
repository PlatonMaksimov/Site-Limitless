import path from 'node:path';

export function loadConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const origin = env.SITE_ORIGIN || 'http://127.0.0.1:4180';
  const url = new URL(origin);
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid SITE_ORIGIN');
  const ownerId = env.TELEGRAM_OWNER_ID ? number('TELEGRAM_OWNER_ID', 0, 1, Number.MAX_SAFE_INTEGER) : null;
  const privacyUrl = env.PRIVACY_URL || '';
  if (privacyUrl) {
    const privacy = new URL(privacyUrl, origin);
    if (privacy.origin !== origin || privacy.username || privacy.password) throw new Error('PRIVACY_URL must be same-origin');
  }
  if ((env.PRIVACY_VERSION || '').length > 128) throw new Error('Invalid PRIVACY_VERSION');
  return {
    host: '127.0.0.1',
    port: number('PORT', 4180, 1024, 65535),
    siteOrigin: origin,
    secure: url.protocol === 'https:',
    databasePath: path.resolve(env.DATABASE_PATH || 'data/limitless.sqlite'),
    token: env.TELEGRAM_BOT_TOKEN || '',
    ownerId,
    privacyUrl,
    privacyVersion: env.PRIVACY_VERSION || '',
    leadsEnabled: env.LEADS_ENABLED === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    retentionDays: number('RETENTION_DAYS', 30, 1, 365),
    maxQueue: number('MAX_PENDING_DELIVERIES', 5000, 10, 50000),
    rateLimit: number('LEAD_RATE_LIMIT', 5, 1, 100),
    rateWindowMs: 10 * 60 * 1000,
  };
}

export function availability(config, store) {
  if (!config.secure) return { available: false, reason: 'https' };
  if (!config.privacyUrl || !config.privacyVersion) return { available: false, reason: 'privacy' };
  if (!config.token || !config.ownerId || !config.leadsEnabled) return { available: false, reason: 'setup' };
  if (!store.activeAdmins().length || !store.stats().notificationsEnabled) return { available: false, reason: 'admins' };
  return { available: true, reason: '' };
}
