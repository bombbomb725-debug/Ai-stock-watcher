-- AI Stock Watcher multi-user schema (Cloudflare D1)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  picture_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, symbol),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist(symbol);

CREATE TABLE IF NOT EXISTS user_stock_state (
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  status_label TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  last_price REAL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, symbol),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, symbol, old_status, new_status, sent_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_ideas (
  symbol TEXT PRIMARY KEY,
  company_name TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'wait',
  rationale TEXT,
  scanned_at TEXT NOT NULL
);
