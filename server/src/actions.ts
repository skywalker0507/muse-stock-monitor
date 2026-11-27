// 美股投资监控中心 — 服务端 actions。
// 行情：ctx.tool.finance_ticker（个股/ETF 结构化报价 + 日线历史，唯一价格来源）
// 52 周高/低与回撤/均线/RSI：由本标的自身近 252 个交易日日K（OHLC）在服务端
//   确定性计算，不采用行情源的 week_52 字段（实测 GOOG 会串入 GOOGL 数值），
//   也不使用模型估算。指数（标普500/纳指100）与 VIX/10Y：
//   finance_ticker 只能解析到 OANDA 差价合约（数值与真实指数不符），改走
//   定向网页搜索 + 提炼，并强制标注来源与 asOf；取不到一律 null 显示不可用。
// 预警：状态机（alert_state）——只有实际跨越阈值才触发，同日同指标只保留
//   最高等级一条，带冷却期与跌回恢复，重复刷新不产生重复预警。
// AI（ctx.inference）只用于新闻/财报/指标提炼与日报/周报撰写；报告 AI 失败时
//   降级为确定性事实汇总并写明失败原因，绝不静默为空。

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import * as schema from "./schema";

type Db = ReturnType<Ctx["db"]>;

// ---------- 基础常量与工具 ----------

const DEFAULT_WATCHLIST: { symbol: string; grp: "core" | "opportunity" }[] = [
  { symbol: "GOOG", grp: "core" },
  { symbol: "MSFT", grp: "core" },
  { symbol: "QQQ", grp: "core" },
  { symbol: "QQQM", grp: "core" },
  { symbol: "SPY", grp: "core" },
  { symbol: "VOO", grp: "core" },
  { symbol: "NVDA", grp: "opportunity" },
  { symbol: "AMD", grp: "opportunity" },
  { symbol: "AVGO", grp: "opportunity" },
  { symbol: "AMZN", grp: "opportunity" },
  { symbol: "META", grp: "opportunity" },
  { symbol: "AAPL", grp: "opportunity" },
  { symbol: "MU", grp: "opportunity" },
];

const MARKET_LABELS = {
  SPX: "标普500指数",
  NAS100: "纳斯达克100指数",
  VIX: "VIX 恐慌指数",
  TNX10Y: "美国10年期国债收益率",
};
const MARKET_KEYS = Object.keys(MARKET_LABELS) as (keyof typeof MARKET_LABELS)[];

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function daysAgoISO(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------- NYSE 交易日历（确定性，代码内置） ----------
// 休市日与提前收盘日为 NYSE 官方公布日历（2026 / 2027）；夏令时按美国法定
// 规则计算（3 月第二个周日开始、11 月第一个周日结束），并与 Intl 实际
// 美东偏移交叉校验。交易时段：美东 09:30–16:00，提前收盘日 09:30–13:00。

const NYSE_HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "元旦",
  "2026-01-19": "马丁·路德·金纪念日",
  "2026-02-16": "总统日",
  "2026-04-03": "耶稣受难日",
  "2026-05-25": "阵亡将士纪念日",
  "2026-06-19": "六月节",
  "2026-07-03": "独立日（顺延休市）",
  "2026-09-07": "劳动节",
  "2026-11-26": "感恩节",
  "2026-12-25": "圣诞节",
  // 2027
  "2027-01-01": "元旦",
  "2027-01-18": "马丁·路德·金纪念日",
  "2027-02-15": "总统日",
  "2027-03-26": "耶稣受难日",
  "2027-05-31": "阵亡将士纪念日",
  "2027-06-18": "六月节（顺延休市）",
  "2027-07-05": "独立日（顺延休市）",
  "2027-09-06": "劳动节",
  "2027-11-25": "感恩节",
  "2027-12-24": "圣诞节（顺延休市）",
};

// 提前收盘（13:00 ET）
const NYSE_EARLY_CLOSE: Record<string, string> = {
  "2026-11-27": "感恩节次日",
  "2026-12-24": "圣诞前夕",
  "2027-11-26": "感恩节次日",
};

function nthSunday(year: number, month: number, n: number): number {
  // month: 1-12；返回该月第 n 个周日的日期（日）
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

function dstRangeET(year: number): { start: string; end: string } {
  const s = nthSunday(year, 3, 2);
  const e = nthSunday(year, 11, 1);
  return {
    start: `${year}-03-${String(s).padStart(2, "0")}`,
    end: `${year}-11-${String(e).padStart(2, "0")}`,
  };
}

function etOffsetMinutes(d: Date): number {
  // 美东相对 UTC 的偏移分钟数（夏令时 -240，冬令时 -300），由 Intl 实测
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUTC - d.getTime()) / 60000);
}

function isTradingDay(dateStr: string): boolean {
  if (NYSE_HOLIDAYS[dateStr]) return false;
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function prevTradingDay(dateStr: string): string {
  let d = shiftDate(dateStr, -1);
  while (!isTradingDay(d)) d = shiftDate(d, -1);
  return d;
}

function nextTradingDay(dateStr: string): string {
  let d = shiftDate(dateStr, 1);
  while (!isTradingDay(d)) d = shiftDate(d, 1);
  return d;
}

function etClock(d: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { date: etDate(d), minutes: h * 60 + m };
}

type MarketStatus = {
  phase: "premarket" | "open" | "afterhours" | "closed";
  phaseLabel: string;
  isTradingDay: boolean;
  todayET: string;
  holidayName: string | null;
  earlyClose: boolean;
  earlyCloseNote: string | null;
  closeTimeET: string;
  isDST: boolean;
  dstLabel: string;
  beijingSession: string;
  lastTradingDay: string;
  lastClosedTradingDay: string;
  nextTradingDay: string;
};

function marketStatusNow(now = new Date()): MarketStatus {
  const { date: today, minutes } = etClock(now);
  const holidayName = NYSE_HOLIDAYS[today] ?? null;
  const earlyNote = NYSE_EARLY_CLOSE[today] ?? null;
  const trading = isTradingDay(today);
  const closeMin = earlyNote ? 13 * 60 : 16 * 60;
  let phase: MarketStatus["phase"] = "closed";
  let phaseLabel = "休市";
  if (trading) {
    if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
      phase = "premarket";
      phaseLabel = "盘前";
    } else if (minutes >= 9 * 60 + 30 && minutes < closeMin) {
      phase = "open";
      phaseLabel = "盘中";
    } else if (minutes >= closeMin && minutes < 20 * 60) {
      phase = "afterhours";
      phaseLabel = "盘后";
    }
  }
  if (holidayName) phaseLabel = `休市（${holidayName}）`;
  else if (!trading && phase === "closed") phaseLabel = "休市（周末）";
  const isDST = etOffsetMinutes(now) === -240;
  const lastTd = phase === "open" || phase === "afterhours" || (trading && minutes >= 9 * 60 + 30)
    ? today
    : prevTradingDay(today);
  return {
    phase,
    phaseLabel,
    isTradingDay: trading,
    todayET: today,
    holidayName,
    earlyClose: !!earlyNote,
    earlyCloseNote: earlyNote,
    closeTimeET: earlyNote ? "13:00" : "16:00",
    isDST,
    dstLabel: isDST ? "夏令时（美东 UTC-4）" : "冬令时（美东 UTC-5）",
    beijingSession: isDST
      ? "北京时间 21:30 – 次日 04:00"
      : "北京时间 22:30 – 次日 05:00",
    lastTradingDay: lastTd,
    lastClosedTradingDay: trading && minutes >= closeMin ? today : prevTradingDay(today),
    nextTradingDay: trading && minutes < 9 * 60 + 30 ? today : nextTradingDay(today),
  };
}

// ---------- finance_ticker 封装 ----------

type TickerPoint = {
  date: string | null;
  close: number | null;
  high: number | null;
  low: number | null;
};
type TickerInstrument = {
  name: string;
  symbol: string | null;
  price: number | null;
  change: number | null;
  change_percent: number | null;
  high: number | null;
  low: number | null;
  week_52_high: number | null;
  week_52_low: number | null;
  market_cap: number | null;
  beta: number | null;
  market_status: string | null;
  as_of: string | null;
  url: string | null;
  history?: { points: TickerPoint[] } | null;
};
type TickerContent = {
  resolved: { symbol: string; matched: string };
  instrument: TickerInstrument | null;
  sources: { title: string; url: string }[];
};

async function fetchTicker(
  ctx: Ctx,
  symbol: string,
  opts?: { interval: "1d"; since: string },
): Promise<TickerContent> {
  const fn = ctx.tool.finance_ticker as unknown as (
    s: string,
    o?: unknown,
  ) => Promise<{ content: TickerContent }>;
  const res = await fn(symbol, opts);
  return res.content;
}

type SearchResult = {
  title: string;
  url: string | null;
  source: string | null;
  snippet: string | null;
  published_at: string | null;
};

async function webSearch(ctx: Ctx, query: string): Promise<SearchResult[]> {
  const fn = ctx.tool.web_search as unknown as (
    q: string,
  ) => Promise<{ content: { results: SearchResult[] } }>;
  const res = await fn(query);
  return res.content.results ?? [];
}

// ---------- 初始化（用户给定的标的清单与默认规则，仅在为空时写入一次） ----------

async function ensureSeeded(db: Db) {
  const [existingRules] = await db.select({ id: schema.rules.id }).from(schema.rules).limit(1);
  if (!existingRules) {
    const [existingSymbol] = await db.select({ id: schema.watchlist.id }).from(schema.watchlist).limit(1);
    if (!existingSymbol) {
      await db.insert(schema.watchlist).values(
        DEFAULT_WATCHLIST.map((w) => ({ symbol: w.symbol, grp: w.grp, name: "" })),
      ).onConflictDoNothing();
    }
    await db.insert(schema.rules).values({ id: 1 }).onConflictDoNothing();
  }
  const [existingMarket] = await db.select({ key: schema.marketIndicators.key }).from(schema.marketIndicators).limit(1);
  if (!existingMarket) {
    await db.insert(schema.marketIndicators).values(
      MARKET_KEYS.map((key) => ({ key, label: MARKET_LABELS[key], source: "" })),
    ).onConflictDoNothing();
  }
}

async function logRun(db: Db, kind: string, status: (typeof schema.refreshRuns.$inferSelect)["status"], detail: string, started: Date) {
  const finished = new Date();
  await db.insert(schema.refreshRuns).values({
    kind,
    status,
    detail: detail.slice(0, 500),
    startedAt: started,
    finishedAt: finished,
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
  });
}

// ---------- 指标计算（确定性） ----------

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i] ?? 0;
  return s / n;
}

function rsi14(closes: number[]): number | null {
  const period = 14;
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function windowHigh(highs: number[], closes: number[], n: number): number | null {
  const len = closes.length;
  if (len === 0) return null;
  let m = -Infinity;
  for (let i = Math.max(0, len - n); i < len; i++) {
    const v = highs[i] ?? closes[i] ?? 0;
    if (v > m) m = v;
  }
  return m === -Infinity ? null : m;
}

function ddTier(dd52: number | null): number {
  if (dd52 == null) return 0;
  if (dd52 >= 30) return 5;
  if (dd52 >= 20) return 4;
  if (dd52 >= 15) return 3;
  if (dd52 >= 10) return 2;
  if (dd52 >= 5) return 1;
  return 0;
}

const TIER_LABELS = ["—", "轻度回调 ≥5%", "开始关注 ≥10%", "重点研究 ≥15%", "深度回调 ≥20%", "重大回撤 ≥30%"];

// ---------- 预警状态机 ----------
// 每个指标一个状态行：prevValue（上次观测值）、firedLevel（已触发最高等级）、
// lastFiredAt（冷却计时）。只有等级实际上升（跨越）才可能触发；冷却期内不
// 重复；指标跌回全部阈值以下（等级回到 0）视为恢复，之后再跨越可重新触发。
// 同一指标同一交易日只保留最高等级一条：插入前删除当日较低等级的同类预警。

const COOLDOWN_MS = {
  fast: 6 * 3600 * 1000, // VIX / 个股异动 / 指数下跌：6 小时
  slow: 24 * 3600 * 1000, // 回撤等级 / 持仓回撤：24 小时
};

async function evalCrossing(
  db: Db,
  key: string,
  value: number | null,
  level: number,
  cooldownMs: number,
  priorLevel?: (value: number) => number,
): Promise<{ crossed: boolean; prevValue: number | null }> {
  const rows = await db.select().from(schema.alertState).where(eq(schema.alertState.key, key)).limit(1);
  const st = rows[0];
  const now = new Date();
  if (!st) {
    // 首次观测只建立基线，不触发（避免存量状态在升级后集中误报）
    await db.insert(schema.alertState).values({
      key,
      prevValue: value,
      firedLevel: level,
      lastFiredAt: null,
      updatedAt: now,
    });
    return { crossed: false, prevValue: null };
  }
  let crossed = false;
  let lastFiredAt = st.lastFiredAt;
  const lastLevel = priorLevel && st.prevValue != null ? priorLevel(st.prevValue) : st.firedLevel;
  if (level > lastLevel) {
    const cooled = !st.lastFiredAt || now.getTime() - st.lastFiredAt.getTime() >= cooldownMs;
    if (cooled) {
      crossed = true;
      lastFiredAt = now;
    }
  }
  await db
    .update(schema.alertState)
    .set({ prevValue: value, firedLevel: level, lastFiredAt, updatedAt: now })
    .where(eq(schema.alertState.key, key));
  return { crossed, prevValue: st.prevValue };
}

// 同日同指标只保留最高等级：先删当日较低等级的同类预警，再插入（dedup 兜底）
async function insertAlertMaxLevel(
  db: Db,
  opts: {
    dedupKey: string;
    symbol: string | null;
    kind: string;
    level: "info" | "warn" | "critical";
    title: string;
    detail: string;
    match: (dedupKey: string) => boolean; // 是否属于「同指标同日」这一组
    rank: number; // 本条等级序号（越大越高）
    rankOf: (dedupKey: string) => number;
  },
): Promise<boolean> {
  const sameDay = await db
    .select({ id: schema.alerts.id, dedupKey: schema.alerts.dedupKey })
    .from(schema.alerts)
    .where(eq(schema.alerts.kind, opts.kind));
  const related = sameDay.filter((a) => opts.match(a.dedupKey));
  if (related.some((a) => opts.rankOf(a.dedupKey) >= opts.rank)) return false;
  const stale = related.map((a) => a.id);
  if (stale.length > 0) {
    await db.delete(schema.alerts).where(inArray(schema.alerts.id, stale));
  }
  const res = await db
    .insert(schema.alerts)
    .values({
      dedupKey: opts.dedupKey,
      symbol: opts.symbol,
      kind: opts.kind,
      level: opts.level,
      title: opts.title,
      detail: opts.detail,
    })
    .onConflictDoNothing()
    .returning({ id: schema.alerts.id });
  return res.length > 0;
}

// ---------- 单标的刷新 ----------

async function refreshSymbol(
  ctx: Ctx,
  db: Db,
  symbol: string,
): Promise<{ ok: boolean; price: number | null; changePct: number | null; dd52: number | null; tier: number; error?: string }> {
  // 报价拉取带一次重试：单标的瞬时失败（如 v1 的 MSFT）不应让整只标的为空
  let inst: TickerInstrument | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 2 && !inst; attempt++) {
    try {
      const quote = await fetchTicker(ctx, symbol);
      if (quote.instrument && quote.instrument.price != null) {
        inst = quote.instrument;
      } else {
        lastErr = quote.instrument ? "行情源返回价格为空" : "行情源未匹配到该代码";
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message.slice(0, 100) : "行情请求失败";
    }
  }
  if (!inst || inst.price == null) {
    return { ok: false, price: null, changePct: null, dd52: null, tier: 0, error: lastErr || "行情不可用" };
  }
  const hist = await fetchTicker(ctx, symbol, { interval: "1d", since: daysAgoISO(400) });
  const points = (hist.instrument?.history?.points ?? []).filter(
    (p) => p.date && p.close != null,
  ) as { date: string; close: number; high: number | null; low: number | null }[];

  if (points.length > 0) {
    for (const p of points) {
      await db
        .insert(schema.dailyBars)
        .values({ symbol, date: p.date, close: p.close, high: p.high, low: p.low })
        .onConflictDoUpdate({
          target: [schema.dailyBars.symbol, schema.dailyBars.date],
          set: { close: p.close, high: p.high, low: p.low },
        });
    }
    // 只保留最近 400 个交易日
    const cutoff = points[Math.max(0, points.length - 400)]?.date;
    if (cutoff) {
      const all = await db
        .select({ id: schema.dailyBars.id, date: schema.dailyBars.date })
        .from(schema.dailyBars)
        .where(eq(schema.dailyBars.symbol, symbol));
      const staleIds = all.filter((b) => b.date < cutoff).map((b) => b.id);
      if (staleIds.length > 0) {
        await db.delete(schema.dailyBars).where(inArray(schema.dailyBars.id, staleIds));
      }
    }
  }

  // 指标一律以数据库中的日线为准（与刚写入的口径一致，含历史积累）
  const bars = await db
    .select()
    .from(schema.dailyBars)
    .where(eq(schema.dailyBars.symbol, symbol))
    .orderBy(asc(schema.dailyBars.date));
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high ?? b.close);
  const price = inst.price;

  // 52 周高/低：近 252 个交易日日K极值（高用 high、低用 low），并入当日
  // 行情的高/低（日K通常滞后一个交易日）。记录极值所在日期以便核查。
  const win = bars.slice(-252);
  let h52: number | null = null;
  let h52Date: string | null = null;
  let l52: number | null = null;
  let l52Date: string | null = null;
  for (const b of win) {
    const hv = b.high ?? b.close;
    if (h52 == null || hv > h52) {
      h52 = hv;
      h52Date = b.date;
    }
    const lv = b.low ?? b.close;
    if (l52 == null || lv < l52) {
      l52 = lv;
      l52Date = b.date;
    }
  }
  // 当日高/低所属的交易日：报价快照时间落在休市日或盘前时，归属最近交易日
  let quoteDate = etDate();
  if (inst.as_of) {
    const asOfDate = new Date(inst.as_of);
    if (!Number.isNaN(asOfDate.getTime())) {
      const st = marketStatusNow(asOfDate);
      quoteDate = st.lastTradingDay;
    }
  }
  if (num(inst.high) != null && (h52 == null || (inst.high as number) > h52)) {
    h52 = inst.high;
    h52Date = quoteDate;
  }
  if (num(inst.low) != null && (l52 == null || (inst.low as number) < l52)) {
    l52 = inst.low;
    l52Date = quoteDate;
  }

  await db
    .insert(schema.quotes)
    .values({
      symbol,
      name: inst.name ?? symbol,
      price: num(inst.price),
      change: num(inst.change),
      changePct: num(inst.change_percent),
      dayHigh: num(inst.high),
      dayLow: num(inst.low),
      week52High: h52,
      week52Low: l52,
      week52HighDate: h52Date,
      week52LowDate: l52Date,
      marketCap: num(inst.market_cap),
      beta: num(inst.beta),
      marketStatus: inst.market_status,
      asOf: inst.as_of,
      sourceUrl: inst.url,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.quotes.symbol,
      set: {
        name: inst.name ?? symbol,
        price: num(inst.price),
        change: num(inst.change),
        changePct: num(inst.change_percent),
        dayHigh: num(inst.high),
        dayLow: num(inst.low),
        week52High: h52,
        week52Low: l52,
        week52HighDate: h52Date,
        week52LowDate: l52Date,
        marketCap: num(inst.market_cap),
        beta: num(inst.beta),
        marketStatus: inst.market_status,
        asOf: inst.as_of,
        sourceUrl: inst.url,
        updatedAt: new Date(),
      },
    });

  if (inst.name) {
    await db.update(schema.watchlist).set({ name: inst.name }).where(eq(schema.watchlist.symbol, symbol));
  }

  const dd = (h: number | null) => (h && h > 0 ? Math.max(0, ((h - price) / h) * 100) : null);
  const dd52v = dd(h52);
  const tier = ddTier(dd52v);
  const indValues = {
    dd52: dd52v,
    dd20: dd(windowHigh(highs, closes, 20)),
    dd60: dd(windowHigh(highs, closes, 60)),
    ma20: sma(closes, 20),
    ma50: sma(closes, 50),
    ma200: sma(closes, 200),
    rsi14: rsi14(closes),
    tier,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.indicators)
    .values({ symbol, ...indValues })
    .onConflictDoUpdate({ target: schema.indicators.symbol, set: indValues });

  return { ok: true, price, changePct: num(inst.change_percent), dd52: dd52v, tier };
}

// ---------- 行情刷新（含规则评估与预警去重） ----------

async function refreshMarketInternal(ctx: Ctx, force: boolean) {
  const db = ctx.db<typeof schema>();
  await ensureSeeded(db);
  const started = new Date();

  if (!force) {
    const last = await db
      .select()
      .from(schema.refreshRuns)
      .where(eq(schema.refreshRuns.kind, "market"))
      .orderBy(desc(schema.refreshRuns.id))
      .limit(1);
    const lastRun = last[0];
    if (lastRun && lastRun.status === "ok" && Date.now() - lastRun.finishedAt.getTime() < 10 * 60 * 1000) {
      return { updated: 0, failed: [] as string[], skipped: true, newAlerts: 0 };
    }
  }

  const watch = await db.select().from(schema.watchlist).orderBy(asc(schema.watchlist.id));
  const positions = await db.select().from(schema.positions);
  const watchedSymbols = new Set(watch.map((row) => row.symbol));
  const symbols = [...new Set([...watchedSymbols, ...positions.map((row) => row.symbol)])];
  const rulesRows = await db.select().from(schema.rules).limit(1);
  const rules = rulesRows[0] ?? { movePct: 5, indexDropPct: 2, vixLevels: "20,25,30,40", ddWatchPct: 10 };
  const today = etDate();
  const failed: string[] = [];
  const failReasons: string[] = [];
  let updated = 0;
  let newAlerts = 0;

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const r = await refreshSymbol(ctx, db, symbol);
        if (!r.ok) {
          failed.push(symbol);
          if (r.error) failReasons.push(`${symbol}：${r.error}`);
        }
        return { symbol, ...r };
      } catch (e) {
        failed.push(symbol);
        failReasons.push(`${symbol}：${e instanceof Error ? e.message.slice(0, 80) : "未知错误"}`);
        return { symbol, ok: false, price: null, changePct: null, dd52: null, tier: 0 };
      }
    }),
  );
  updated = results.filter((r) => r.ok).length;

  const drawdownLevel = (value: number) => value >= rules.ddWatchPct ? Math.max(1, ddTier(value)) : 0;
  for (const r of results) {
    if (!r.ok || !watchedSymbols.has(r.symbol)) continue;
    // 个股异动：等级 1 = 达到阈值，2 = 达到阈值的 1.6 倍（严重）
    if (r.changePct != null) {
      const mag = Math.abs(r.changePct);
      const lvl = mag >= rules.movePct * 1.6 ? 2 : mag >= rules.movePct ? 1 : 0;
      const ev = await evalCrossing(db, `move:${r.symbol}`, r.changePct, lvl, COOLDOWN_MS.fast);
      if (ev.crossed && lvl > 0) {
        const inserted = await insertAlertMaxLevel(db, {
          dedupKey: `move:${r.symbol}:${today}:${lvl}`,
          symbol: r.symbol,
          kind: "move",
          level: lvl >= 2 ? "critical" : "warn",
          title: `${r.symbol} 当日${r.changePct >= 0 ? "上涨" : "下跌"} ${mag.toFixed(2)}%`,
          detail: `由 ${ev.prevValue != null ? `${ev.prevValue >= 0 ? "+" : ""}${ev.prevValue.toFixed(2)}%` : "—"} 跨越监控阈值 ±${rules.movePct}%（状态机确认实际跨越；6 小时冷却期内不重复）。`,
          match: (k) => k.startsWith(`move:${r.symbol}:${today}:`),
          rank: lvl,
          rankOf: (k) => Number(k.split(":").pop() ?? 0) || 0,
        });
        if (inserted) newAlerts++;
      }
    }
    // 回撤先检查用户阈值，再判断后续分级升级，冷却 24 小时
    if (r.dd52 != null) {
      const rank = drawdownLevel(r.dd52);
      const ev = await evalCrossing(db, `dd:${r.symbol}`, r.dd52, rank, COOLDOWN_MS.slow, drawdownLevel);
      if (ev.crossed && rank > 0) {
        const inserted = await insertAlertMaxLevel(db, {
          dedupKey: `dd:${r.symbol}:${today}:${rank}`,
          symbol: r.symbol,
          kind: "drawdown",
          level: r.tier >= 4 ? "critical" : r.tier >= 3 ? "warn" : "info",
          title: `${r.symbol} 距52周高点回撤 ${r.dd52.toFixed(1)}%`,
          detail: `达到回撤关注阈值 ${rules.ddWatchPct}%${r.tier > 0 ? ` · ${TIER_LABELS[r.tier]}` : ""}（此前 ${ev.prevValue != null ? `${ev.prevValue.toFixed(1)}%` : "—"}）。回撤不等于买入机会，需区分下跌原因后再研究。`,
          match: (k) => k.startsWith(`dd:${r.symbol}:${today}:`),
          rank,
          rankOf: (k) => Number(k.split(":").pop() ?? 0) || 0,
        });
        if (inserted) newAlerts++;
      }
    }
  }

  // 持仓：更新期间最高价 + 从高点回撤预警（跨越触发，24 小时冷却）
  const refreshedSymbols = new Set(results.filter((row) => row.ok).map((row) => row.symbol));
  const quoteRows = await db.select().from(schema.quotes);
  const quoteMap = new Map(quoteRows.map((q) => [q.symbol, q]));
  for (const p of positions) {
    if (!refreshedSymbols.has(p.symbol)) continue;
    const q = quoteMap.get(p.symbol);
    if (!q || q.price == null) continue;
    const newPeak = Math.max(p.peakPrice ?? 0, q.price, q.dayHigh ?? 0);
    if (newPeak !== (p.peakPrice ?? 0)) {
      await db.update(schema.positions).set({ peakPrice: newPeak }).where(eq(schema.positions.id, p.id));
    }
    if (newPeak > 0) {
      const ddPeak = ((newPeak - q.price) / newPeak) * 100;
      const threshold = p.horizon === "long" ? 25 : 15;
      const lvl = ddPeak >= threshold ? 1 : 0;
      const ev = await evalCrossing(db, `pos:${p.id}`, ddPeak, lvl, COOLDOWN_MS.slow);
      if (ev.crossed) {
        const res = await db
          .insert(schema.alerts)
          .values({
            dedupKey: `pos:${p.id}:${today}:${threshold}`,
            symbol: p.symbol,
            kind: "position",
            level: "warn",
            title: `${p.symbol} 持仓自期间最高价回撤 ${ddPeak.toFixed(1)}%`,
            detail: `${p.horizon === "long" ? "长期核心持仓" : "短中期持仓"}阈值 ${threshold}%，由 ${ev.prevValue != null ? `${ev.prevValue.toFixed(1)}%` : "—"} 跨越触发，建议重新评估投资逻辑而非机械卖出。`,
          })
          .onConflictDoNothing()
          .returning({ id: schema.alerts.id });
        if (res.length > 0) newAlerts++;
      }
    }
  }

  const status = failed.length === 0 ? "ok" : updated === 0 ? "error" : "partial";
  await logRun(
    db,
    "market",
    status,
    `更新 ${updated}/${symbols.length} 个标的${failed.length ? `；失败：${failReasons.join("；") || failed.join(",")}` : ""}；新增预警 ${newAlerts} 条`,
    started,
  );
  ctx.invalidateQueries();
  return { updated, failed, skipped: false, newAlerts };
}

// 指数下跌预警评估（指数值由资讯刷新从公开来源提炼后调用）
async function evalIndexAlerts(db: Db, indexChange: Record<string, number | null>, today: string): Promise<number> {
  const rulesRows = await db.select().from(schema.rules).limit(1);
  const rules = rulesRows[0] ?? { movePct: 5, indexDropPct: 2, vixLevels: "20,25,30,40", ddWatchPct: 10 };
  let n = 0;
  for (const key of ["SPX", "NAS100"] as const) {
    const chg = indexChange[key];
    if (chg == null) continue;
    const lvl = chg <= -rules.indexDropPct * 1.5 ? 2 : chg <= -rules.indexDropPct ? 1 : 0;
    const ev = await evalCrossing(db, `idx:${key}`, chg, lvl, COOLDOWN_MS.fast);
    if (ev.crossed && lvl > 0) {
      const label = key === "SPX" ? "标普500指数" : "纳斯达克100指数";
      const inserted = await insertAlertMaxLevel(db, {
        dedupKey: `index:${key}:${today}:${lvl}`,
        symbol: null,
        kind: "index_drop",
        level: lvl >= 2 ? "critical" : "warn",
        title: `${label} 当日下跌 ${Math.abs(chg).toFixed(2)}%`,
        detail: `由 ${ev.prevValue != null ? `${ev.prevValue >= 0 ? "+" : ""}${ev.prevValue.toFixed(2)}%` : "—"} 跨越监控阈值 -${rules.indexDropPct}%（指数收盘口径，来源见市场指标标注）。`,
        match: (k) => k.startsWith(`index:${key}:${today}:`),
        rank: lvl,
        rankOf: (k) => Number(k.split(":").pop() ?? 0) || 0,
      });
      if (inserted) n++;
    }
  }
  return n;
}

// ---------- 新闻 / 财报 / 风险指标（搜索提炼） ----------

const newsDistillSchema = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      source: z.string(),
      published_at: z.string().nullable(),
      symbols: z.array(z.string()),
    }),
  ),
});

const earningsDistillSchema = z.object({
  items: z.array(
    z.object({
      symbol: z.string(),
      report_date: z.string(),
      timing: z.string().nullable(),
      eps_est: z.string().nullable(),
      source: z.string().nullable(),
    }),
  ),
});

const indicatorDistillSchema = z.object({
  spx: z.object({ value: z.number().nullable(), change_pct: z.number().nullable(), as_of: z.string().nullable() }),
  nas100: z.object({ value: z.number().nullable(), change_pct: z.number().nullable(), as_of: z.string().nullable() }),
  vix: z.object({ value: z.number().nullable(), as_of: z.string().nullable() }),
  tnx10y: z.object({ value: z.number().nullable(), as_of: z.string().nullable() }),
});

async function refreshNewsInternal(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  await ensureSeeded(db);
  const started = new Date();
  const watch = await db.select().from(schema.watchlist);
  const symbols = watch.map((w) => w.symbol);
  const errors: string[] = [];
  let newsAdded = 0;
  let earningsAdded = 0;

  const trim = (rs: SearchResult[], n: number) =>
    rs
      .filter((r) => r.url)
      .slice(0, n)
      .map((r) => ({
        title: r.title.slice(0, 160),
        url: r.url,
        source: r.source,
        snippet: (r.snippet ?? "").slice(0, 220),
        published_at: r.published_at,
      }));

  // 先并行完成全部搜索（快），再并行提炼，避免串行耗尽 action 时限。
  // 财报改为逐标的定向搜索（实测组合查询命不中具体日期，逐个搜 Zacks/
  // TipRanks 等日历页可得明确日期），每条结果带 symbol_hint 供提炼对齐。
  const [newsSearch, spxSearch, nasdaqSearch, vixSearch, yieldSearch, earnSearches] = await Promise.all([
    webSearch(ctx, `US stock market news today ${symbols.slice(0, 7).join(" ")}`),
    webSearch(ctx, "S&P 500 index closing value latest trading session SPX"),
    webSearch(ctx, "Nasdaq 100 index closing value latest trading session NDX"),
    webSearch(ctx, "VIX index today closing level"),
    webSearch(ctx, "10 year treasury yield today close percent"),
    Promise.all(
      symbols.map(async (s) => {
        try {
          const rs = await webSearch(ctx, `${s} next earnings report date earnings calendar`);
          return { symbol: s, results: rs };
        } catch {
          return { symbol: s, results: [] as SearchResult[] };
        }
      }),
    ),
  ]);
  const newsPool = trim(newsSearch, 10);
  const earnPool = earnSearches.flatMap(({ symbol, results }) =>
    results
      .filter((r) => r.url)
      .slice(0, 3)
      .map((r) => ({
        symbol_hint: symbol,
        title: r.title.slice(0, 160),
        url: r.url,
        source: r.source,
        snippet: (r.snippet ?? "").slice(0, 260),
        published_at: r.published_at,
      })),
  );
  const indPool = [spxSearch, nasdaqSearch, vixSearch, yieldSearch].flatMap((results) => trim(results, 4));

  const earnPrompt = (pool: typeof earnPool) =>
    `下面是逐个公司定向搜索的网页结果（symbol_hint 是该组结果对应的公司代码）。请提取每家公司下一次财报发布日期：只提取结果中有明确日期依据的条目；symbol 用 symbol_hint 的代码（除非结果明确说的是另一家公司）；report_date 用 YYYY-MM-DD（原文如 02/24/2027 需换算）；timing 填「盘前」「盘后」或 null（未确认/estimated 也填 null 并在 source 后不加说明）；eps_est 填一致预期 EPS 的原文字符串（如 "$2.88"），没有则 null；source 填来源网站名。同一公司多条结果日期一致时只输出一条；相互矛盾时取标注 confirmed 的那条，都未确认则省略。找不到依据的公司不要编造，直接省略。\n\n${JSON.stringify(pool)}`;

  const [newsOut, earnOut, indOut] = await Promise.allSettled([
    newsPool.length > 0
      ? ctx.inference.complete(
          `下面是网页搜索结果。从中挑选与这些美股标的相关的重大新闻：${symbols.join("、")}，以及影响美股大盘的宏观/美联储新闻。只保留真正重要的（财报、指引、并购、监管、重大产品、宏观数据、美联储），剔除行情报价页、广告和无关内容，最多 10 条。url 必须逐字复制搜索结果中的链接，不得改写或编造；symbols 只填新闻明确涉及的标的代码（大盘新闻可为空数组）；published_at 有明确日期才填 YYYY-MM-DD，否则为 null。\n\n${JSON.stringify(newsPool)}`,
          { schema: newsDistillSchema },
        )
      : Promise.resolve(null),
    earnPool.length > 0
      ? ctx.inference.complete(earnPrompt(earnPool), { schema: earningsDistillSchema })
      : Promise.resolve(null),
    indPool.length > 0
      ? ctx.inference.complete(
          `下面是网页搜索结果。请提取以下指标的最新数值（只能用搜索结果中有明确数字依据的，找不到就填 null，绝不估算、绝不用差价合约/CFD 报价冒充指数）：1) 标普500指数（S&P 500）最新收盘点位与当日涨跌幅 %；2) 纳斯达克100指数最新收盘点位与当日涨跌幅 %；3) VIX 恐慌指数最新点位；4) 美国10年期国债收益率（百分数，如 4.25 表示 4.25%）。as_of 填该数值对应的日期（YYYY-MM-DD），不确定则 null。\n\n${JSON.stringify(indPool)}`,
          { schema: indicatorDistillSchema },
        )
      : Promise.resolve(null),
  ]);

  // 新闻落库
  if (newsOut.status === "fulfilled" && newsOut.value) {
    const urlSet = new Set(newsPool.map((r) => r.url));
    for (const item of newsOut.value.items) {
      if (!urlSet.has(item.url)) continue;
      const res = await db
        .insert(schema.news)
        .values({
          urlHash: hashStr(item.url),
          title: item.title.slice(0, 300),
          url: item.url,
          source: item.source ?? "",
          publishedAt: item.published_at,
          symbols: item.symbols.filter((s) => symbols.includes(s.toUpperCase())).join(","),
        })
        .onConflictDoNothing()
        .returning({ id: schema.news.id });
      newsAdded += res.length;
    }
    const allNews = await db.select({ id: schema.news.id }).from(schema.news).orderBy(desc(schema.news.id));
    if (allNews.length > 200) {
      const stale = allNews.slice(200).map((n) => n.id);
      await db.delete(schema.news).where(inArray(schema.news.id, stale));
    }
  } else if (newsOut.status === "rejected") {
    errors.push(`新闻：${newsOut.reason instanceof Error ? newsOut.reason.message.slice(0, 120) : "未知错误"}`);
  }

  // 财报落库
  if (earnOut.status === "fulfilled" && earnOut.value) {
    const today = etDate();
    for (const item of earnOut.value.items) {
      const sym = item.symbol.toUpperCase();
      if (!symbols.includes(sym)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.report_date) || item.report_date < today) continue;
      const existing = await db.select().from(schema.earnings).where(eq(schema.earnings.symbol, sym));
      if (existing.some((e) => e.reportDate === item.report_date)) continue;
      await db.insert(schema.earnings).values({
        symbol: sym,
        reportDate: item.report_date,
        timing: item.timing,
        epsEst: item.eps_est,
        source: item.source,
        note: "来自公开财报日历搜索，可能调整",
      });
      earningsAdded++;
    }
  } else if (earnOut.status === "rejected") {
    errors.push(`财报：${earnOut.reason instanceof Error ? earnOut.reason.message.slice(0, 120) : "未知错误"}`);
  }

  // 市场指标落库：每次尝试都记录 lastAttemptAt；取得数值才更新 value 并
  // 记录 fetchedAt。取不到时保留旧值（或 null=不可用），绝不编造。
  const attemptedAt = new Date();
  const miSource = "公开来源提炼（指数收盘口径，可能延迟）";
  if (indOut.status === "fulfilled" && indOut.value) {
    const distilled = indOut.value;
    const put = async (
      key: string,
      value: number | null,
      asOf: string | null,
      changePct?: number | null,
      note?: string | null,
    ) => {
      if (value == null) {
        await db
          .update(schema.marketIndicators)
          .set({ lastAttemptAt: attemptedAt })
          .where(eq(schema.marketIndicators.key, key));
        return;
      }
      await db
        .update(schema.marketIndicators)
        .set({
          value,
          changePct: changePct ?? null,
          asOf,
          source: miSource,
          note: note ?? null,
          fetchedAt: attemptedAt,
          lastAttemptAt: attemptedAt,
        })
        .where(eq(schema.marketIndicators.key, key));
    };
    await put("SPX", distilled.spx.value, distilled.spx.as_of, distilled.spx.change_pct);
    await put("NAS100", distilled.nas100.value, distilled.nas100.as_of, distilled.nas100.change_pct);
    await put("VIX", distilled.vix.value, distilled.vix.as_of);
    await put("TNX10Y", distilled.tnx10y.value, distilled.tnx10y.as_of, null, "单位：%");

    // 指数下跌预警（状态机跨越触发）
    const today = etDate();
    await evalIndexAlerts(
      db,
      { SPX: distilled.spx.change_pct, NAS100: distilled.nas100.change_pct },
      today,
    );

    // VIX 预警（状态机）：等级 = 已跨越的最高阈值序号；只在实际向上跨越
    // 时触发，同日只保留最高等级一条；跌回最低阈值以下自动恢复。
    const rulesRows = await db.select().from(schema.rules).limit(1);
    const levels = (rulesRows[0]?.vixLevels ?? "20,25,30,40")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const vix = distilled.vix.value;
    if (vix != null && levels.length > 0) {
      let lvl = 0;
      levels.forEach((th, i) => {
        if (vix >= th) lvl = i + 1;
      });
      const ev = await evalCrossing(db, "vix", vix, lvl, COOLDOWN_MS.fast);
      if (ev.crossed && lvl > 0) {
        const highest = levels[lvl - 1] ?? 0;
        await insertAlertMaxLevel(db, {
          dedupKey: `vix:${highest}:${today}`,
          symbol: null,
          kind: "vix",
          level: highest >= 30 ? "critical" : "warn",
          title: `VIX 升至 ${vix.toFixed(1)}，突破 ${highest} 阈值`,
          detail: `由 ${ev.prevValue != null ? ev.prevValue.toFixed(1) : "—"} 向上跨越 ${highest} 阈值触发（同日只保留最高等级一条；6 小时冷却；跌回 ${levels[0]} 以下恢复）。恐慌指数处于高位，注意市场波动与流动性风险。`,
          match: (k) => k.startsWith("vix:") && k.endsWith(`:${today}`),
          rank: highest,
          rankOf: (k) => Number(k.split(":")[1] ?? 0) || 0,
        });
      }
    }
  } else {
    // 提炼失败：六项指标全部记一次尝试时间，状态页可见失败痕迹
    for (const key of MARKET_KEYS) {
      await db
        .update(schema.marketIndicators)
        .set({ lastAttemptAt: attemptedAt })
        .where(eq(schema.marketIndicators.key, key));
    }
    if (indOut.status === "rejected") {
      errors.push(`市场指标：${indOut.reason instanceof Error ? indOut.reason.message.slice(0, 120) : "未知错误"}`);
    }
  }

  await logRun(
    db,
    "news",
    errors.length >= 3 ? "error" : errors.length > 0 ? "partial" : "ok",
    `新增新闻 ${newsAdded} 条、财报 ${earningsAdded} 条${errors.length ? `；部分失败：${errors.join("；")}` : ""}`,
    started,
  );
  ctx.invalidateQueries();
  return { newsAdded, earningsAdded, errors };
}

// ---------- 报告生成 ----------

async function generateReportInternal(ctx: Ctx, kind: "daily" | "weekly") {
  const db = ctx.db<typeof schema>();
  await ensureSeeded(db);
  const started = new Date();
  const today = marketStatusNow(started).lastClosedTradingDay;

  const watch = await db.select().from(schema.watchlist);
  const quoteRows = await db.select().from(schema.quotes);
  const indRows = await db.select().from(schema.indicators);
  const miRows = await db.select().from(schema.marketIndicators).where(inArray(schema.marketIndicators.key, MARKET_KEYS));
  const posRows = await db.select().from(schema.positions);
  const newsRows = await db.select().from(schema.news).orderBy(desc(schema.news.id)).limit(12);
  const alertRows = await db.select().from(schema.alerts).orderBy(desc(schema.alerts.id)).limit(12);
  const earnRows = await db
    .select()
    .from(schema.earnings)
    .where(gte(schema.earnings.reportDate, today))
    .orderBy(asc(schema.earnings.reportDate))
    .limit(15);

  const qMap = new Map(quoteRows.map((q) => [q.symbol, q]));
  const iMap = new Map(indRows.map((i) => [i.symbol, i]));
  const stockLines = watch.map((w) => {
    const q = qMap.get(w.symbol);
    const ind = iMap.get(w.symbol);
    return {
      代码: w.symbol,
      分组: w.grp === "core" ? "核心" : w.grp === "opportunity" ? "机会" : "自定义",
      价格USD: q?.price ?? null,
      当日涨跌pct: q?.changePct ?? null,
      距52周高回撤pct: ind?.dd52 ?? null,
      RSI14: ind?.rsi14 ?? null,
      MA20: ind?.ma20 ?? null,
      MA50: ind?.ma50 ?? null,
      MA200: ind?.ma200 ?? null,
    };
  });
  const posLines = posRows.map((p) => {
    const q = qMap.get(p.symbol);
    const mv = q?.price != null ? q.price * p.shares : null;
    const costTotal = p.cost * p.shares;
    return {
      代码: p.symbol,
      数量: p.shares,
      成本价: p.cost,
      现价: q?.price ?? null,
      浮盈亏USD: mv != null ? Math.round((mv - costTotal) * 100) / 100 : null,
      周期: p.horizon === "long" ? "长期核心" : "短中期",
    };
  });

  const dataBlock = JSON.stringify(
    {
      日期美东: today,
      市场指标: miRows.map((m) => ({ 指标: m.label, 数值: m.value, 涨跌pct: m.changePct, 数据时间: m.asOf, 备注: m.note })),
      标的: stockLines,
      持仓: posLines,
      近期预警: alertRows.map((a) => a.title),
      近期新闻标题: newsRows.map((n) => ({ 标题: n.title, 来源: n.source, 涉及: n.symbols })),
      未来财报: earnRows.map((e) => ({ 代码: e.symbol, 日期: e.reportDate, 时点: e.timing, 预期EPS: e.epsEst })),
    },
    null,
    1,
  );

  const structure =
    kind === "daily"
      ? "结构：## 市场总览（指数与风险指标）；## 标的表现（涨跌与主要驱动，区分事实与推测）；## 回撤与潜在机会（按回撤等级列出，逐一区分下跌类型：市场情绪/宏观/行业周期/基本面恶化/估值回归，证据不足时明确写「原因待确认」，并给出参考价格区间与分批建仓思路，不给确定性买卖结论）；## 持仓风险（浮盈亏、集中度、距期间高点回撤；长期核心持仓不因正常波动建议卖出）；## 明日关注（财报与事件）；## 风险提示。"
      : "结构：## 本周市场走势；## 风险指标变化；## 重点公司基本面与新闻回顾；## 最值得研究的投资机会排名（最多5个，附依据、主要风险、参考价格区间）；## 上周判断回顾（如无历史报告则写「暂无可回顾的上周报告」）；## 下周关注（宏观事件与财报）；## 下周关注价格区间汇总。";

  // AI 只在此处用于撰写分析；失败（超时等）时降级为确定性事实汇总，
  // 报告不落空，失败原因同时写进报告正文与运行记录。
  let content: string;
  let degradedReason = "";
  try {
    content = await ctx.inference.complete(
      `你是一名严谨的美股投资研究助手。基于下面这份真实监控数据，撰写一份简体中文${kind === "daily" ? "每日盘后" : "每周"}投资报告（Markdown 格式）。铁律：只能使用数据中给出的数字，数据为 null 的项写「不可用」，不得编造价格、财务数据或新闻；新闻只引用给出的标题；明确区分「客观事实」与「分析判断」；不给出确定性的买入/卖出结论，只给研究优先级、参考区间和分批思路，并附风险提示。${structure}\n\n数据：\n${dataBlock}`,
      { schema: z.string(), timeout_secs: 240 },
    );
  } catch (e) {
    degradedReason = e instanceof Error ? e.message.slice(0, 160) : "未知错误";
    const f2 = (v: number | null | undefined, d = 2) => (v == null ? "不可用" : v.toFixed(d));
    const lines: string[] = [
      `> 本报告为降级版事实汇总：AI 分析生成失败（${degradedReason}），以下内容全部由已存储的真实监控数据确定性生成，不含分析判断。`,
      "",
      "## 市场总览（客观事实）",
      ...miRows.map(
        (m) =>
          `- ${m.label}：${m.value == null ? "不可用" : m.key === "TNX10Y" ? `${m.value.toFixed(2)}%` : f2(m.value)}${m.changePct != null ? `（${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%）` : ""}，数据时间 ${m.asOf ?? "未知"}，来源 ${m.source || "未标注"}`,
      ),
      "",
      "## 标的表现（客观事实）",
      ...stockLines.map(
        (s) =>
          `- ${s.代码}（${s.分组}）：$${f2(s.价格USD)}，当日 ${s.当日涨跌pct == null ? "不可用" : `${s.当日涨跌pct >= 0 ? "+" : ""}${s.当日涨跌pct.toFixed(2)}%`}，距52周高回撤 ${s.距52周高回撤pct == null ? "不可用" : `${s.距52周高回撤pct.toFixed(1)}%`}，RSI(14) ${f2(s.RSI14, 1)}`,
      ),
      "",
      "## 持仓（客观事实）",
      ...(posLines.length > 0
        ? posLines.map(
            (p) =>
              `- ${p.代码}：${p.数量} 股，成本 $${f2(p.成本价)}，现价 $${f2(p.现价)}，浮盈亏 ${p.浮盈亏USD == null ? "不可用" : `$${p.浮盈亏USD.toFixed(2)}`}（${p.周期}）`,
          )
        : ["- 暂无持仓记录。"]),
      "",
      "## 近期预警（客观事实）",
      ...(alertRows.length > 0 ? alertRows.map((a) => `- ${a.title}`) : ["- 暂无预警记录。"]),
      "",
      "## 近期新闻标题（客观事实）",
      ...(newsRows.length > 0
        ? newsRows.map((n) => `- ${n.title}（${n.source || "未知来源"}）`)
        : ["- 暂无新闻记录。"]),
      "",
      "## 未来财报（客观事实）",
      ...(earnRows.length > 0
        ? earnRows.map((er) => `- ${er.symbol}：${er.reportDate}${er.timing ? ` ${er.timing}` : ""}${er.epsEst ? `，预期EPS ${er.epsEst}` : ""}`)
        : ["- 财报日历暂无记录（不可用）。"]),
      "",
      "## 说明",
      "本报告因 AI 生成失败而降级为事实汇总；下跌原因区分、机会评估等分析判断待 AI 恢复后在下一期报告中补充。以上均为客观事实罗列，不构成投资建议。",
    ];
    content = lines.join("\n");
  }

  const reportSymbols = [...new Set([...watch, ...posRows].map((row) => row.symbol))];
  const datedQuotes = reportSymbols.filter((symbol) => {
    const quote = qMap.get(symbol);
    const asOf = quote?.asOf;
    if (quote?.price == null || !asOf) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return asOf === today;
    const timestamp = new Date(asOf);
    return Number.isFinite(timestamp.getTime()) && etDate(timestamp) === today;
  }).length;
  content = `> 报价覆盖 ${datedQuotes}/${reportSymbols.length} · ${today} ET（按观测日期统计）\n\n${content}`;
  const period = kind === "daily" ? today : `${today} 当周`;
  const title = kind === "daily" ? `${today} 每日投资报告` : `${period} 每周投资报告`;
  const inserted = await db
    .insert(schema.reports)
    .values({ kind, period, title, content })
    .returning({ id: schema.reports.id });
  await logRun(
    db,
    "report",
    "ok",
    degradedReason
      ? `生成${kind === "daily" ? "日报" : "周报"}（降级事实汇总）：${title}；AI 失败原因：${degradedReason}`
      : `生成${kind === "daily" ? "日报" : "周报"}：${title}`,
    started,
  );
  ctx.invalidateQueries();
  return { id: inserted[0]?.id ?? 0, title };
}

// ---------- 定时刷新（盘后全量） ----------

async function scheduledRefreshInternal(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const started = new Date();
  const calendar = marketStatusNow(started);
  const hasClosed = calendar.isTradingDay && calendar.lastClosedTradingDay === calendar.todayET;
  const parts: string[] = [];
  let errors = 0;
  let marketUpdated = 0;
  let servicesSucceeded = 0;
  if (!calendar.isTradingDay) parts.push(`美东 ${calendar.todayET} 休市，跳过日报生成`);
  if (calendar.isTradingDay && !hasClosed) parts.push("常规交易尚未收盘，跳过报告生成");
  if (calendar.earlyClose) parts.push(`美东提前收盘（${calendar.closeTimeET} ET）`);
  try {
    const result = await refreshMarketInternal(ctx, true);
    marketUpdated = result.updated;
    if (result.updated > 0) servicesSucceeded++;
    if (result.failed.length > 0) errors++;
    parts.push(`行情更新 ${result.updated} 个标的，新增预警 ${result.newAlerts} 条${result.failed.length ? `，失败 ${result.failed.join("、")}` : ""}`);
  } catch (error) {
    errors++;
    parts.push(`行情失败：${error instanceof Error ? error.message.slice(0, 100) : "未知错误"}`);
  }
  try {
    const result = await refreshNewsInternal(ctx);
    if (result.errors.length < 3) servicesSucceeded++;
    if (result.errors.length > 0) errors++;
    parts.push(`新闻 +${result.newsAdded}，财报 +${result.earningsAdded}${result.errors.length ? `；${result.errors.join("；")}` : ""}`);
  } catch (error) {
    errors++;
    parts.push(`资讯失败：${error instanceof Error ? error.message.slice(0, 100) : "未知错误"}`);
  }
  if (hasClosed && marketUpdated > 0) {
    try {
      const daily = await generateReportInternal(ctx, "daily");
      parts.push(`日报已生成（#${daily.id}）`);
      const nextWeekday = new Date(`${nextTradingDay(calendar.todayET)}T12:00:00Z`).getUTCDay();
      const currentWeekday = new Date(`${calendar.todayET}T12:00:00Z`).getUTCDay();
      if (nextWeekday <= currentWeekday) {
        const weekly = await generateReportInternal(ctx, "weekly");
        parts.push(`周报已生成（#${weekly.id}）`);
      }
    } catch (error) {
      errors++;
      parts.push(`报告失败：${error instanceof Error ? error.message.slice(0, 100) : "未知错误"}`);
    }
  } else if (hasClosed) {
    parts.push("无更新的标的行情，跳过报告生成");
  }
  const status = errors ? (servicesSucceeded ? "partial" : "error") : hasClosed && marketUpdated > 0 ? "ok" : "skipped";
  const detail = parts.join("；");
  await logRun(db, "full", status, detail, started);
  ctx.invalidateQueries();
  return { detail };
}

// ---------- 响应结构 ----------

const nullableNum = z.number().nullable();

const stockRowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  grp: z.string(),
  price: nullableNum,
  change: nullableNum,
  changePct: nullableNum,
  dayHigh: nullableNum,
  dayLow: nullableNum,
  week52High: nullableNum,
  week52Low: nullableNum,
  week52HighDate: z.string().nullable(),
  week52LowDate: z.string().nullable(),
  marketCap: nullableNum,
  beta: nullableNum,
  marketStatus: z.string().nullable(),
  asOf: z.string().nullable(),
  dd52: nullableNum,
  dd20: nullableNum,
  dd60: nullableNum,
  ma20: nullableNum,
  ma50: nullableNum,
  ma200: nullableNum,
  rsi14: nullableNum,
  tier: z.number(),
  spark: z.array(z.number()),
});

const dashboardResponse = z.object({
  stocks: z.array(stockRowSchema),
  market: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: nullableNum,
      changePct: nullableNum,
      asOf: z.string().nullable(),
      source: z.string(),
      note: z.string().nullable(),
      fetchedAt: z.string().nullable(),
      lastAttemptAt: z.string().nullable(),
    }),
  ),
  calendar: z.object({
    phase: z.string(),
    phaseLabel: z.string(),
    isTradingDay: z.boolean(),
    todayET: z.string(),
    holidayName: z.string().nullable(),
    earlyClose: z.boolean(),
    earlyCloseNote: z.string().nullable(),
    closeTimeET: z.string(),
    isDST: z.boolean(),
    dstLabel: z.string(),
    beijingSession: z.string(),
    lastTradingDay: z.string(),
    lastClosedTradingDay: z.string(),
    nextTradingDay: z.string(),
    dst2026: z.string(),
    dst2027: z.string(),
  }),
  positions: z.array(
    z.object({
      id: z.number(),
      symbol: z.string(),
      shares: z.number(),
      cost: z.number(),
      horizon: z.string(),
      note: z.string(),
      peakPrice: nullableNum,
      price: nullableNum,
      marketValue: nullableNum,
      pnl: nullableNum,
      pnlPct: nullableNum,
      weightPct: nullableNum,
      ddFromPeak: nullableNum,
      quoteAsOf: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  rules: z.object({
    movePct: z.number(),
    indexDropPct: z.number(),
    vixLevels: z.string(),
    ddWatchPct: z.number(),
  }),
  alerts: z.array(
    z.object({
      id: z.number(),
      symbol: z.string().nullable(),
      kind: z.string(),
      level: z.string(),
      title: z.string(),
      detail: z.string(),
      tradeDate: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  news: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      url: z.string(),
      source: z.string(),
      publishedAt: z.string().nullable(),
      symbols: z.string(),
      fetchedAt: z.string(),
    }),
  ),
  earnings: z.array(
    z.object({
      id: z.number(),
      symbol: z.string(),
      reportDate: z.string(),
      timing: z.string().nullable(),
      epsEst: z.string().nullable(),
      source: z.string().nullable(),
      note: z.string(),
    }),
  ),
  reports: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      period: z.string(),
      title: z.string(),
      createdAt: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      status: z.string(),
      detail: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
      durationMs: z.number().nullable(),
    }),
  ),
  lastMarketUpdate: z.string().nullable(),
});

const systemStatusResponse = z.object({
  tasks: z.array(
    z.object({
      name: z.string(),
      owner: z.string(),
      schedule: z.string(),
      source: z.string(),
      lastSuccessAt: z.string().nullable(),
      lastRunAt: z.string().nullable(),
      nextRunAt: z.string().nullable(),
      lastDurationMs: z.number().nullable(),
      lastStatus: z.string().nullable(),
      lastDetail: z.string().nullable(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      status: z.string(),
      detail: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
      durationMs: z.number().nullable(),
    }),
  ),
  dataStatus: z.array(
    z.object({
      name: z.string(),
      source: z.string(),
      quoteAsOf: z.string().nullable(),
      fetchedAt: z.string().nullable(),
      lastAttemptAt: z.string().nullable(),
      state: z.string(),
    }),
  ),
  counts: z.object({
    watchlist: z.number(),
    bars: z.number(),
    alerts: z.number(),
    reports: z.number(),
    news: z.number(),
    earnings: z.number(),
  }),
  upcomingCalendar: z.array(
    z.object({ date: z.string(), label: z.string(), type: z.string() }),
  ),
});

type DashboardOut = z.infer<typeof dashboardResponse>;

// ---------- Actions ----------

export const Actions = {
  getDashboard: defineAction({
    description: "读取监控中心全部数据：行情、指标、市场风险、持仓、预警、新闻、财报、报告与刷新记录。",
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<DashboardOut> {
      const db = ctx.db<typeof schema>();
      await ensureSeeded(db);
      const watch = await db.select().from(schema.watchlist).orderBy(asc(schema.watchlist.id));
      const quoteRows = await db.select().from(schema.quotes);
      const indRows = await db.select().from(schema.indicators);
      const qMap = new Map(quoteRows.map((q) => [q.symbol, q]));
      const iMap = new Map(indRows.map((i) => [i.symbol, i]));

      const bars = watch.length === 0 ? [] : await db
        .select({ symbol: schema.dailyBars.symbol, close: schema.dailyBars.close })
        .from(schema.dailyBars)
        .where(inArray(schema.dailyBars.symbol, watch.map((row) => row.symbol)))
        .orderBy(asc(schema.dailyBars.date));
      const sparkMap = new Map<string, number[]>();
      for (const b of bars) {
        const arr = sparkMap.get(b.symbol) ?? [];
        arr.push(b.close);
        sparkMap.set(b.symbol, arr);
      }

      const stocks = watch.map((w) => {
        const q = qMap.get(w.symbol);
        const ind = iMap.get(w.symbol);
        const sparkAll = sparkMap.get(w.symbol) ?? [];
        return {
          symbol: w.symbol,
          name: q?.name || w.name || w.symbol,
          grp: w.grp,
          price: q?.price ?? null,
          change: q?.change ?? null,
          changePct: q?.changePct ?? null,
          dayHigh: q?.dayHigh ?? null,
          dayLow: q?.dayLow ?? null,
          week52High: q?.week52High ?? null,
          week52Low: q?.week52Low ?? null,
          week52HighDate: q?.week52HighDate ?? null,
          week52LowDate: q?.week52LowDate ?? null,
          marketCap: q?.marketCap ?? null,
          beta: q?.beta ?? null,
          marketStatus: q?.marketStatus ?? null,
          asOf: q?.asOf ?? null,
          dd52: ind?.dd52 ?? null,
          dd20: ind?.dd20 ?? null,
          dd60: ind?.dd60 ?? null,
          ma20: ind?.ma20 ?? null,
          ma50: ind?.ma50 ?? null,
          ma200: ind?.ma200 ?? null,
          rsi14: ind?.rsi14 ?? null,
          tier: ind?.tier ?? 0,
          spark: sparkAll.slice(-30),
        };
      });

      const miRows = await db.select().from(schema.marketIndicators);
      const miMap = new Map(miRows.map((m) => [m.key, m]));
      const market = MARKET_KEYS.map((key) => {
        const m = miMap.get(key);
        return {
          key,
          label: m?.label ?? key,
          value: m?.value ?? null,
          changePct: m?.changePct ?? null,
          asOf: m?.asOf ?? null,
          source: m?.source ?? "",
          note: m?.note ?? null,
          fetchedAt: m?.fetchedAt ? m.fetchedAt.toISOString() : null,
          lastAttemptAt: m?.lastAttemptAt ? m.lastAttemptAt.toISOString() : null,
        };
      });

      const cal = marketStatusNow();
      const d26 = dstRangeET(2026);
      const d27 = dstRangeET(2027);
      const calendar = {
        phase: cal.phase,
        phaseLabel: cal.phaseLabel,
        isTradingDay: cal.isTradingDay,
        todayET: cal.todayET,
        holidayName: cal.holidayName,
        earlyClose: cal.earlyClose,
        earlyCloseNote: cal.earlyCloseNote,
        closeTimeET: cal.closeTimeET,
        isDST: cal.isDST,
        dstLabel: cal.dstLabel,
        beijingSession: cal.beijingSession,
        lastTradingDay: cal.lastTradingDay,
        lastClosedTradingDay: cal.lastClosedTradingDay,
        nextTradingDay: cal.nextTradingDay,
        dst2026: `${d26.start} – ${d26.end}`,
        dst2027: `${d27.start} – ${d27.end}`,
      };

      const posRows = await db.select().from(schema.positions).orderBy(asc(schema.positions.id));
      let totalValue = 0;
      const posComputed = posRows.map((p) => {
        const q = qMap.get(p.symbol);
        const price = q?.price ?? null;
        const marketValue = price != null ? price * p.shares : null;
        if (marketValue != null) totalValue += marketValue;
        return { p, price, marketValue };
      });
      const positions = posComputed.map(({ p, price, marketValue }) => {
        const costTotal = p.cost * p.shares;
        const pnl = marketValue != null ? marketValue - costTotal : null;
        return {
          id: p.id,
          symbol: p.symbol,
          shares: p.shares,
          cost: p.cost,
          horizon: p.horizon,
          note: p.note,
          peakPrice: p.peakPrice ?? null,
          price,
          marketValue,
          pnl,
          pnlPct: pnl != null && costTotal > 0 ? (pnl / costTotal) * 100 : null,
          weightPct: marketValue != null && totalValue > 0 ? (marketValue / totalValue) * 100 : null,
          ddFromPeak:
            p.peakPrice != null && p.peakPrice > 0 && price != null
              ? ((p.peakPrice - price) / p.peakPrice) * 100
              : null,
          quoteAsOf: qMap.get(p.symbol)?.asOf ?? null,
          createdAt: p.createdAt.toISOString(),
        };
      });

      const rulesRows = await db.select().from(schema.rules).limit(1);
      const rulesRow = rulesRows[0];
      const alertRows = await db.select().from(schema.alerts).orderBy(desc(schema.alerts.id)).limit(50);
      const newsRows = await db.select().from(schema.news).orderBy(desc(schema.news.id)).limit(40);
      const earnRows = await db.select().from(schema.earnings).where(gte(schema.earnings.reportDate, cal.todayET)).orderBy(asc(schema.earnings.reportDate)).limit(80);
      const reportRows = await db.select().from(schema.reports).orderBy(desc(schema.reports.id)).limit(30);
      const runRows = await db.select().from(schema.refreshRuns).orderBy(desc(schema.refreshRuns.id)).limit(10);
      const activeSymbols = new Set([...watch, ...posRows].map((row) => row.symbol));
      const lastQuote = quoteRows.reduce<Date | null>((acc, q) => {
        if (!activeSymbols.has(q.symbol)) return acc;
        if (!acc || q.updatedAt > acc) return q.updatedAt;
        return acc;
      }, null);

      return {
        stocks,
        market,
        calendar,
        positions,
        rules: {
          movePct: rulesRow?.movePct ?? 5,
          indexDropPct: rulesRow?.indexDropPct ?? 2,
          vixLevels: rulesRow?.vixLevels ?? "20,25,30,40",
          ddWatchPct: rulesRow?.ddWatchPct ?? 10,
        },
        alerts: alertRows.map((a) => ({
          id: a.id,
          symbol: a.symbol,
          kind: a.kind,
          level: a.level,
          title: a.title,
          detail: a.detail,
          tradeDate: a.dedupKey.split(":").find((part) => /^\d{4}-\d{2}-\d{2}$/.test(part)) ?? null,
          createdAt: a.createdAt.toISOString(),
        })),
        news: newsRows.map((n) => ({
          id: n.id,
          title: n.title,
          url: n.url,
          source: n.source,
          publishedAt: n.publishedAt,
          symbols: n.symbols,
          fetchedAt: n.fetchedAt.toISOString(),
        })),
        earnings: earnRows.map((e) => ({
          id: e.id,
          symbol: e.symbol,
          reportDate: e.reportDate,
          timing: e.timing,
          epsEst: e.epsEst,
          source: e.source,
          note: e.note,
        })),
        reports: reportRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          period: r.period,
          title: r.title,
          createdAt: r.createdAt.toISOString(),
        })),
        runs: runRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          detail: r.detail,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt.toISOString(),
          durationMs: r.durationMs ?? null,
        })),
        lastMarketUpdate: lastQuote ? lastQuote.toISOString() : null,
      };
    },
  }),

  refreshMarket: defineAction({
    description: "刷新全部监控标的行情与技术指标，并按监控规则评估预警（10 分钟内重复调用会跳过）。",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      updated: z.number(),
      failed: z.array(z.string()),
      skipped: z.boolean(),
      newAlerts: z.number(),
    }),
    async handler(ctx, args) {
      return await refreshMarketInternal(ctx, args.force);
    },
  }),

  refreshNews: defineAction({
    description: "通过网页搜索刷新重大新闻、财报日历与市场风险指标。",
    request: z.object({}),
    response: z.object({
      newsAdded: z.number(),
      earningsAdded: z.number(),
      errors: z.array(z.string()),
    }),
    async handler(ctx) {
      return await refreshNewsInternal(ctx);
    },
  }),

  generateReport: defineAction({
    description: "基于已存储的真实行情、新闻与持仓数据生成一份简体中文日报或周报并存入历史。",
    request: z.object({ kind: z.enum(["daily", "weekly"]) }),
    response: z.object({ id: z.number(), title: z.string() }),
    async handler(ctx, args) {
      return await generateReportInternal(ctx, args.kind);
    },
  }),

  scheduledRefresh: defineAction({
    description: "盘后全量刷新：行情与指标、新闻与财报、生成日报（本周最后一个交易日另生成周报），供定时任务调用。",
    request: z.object({}),
    response: z.object({ detail: z.string() }),
    async handler(ctx) {
      return await scheduledRefreshInternal(ctx);
    },
  }),

  getSystemStatus: defineAction({
    description: "读取系统运行状态：后台任务清单（Space 定时刷新 + 主助手 4 个任务）的频率/上次成功/下次计划/耗时/失败原因、执行记录、数据来源与更新时间、未来交易日历。",
    request: z.object({}),
    response: systemStatusResponse,
    async handler(ctx): Promise<z.infer<typeof systemStatusResponse>> {
      const db = ctx.db<typeof schema>();
      await ensureSeeded(db);
      const runRows = await db
        .select()
        .from(schema.refreshRuns)
        .orderBy(desc(schema.refreshRuns.id))
        .limit(30);
      const byKind = (kinds: string[]) => runRows.filter((r) => kinds.includes(r.kind));
      const lastOk = (rows: typeof runRows) => rows.find((r) => r.status === "ok") ?? null;
      const bjTime = (hour: number, minute: number, from = new Date()): Date => {
        // 北京时间（UTC+8，无夏令时）下一次 hour:minute
        const bjNow = new Date(from.getTime() + 8 * 3600 * 1000);
        const cand = new Date(
          Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate(), hour - 8, minute),
        );
        if (cand.getTime() <= from.getTime()) cand.setUTCDate(cand.getUTCDate() + 1);
        return cand;
      };
      const taskOf = (
        name: string,
        owner: string,
        schedule: string,
        source: string,
        kinds: string[],
        nextRunAt: Date | null,
      ) => {
        const rows = byKind(kinds);
        const last = rows[0] ?? null;
        const ok = lastOk(rows);
        return {
          name,
          owner,
          schedule,
          source,
          lastSuccessAt: ok ? ok.finishedAt.toISOString() : null,
          lastRunAt: last ? last.finishedAt.toISOString() : null,
          nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
          lastDurationMs: last?.durationMs ?? null,
          lastStatus: last?.status ?? null,
          lastDetail: last?.detail ?? null,
        };
      };
      const tasks = [
        taskOf(
          "盘后全量刷新（行情+资讯+日报）",
          "本 Space 定时任务",
          "每日 05:30（北京时间）",
          "平台行情通道 + 公开来源提炼",
          ["full"],
          bjTime(5, 30),
        ),
        taskOf("行情刷新", "本 Space（页面/手动触发）", "手动或页面打开时补刷", "平台行情通道（结构化）", ["market"], null),
        taskOf("资讯刷新（新闻/财报/市场指标）", "本 Space（页面/手动触发）", "手动触发", "公开网页搜索提炼", ["news"], null),
        taskOf("报告生成", "本 Space", "盘后全量刷新内含；也可手动生成", "已存储数据 + AI 撰写（失败降级事实汇总）", ["report"], null),
        {
          name: "盘前分析",
          owner: "Muse 主助手后台任务",
          schedule: "每个美股交易日 22:00（北京时间，冬令时）",
          source: "主助手任务系统（执行记录不在本 Space 数据库内）",
          lastSuccessAt: null,
          lastRunAt: null,
          nextRunAt: null,
          lastDurationMs: null,
          lastStatus: null,
          lastDetail: "由主助手调度并推送到聊天；本页仅列计划时间，执行明细见主助手任务记录。",
        },
        {
          name: "盘后分析",
          owner: "Muse 主助手后台任务",
          schedule: "每个美股交易日 05:30（北京时间，冬令时）",
          source: "主助手任务系统（执行记录不在本 Space 数据库内）",
          lastSuccessAt: null,
          lastRunAt: null,
          nextRunAt: null,
          lastDurationMs: null,
          lastStatus: null,
          lastDetail: "由主助手调度并推送到聊天；本页仅列计划时间，执行明细见主助手任务记录。",
        },
        {
          name: "盘中监控检查",
          owner: "Muse 主助手后台任务",
          schedule: "盘中每 30 分钟",
          source: "主助手任务系统（执行记录不在本 Space 数据库内）",
          lastSuccessAt: null,
          lastRunAt: null,
          nextRunAt: null,
          lastDurationMs: null,
          lastStatus: null,
          lastDetail: "由主助手调度；无重要变化时不推送。本页仅列计划，执行明细见主助手任务记录。",
        },
        {
          name: "每周深度分析（周报）",
          owner: "Muse 主助手后台任务",
          schedule: "每周六 06:00（北京时间）",
          source: "主助手任务系统（执行记录不在本 Space 数据库内）",
          lastSuccessAt: null,
          lastRunAt: null,
          nextRunAt: null,
          lastDurationMs: null,
          lastStatus: null,
          lastDetail: "由主助手调度并推送到聊天；本页仅列计划时间，执行明细见主助手任务记录。",
        },
      ];

      const quoteRows = await db.select().from(schema.quotes);
      const lastQuoteFetch = quoteRows.reduce<Date | null>((acc, q) => (!acc || q.updatedAt > acc ? q.updatedAt : acc), null);
      const lastQuoteAsOf = quoteRows.reduce<string | null>((acc, q) => (q.asOf && (!acc || q.asOf > acc) ? q.asOf : acc), null);
      const miRows = await db.select().from(schema.marketIndicators);
      const dataStatus = [
        {
          name: "个股/ETF 行情与日线",
          source: "平台行情通道（结构化报价 + 日K）",
          quoteAsOf: lastQuoteAsOf,
          fetchedAt: lastQuoteFetch ? lastQuoteFetch.toISOString() : null,
          lastAttemptAt: lastQuoteFetch ? lastQuoteFetch.toISOString() : null,
          state: lastQuoteFetch ? "已获取" : "尚未刷新",
        },
        ...miRows.filter((m) => MARKET_KEYS.some((key) => key === m.key)).map((m) => ({
          name: m.label,
          source: m.source || "尚未刷新",
          quoteAsOf: m.asOf,
          fetchedAt: m.fetchedAt ? m.fetchedAt.toISOString() : null,
          lastAttemptAt: m.lastAttemptAt ? m.lastAttemptAt.toISOString() : null,
          state: m.value != null ? `当前值 ${m.key === "TNX10Y" ? `${m.value.toFixed(2)}%` : m.value}` : "不可用",
        })),
      ];

      const watch = await db.select({ id: schema.watchlist.id }).from(schema.watchlist);
      const bars = await db.select({ id: schema.dailyBars.id }).from(schema.dailyBars);
      const alertRows = await db.select({ id: schema.alerts.id }).from(schema.alerts);
      const reportRows = await db.select({ id: schema.reports.id }).from(schema.reports);
      const newsRows = await db.select({ id: schema.news.id }).from(schema.news);
      const earnRows = await db.select({ id: schema.earnings.id }).from(schema.earnings);

      const today = etDate();
      const upcomingCalendar: { date: string; label: string; type: string }[] = [];
      for (let i = 0; i <= 370 && upcomingCalendar.length < 14; i++) {
        const d = shiftDate(today, i);
        if (NYSE_HOLIDAYS[d]) upcomingCalendar.push({ date: d, label: NYSE_HOLIDAYS[d] as string, type: "休市" });
        else if (NYSE_EARLY_CLOSE[d]) upcomingCalendar.push({ date: d, label: NYSE_EARLY_CLOSE[d] as string, type: "提前收盘 13:00 ET" });
      }

      return {
        tasks,
        runs: runRows.slice(0, 20).map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          detail: r.detail,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt.toISOString(),
          durationMs: r.durationMs ?? null,
        })),
        dataStatus,
        counts: {
          watchlist: watch.length,
          bars: bars.length,
          alerts: alertRows.length,
          reports: reportRows.length,
          news: newsRows.length,
          earnings: earnRows.length,
        },
        upcomingCalendar,
      };
    },
  }),

  testNotification: defineAction({
    description: "写入一条明确标注为【测试通知】的预警记录，用于验证后台记录与推送链路；返回记录 id 与写入时间供核对。",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      alertId: z.number(),
      createdAt: z.string(),
      message: z.string(),
    }),
    async handler(ctx): Promise<{ ok: true; alertId: number; createdAt: string; message: string }> {
      const db = ctx.db<typeof schema>();
      await ensureSeeded(db);
      const now = new Date();
      const stamp = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(now);
      const inserted = await db
        .insert(schema.alerts)
        .values({
          dedupKey: `test:${now.getTime()}`,
          symbol: null,
          kind: "test",
          level: "info",
          title: "【测试通知】后台推送链路测试",
          detail: `这是一条由「发送测试通知」功能写入的测试记录（北京时间 ${stamp}）。它证明 Space 数据库写入与预警记录链路可用；聊天侧的主动推送由 Muse 主助手任务另行验证。`,
        })
        .returning({ id: schema.alerts.id });
      const row = inserted[0];
      if (!row) throw new Error("测试通知写入失败");
      ctx.invalidateQueries();
      return {
        ok: true,
        alertId: row.id,
        createdAt: now.toISOString(),
        message: `测试通知已写入预警记录 #${row.id}（北京时间 ${stamp}）`,
      };
    },
  }),

  getReport: defineAction({
    description: "按 id 读取一份已保存的日报或周报全文。",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      id: z.number(),
      kind: z.string(),
      title: z.string(),
      content: z.string(),
      createdAt: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.reports).where(eq(schema.reports.id, args.id)).limit(1);
      const r = rows[0];
      if (!r) throw new Error("报告不存在");
      return { id: r.id, kind: r.kind, title: r.title, content: r.content, createdAt: r.createdAt.toISOString() };
    },
  }),

  getSymbolDetail: defineAction({
    description: "读取单个标的的近一年日线收盘序列（用于走势图）及该标的的财报与新闻。",
    request: z.object({ symbol: z.string().min(1).max(12) }),
    response: z.object({
      symbol: z.string(),
      bars: z.array(z.object({ date: z.string(), close: z.number() })),
      earnings: z.array(
        z.object({ id: z.number(), reportDate: z.string(), timing: z.string().nullable(), epsEst: z.string().nullable() }),
      ),
      news: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), source: z.string() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const sym = args.symbol.toUpperCase();
      const bars = await db
        .select({ date: schema.dailyBars.date, close: schema.dailyBars.close })
        .from(schema.dailyBars)
        .where(eq(schema.dailyBars.symbol, sym))
        .orderBy(asc(schema.dailyBars.date));
      const earns = await db
        .select()
        .from(schema.earnings)
        .where(and(eq(schema.earnings.symbol, sym), gte(schema.earnings.reportDate, etDate())))
        .orderBy(asc(schema.earnings.reportDate));
      const allNews = await db.select().from(schema.news).orderBy(desc(schema.news.id)).limit(100);
      const relNews = allNews.filter((n) => n.symbols.split(",").includes(sym)).slice(0, 10);
      return {
        symbol: sym,
        bars,
        earnings: earns.map((e) => ({ id: e.id, reportDate: e.reportDate, timing: e.timing, epsEst: e.epsEst })),
        news: relNews.map((n) => ({ id: n.id, title: n.title, url: n.url, source: n.source })),
      };
    },
  }),

  addSymbol: defineAction({
    description: "把一个新的股票/ETF 代码加入监控列表（先向行情源验证代码真实存在）。",
    request: z.object({ symbol: z.string().trim().min(1).max(10) }),
    response: z.object({ symbol: z.string(), name: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureSeeded(db);
      const sym = args.symbol.toUpperCase();
      if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) throw new Error("代码格式不正确");
      const existing = await db.select().from(schema.watchlist).where(eq(schema.watchlist.symbol, sym)).limit(1);
      if (existing.length > 0) throw new Error(`${sym} 已在监控列表中`);
      const t = await fetchTicker(ctx, sym);
      if (!t.instrument || t.instrument.price == null) {
        throw new Error(`行情源未找到代码 ${sym}，请确认代码正确`);
      }
      await db.insert(schema.watchlist).values({ symbol: sym, name: t.instrument.name ?? sym, grp: "custom" });
      try {
        await refreshSymbol(ctx, db, sym);
      } catch {
        // 行情已验证存在，历史拉取失败不阻塞添加，后续刷新会补齐
      }
      ctx.invalidateQueries();
      return { symbol: sym, name: t.instrument.name ?? sym };
    },
  }),

  removeSymbol: defineAction({
    description: "取消关注标的，保留历史数据与持仓监控。",
    request: z.object({ symbol: z.string().min(1).max(12) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const sym = args.symbol.toUpperCase();
      await db.delete(schema.watchlist).where(eq(schema.watchlist.symbol, sym));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addPosition: defineAction({
    description: "录入一笔持仓：代码、数量、成本价、投资周期（长期核心/短中期）与备注。",
    request: z.object({
      symbol: z.string().trim().min(1).max(10),
      shares: z.number().positive().max(100000000),
      cost: z.number().nonnegative().max(1000000),
      horizon: z.enum(["long", "trade"]),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const sym = args.symbol.toUpperCase();
      const q = await db.select().from(schema.quotes).where(eq(schema.quotes.symbol, sym)).limit(1);
      const inserted = await db
        .insert(schema.positions)
        .values({
          symbol: sym,
          shares: args.shares,
          cost: args.cost,
          horizon: args.horizon,
          note: args.note,
          peakPrice: q[0]?.price ?? args.cost,
        })
        .returning({ id: schema.positions.id });
      ctx.invalidateQueries();
      const row = inserted[0];
      if (!row) throw new Error("录入失败");
      return { id: row.id };
    },
  }),

  updatePosition: defineAction({
    description: "修改一笔持仓的数量、成本价、投资周期或备注。",
    request: z.object({
      id: z.number().int().positive(),
      shares: z.number().positive().max(100000000),
      cost: z.number().nonnegative().max(1000000),
      horizon: z.enum(["long", "trade"]),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.positions)
        .set({ shares: args.shares, cost: args.cost, horizon: args.horizon, note: args.note })
        .where(eq(schema.positions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deletePosition: defineAction({
    description: "删除一笔持仓记录。",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.positions).where(eq(schema.positions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  updateRules: defineAction({
    description: "更新监控规则：个股异动阈值、指数下跌阈值、VIX 阈值序列、回撤关注阈值。",
    request: z.object({
      movePct: z.number().min(0.5).max(50),
      indexDropPct: z.number().min(0.2).max(20),
      vixLevels: z.string().trim().min(1).max(60),
      ddWatchPct: z.number().min(1).max(60),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await ensureSeeded(db);
      const levels = args.vixLevels
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n < 200);
      if (levels.length === 0) throw new Error("VIX 阈值至少填写一个有效数字");
      await db
        .update(schema.rules)
        .set({
          movePct: args.movePct,
          indexDropPct: args.indexDropPct,
          vixLevels: levels.sort((a, b) => a - b).join(","),
          ddWatchPct: args.ddWatchPct,
        })
        .where(eq(schema.rules.id, 1));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addEarnings: defineAction({
    description: "手动添加一条财报日历记录。",
    request: z.object({
      symbol: z.string().trim().min(1).max(10),
      reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timing: z.string().max(10).default(""),
      epsEst: z.string().max(30).default(""),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.earnings)
        .values({
          symbol: args.symbol.toUpperCase(),
          reportDate: args.reportDate,
          timing: args.timing || null,
          epsEst: args.epsEst || null,
          source: "手动录入",
          note: args.note,
        })
        .returning({ id: schema.earnings.id });
      ctx.invalidateQueries();
      const row = inserted[0];
      if (!row) throw new Error("添加失败");
      return { id: row.id };
    },
  }),

  deleteEarnings: defineAction({
    description: "删除一条财报日历记录。",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.earnings).where(eq(schema.earnings.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteAlert: defineAction({
    description: "删除一条历史预警记录。",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.alerts).where(eq(schema.alerts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
