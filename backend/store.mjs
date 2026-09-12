import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function normalizeAdminId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Invalid admin ID.');
  return id;
}

function text(value, label, maximum, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())
    || value.includes('\0')) throw new TypeError(`Invalid ${label}.`);
  return value;
}

function limitValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid limit.');
  return Math.min(value, 100);
}

function leadRecord(row) {
  return row ? {
    id: row.id,
    createdAt: row.created_at,
    name: row.name,
    contact: row.contact,
    service: row.service,
    message: row.message,
    consent: true,
    privacyVersion: row.privacy_version,
  } : null;
}

/**
 * Synchronous, single-owner SQLite store. No user profiles, updates, IPs or tokens
 * are retained. activeAdmins() includes admins with paused notifications.
 * enqueue() snapshots all authorized recipients; pausing retains their outbox.
 */
export class Store {
  #db;
  #statements = new Map();

  constructor(databasePath) {
    this.#db = new DatabaseSync(databasePath);
    try {
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS admins (
          id INTEGER PRIMARY KEY CHECK (id > 0),
          role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
          notifications INTEGER NOT NULL DEFAULT 1 CHECK (notifications IN (0, 1))
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON admins(role) WHERE role = 'owner';
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          name TEXT NOT NULL,
          contact TEXT NOT NULL,
          service TEXT NOT NULL,
          message TEXT NOT NULL,
          consent INTEGER NOT NULL CHECK (consent = 1),
          privacy_version TEXT NOT NULL,
          idempotency_key TEXT UNIQUE,
          payload_hash TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at, id);
        CREATE TABLE IF NOT EXISTS deliveries (
          lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          delivered_at INTEGER,
          PRIMARY KEY (lead_id, admin_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(next_attempt_at)
          WHERE delivered_at IS NULL;
        CREATE TABLE IF NOT EXISTS worker_state (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO worker_state(key, value) VALUES ('offset', 0);
      `);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #query(sql) {
    if (!this.#statements.has(sql)) this.#statements.set(sql, this.#db.prepare(sql));
    return this.#statements.get(sql);
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
      this.#statements.clear();
    }
  }

  enqueue(lead, { idempotencyKey = null, payloadHash, privacyVersion } = {}) {
    if (!lead || lead.consent !== true) throw new TypeError('Consent is required.');
    const name = text(lead.name, 'name', 80);
    const contact = text(lead.contact, 'contact', 160);
    const service = text(lead.service, 'service', 80);
    const message = text(lead.message, 'message', 3000, true);
    if (idempotencyKey !== null) text(idempotencyKey, 'idempotency key', 200);
    text(payloadHash, 'payload hash', 256);
    text(privacyVersion, 'privacy version', 128);

    return this.#transaction(() => {
      const existing = idempotencyKey === null ? null : this.getByKey(idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          const error = new Error('Idempotency key conflicts with an existing payload.');
          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return { id: existing.id, duplicate: true };
      }
      const admins = this.activeAdmins();
      if (admins.length === 0) throw new Error('No active administrators.');
      const id = randomUUID();
      const now = Date.now();
      this.#query(`INSERT INTO leads
        (id, created_at, name, contact, service, message, consent, privacy_version, idempotency_key, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(id, now, name, contact, service, message, privacyVersion, idempotencyKey, payloadHash);
      const delivery = this.#query('INSERT INTO deliveries (lead_id, admin_id, next_attempt_at) VALUES (?, ?, ?)');
      for (const admin of admins) delivery.run(id, admin.id, now);
      return { id, duplicate: false };
    });
  }

  getByKey(key) {
    text(key, 'idempotency key', 200);
    const row = this.#query('SELECT id, payload_hash FROM leads WHERE idempotency_key = ?').get(key);
    return row ? { id: row.id, payloadHash: row.payload_hash } : null;
  }

  activeAdmins() {
    return this.#query("SELECT id, role FROM admins ORDER BY role = 'owner' DESC, id")
      .all().map(row => ({ id: row.id, role: row.role }));
  }

  // An explicit owner replacement revokes the previous owner, including their outbox.
  setOwner(id) {
    id = normalizeAdminId(id);
    this.#transaction(() => {
      this.#query("DELETE FROM admins WHERE role = 'owner' AND id != ?").run(id);
      this.#query(`INSERT INTO admins (id, role) VALUES (?, 'owner')
        ON CONFLICT(id) DO UPDATE SET role = 'owner'`).run(id);
    });
  }

  addAdmin(id) {
    id = normalizeAdminId(id);
    this.#query("INSERT INTO admins (id, role) VALUES (?, 'admin') ON CONFLICT(id) DO NOTHING").run(id);
  }

  revokeAdmin(id) {
    id = normalizeAdminId(id);
    return this.#transaction(() => {
      if (this.getAdmin(id)?.role === 'owner') throw new Error('The owner cannot be revoked.');
      return this.#query('DELETE FROM admins WHERE id = ?').run(id).changes > 0;
    });
  }

  getAdmin(id) {
    id = normalizeAdminId(id);
    const row = this.#query('SELECT id, role, notifications FROM admins WHERE id = ?').get(id);
    return row ? { id: row.id, role: row.role, notifications: row.notifications === 1 } : null;
  }

  setNotifications(id, enabled) {
    id = normalizeAdminId(id);
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid notification preference.');
    return this.#query('UPDATE admins SET notifications = ? WHERE id = ?')
      .run(Number(enabled), id).changes > 0;
  }

  recentLeads(limit = 5) {
    return this.#query('SELECT * FROM leads ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limitValue(limit)).map(leadRecord);
  }

  getLead(id) {
    if (typeof id !== 'string') return null;
    return leadRecord(this.#query('SELECT * FROM leads WHERE id = ?').get(id));
  }

  stats() {
    const row = this.#query(`SELECT
      (SELECT COUNT(*) FROM leads) AS totalLeads,
      (SELECT COUNT(*) FROM deliveries WHERE delivered_at IS NULL) AS pendingDeliveries,
      (SELECT COUNT(*) FROM deliveries WHERE delivered_at IS NOT NULL) AS deliveredDeliveries,
      (SELECT COUNT(*) FROM admins) AS admins,
      (SELECT COUNT(*) FROM admins WHERE notifications = 1) AS notificationsEnabled`).get();
    return { ...row };
  }

  getOffset() {
    return this.#query("SELECT value FROM worker_state WHERE key = 'offset'").get().value;
  }

  setOffset(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid update offset.');
    this.#query("UPDATE worker_state SET value = MAX(value, ?) WHERE key = 'offset'").run(offset);
  }

  pendingDeliveries(limit = 10) {
    return this.#query(`SELECT l.*, d.admin_id, d.attempts, d.next_attempt_at
      FROM deliveries d JOIN leads l ON l.id = d.lead_id JOIN admins a ON a.id = d.admin_id
      WHERE d.delivered_at IS NULL AND d.next_attempt_at <= ? AND a.notifications = 1
      ORDER BY d.next_attempt_at, l.created_at, l.id, d.admin_id LIMIT ?`)
      .all(Date.now(), limitValue(limit)).map(row => ({
        ...leadRecord(row),
        leadId: row.id,
        adminId: row.admin_id,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
      }));
  }

  markDelivered(leadId, adminId) {
    this.#query(`UPDATE deliveries SET delivered_at = ?
      WHERE lead_id = ? AND admin_id = ? AND delivered_at IS NULL`)
      .run(Date.now(), leadId, normalizeAdminId(adminId));
  }

  // attempts counts failures; successful acknowledgement is separately recorded.
  markRetry(leadId, adminId, delaySeconds) {
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 31_536_000) {
      throw new TypeError('Invalid retry delay.');
    }
    this.#query(`UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ?
      WHERE lead_id = ? AND admin_id = ? AND delivered_at IS NULL`)
      .run(Date.now() + Math.ceil(delaySeconds * 1000), leadId, normalizeAdminId(adminId));
  }

  // Retention also removes idempotency keys; a purged key may be used again.
  purgeExpired(days) {
    if (!Number.isFinite(days) || days <= 0 || days > 36_500) throw new TypeError('Invalid retention days.');
    const deleted = this.#transaction(() => this.#query('DELETE FROM leads WHERE created_at < ?')
      .run(Date.now() - days * 86_400_000).changes);
    // secure_delete clears freed cells; truncate the WAL when no other reader holds it.
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return deleted;
  }
}
