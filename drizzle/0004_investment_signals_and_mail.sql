CREATE TABLE investment_plans (
  symbol TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  thesis TEXT NOT NULL,
  entry_low REAL,
  entry_high REAL,
  risk_price REAL,
  peak_giveback_pct REAL,
  opening_drop_pct REAL,
  include_extended INTEGER NOT NULL,
  next_event TEXT NOT NULL,
  next_event_date TEXT,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE investment_quote_state (
  symbol TEXT PRIMARY KEY NOT NULL,
  observed_at INTEGER NOT NULL,
  lot_signature TEXT NOT NULL,
  peak_pnl REAL,
  entry_active INTEGER NOT NULL,
  risk_active INTEGER NOT NULL,
  giveback_active INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE investment_mail (
  id TEXT PRIMARY KEY NOT NULL,
  digest_key TEXT UNIQUE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  retry_after INTEGER,
  provider_ref TEXT,
  error TEXT,
  sent_at INTEGER,
  confirmed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE investment_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  title TEXT NOT NULL,
  impact TEXT NOT NULL,
  next_step TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  observed_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  mail_id TEXT REFERENCES investment_mail(id)
);
--> statement-breakpoint
CREATE INDEX investment_signals_queue_idx ON investment_signals(priority, mail_id, expires_at);
--> statement-breakpoint
CREATE INDEX investment_signals_mail_idx ON investment_signals(mail_id);
--> statement-breakpoint
CREATE INDEX investment_mail_status_idx ON investment_mail(mode, status, retry_after);
