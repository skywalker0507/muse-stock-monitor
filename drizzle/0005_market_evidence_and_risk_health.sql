ALTER TABLE quotes ADD COLUMN observed_at_ms INTEGER;
--> statement-breakpoint
ALTER TABLE daily_bars ADD COLUMN verified_at_ms INTEGER;
--> statement-breakpoint
ALTER TABLE indicators ADD COLUMN quote_observed_at_ms INTEGER;
--> statement-breakpoint
ALTER TABLE investment_quote_state ADD COLUMN price REAL;
--> statement-breakpoint
ALTER TABLE investment_quote_state ADD COLUMN risk_started_at INTEGER;
--> statement-breakpoint
ALTER TABLE investment_signals ADD COLUMN risk_started_at INTEGER;
--> statement-breakpoint
CREATE INDEX investment_risk_episode_idx ON investment_signals(symbol, kind, risk_started_at, id);
--> statement-breakpoint
CREATE TABLE investment_heartbeats (
  job TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  last_success_at INTEGER,
  detail TEXT NOT NULL
);
