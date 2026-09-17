-- VigilOps Cloud: accounts, subscriptions, servers, backups, alerts

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  login TEXT,
  name TEXT,
  email TEXT NOT NULL,
  emails TEXT NOT NULL DEFAULT '[]',        -- JSON array of verified emails, lowercase
  telegram_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                       -- Bachs sub_...
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  customer_id TEXT,
  email TEXT NOT NULL,                       -- lowercase
  plan TEXT NOT NULL,                        -- pro | team | enterprise
  interval TEXT,
  status TEXT NOT NULL,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX subscriptions_email ON subscriptions(email);
CREATE INDEX subscriptions_account ON subscriptions(account_id);

CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hostname TEXT,
  agent_version TEXT,
  schedules TEXT NOT NULL DEFAULT '[]',      -- JSON from the agent's heartbeat
  utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  offline_alerted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX servers_account ON servers(account_id);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  container TEXT NOT NULL,
  database_name TEXT NOT NULL,
  file TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  status TEXT NOT NULL,                      -- uploading | complete | failed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE (server_id, file)
);
CREATE INDEX backups_account ON backups(account_id, status);
CREATE INDEX backups_server ON backups(server_id, container, created_at);

CREATE TABLE telegram_links (
  code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE alerts (
  key TEXT PRIMARY KEY,                      -- dedupe key, e.g. missed:<server>:<container>:<slot>
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
