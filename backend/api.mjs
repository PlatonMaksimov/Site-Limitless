import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { availability } from './config.mjs';
import { validateLead } from '../src/lead.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function createRateLimiter({ max = 5, windowMs = 600000, capacity = 10000, now = Date.now } = {}) {
  const buckets = new Map();
  return (key) => {
    const current = now();
    if (buckets.size >= capacity) {
      for (const [id, bucket] of buckets) if (bucket.until <= current) buckets.delete(id);
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= current) {
      if (!bucket && buckets.size >= capacity) return false;
      bucket = { count: 0, until: current + windowMs };
      buckets.set(key, bucket);
    }
    return ++bucket.count <= max;
  };
}

function readJSON(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16384) {
        if (!failed) { failed = true; reject(Object.assign(new Error('Body too large'), { status: 413 })); }
      } else if (!failed) chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    request.on('aborted', () => reject(Object.assign(new Error('Aborted'), { status: 400 })));
    request.on('error', () => reject(Object.assign(new Error('Read error'), { status: 400 })));
  });
}

export function parseLead(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') return null;
  const fields = ['name', 'contact', 'service', 'message'];
  if (!fields.every((key) => typeof body[key] === 'string') || body.consent !== true) return null;
  // Enforce limits before trimming, and reject invisible control characters.
  if (body.name.length > 80 || body.contact.length > 160 || body.message.length > 3000) return null;
  if (fields.some((key) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body[key]))) return null;
  if (/[\r\n]/.test(body.name + body.contact + body.service)) return null;
  const lead = Object.fromEntries(fields.map((key) => [key, body[key].trim()]));
  lead.consent = true;
  return Object.keys(validateLead(lead)).length ? null : lead;
}

export function createApiServer({ config, store, logger = console, readiness = () => true }) {
  const salt = randomBytes(32).toString('hex');
  const limit = createRateLimiter({ max: config.rateLimit, windowMs: config.rateWindowMs });
  const globalLimit = createRateLimiter({ max: 200, windowMs: 60000, capacity: 1 });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    const remote = request.socket.remoteAddress;
    const proxy = config.trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    const encrypted = Boolean(request.socket.encrypted) || (proxy && request.headers['x-forwarded-proto'] === 'https');
    try {
      if (request.url === '/api/health' && request.method === 'GET') {
        json(200, { ok: true });
        return;
      }
      if (request.url === '/runtime-config.js' && ['GET', 'HEAD'].includes(request.method)) {
        const state = encrypted ? availability(config, store) : { available: false, reason: 'https' };
        const available = state.available && readiness();
        const runtime = {
          form: { endpoint: '/api/leads', timeoutMs: 12000 },
          privacyUrl: config.privacyUrl,
          available,
          reason: available ? '' : state.reason || 'setup',
        };
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(request.method === 'HEAD' ? undefined : `globalThis.LIMITLESS_RUNTIME = ${JSON.stringify(runtime).replace(/</g, '\\u003c')};\n`);
        return;
      }
      if (request.url !== '/api/leads') { json(404, { ok: false, code: 'not_found' }); return; }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        json(405, { ok: false, code: 'method_not_allowed' }); return;
      }
      const sameOrigin = request.headers.origin === config.siteOrigin;
      const fetchSite = request.headers['sec-fetch-site'];
      if (!sameOrigin || (fetchSite && fetchSite !== 'same-origin')) { json(403, { ok: false, code: 'origin' }); return; }
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
        json(415, { ok: false, code: 'content_type' }); return;
      }
      const address = proxy ? (request.headers['x-real-ip'] || remote) : remote;
      if (!globalLimit('all') || !limit(hash(salt + address))) {
        response.setHeader('Retry-After', '600');
        json(429, { ok: false, code: 'rate_limit' }); return;
      }
      if (!encrypted || !availability(config, store).available || !readiness()) { json(503, { ok: false, code: 'unavailable' }); return; }
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !uuid.test(key)) { json(400, { ok: false, code: 'idempotency_key' }); return; }
      if (Number(request.headers['content-length']) > 16384) { json(413, { ok: false, code: 'body_size' }); return; }
      const body = await readJSON(request);
      const lead = parseLead(body);
      if (!lead) { json(422, { ok: false, code: 'validation' }); return; }
      // Administrator preferences or worker readiness may change while a slow
      // request body is arriving. Recheck before the synchronous transaction.
      if (!availability(config, store).available || !readiness()) { json(503, { ok: false, code: 'unavailable' }); return; }
      const payloadHash = hash(JSON.stringify(lead));
      const existing = store.getByKey(key);
      if (existing) {
        if (existing.payloadHash !== payloadHash) json(409, { ok: false, code: 'idempotency_conflict' });
        else json(200, { ok: true, id: existing.id });
        return;
      }
      if (store.stats().pendingDeliveries + store.activeAdmins().length > config.maxQueue) {
        json(503, { ok: false, code: 'queue_full' }); return;
      }
      const result = store.enqueue(lead, { idempotencyKey: key, payloadHash, privacyVersion: config.privacyVersion });
      // Success means a durable transaction has committed, NOT Telegram delivery.
      json(201, { ok: true, id: result.id });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
      if (status === 500) logger.error('lead_api_error'); // No contacts, bodies, tokens or request URLs.
      json(status, { ok: false, code: status === 500 ? 'internal_error' : 'invalid_body' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}
