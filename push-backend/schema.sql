PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_test_at INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  schedule_revision TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes IN (120, 30, 5)),
  due_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claim_token TEXT,
  claim_until INTEGER,
  delivered_at INTEGER,
  error_code INTEGER,
  UNIQUE (device_id, item_id, start_at, offset_minutes)
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, next_attempt_at, due_at);
CREATE INDEX IF NOT EXISTS jobs_device ON jobs(device_id, revision);

-- Hashes of client IPs, used only for a short pairing-attempt rate limit.
CREATE TABLE IF NOT EXISTS pairing_attempts (
  ip_hash TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket)
);
