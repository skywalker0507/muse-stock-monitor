import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 监控标的（用户指定的核心/机会列表 + 自定义添加）
export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull().default(""),
  grp: text("grp", { enum: ["core", "opportunity", "custom"] })
    .notNull()
    .default("custom"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 最新行情快照（每标的一行，刷新时 upsert）
export const quotes = sqliteTable("quotes", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull().default(""),
  price: real("price"),
  change: real("change"),
  changePct: real("change_pct"),
  dayHigh: real("day_high"),
  dayLow: real("day_low"),
  week52High: real("week52_high"),
  week52Low: real("week52_low"),
  // 52 周高/低的来源日期（由近 252 个交易日日K计算时为极值所在交易日）
  week52HighDate: text("week52_high_date"),
  week52LowDate: text("week52_low_date"),
  marketCap: real("market_cap"),
  beta: real("beta"),
  marketStatus: text("market_status"),
  asOf: text("as_of"),
  sourceUrl: text("source_url"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 日线收盘历史（用于走势图、持仓期间最高价追踪；每标的保留约 400 个交易日）
export const dailyBars = sqliteTable("daily_bars", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD（美东交易日）
  close: real("close").notNull(),
  high: real("high"),
  low: real("low"),
});

// 计算指标（回撤 / 均线 / RSI），刷新时由日线确定性计算
export const indicators = sqliteTable("indicators", {
  symbol: text("symbol").primaryKey(),
  dd52: real("dd52"), // 距 52 周高回撤 %
  dd20: real("dd20"),
  dd60: real("dd60"),
  ma20: real("ma20"),
  ma50: real("ma50"),
  ma200: real("ma200"),
  rsi14: real("rsi14"),
  tier: integer("tier").notNull().default(0), // 0 无 / 1 轻度5 / 2 关注10 / 3 重点15 / 4 深度20 / 5 重大30
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 市场风险指标（指数走 finance_ticker；VIX/10Y/DXY/恐惧贪婪走搜索提炼，不可得为 null）
export const marketIndicators = sqliteTable("market_indicators", {
  key: text("key").primaryKey(), // SPX / NAS100 / VIX / TNX10Y / DXY / FEAR_GREED
  label: text("label").notNull(),
  value: real("value"),
  changePct: real("change_pct"),
  asOf: text("as_of"),
  source: text("source").notNull().default(""),
  note: text("note"),
  // 最近一次成功取得数值的时间 / 最近一次尝试获取的时间（失败时 value 保持旧值或 null）
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
});

// 用户手动录入的持仓
export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  shares: real("shares").notNull(),
  cost: real("cost").notNull(),
  horizon: text("horizon", { enum: ["long", "trade"] })
    .notNull()
    .default("long"),
  note: text("note").notNull().default(""),
  peakPrice: real("peak_price"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 监控规则（单行）
export const rules = sqliteTable("rules", {
  id: integer("id").primaryKey(),
  movePct: real("move_pct").notNull().default(5),
  indexDropPct: real("index_drop_pct").notNull().default(2),
  vixLevels: text("vix_levels").notNull().default("20,25,30,40"),
  ddWatchPct: real("dd_watch_pct").notNull().default(10),
});

// 预警记录（dedup_key 唯一，同一事件同一交易日不重复）
export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dedupKey: text("dedup_key").notNull().unique(),
  symbol: text("symbol"),
  kind: text("kind").notNull(), // move / index_drop / vix / drawdown / position
  level: text("level", { enum: ["info", "warn", "critical"] })
    .notNull()
    .default("info"),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 重大新闻（搜索提炼，url_hash 去重）
export const news = sqliteTable("news", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  urlHash: text("url_hash").notNull().unique(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  source: text("source").notNull().default(""),
  publishedAt: text("published_at"),
  symbols: text("symbols").notNull().default(""),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 财报日历（搜索提炼 + 用户手动添加）
export const earnings = sqliteTable("earnings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  reportDate: text("report_date").notNull(), // YYYY-MM-DD
  timing: text("timing"), // 盘前 / 盘后 / 未确认
  epsEst: text("eps_est"),
  source: text("source"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 日报 / 周报
export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["daily", "weekly"] }).notNull(),
  period: text("period").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 刷新执行记录（自动化任务状态）
export const refreshRuns = sqliteTable("refresh_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(), // market / news / report / full
  status: text("status", { enum: ["ok", "partial", "error", "skipped"] }).notNull(),
  detail: text("detail").notNull().default(""),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
  durationMs: integer("duration_ms"),
});

// 预警状态机（每指标一行）：保存上次值与已触发等级，实现跨越触发 / 冷却 / 恢复
export const alertState = sqliteTable("alert_state", {
  key: text("key").primaryKey(), // vix / move:SYM / dd:SYM / idx:SPX / pos:{id}
  prevValue: real("prev_value"),
  firedLevel: integer("fired_level").notNull().default(0), // 已触发的最高等级（0=未触发/已恢复）
  lastFiredAt: integer("last_fired_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const investmentPlans = sqliteTable("investment_plans", {
  symbol: text("symbol").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  purpose: text("purpose", { enum: ["long", "trade", "watch"] }).notNull(),
  thesis: text("thesis").notNull(),
  entryLow: real("entry_low"),
  entryHigh: real("entry_high"),
  riskPrice: real("risk_price"),
  peakGivebackPct: real("peak_giveback_pct"),
  openingDropPct: real("opening_drop_pct"),
  includeExtended: integer("include_extended", { mode: "boolean" }).notNull(),
  nextEvent: text("next_event").notNull(),
  nextEventDate: text("next_event_date"),
  updatedAt: integer("updated_at").notNull(),
});

export const investmentQuoteState = sqliteTable("investment_quote_state", {
  symbol: text("symbol").primaryKey(),
  observedAt: integer("observed_at").notNull(),
  lotSignature: text("lot_signature").notNull(),
  peakPnl: real("peak_pnl"),
  entryActive: integer("entry_active", { mode: "boolean" }).notNull(),
  riskActive: integer("risk_active", { mode: "boolean" }).notNull(),
  givebackActive: integer("giveback_active", { mode: "boolean" }).notNull(),
});

export const investmentMail = sqliteTable("investment_mail", {
  id: text("id").primaryKey(),
  digestKey: text("digest_key").unique(),
  mode: text("mode", { enum: ["urgent", "digest"] }).notNull(),
  status: text("status", { enum: ["sending", "sent", "not_sent", "uncertain", "expired"] }).notNull(),
  claimToken: text("claim_token").notNull(),
  attempts: integer("attempts").notNull(),
  capturedAt: integer("captured_at").notNull(),
  leaseUntil: integer("lease_until").notNull(),
  retryAfter: integer("retry_after"),
  providerRef: text("provider_ref"),
  error: text("error"),
  sentAt: integer("sent_at"),
  confirmedAt: integer("confirmed_at"),
});

export const investmentSignals = sqliteTable("investment_signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventKey: text("event_key").notNull().unique(),
  symbol: text("symbol").notNull(),
  kind: text("kind", { enum: ["price_zone", "risk_price", "opening_drop", "profit_giveback", "halt", "sec_filing", "test"] }).notNull(),
  priority: text("priority", { enum: ["urgent", "digest"] }).notNull(),
  tradeDate: text("trade_date").notNull(),
  title: text("title").notNull(),
  impact: text("impact").notNull(),
  nextStep: text("next_step").notNull(),
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  observedAt: integer("observed_at").notNull(),
  detectedAt: integer("detected_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  mailId: text("mail_id").references(() => investmentMail.id),
});
