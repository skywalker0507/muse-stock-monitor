import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import * as schema from "./schema";
import { compatiblePreviousClose, secureSourceUrl, validatedQuote } from "./market-evidence";
import { heartbeatStatus, monitorHealth, monitorHealthView, saveHeartbeat } from "./investment-health";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
type Db = ReturnType<Ctx["db"]>;
type Signal = typeof schema.investmentSignals.$inferInsert;
type Mail = typeof schema.investmentMail.$inferSelect;
type Lot = typeof schema.positions.$inferSelect;
type Plan = typeof schema.investmentPlans.$inferSelect;

type Session = {
  date: string;
  phase: string;
  previousTradingDay: string;
  lastClosedTradingDay: string;
  minutesET: number;
};

export interface InvestmentFeed {
  sessionAt(date: Date): Session;
  quote(ctx: Ctx, symbol: string): Promise<unknown>;
}

function ownerDb(ctx: Ctx) {
  if (!ctx.viewer || !("isOwner" in ctx.viewer) || ctx.viewer.isOwner !== true) {
    throw new Error("投资计划和邮件操作仅限 Space 所有者及其授权任务。");
  }
  return ctx.db<typeof schema>();
}

const symbolInput = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9.-]{0,9}$/);
const priceInput = z.number().positive().max(1e7).nullable();
const calendarDate = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const planFields = z.object({
  symbol: symbolInput,
  enabled: z.boolean(),
  purpose: z.enum(["long", "trade", "watch"]),
  thesis: z.string().trim().max(400),
  entryLow: priceInput,
  entryHigh: priceInput,
  riskPrice: priceInput,
  peakGivebackPct: z.number().min(1).max(100).nullable(),
  openingDropPct: z.number().min(1).max(35).nullable(),
  includeExtended: z.boolean(),
  nextEvent: z.string().trim().max(140),
  nextEventDate: calendarDate.nullable(),
});
const planInput = planFields.superRefine((plan, check) => {
  if ((plan.entryLow == null) !== (plan.entryHigh == null) ||
      (plan.entryLow != null && plan.entryHigh != null && plan.entryLow > plan.entryHigh)) {
    check.addIssue({ code: "custom", path: ["entryHigh"], message: "观察区上下限必须同时填写，且下限不能高于上限。" });
  }
  if (plan.nextEventDate && !plan.nextEvent) {
    check.addIssue({ code: "custom", path: ["nextEvent"], message: "请填写关键事件名称。" });
  }
});
const signalView = z.object({
  id: z.number(),
  symbol: z.string(),
  kind: z.string(),
  priority: z.enum(["urgent", "digest"]),
  title: z.string(),
  impact: z.string(),
  nextStep: z.string(),
  source: z.string(),
  sourceUrl: z.string().nullable(),
  observedAt: z.number(),
  detectedAt: z.number(),
  expiresAt: z.number(),
});
const mailView = z.object({
  id: z.uuid(),
  mode: z.enum(["urgent", "digest"]),
  status: z.enum(["sending", "sent", "not_sent", "uncertain", "expired"]),
  capturedAt: z.number(),
  sentAt: z.number().nullable(),
  confirmedAt: z.number().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  test: z.boolean(),
});

async function getTargets(db: Db) {
  const [plans, positions, watch] = await Promise.all([
    db.select().from(schema.investmentPlans).orderBy(asc(schema.investmentPlans.symbol)),
    db.select().from(schema.positions).orderBy(asc(schema.positions.id)),
    db.select({ symbol: schema.watchlist.symbol }).from(schema.watchlist).orderBy(asc(schema.watchlist.id)),
  ]);
  const plansBySymbol = new Map(plans.map((plan) => [plan.symbol, plan]));
  const lotsBySymbol = new Map<string, Lot[]>();
  for (const position of positions) {
    const lots = lotsBySymbol.get(position.symbol) ?? [];
    lots.push(position);
    lotsBySymbol.set(position.symbol, lots);
  }
  const symbols = [...new Set([...lotsBySymbol.keys(), ...plansBySymbol.keys(), ...watch.map((item) => item.symbol)])];
  return { plans, plansBySymbol, lotsBySymbol, symbols };
}

function activeTargets(targets: Awaited<ReturnType<typeof getTargets>>) {
  return targets.symbols.filter((symbol) => targets.lotsBySymbol.has(symbol) || targets.plansBySymbol.get(symbol)?.enabled);
}

function planReview(plan: Plan | undefined, held: boolean) {
  if (plan?.purpose === "long" || (held && !plan)) return "核对持仓和最新公告，复核原有持有理由是否变化。";
  if (plan?.purpose === "trade") return "在券商核对最新报价与可交易状态，再按你的退出纪律复核。";
  return "核对最新报价和相关公告，再决定是否继续观察。";
}

function positionImpact(held: boolean) {
  return held ? "涉及你已录入的持仓。" : "涉及你启用的投资计划。";
}

async function scanSymbol(ctx: Ctx, db: Db, feed: InvestmentFeed, symbol: string, plan: Plan | undefined, lots: Lot[]) {
  const response = await feed.quote(ctx, symbol);
  const instrument = validatedQuote(response, symbol, Date.now());
  if (!instrument) return "unavailable" as const;
  const { observedAt } = instrument;
  const now = Date.now();
  const observed = feed.sessionAt(new Date(observedAt));
  const current = feed.sessionAt(new Date(now));
  if (observedAt > now + minute || observedAt < now - 15 * minute || observed.date !== current.date ||
      !["open", "premarket", "afterhours"].includes(current.phase)) return "stale" as const;
  const regular = observed.phase === "open" && current.phase === "open";
  const extended = observed.phase === current.phase && ["premarket", "afterhours"].includes(observed.phase);
  if (!regular && !(plan?.includeExtended && extended)) return "session" as const;

  const [previous] = await db.select().from(schema.investmentQuoteState).where(eq(schema.investmentQuoteState.symbol, symbol)).limit(1);
  if (previous && observedAt < previous.observedAt) return "stale" as const;
  const held = lots.length > 0;
  const price = instrument.price;
  const lotSignature = JSON.stringify(lots.map(({ id, shares, cost }) => [id, shares, cost]));
  const pnl = lots.reduce((total, lot) => total + (price - lot.cost) * lot.shares, 0);
  const sameLots = lotSignature === previous?.lotSignature;
  const priorPeak = sameLots ? previous.peakPnl : null;
  // Extended-hours quotes can trigger opt-in price rules. Portfolio peaks are recorded in the regular session.
  const peakPnl = held ? (regular ? Math.max(priorPeak ?? pnl, pnl) : priorPeak) : null;
  const giveback = peakPnl != null && peakPnl > 0 ? (peakPnl - pnl) / peakPnl * 100 : null;
  const entryActive = plan?.entryLow != null && plan.entryHigh != null && price >= plan.entryLow && price <= plan.entryHigh;
  const riskActive = plan?.riskPrice != null && price <= plan.riskPrice;
  const givebackActive = regular ? plan?.peakGivebackPct != null && giveback != null && giveback >= plan.peakGivebackPct :
    sameLots && previous.givebackActive;
  const marketPhase = regular ? "常规交易" : observed.phase === "premarket" ? "盘前" : "盘后";
  const quoteText = `${marketPhase}报价 $${price.toFixed(2)}`;
  const base = {
    symbol,
    tradeDate: observed.date,
    impact: positionImpact(held),
    source: "Muse 行情通道",
    sourceUrl: secureSourceUrl(instrument.url)?.href ?? null,
    observedAt,
    detectedAt: now,
  };
  const pending: Signal[] = [];
  const makeSignal = (kind: Signal["kind"], priority: Signal["priority"], title: string, nextStep: string) => {
    pending.push({
      ...base, kind, priority, title, nextStep,
      eventKey: `${kind}:${symbol}:${observed.date}`,
      expiresAt: now + (priority === "urgent" ? 3 * hour : 2 * day),
    });
  };

  const events = schema.investmentSignals;
  const mails = schema.investmentMail;
  const episodeDay = (date: string) => Date.parse(`${date}T00:00:00Z`);
  let riskStartedAt = riskActive ? previous?.riskStartedAt ?? episodeDay(observed.date) : null;
  if (riskActive && plan?.riskPrice != null) {
    const [latest] = previous?.riskActive ? await db.select({
      id: events.id, observedAt: events.observedAt, expiresAt: events.expiresAt,
      riskStartedAt: events.riskStartedAt, mailId: events.mailId, status: mails.status,
    }).from(events).leftJoin(mails, eq(mails.id, events.mailId)).where(and(
      eq(events.symbol, symbol), eq(events.kind, "risk_price"),
      previous.riskStartedAt != null ? gte(events.observedAt, previous.riskStartedAt) : gte(events.detectedAt, plan.updatedAt),
    )).orderBy(desc(events.id)).limit(1) : [];
    riskStartedAt = latest ? latest.riskStartedAt ?? episodeDay(feed.sessionAt(new Date(latest.observedAt)).date) : riskStartedAt;
    const undelivered = latest && (latest.mailId == null || latest.status === "expired" || latest.status === "not_sent");
    const delayed = undelivered && latest.expiresAt <= now;
    if (!latest || delayed) {
      pending.push({
        ...base, kind: "risk_price", priority: "urgent", riskStartedAt,
        eventKey: delayed ? `risk_price:${symbol}:recheck:${latest.id}` : `risk_price:${symbol}:${observed.date}`,
        title: `${symbol} ${delayed ? "延迟复核，仍低于" : "触及"}风险价 $${plan.riskPrice.toFixed(2)} · ${quoteText}`,
        nextStep: planReview(plan, held), expiresAt: now + 3 * hour,
      });
    }
  }
  if (entryActive && !previous?.entryActive && plan?.entryLow != null && plan.entryHigh != null) {
    const pendingEvent = plan.nextEvent && (!plan.nextEventDate || plan.nextEventDate >= observed.date);
    const next = pendingEvent ? `先查 ${plan.nextEvent}${plan.nextEventDate ? `（${plan.nextEventDate} ET）` : ""} 是否会改变判断。` :
      "先核对大盘与同行走势，并检查近期公告；证据完整后再研究是否分批加仓。";
    makeSignal("price_zone", "digest", `${symbol} ${quoteText}，进入观察区 $${plan.entryLow.toFixed(2)}–$${plan.entryHigh.toFixed(2)}`, next);
  }
  if (regular && givebackActive && (!sameLots || !previous.givebackActive) && giveback != null && peakPnl != null) {
    makeSignal(
      "profit_giveback", "digest",
      `${symbol} 自本组建档以来的浮盈峰值回吐 ${giveback.toFixed(0)}%`,
      `常规交易观测峰值 $${peakPnl.toFixed(2)}，当前估算浮盈亏 $${pnl.toFixed(2)}。复核你的止盈纪律。`,
    );
  }
  let unverifiedClose = false;
  if (held && regular && observed.minutesET < 630) {
    const [priorBar] = await db.select({ close: schema.dailyBars.close }).from(schema.dailyBars)
      .where(and(eq(schema.dailyBars.symbol, symbol), eq(schema.dailyBars.date, observed.previousTradingDay),
        isNotNull(schema.dailyBars.verifiedAtMs))).limit(1);
    const threshold = plan?.openingDropPct ?? 8;
    const comparable = compatiblePreviousClose(instrument, priorBar?.close ?? null);
    unverifiedClose = !comparable;
    const drop = comparable && priorBar ? (1 - price / priorBar.close) * 100 : null;
    if (drop != null && drop >= threshold && !riskActive) {
      makeSignal("opening_drop", "urgent", `${symbol} 开盘后一小时较前收下跌 ${drop.toFixed(1)}%`, `${quoteText}。原因待核实，先查公司公告、交易所和同行走势。`);
    }
  }

  const state = { observedAt, price, riskStartedAt, lotSignature, peakPnl, entryActive, riskActive, givebackActive };
  const updateState = db.insert(schema.investmentQuoteState).values({ symbol, ...state }).onConflictDoUpdate({
    target: schema.investmentQuoteState.symbol, set: state, setWhere: lte(schema.investmentQuoteState.observedAt, observedAt),
  });
  const endedRisk = previous?.riskActive && !riskActive;
  const markEnded = db.update(events).set({ expiresAt: now }).where(and(
    eq(events.symbol, symbol), eq(events.kind, "risk_price"), gt(events.expiresAt, now),
    exists(db.select({ symbol: schema.investmentQuoteState.symbol }).from(schema.investmentQuoteState).where(and(
      eq(schema.investmentQuoteState.symbol, symbol), eq(schema.investmentQuoteState.observedAt, observedAt),
      eq(schema.investmentQuoteState.riskActive, false),
    ))),
  ));
  if (pending.length === 0) {
    if (endedRisk) await db.batch([updateState, markEnded]);
    else await updateState;
    return { signals: 0, unverifiedClose };
  }
  const [inserted] = await db.batch([
    db.insert(events).values(pending).onConflictDoNothing().returning({ id: events.id }),
    updateState, ...(endedRisk ? [markEnded] : []),
  ]);
  return { signals: inserted.length, unverifiedClose };
}

const externalEvent = z.object({
  id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9:_.-]+$/),
  symbol: symbolInput,
  type: z.enum(["halt", "sec_filing"]),
  occurredAt: instant,
  sourceUrl: z.string().max(700),
  code: z.string().trim().max(20).optional(),
  items: z.array(z.string().regex(/^\d\.\d{2}$/)).max(15).optional(),
});

function officialEvent(event: z.output<typeof externalEvent>) {
  const url = secureSourceUrl(event.sourceUrl);
  if (!url) return null;
  if (event.type === "halt" && ["nasdaqtrader.com", "www.nasdaqtrader.com"].includes(url.hostname) &&
      /^\/(?:rss|trader)\.aspx$/i.test(url.pathname)) return url.href;
  if (event.type === "sec_filing" && ["www.sec.gov", "sec.gov"].includes(url.hostname) &&
      /^\/Archives\/edgar\/data\/\d+\/\d{18}\//i.test(url.pathname)) return url.href;
  return null;
}

function formatTime(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium", hourCycle: "h23" }).format(ms);
}

function deliveryStatus(row: Mail, now: number): Mail["status"] {
  return row.status === "sending" && row.leaseUntil <= now ? "uncertain" : row.status;
}

function mailText(mail: Mail, signals: (typeof schema.investmentSignals.$inferSelect)[]) {
  const items = signals.map((event) => [
    event.title,
    event.impact,
    `建议复核  ${event.nextStep}`,
    `来源  ${event.source}${event.sourceUrl ? `  ${event.sourceUrl}` : ""}`,
    `北京时间  证据 ${formatTime(event.observedAt)} · 发现 ${formatTime(event.detectedAt)}`,
  ].join("\n"));
  const test = signals.some((event) => event.kind === "test");
  const first = signals[0];
  const headline = test ? "【测试】Muse 到 QQ 邮件链路" :
    mail.mode === "urgent" && first ? `【紧急复核】${first.title}` : `【投资关注】${signals.length} 条待复核信号`;
  return {
    id: mail.id,
    claimToken: mail.claimToken,
    leaseUntil: mail.leaseUntil,
    subject: `${headline} [MSG-${mail.id}]`,
    body: `${items.join("\n\n")}\n\n在 Muse Space 打开「投资信号」查看详情。\n消息编号 ${mail.id}`,
    signalId: !test && mail.mode === "urgent" ? first?.id ?? null : null,
  };
}

function currentRiskOrOtherSignal(db: Db) {
  const signals = schema.investmentSignals;
  const state = schema.investmentQuoteState;
  const plans = schema.investmentPlans;
  return or(ne(signals.kind, "risk_price"), exists(
    db.select({ symbol: state.symbol }).from(state).innerJoin(plans, eq(plans.symbol, state.symbol))
      .where(and(eq(state.symbol, signals.symbol), eq(state.riskActive, true), eq(plans.enabled, true), isNotNull(plans.riskPrice),
        or(isNull(state.price), lte(state.price, plans.riskPrice)),
        or(isNull(signals.riskStartedAt), eq(state.riskStartedAt, signals.riskStartedAt)))),
  ));
}

async function signalsForMail(db: Db, id: string, now: number) {
  const signals = schema.investmentSignals;
  return db.select().from(signals)
    .where(and(eq(signals.mailId, id), gt(signals.expiresAt, now), currentRiskOrOtherSignal(db)))
    .orderBy(desc(signals.detectedAt));
}

async function claimMail(db: Db, mode: Mail["mode"], digestDay: string, now: number) {
  const mails = schema.investmentMail;
  const signals = schema.investmentSignals;
  const token = crypto.randomUUID();
  const leaseLimit = now + 5 * minute;
  const [retry] = await db.select().from(mails).where(and(
    eq(mails.mode, mode), eq(mails.status, "not_sent"), isNull(mails.confirmedAt), lt(mails.attempts, 3), lte(mails.retryAfter, now),
  )).orderBy(asc(mails.capturedAt)).limit(1);
  if (retry) {
    const events = await signalsForMail(db, retry.id, now);
    const expired = events.length === 0;
    const leaseUntil = Math.min(leaseLimit, ...events.map((event) => event.expiresAt));
    const [claimed] = await db.update(mails).set({
      status: expired ? "expired" : "sending",
      attempts: expired ? retry.attempts : retry.attempts + 1,
      claimToken: token, leaseUntil, retryAfter: null,
    }).where(and(eq(mails.id, retry.id), eq(mails.status, "not_sent"), isNull(mails.confirmedAt), eq(mails.claimToken, retry.claimToken))).returning();
    if (claimed && !expired && events.length) return mailText(claimed, events);
  }

  const digestKey = mode === "digest" ? `digest:${digestDay}` : null;
  if (digestKey) {
    const [already] = await db.select({ id: mails.id }).from(mails).where(eq(mails.digestKey, digestKey)).limit(1);
    if (already) return null;
  }
  const unclaimed = and(eq(signals.priority, mode), isNull(signals.mailId), gt(signals.expiresAt, now),
    currentRiskOrOtherSignal(db),
    mode === "digest" ? lte(signals.tradeDate, digestDay) : undefined);
  const candidates = await db.select({ id: signals.id, expiresAt: signals.expiresAt }).from(signals).where(unclaimed)
    .orderBy(asc(signals.detectedAt), asc(signals.id)).limit(mode === "urgent" ? 1 : 12);
  if (candidates.length === 0) return null;
  const id = crypto.randomUUID();
  const leaseUntil = Math.min(leaseLimit, ...candidates.map((event) => event.expiresAt));
  const [inserted, assigned] = await db.batch([
    db.insert(mails).values({
      id, digestKey, mode, status: "sending", claimToken: token, attempts: 1, capturedAt: now, leaseUntil,
    }).onConflictDoNothing().returning(),
    db.update(signals).set({ mailId: id }).where(and(
      unclaimed, inArray(signals.id, candidates.map((event) => event.id)),
      exists(db.select({ id: mails.id }).from(mails).where(eq(mails.id, id))),
    )).returning(),
  ]);
  const [mail] = inserted;
  if (mail && assigned.length) return mailText(mail, assigned);
  if (mail) await db.delete(mails).where(eq(mails.id, id));
  return null;
}

export function createInvestmentActions(feed: InvestmentFeed) {
  return {
    getInvestmentTargets: defineAction({
      description: "读取自选、持仓和计划标的。官方事件采集使用 held 或 planned 为真的标的。",
      request: z.object({}),
      response: z.object({
        targets: z.array(z.object({ symbol: z.string(), held: z.boolean(), planned: z.boolean() })),
        plans: z.array(planFields),
      }),
      async handler(ctx) {
        const data = await getTargets(ownerDb(ctx));
        return {
          targets: data.symbols.map((symbol) => ({
            symbol, held: data.lotsBySymbol.has(symbol), planned: data.plansBySymbol.get(symbol)?.enabled ?? false,
          })),
          plans: data.plans,
        };
      },
    }),

    saveInvestmentPlan: defineAction({
      description: "保存一个标的的持有目的、观察区、风险复核条件和下一关键事件。",
      request: planInput,
      response: z.object({ ok: z.literal(true) }),
      async handler(ctx, input) {
        const db = ownerDb(ctx);
        const { symbols } = await getTargets(db);
        if (!symbols.includes(input.symbol)) throw new Error("请先添加自选或录入持仓。");
        const [previous] = await db.select().from(schema.investmentPlans).where(eq(schema.investmentPlans.symbol, input.symbol)).limit(1);
        const saved = { ...input, updatedAt: Date.now() };
        const { symbol, ...changes } = saved;
        const riskChanged = !previous || previous.enabled !== input.enabled || previous.riskPrice !== input.riskPrice;
        const ops = db.insert(schema.investmentPlans).values(saved).onConflictDoUpdate({ target: schema.investmentPlans.symbol, set: changes });
        if (riskChanged) {
          const events = schema.investmentSignals;
          await db.batch([
            ops,
            db.update(schema.investmentQuoteState).set({ entryActive: false, riskActive: false, riskStartedAt: null, givebackActive: false })
              .where(eq(schema.investmentQuoteState.symbol, symbol)),
            db.update(events).set({ expiresAt: saved.updatedAt }).where(and(eq(events.symbol, symbol),
              eq(events.kind, "risk_price"), isNull(events.mailId), gt(events.expiresAt, saved.updatedAt))),
          ]);
        } else {
          await ops;
        }
        ctx.invalidateQueries();
        return { ok: true as const };
      },
    }),

    scanInvestmentPrices: defineAction({
      description: "采集持仓和已启用计划的报价，检查观察区、风险复核价、开盘急跌和浮盈回吐。",
      request: z.object({ worker: z.boolean().default(false) }),
      response: z.object({
        checked: z.number(), signals: z.number(), deferred: z.number(), unavailable: z.array(z.string()), unverifiedClose: z.array(z.string()),
      }),
      async handler(ctx, { worker }) {
        const db = ownerDb(ctx);
        const startedAt = new Date();
        const session = feed.sessionAt(startedAt);
        const data = await getTargets(db);
        const symbols = activeTargets(data);
        const report = { checked: 0, signals: 0, deferred: 0, unavailable: [] as string[], unverifiedClose: [] as string[] };
        if (symbols.length === 0 || !["open", "premarket", "afterhours"].includes(session.phase)) {
          if (worker) {
            await saveHeartbeat(db, "price", "skipped", symbols.length === 0 ? "暂无监测标的" : "当前休市");
            ctx.invalidateQueries();
          }
          return { ...report, deferred: symbols.length };
        }
        const eligible = symbols.filter((symbol) => {
          const plan = data.plansBySymbol.get(symbol);
          return session.phase === "open" || (plan?.enabled && plan.includeExtended);
        });
        report.deferred = symbols.length - eligible.length;
        if (eligible.length === 0) {
          if (worker) {
            await saveHeartbeat(db, "price", "skipped", "无计划启用当前时段");
            ctx.invalidateQueries();
          }
          return report;
        }
        for (let offset = 0; offset < eligible.length; offset += 4) {
          const batch = eligible.slice(offset, offset + 4);
          const results = await Promise.allSettled(batch.map((symbol) => {
            const plan = data.plansBySymbol.get(symbol);
            return scanSymbol(ctx, db, feed, symbol, plan?.enabled ? plan : undefined, data.lotsBySymbol.get(symbol) ?? []);
          }));
          results.forEach((result, index) => {
            if (result.status === "fulfilled" && typeof result.value === "object") {
              report.checked++;
              report.signals += result.value.signals;
              const symbol = batch[index];
              if (symbol && result.value.unverifiedClose) report.unverifiedClose.push(symbol);
            } else if (result.status === "fulfilled" && result.value === "session") {
              report.deferred++;
            } else {
              report.unavailable.push(`${batch[index]} · ${result.status === "fulfilled" && result.value === "stale" ? "报价时间不符" : "未取得可信报价"}`);
            }
          });
        }
        const finishedAt = new Date();
        const detail = `已检查 ${report.checked} 个标的，新增 ${report.signals} 个投资信号`
          + (report.unavailable.length ? `；${report.unavailable.join("、")}` : "")
          + (report.unverifiedClose.length ? `；前收待核对 ${report.unverifiedClose.join("、")}` : "");
        const status = report.unavailable.length === 0 && report.unverifiedClose.length === 0 ?
          "ok" : report.checked === 0 ? "error" : "partial";
        await db.insert(schema.refreshRuns).values({
          kind: "investment", status, startedAt, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), detail,
        });
        if (worker) await saveHeartbeat(db, "price", status, detail, finishedAt.getTime());
        ctx.invalidateQueries();
        return report;
      },
    }),

    importInvestmentEvents: defineAction({
      description: "导入官方交易暂停和 SEC 8-K 事件。提供稳定事件编号、精确标的、时间与官方来源。",
      request: z.object({
        events: z.array(externalEvent).max(100),
        sourceErrors: z.array(z.string().max(150)).max(12).default([]),
        source: z.enum(["all", "halt", "sec"]).default("all"),
      }),
      response: z.object({ added: z.number(), ignored: z.number() }),
      async handler(ctx, { events, sourceErrors, source }) {
        const db = ownerDb(ctx);
        const data = await getTargets(db);
        const symbols = new Set(activeTargets(data));
        const now = Date.now();
        const rows: Signal[] = [];
        for (const event of events) {
          const sourceUrl = officialEvent(event);
          const observedAt = Date.parse(event.occurredAt);
          const halt = event.type === "halt";
          const code = event.code && /^[A-Z0-9]{1,12}$/i.test(event.code) ? event.code.toUpperCase() : "未提供";
          const marketWide = halt && event.symbol === "MARKET" && /^MWC[123]$/.test(code) && symbols.size > 0;
          if (!sourceUrl || (!symbols.has(event.symbol) && !marketWide) || observedAt > now + minute || observedAt < now - day) continue;
          const held = data.lotsBySymbol.has(event.symbol);
          const items = new Set(event.items ?? []);
          const bankruptcy = items.has("1.03");
          const restatement = items.has("4.02");
          const material = halt || bankruptcy || restatement;
          // Routine earnings 8-Ks are summarized. Only high-confidence material filings for holdings interrupt the user.
          const urgent = (held || marketWide) && material && observedAt > now - 3 * hour;
          const title = marketWide ? `美股市场交易暂停（${code}）` : halt ? `${event.symbol} 交易所公布暂停交易（${code}）` : bankruptcy ? `${event.symbol} SEC 8-K 披露破产或接管事项` :
            restatement ? `${event.symbol} SEC 8-K 披露历史财务信息不可依赖事项` : `${event.symbol} 提交 SEC 8-K`;
          const impact = marketWide ? "涉及美股市场整体交易状态。" : positionImpact(held);
          const nextStep = halt ? "查看交易所状态与复牌时间，再核对券商端是否可交易。暂停原因以交易所或公司后续披露为准。" :
            "查看 8-K 正文与附件，确认事件范围并评估是否改变持有或观察计划。";
          rows.push({
            eventKey: `${event.type}:${event.symbol}:${event.id}`,
            symbol: event.symbol, kind: event.type, priority: urgent ? "urgent" : "digest",
            tradeDate: feed.sessionAt(new Date(observedAt)).date, title, impact, nextStep,
            source: halt ? "Nasdaq Trader 交易暂停公告" : "SEC EDGAR", sourceUrl,
            observedAt, detectedAt: now, expiresAt: observedAt + (urgent ? 3 * hour : 2 * day),
          });
        }
        let added = 0;
        // D1 has 100 bound parameters per statement. An official event currently binds 13.
        const rowsPerInsert = 7;
        for (let offset = 0; offset < rows.length; offset += rowsPerInsert) {
          const inserted = await db.insert(schema.investmentSignals).values(rows.slice(offset, offset + rowsPerInsert))
            .onConflictDoNothing().returning({ id: schema.investmentSignals.id });
          added += inserted.length;
        }
        const finishedAt = new Date();
        const status = sourceErrors.length === 0 ? "ok" : rows.length ? "partial" : "error";
        const detail = `${source === "halt" ? "Nasdaq 暂停交易" : source === "sec" ? "SEC 8-K" : "官方事件"}新增 ${added} 条`
          + (sourceErrors.length ? `；${sourceErrors.join("；")}` : "");
        await db.insert(schema.refreshRuns).values({
          kind: "investment_events", status, startedAt: finishedAt, finishedAt, durationMs: 0, detail,
        });
        if (source !== "all") await saveHeartbeat(db, source, status, detail, finishedAt.getTime());
        ctx.invalidateQueries();
        return { added, ignored: events.length - added };
      },
    }),

    recordInvestmentMailHeartbeat: defineAction({
      description: "邮件任务处理完一轮后回写健康状态。空队列也回写；发件结果待核对时填写 partial 或 error。",
      request: z.object({ status: heartbeatStatus, detail: z.string().trim().max(180).default("") }),
      response: z.object({ ok: z.literal(true) }),
      async handler(ctx, { status, detail }) {
        await saveHeartbeat(ownerDb(ctx), "mail", status, detail);
        ctx.invalidateQueries();
        return { ok: true as const };
      },
    }),

    getInvestmentOverview: defineAction({
      description: "读取投资信号、邮件进度和最近的监测状态。",
      request: z.object({}),
      response: z.object({
        signals: z.array(signalView),
        mail: z.array(mailView),
        pendingUrgent: z.number(),
        pendingDigest: z.number(),
        openRisks: z.array(z.object({ symbol: z.string(), price: z.number().nullable(), riskPrice: z.number(), observedAt: z.number() })),
        health: monitorHealthView,
        runs: z.array(z.object({ kind: z.string(), status: z.string(), detail: z.string(), at: z.number() })),
      }),
      async handler(ctx) {
        const db = ownerDb(ctx);
        const now = Date.now();
        const session = feed.sessionAt(new Date(now));
        const targets = await getTargets(db);
        const live = activeTargets(targets).length > 0;
        const extended = targets.plans.some((plan) => plan.enabled && plan.includeExtended);
        const expectWorkers = live && ["open", "premarket", "afterhours"].includes(session.phase);
        const expectPrice = expectWorkers && (session.phase === "open" || extended);
        const [signals, mail, pending, runs, testRows, openRisks, health] = await Promise.all([
          db.select().from(schema.investmentSignals).orderBy(desc(schema.investmentSignals.detectedAt), desc(schema.investmentSignals.id)).limit(40),
          db.select().from(schema.investmentMail).orderBy(desc(schema.investmentMail.capturedAt)).limit(20),
          db.select({ priority: schema.investmentSignals.priority }).from(schema.investmentSignals)
            .where(and(isNull(schema.investmentSignals.mailId), gt(schema.investmentSignals.expiresAt, now), currentRiskOrOtherSignal(db))),
          db.select().from(schema.refreshRuns).where(inArray(schema.refreshRuns.kind, ["investment", "investment_events"]))
            .orderBy(desc(schema.refreshRuns.id)).limit(5),
          db.select({ mailId: schema.investmentSignals.mailId }).from(schema.investmentSignals)
            .where(eq(schema.investmentSignals.kind, "test")).orderBy(desc(schema.investmentSignals.id)).limit(40),
          db.select({
            symbol: schema.investmentQuoteState.symbol, price: schema.investmentQuoteState.price,
            riskPrice: schema.investmentPlans.riskPrice, observedAt: schema.investmentQuoteState.observedAt,
          }).from(schema.investmentQuoteState)
            .innerJoin(schema.investmentPlans, eq(schema.investmentPlans.symbol, schema.investmentQuoteState.symbol))
            .where(and(eq(schema.investmentQuoteState.riskActive, true), eq(schema.investmentPlans.enabled, true),
              isNotNull(schema.investmentPlans.riskPrice))).orderBy(desc(schema.investmentQuoteState.observedAt)).limit(50),
          monitorHealth(db, now, expectPrice, expectWorkers),
        ]);
        const testIds = new Set(testRows.map((row) => row.mailId));
        return {
          signals: signals.filter((signal) => signal.kind !== "test"),
          mail: mail.map((entry) => ({ ...entry, status: deliveryStatus(entry, now), test: testIds.has(entry.id) })),
          pendingUrgent: pending.filter((signal) => signal.priority === "urgent").length,
          pendingDigest: pending.filter((signal) => signal.priority === "digest").length,
          openRisks: openRisks.flatMap((risk) => risk.riskPrice == null ? [] : [{ ...risk, riskPrice: risk.riskPrice }]),
          health,
          runs: runs.map(({ kind, status, detail, finishedAt }) => ({ kind, status, detail, at: finishedAt.getTime() })),
        };
      },
    }),

    queueInvestmentMailTest: defineAction({
      description: "把带有测试标记的模拟严重事件放入真实待发邮件队列。需要邮件任务领取和发送。",
      request: z.object({}),
      response: z.object({ added: z.boolean() }),
      async handler(ctx) {
        const db = ownerDb(ctx);
        const now = Date.now();
        const inserted = await db.insert(schema.investmentSignals).values({
          eventKey: `mail-test:${Math.floor(now / (5 * minute))}`, symbol: "TEST", kind: "test", priority: "urgent",
          tradeDate: feed.sessionAt(new Date(now)).date, title: "模拟持仓收到交易暂停公告",
          impact: "这是邮件链路验证，无真实交易事件。", nextStep: "到 QQ 邮箱核对消息编号，再在投资信号页面确认收件。",
          source: "Space 测试事件", observedAt: now, detectedAt: now, expiresAt: now + day,
        }).onConflictDoNothing().returning({ id: schema.investmentSignals.id });
        ctx.invalidateQueries();
        return { added: inserted.length > 0 };
      },
    }),

    claimInvestmentMail: defineAction({
      description: "由已授权邮件任务领取一封紧急邮件或盘后摘要，准备原样发给配置的 QQ 邮箱。领取后须回写实际结果。",
      request: z.object({ mode: z.enum(["urgent", "digest"]) }),
      response: z.object({ mail: z.object({
        id: z.uuid(), claimToken: z.uuid(), leaseUntil: z.number(), subject: z.string(), body: z.string(), signalId: z.number().nullable(),
      }).nullable() }),
      async handler(ctx, { mode }) {
        const db = ownerDb(ctx);
        const now = Date.now();
        const latestClose = feed.sessionAt(new Date(now)).lastClosedTradingDay;
        const mail = await claimMail(db, mode, latestClose, now);
        if (mail) ctx.invalidateQueries();
        return { mail };
      },
    }),

    recordInvestmentMail: defineAction({
      description: "回写邮件服务实际结果。确定未发送才填 not_sent，结果不明填 uncertain。sent 需邮件服务凭据。",
      request: z.discriminatedUnion("outcome", [
        z.object({ id: z.uuid(), claimToken: z.uuid(), outcome: z.literal("sent"), providerRef: z.string().trim().min(1).max(160) }),
        z.object({ id: z.uuid(), claimToken: z.uuid(), outcome: z.literal("not_sent"), error: z.string().trim().min(1).max(180) }),
        z.object({ id: z.uuid(), claimToken: z.uuid(), outcome: z.literal("uncertain"), error: z.string().trim().min(1).max(180) }),
      ]),
      response: z.object({ ok: z.boolean() }),
      async handler(ctx, args) {
        const db = ownerDb(ctx);
        const mail = schema.investmentMail;
        const now = Date.now();
        const [updated] = await db.update(mail).set({
          status: args.outcome,
          providerRef: args.outcome === "sent" ? args.providerRef : null,
          sentAt: args.outcome === "sent" ? now : null,
          error: args.outcome === "sent" ? null : args.error,
          retryAfter: args.outcome === "not_sent" ? now + 2 * minute : null,
        }).where(and(eq(mail.id, args.id), eq(mail.claimToken, args.claimToken),
          args.outcome === "sent" ? inArray(mail.status, ["sending", "uncertain"]) : and(eq(mail.status, "sending"), isNull(mail.confirmedAt)),
        )).returning({ id: mail.id });
        if (updated) ctx.invalidateQueries();
        const [current] = updated ? [] : await db.select({ status: mail.status }).from(mail)
          .where(and(eq(mail.id, args.id), eq(mail.claimToken, args.claimToken))).limit(1);
        return { ok: !!updated || current?.status === args.outcome };
      },
    }),

    confirmInvestmentMail: defineAction({
      description: "收件人在 QQ 收件箱看到相同消息编号后，确认此邮件实际收到。",
      request: z.object({ id: z.uuid() }),
      response: z.object({ ok: z.boolean() }),
      async handler(ctx, { id }) {
        const db = ownerDb(ctx);
        const now = Date.now();
        const mail = schema.investmentMail;
        const [updated] = await db.update(mail).set({ confirmedAt: now })
          .where(and(eq(mail.id, id), isNull(mail.confirmedAt),
            inArray(mail.status, ["sending", "uncertain", "sent"]))).returning({ id: mail.id });
        if (updated) ctx.invalidateQueries();
        return { ok: !!updated };
      },
    }),
  } satisfies ActionsModule;
}
