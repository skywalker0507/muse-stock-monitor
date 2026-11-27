ALTER TABLE daily_bars ADD COLUMN low REAL;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN week52_high_date TEXT;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN week52_low_date TEXT;
--> statement-breakpoint
ALTER TABLE market_indicators ADD COLUMN fetched_at INTEGER;
--> statement-breakpoint
ALTER TABLE market_indicators ADD COLUMN last_attempt_at INTEGER;
--> statement-breakpoint
ALTER TABLE refresh_runs ADD COLUMN duration_ms INTEGER;
--> statement-breakpoint
CREATE TABLE alert_state (
  key TEXT PRIMARY KEY,
  prev_value REAL,
  fired_level INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
DELETE FROM alerts WHERE kind = 'vix' AND EXISTS (
  SELECT 1 FROM alerts b
  WHERE b.kind = 'vix'
    AND substr(b.dedup_key, -10) = substr(alerts.dedup_key, -10)
    AND CAST(substr(b.dedup_key, 5, length(b.dedup_key) - 15) AS INTEGER)
        > CAST(substr(alerts.dedup_key, 5, length(alerts.dedup_key) - 15) AS INTEGER)
);
