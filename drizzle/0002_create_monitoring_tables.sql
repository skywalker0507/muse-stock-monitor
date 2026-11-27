DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  grp TEXT NOT NULL DEFAULT 'custom',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE quotes (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  price REAL,
  change REAL,
  change_pct REAL,
  day_high REAL,
  day_low REAL,
  week52_high REAL,
  week52_low REAL,
  market_cap REAL,
  beta REAL,
  market_status TEXT,
  as_of TEXT,
  source_url TEXT,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE daily_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  high REAL,
  UNIQUE(symbol, date)
);
--> statement-breakpoint
CREATE INDEX idx_daily_bars_symbol_date ON daily_bars(symbol, date);
--> statement-breakpoint
CREATE TABLE indicators (
  symbol TEXT PRIMARY KEY,
  dd52 REAL,
  dd20 REAL,
  dd60 REAL,
  ma20 REAL,
  ma50 REAL,
  ma200 REAL,
  rsi14 REAL,
  tier INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE market_indicators (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value REAL,
  change_pct REAL,
  as_of TEXT,
  source TEXT NOT NULL DEFAULT '',
  note TEXT
);
--> statement-breakpoint
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  shares REAL NOT NULL,
  cost REAL NOT NULL,
  horizon TEXT NOT NULL DEFAULT 'long',
  note TEXT NOT NULL DEFAULT '',
  peak_price REAL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE rules (
  id INTEGER PRIMARY KEY,
  move_pct REAL NOT NULL DEFAULT 5,
  index_drop_pct REAL NOT NULL DEFAULT 2,
  vix_levels TEXT NOT NULL DEFAULT '20,25,30,40',
  dd_watch_pct REAL NOT NULL DEFAULT 10
);
--> statement-breakpoint
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  symbol TEXT,
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  symbols TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  report_date TEXT NOT NULL,
  timing TEXT,
  eps_est TEXT,
  source TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);
