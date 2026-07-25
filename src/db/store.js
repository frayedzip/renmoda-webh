// SQLite stores exactly one thing that matters: processed webhook event IDs.
// Razorpay redelivers on timeout, and a duplicate subscription.charged would
// re-apply the plan tag (harmless on its own, but dedupe keeps the audit trail
// honest and guards any future money-affecting work).
// membership_log is a pure audit trail so "why does this member have this tag?"
// is answerable without guessing.
//
// Kept behind a tiny interface (hasProcessed / claimEvent / logMembership) so
// the backing store is swappable later without touching business logic.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function createStore(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id    TEXT PRIMARY KEY,
      event_type  TEXT NOT NULL,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS membership_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id            TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      shopify_customer_id TEXT NOT NULL,
      action              TEXT NOT NULL CHECK (action IN ('tag_added', 'tag_removed')),
      tag                 TEXT NOT NULL,
      note                TEXT,
      created_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_membership_log_customer
      ON membership_log (shopify_customer_id, created_at);

    -- Offline Admin API token from the OAuth authorization code flow (for
    -- production stores, where client credentials is not permitted). Normally
    -- non-expiring (expires_at NULL); refresh_token/expires_at are only set if
    -- Shopify issues an expiring token.
    CREATE TABLE IF NOT EXISTS shopify_tokens (
      shop          TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,
      scope         TEXT,
      refresh_token TEXT,
      expires_at    TEXT,
      obtained_at   TEXT NOT NULL
    );
  `);

  const claimStmt = db.prepare(
    'INSERT OR IGNORE INTO processed_events (event_id, event_type, received_at) VALUES (?, ?, ?)'
  );
  const hasStmt = db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?');
  const logStmt = db.prepare(`
    INSERT INTO membership_log
      (event_id, event_type, shopify_customer_id, action, tag, note, created_at)
    VALUES
      (@eventId, @eventType, @shopifyCustomerId, @action, @tag, @note, @createdAt)
  `);

  const getTokenStmt = db.prepare(
    'SELECT shop, access_token, scope, refresh_token, expires_at, obtained_at FROM shopify_tokens WHERE shop = ?'
  );
  const saveTokenStmt = db.prepare(`
    INSERT INTO shopify_tokens (shop, access_token, scope, refresh_token, expires_at, obtained_at)
    VALUES (@shop, @accessToken, @scope, @refreshToken, @expiresAt, @obtainedAt)
    ON CONFLICT(shop) DO UPDATE SET
      access_token  = excluded.access_token,
      scope         = excluded.scope,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      obtained_at   = excluded.obtained_at
  `);

  return {
    hasProcessed(eventId) {
      return hasStmt.get(eventId) !== undefined;
    },

    // Atomic claim: INSERT OR IGNORE + changes check in a single statement.
    // A check-then-insert as two steps would let two concurrent deliveries of
    // the same event both pass the check and both credit the wallet.
    claimEvent(eventId, eventType) {
      const result = claimStmt.run(eventId, eventType, new Date().toISOString());
      return result.changes > 0;
    },

    logMembership({ eventId, eventType, shopifyCustomerId, action, tag, note = null }) {
      logStmt.run({
        eventId,
        eventType,
        shopifyCustomerId,
        action,
        tag,
        note,
        createdAt: new Date().toISOString(),
      });
    },

    getShopifyToken(shop) {
      const row = getTokenStmt.get(shop);
      if (!row) return null;
      return {
        shop: row.shop,
        accessToken: row.access_token,
        scope: row.scope,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
        obtainedAt: row.obtained_at,
      };
    },

    saveShopifyToken({ shop, accessToken, scope = null, refreshToken = null, expiresAt = null }) {
      saveTokenStmt.run({
        shop,
        accessToken,
        scope,
        refreshToken,
        expiresAt,
        obtainedAt: new Date().toISOString(),
      });
    },

    close() {
      db.close();
    },
  };
}
