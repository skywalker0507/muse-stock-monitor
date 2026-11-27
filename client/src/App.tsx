import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import {
Area,
AreaChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import { InvestmentCenter, InvestmentPlanEditor, InvestmentSignal, monitorIssue, useInvestmentOverview } from "./investment";
import type { Actions } from "../../server/src/actions";

const FIELDS = actionFields<typeof Actions>();

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Stock = Dashboard["stocks"][number];
type Position = Dashboard["positions"][number];

// ---------- 格式化 ----------

const fmtPrice = (v: number | null | undefined) =>
  v == null ? "不可用" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
const fmtDd = (v: number | null | undefined) => (v == null ? "—" : `-${v.toFixed(1)}%`);
const fmtNum = (v: number | null | undefined, digits = 1) => (v == null ? "—" : v.toFixed(digits));
const fmtMoney = (v: number | null | undefined) => {
  if (v == null) return "不可用";
  const abs = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${s}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${s}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${s}$${(abs / 1e6).toFixed(1)}M`;
  return `${s}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};
const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
};
const chgColor = (v: number | null | undefined) =>
  v == null ? "text-[var(--dim)]" : v > 0 ? "text-[var(--up)]" : v < 0 ? "text-[var(--down)]" : "text-[var(--dim)]";


// 代码旁展示名（仅 UI 呈现，不改数据库中的原始名称）：已知标的用中文/通用名，自定义标的回退到库中名称
const CN_NAMES: Record<string, string> = {
  GOOG: "Alphabet",
  MSFT: "微软",
  QQQ: "纳斯达克100 ETF",
  QQQM: "纳斯达克100 ETF",
  SPY: "标普500 ETF",
  VOO: "标普500 ETF",
  NVDA: "英伟达",
  AMD: "超威半导体",
  AVGO: "博通",
  AMZN: "亚马逊",
  META: "Meta",
  AAPL: "苹果",
  MU: "美光科技",
};
const displayName = (symbol: string, fallback: string) => CN_NAMES[symbol] ?? fallback;

function MdLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: number) => {
    if (list.length > 0) {
      blocks.push(
        <ul key={`ul-${key}`} className="my-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[var(--text)]">
          {list.map((li, i) => (
            <li key={i}>{renderInline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  const renderInline = (s: string) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? (
        <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
      ) : (
        <span key={i}>{p}</span>
      ),
    );
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      flush(idx);
      const level = line.match(/^#+/)?.[0].length ?? 2;
      const content = line.replace(/^#+\s*/, "");
      blocks.push(
        <h3 key={idx} className={level <= 2 ? "mb-1 mt-4 text-base font-semibold text-[var(--text)]" : "mb-1 mt-3 text-sm font-semibold text-[var(--text)]"}>
          {renderInline(content)}
        </h3>,
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flush(idx);
    } else {
      flush(idx);
      blocks.push(
        <p key={idx} className="my-1.5 text-sm leading-6 text-[var(--text)]">{renderInline(line)}</p>,
      );
    }
  });
  flush(lines.length);
  return <div>{blocks}</div>;
}

// ---------- 总览 ----------

type Alert = Dashboard["alerts"][number];
type Earnings = Dashboard["earnings"][number];
type Tab = "overview" | "stocks" | "positions" | "reports" | "news" | "rules" | "system" | "alerts" | "investing" | "plan";
type StockView = "all" | "core" | "opportunity" | "custom" | "triggered" | "research";
type OpenStock = (symbol: string) => void;

const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const beijingClock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const money = (v: number | null) => v == null ? "—" : `${v < 0 ? "-" : ""}$${fmtPrice(Math.abs(v))}`;
const signedMoney = (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : ""}${money(v)}`;
const dayLabel = (date: string) => date.slice(5).replace("-", "月") + "日";
const stockName = (stock: Stock) => displayName(stock.symbol, stock.name);
const statusLabel: Record<string, string> = { ok: "成功", partial: "部分成功", error: "失败", skipped: "跳过" };
const runLabel: Record<string, string> = { full: "盘后全量刷新", market: "行情刷新", news: "资讯刷新", report: "报告生成" };
const alertLevel: Record<string, string> = { critical: "严重", warn: "警告", info: "提示" };

function dataDate(value: string | null) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : nyDate.format(time);
}

function quoteLabel(price: number | null, asOf: string | null, calendar: Dashboard["calendar"]) {
  if (price == null) return "缺报价";
  const date = dataDate(asOf);
  if (!date) return "时间未知";
  if (date < calendar.lastClosedTradingDay) return "报价较旧";
  if (calendar.phase === "open") {
    if (date < calendar.todayET) return "上个交易日";
    const minutes = (Date.now() - Date.parse(asOf ?? "")) / 60000;
    if (minutes > 30) return "报价较旧";
  }
  return null;
}

function latestByTime(stocks: Stock[]) {
  return stocks.reduce<string | null>((latest, stock) => {
    const asOf = stock.asOf;
    if (!asOf || !Number.isFinite(Date.parse(asOf))) return latest;
    return latest && Date.parse(latest) >= Date.parse(asOf) ? latest : asOf;
  }, null);
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`monitor-panel ${className}`}>{children}</div>;
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="monitor-heading">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <Panel className="px-4 py-4 text-sm text-[var(--dim)]">{children}</Panel>;
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="monitor-panel monitor-disclosure">
      <summary>{title}</summary>
      <div className="space-y-3 px-4 pb-4">{children}</div>
    </details>
  );
}

function AlertTitle({ alert, openStock, label = alertLevel[alert.level] ?? "提示" }: {
  alert: Alert;
  openStock?: OpenStock;
  label?: string;
}) {
  const symbol = alert.symbol;
  return (
    <div className="flex items-start gap-3">
      <span className={`monitor-tag ${alert.level === "critical" ? "monitor-tag-risk" : ""}`}>{label}</span>
      {symbol && openStock ? (
        <button type="button" className="min-w-0 text-left font-medium" onClick={() => openStock(symbol)}>{alert.title}</button>
      ) : <p className="min-w-0 text-sm font-medium">{alert.title}</p>}
    </div>
  );
}

function recentAlerts(data: Dashboard) {
  const day = data.calendar.isTradingDay ? data.calendar.todayET : data.calendar.lastTradingDay;
  return data.alerts.filter((alert) => alert.kind !== "test" && (alert.tradeDate ?? dataDate(alert.createdAt)) === day);
}

const MARKET_LABELS: Record<string, string> = { SPX: "标普 500", NAS100: "纳指 100", VIX: "VIX", TNX10Y: "10 年期美债" };

function MarketGrid({ data }: { data: Dashboard }) {
  const closedDate = data.calendar.lastClosedTradingDay;
  return (
    <Panel className="monitor-metrics">
      {Object.entries(MARKET_LABELS).map(([key, label]) => {
        const item = data.market.find((market) => market.key === key);
        const day = dataDate(item?.asOf ?? null);
        const old = !!day && day < closedDate;
        const value = item?.value;
        const change = item?.changePct;
        return (
          <div className="monitor-metric" key={key}>
            <div className="text-xs text-[var(--dim)]">{label}</div>
            <div className="num text-lg font-semibold">
              {value == null ? <span className="text-sm text-[var(--dim)]">不可用</span> : `${fmtPrice(value)}${key === "TNX10Y" ? "%" : ""}`}
            </div>
            <div className="min-h-4 text-xs text-[var(--dim)]">
              {value != null && (old || !day) ? (day ? `旧数据 · ${dayLabel(day)} ET` : "数据日期未确认") :
                change != null && key !== "TNX10Y" ? <span className={chgColor(change)}>{fmtPct(change)}</span> :
                value != null && day ? `${dayLabel(day)} ET` : null}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

function Overview({ data, openStock, openAlerts, openEvents, openSystem, openInvesting }: {
  data: Dashboard; openStock: OpenStock; openAlerts: () => void; openEvents: () => void; openSystem: () => void; openInvesting: () => void;
}) {
  const calendar = data.calendar;
  const investment = useInvestmentOverview();
  const coverageIssue = investment.isError ? "无法核对后台运行状态" : investment.data ? monitorIssue(investment.data.health) : "";
  const openRiskCount = investment.data?.openRisks.length ?? 0;
  const investmentSignals = investment.data?.signals.filter((signal) => signal.priority === "urgent" && signal.expiresAt > Date.now()).slice(0, 3) ?? [];
  const holdings = new Set(data.positions.map((position) => position.symbol));
  const core = new Set(data.stocks.filter((stock) => stock.grp === "core").map((stock) => stock.symbol));
  const rank = (alert: Alert) => (alert.level === "critical" ? 12 : alert.level === "warn" ? 4 : 0)
    + (alert.symbol && holdings.has(alert.symbol) ? 8 : alert.symbol && core.has(alert.symbol) ? 3 : 0);
  const alerts = recentAlerts(data).sort((a, b) => rank(b) - rank(a) || b.id - a.id).slice(0, 3 - investmentSignals.length);
  const near = new Date(`${calendar.todayET}T12:00:00Z`);
  near.setUTCDate(near.getUTCDate() + 1);
  const nearDate = near.toISOString().slice(0, 10);
  const relevant = new Set([...holdings, ...data.stocks.map((stock) => stock.symbol)]);
  const events = data.earnings.filter((event) => relevant.has(event.symbol) && event.reportDate >= calendar.todayET && event.reportDate <= nearDate)
    .sort((a, b) => Number(holdings.has(b.symbol)) - Number(holdings.has(a.symbol)) || a.reportDate.localeCompare(b.reportDate))
    .slice(0, 3 - alerts.length - investmentSignals.length);
  const quoteTime = latestByTime(data.stocks);
  const closeTime = Date.parse(`${calendar.todayET}T${calendar.closeTimeET}:00Z`);
  const earlyCloseTime = beijingClock.format(new Date(closeTime + (calendar.isDST ? 4 : 5) * 3600000));
  const coreIssues = new Set(data.stocks.filter((stock) => stock.grp === "core" && quoteLabel(stock.price, stock.asOf, calendar)).map((stock) => stock.symbol));
  for (const position of data.positions) {
    if (quoteLabel(position.price, position.quoteAsOf, calendar)) coreIssues.add(position.symbol);
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--dim)]">
        <span className="monitor-tag">{calendar.phaseLabel}</span>
        {quoteTime ? <span>最近报价 {fmtTime(quoteTime)} 北京时间</span> : <span>尚未取得报价</span>}
        {calendar.earlyClose ? <span>提前收盘 · 北京时间次日 {earlyCloseTime}</span> : null}
        {coreIssues.size > 0 ? <button type="button" className="monitor-link" onClick={openSystem}>核心或持仓报价待核对 {coreIssues.size} 项</button> : null}
      </div>
      {coverageIssue || openRiskCount > 0 ? (
        <button type="button" onClick={openInvesting} className="monitor-panel px-4 py-3 text-left text-sm">
          {openRiskCount > 0 ? <p className="font-semibold text-[var(--up)]">持续风险 {openRiskCount} 项 · 查看待复核</p> : null}
          {coverageIssue ? <p className={openRiskCount ? "mt-1 text-xs text-[var(--dim)]" : "font-medium"}>监测待核对 · {coverageIssue}</p> : null}
        </button>
      ) : null}
      <section>
        <Heading title="今日关注">
          <div className="flex gap-1">
            <button type="button" className="monitor-link" onClick={openAlerts}>预警记录</button>
            <button type="button" className="monitor-link" onClick={openInvesting}>投资信号</button>
          </div>
        </Heading>
        {investmentSignals.length === 0 && alerts.length === 0 && events.length === 0 ? <Empty>{coverageIssue ? "暂无已记录的触发，监测覆盖待核对。" : investment.isPending ? "正在核对监测状态…" : "暂无新触发。"}</Empty> : (
          <Panel className="monitor-rows">
            {investmentSignals.map((signal) => <InvestmentSignal signal={signal} key={signal.id} compact />)}
            {alerts.map((alert) => (
              <article key={alert.id} className="px-4 py-3">
                <AlertTitle alert={alert} openStock={data.stocks.some((stock) => stock.symbol === alert.symbol) ? openStock : undefined} />
                {alert.detail ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--dim)]">{alert.detail}</p> : null}
              </article>
            ))}
            {events.map((event) => (
              <button type="button" key={event.id} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm" onClick={openEvents}>
                <span className="monitor-tag">财报</span>
                <span>{event.symbol} · {event.reportDate === calendar.todayET ? "今天" : dayLabel(event.reportDate)}{event.timing ? ` · ${event.timing}` : ""}</span>
              </button>
            ))}
          </Panel>
        )}
      </section>
      <section>
        <Heading title="市场速览"><button type="button" className="monitor-link" onClick={openSystem}>数据详情</button></Heading>
        <MarketGrid data={data} />
      </section>
    </>
  );
}

function StockDetail({ stock, alert, threshold, onClose, openPlan }: {
  stock: Stock; alert?: Alert; threshold: number; onClose: () => void; openPlan: () => void;
}) {
  const [range, setRange] = useState<"month" | "quarter" | "year">("quarter");
  const detail = useQuery({
    queryKey: ["symbol-detail", stock.symbol],
    queryFn: () => api.getSymbolDetail({ symbol: stock.symbol }),
  });
  const allBars = detail.data?.bars ?? [];
  const bars = allBars.slice(-(range === "month" ? 22 : range === "quarter" ? 65 : 252));
  const nextEarning = detail.data?.earnings[0];
  return (
    <>
      <Heading title={`${stock.symbol} · ${stockName(stock)}`}>
        <div className="flex flex-wrap justify-end gap-1">
          <button type="button" className="monitor-link" onClick={onClose}>返回自选</button>
          <button type="button" className="monitor-link" onClick={openPlan}>投资计划</button>
        </div>
      </Heading>
      <Panel className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="num text-2xl font-semibold">{money(stock.price)}</span>
          <span className={`num text-sm ${chgColor(stock.changePct)}`}>{fmtPct(stock.changePct)}</span>
          {stock.asOf ? <span className="text-xs text-[var(--dim)]">报价 {fmtTime(stock.asOf)}（北京时间）</span> : null}
        </div>
        <div className="monitor-filters">
          {([["month", "近 1 个月"], ["quarter", "近 3 个月"], ["year", "近 1 年"]] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>
          ))}
        </div>
        {detail.isPending ? <p className="text-sm text-[var(--dim)]">加载走势…</p> : detail.isError ? (
          <button type="button" className="monitor-link" onClick={() => detail.refetch()}>详情加载失败，重试</button>
        ) : bars.length < 2 ? <p className="text-sm text-[var(--dim)]">日线数据不足。</p> : (
          <div className="h-48 w-full min-w-0" aria-label={`${stock.symbol} 日线收盘价，美元`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={bars} margin={{ top: 5, right: 12, bottom: 4, left: 2 }}>
                <XAxis dataKey="date" minTickGap={36} tick={{ fontSize: 11, fill: "var(--dim)" }} tickFormatter={(date: string) => date.slice(5)} />
                <YAxis domain={["auto", "auto"]} width={48} tick={{ fontSize: 11, fill: "var(--dim)" }} />
                <Tooltip formatter={(v) => [money(typeof v === "number" ? v : null), "收盘"]} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
                <Area type="linear" dataKey="close" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.12} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      {alert ? <Panel className="space-y-1 p-4"><AlertTitle alert={alert} /><p className="text-sm text-[var(--dim)]">{alert.detail}</p></Panel> : null}
      {nextEarning ? <Panel className="p-4 text-sm">下次财报 · {nextEarning.reportDate} ET{nextEarning.timing ? ` · ${nextEarning.timing}` : ""}</Panel> : null}
      {detail.data?.news.length ? (
        <Disclosure title="相关新闻">
          {detail.data.news.slice(0, 6).map((item) => <a className="block text-sm underline" key={item.id} href={item.url} target="_blank" rel="noreferrer">{item.title}</a>)}
        </Disclosure>
      ) : null}
      <Disclosure title="技术指标">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            ["距 52 周高点", fmtDd(stock.dd52)], ["回撤关注阈值", `${threshold}%`],
            ["52 周最高 / 最低", `${money(stock.week52High)} / ${money(stock.week52Low)}`],
            ["距 20 日高点", fmtDd(stock.dd20)], ["距 60 日高点", fmtDd(stock.dd60)], ["RSI (14)", fmtNum(stock.rsi14)],
            ["MA20", money(stock.ma20)], ["MA50", money(stock.ma50)], ["MA200", money(stock.ma200)],
            ["日高 / 日低", `${money(stock.dayHigh)} / ${money(stock.dayLow)}`],
            ["52 周高 / 低日期", `${stock.week52HighDate ?? "—"} / ${stock.week52LowDate ?? "—"}`],
            ["市值 / Beta", `${fmtMoney(stock.marketCap)} / ${fmtNum(stock.beta, 2)}`],
          ].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--dim)]">{label}</dt><dd className="num mt-1 text-sm">{value}</dd></div>)}
        </dl>
      </Disclosure>
    </>
  );
}

function StocksTab({ data, selected, setSelected, openEvents, openPlan }: {
  data: Dashboard; selected: string | null; setSelected: (symbol: string | null) => void; openEvents: () => void; openPlan: (symbol: string) => void;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<StockView>("all");
  const [sort, setSort] = useState<"default" | "move" | "drawdown">("default");
  const [adding, setAdding] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const addSymbol = useMutation({
    mutationFn: (symbol: string) => api.addSymbol({ symbol }),
    onSuccess: () => { setNewSymbol(""); setAdding(false); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (symbol: string) => api.removeSymbol({ symbol }),
    onSuccess: () => { setRemoving(null); setRemoveError(""); invalidate(); },
    onError: () => setRemoveError("取消关注失败，请重试。"),
  });
  const alerts = recentAlerts(data);
  const alerted = new Map<string, Alert>();
  for (const alert of alerts) {
    if (alert.symbol && !alerted.has(alert.symbol)) alerted.set(alert.symbol, alert);
  }
  const detailStock = data.stocks.find((stock) => stock.symbol === selected);
  if (detailStock) {
    return <StockDetail key={detailStock.symbol} stock={detailStock} alert={alerted.get(detailStock.symbol)} threshold={data.rules.ddWatchPct} onClose={() => setSelected(null)} openPlan={() => openPlan(detailStock.symbol)} />;
  }

  const threshold = data.rules.ddWatchPct;
  const inResearch = (stock: Stock) => (stock.dd52 != null && stock.dd52 >= threshold) || (stock.rsi14 != null && stock.rsi14 <= 35);
  const visible = data.stocks.filter((stock) => {
    if (view === "all") return true;
    if (view === "triggered") return alerted.has(stock.symbol);
    if (view === "research") return inResearch(stock);
    return view === stock.grp;
  });
  if (sort === "drawdown") visible.sort((a, b) => (b.dd52 ?? -1) - (a.dd52 ?? -1));
  if (sort === "move") visible.sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  return (
    <>
      <Heading title="自选">
        <div className="flex gap-2">
          <button type="button" className="monitor-link" onClick={openEvents}>事件</button>
          <button type="button" className="monitor-secondary" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? "收起" : "添加标的"}</button>
        </div>
      </Heading>
      {adding ? (
        <Panel className="p-3">
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (newSymbol.trim()) addSymbol.mutate(newSymbol.trim().toUpperCase()); }}>
            <input {...FIELDS.addSymbol.symbol} className="monitor-input min-w-0 flex-1" aria-label="新股票代码" placeholder="股票代码，如 TSLA" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value.toUpperCase())} />
            <button type="submit" className="monitor-primary" disabled={addSymbol.isPending || !newSymbol.trim()}>{addSymbol.isPending ? "验证中…" : "添加"}</button>
          </form>
          {addSymbol.error ? <p role="alert" className="mt-2 text-sm text-[var(--up)]">{addSymbol.error.message}</p> : null}
        </Panel>
      ) : null}
      <div className="space-y-2">
        <div className="monitor-filters">
          {([["all", "全部"], ["core", "核心"], ["opportunity", "机会观察"], ["custom", "自定义"], ["triggered", "已触发"], ["research", "回撤与超卖"]] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)}>{label}</button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--dim)]">{view === "research" ? `回撤 ≥${threshold}% 或 RSI ≤35` : `${visible.length} 个标的`}</p>
          <select aria-label="自选排序" className="monitor-input text-xs" value={sort} onChange={(e) => setSort(e.target.value === "drawdown" ? "drawdown" : e.target.value === "move" ? "move" : "default")}>
            <option value="default">默认排序</option><option value="move">按当日波动</option><option value="drawdown">按 52 周回撤</option>
          </select>
        </div>
      </div>
      {removeError ? <p role="alert" className="text-sm text-[var(--up)]">{removeError}</p> : null}
      {visible.length === 0 ? <Empty>{view === "triggered" ? "当前交易日暂无标的预警。" : "此筛选下暂无标的。"}</Empty> : (
        <Panel className="monitor-rows">
          {visible.map((stock) => {
            const quality = quoteLabel(stock.price, stock.asOf, data.calendar);
            const alert = alerted.get(stock.symbol);
            return (
              <div key={stock.symbol} className="relative">
                <div className="flex items-center gap-1 px-3 sm:px-4">
                  <button type="button" className="monitor-stock-row" onClick={() => setSelected(stock.symbol)} aria-label={`查看 ${stock.symbol} 详情`}>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2"><strong>{stock.symbol}</strong>{alert ? <span className="monitor-tag">{alertLevel[alert.level] ?? "预警"}</span> : null}</span>
                      <span className="block truncate text-xs text-[var(--dim)]">{stockName(stock)}</span>
                    </span>
                    <span className="num text-right">
                      <span className="block text-sm font-medium">{money(stock.price)}</span>
                      {quality ? <span className="block text-xs text-[var(--dim)]">{quality}</span> : null}
                    </span>
                    <span className={`num text-right text-sm ${sort === "drawdown" ? "text-[var(--dim)]" : chgColor(stock.changePct)}`}>
                      {sort === "drawdown" ? fmtDd(stock.dd52) : fmtPct(stock.changePct)}
                    </span>
                  </button>
                  <button type="button" className="monitor-icon-button" aria-label={`管理 ${stock.symbol}`} aria-expanded={removing === stock.symbol} onClick={() => { setRemoving(removing === stock.symbol ? null : stock.symbol); setRemoveError(""); }}>⋯</button>
                </div>
                {view === "triggered" && alert ? <p className="px-4 pb-2 text-xs text-[var(--dim)]">{alert.title}</p> : null}
                {view === "research" ? <p className="px-4 pb-2 text-xs text-[var(--dim)]">距 52 周高点 {fmtDd(stock.dd52)} · RSI {fmtNum(stock.rsi14, 0)}</p> : null}
                {removing === stock.symbol ? (
                  <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3 text-sm">
                    <span>取消关注 {stock.symbol}？</span>
                    <button type="button" className="monitor-secondary" onClick={() => setRemoving(null)}>返回</button>
                    <button type="button" className="monitor-secondary" disabled={remove.isPending} onClick={() => remove.mutate(stock.symbol)}>确认取消关注</button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </Panel>
      )}
    </>
  );
}
function PositionForm({
  initial,
  onDone,
}: {
  initial?: Position;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState(initial?.symbol ?? "");
  const [shares, setShares] = useState(initial ? String(initial.shares) : "");
  const [cost, setCost] = useState(initial ? String(initial.cost) : "");
  const [horizon, setHorizon] = useState<"long" | "trade">(initial?.horizon === "trade" ? "trade" : "long");
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const mutation = useMutation({
    mutationFn: async () => {
      const sh = Number(shares);
      const co = Number(cost);
      if (initial) {
        return await api.updatePosition({ id: initial.id, shares: sh, cost: co, horizon, note });
      }
      return await api.addPosition({ symbol: symbol.trim().toUpperCase(), shares: sh, cost: co, horizon, note });
    },
    onSuccess: () => { setError(""); invalidate(); onDone(); },
    onError: (e) => setError(e instanceof Error ? e.message : "保存失败"),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!initial && !symbol.trim()) { setError("请输入股票代码"); return; }
    if (!(Number(shares) > 0)) { setError("数量必须大于 0"); return; }
    if (!cost.trim() || !(Number(cost) >= 0)) { setError("请输入非负成本价"); return; }
    mutation.mutate();
  };
  const inputCls = "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)]";
  return (
    <form onSubmit={submit} className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs text-[var(--dim)]">股票代码</span>
          <input {...FIELDS.addPosition.symbol} aria-label="持仓股票代码" value={symbol} disabled={!!initial} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="如 NVDA" className={`num ${inputCls}`} />
        </label>
        <label className="block">
          <span className="text-xs text-[var(--dim)]">投资周期</span>
          <select aria-label="投资周期" value={horizon} onChange={(e) => setHorizon(e.target.value === "trade" ? "trade" : "long")} className={inputCls}>
            <option value="long">长期核心</option>
            <option value="trade">短中期交易</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[var(--dim)]">持仓数量（股）</span>
          <input {...FIELDS.addPosition.shares} aria-label="持仓数量" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="如 50" className={`num ${inputCls}`} />
        </label>
        <label className="block">
          <span className="text-xs text-[var(--dim)]">成本价（美元）</span>
          <input {...FIELDS.addPosition.cost} aria-label="成本价" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="如 120.50" className={`num ${inputCls}`} />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-[var(--dim)]">备注（可选）</span>
        <input {...FIELDS.addPosition.note} aria-label="持仓备注" value={note} onChange={(e) => setNote(e.target.value)} placeholder="买入逻辑、目标、纪律等" className={inputCls} />
      </label>
      {error ? <p className="text-sm text-[var(--up)]">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" disabled={mutation.isPending} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 font-medium text-black disabled:opacity-50">
          {mutation.isPending ? "保存中…" : initial ? "保存修改" : "录入持仓"}
        </button>
        <button type="button" onClick={onDone} className="rounded-[var(--radius)] border border-[var(--border)] px-4 text-[var(--dim)]">取消</button>
      </div>
    </form>
  );
}

function PositionsTab({ data, openStock }: { data: Dashboard; openStock: OpenStock }) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => api.deletePosition({ id }),
    onSuccess: () => { setConfirmDelete(null); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); },
  });
  const groups = new Map<string, Position[]>();
  for (const position of data.positions) {
    const group = groups.get(position.symbol) ?? [];
    group.push(position);
    groups.set(position.symbol, group);
  }
  const valued = data.positions.filter((position) => position.marketValue != null);
  const totalValue = valued.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
  const totalPnl = valued.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
  const symbolsValued = new Set(valued.map((position) => position.symbol)).size;
  const oldQuotes = new Set(valued.filter((position) => quoteLabel(position.price, position.quoteAsOf, data.calendar)).map((position) => position.symbol));
  const complete = symbolsValued === groups.size;
  return (
    <>
      <Heading title="持仓"><button type="button" className="monitor-secondary" onClick={() => setShowForm(!showForm)}>{showForm ? "收起" : "＋ 录入持仓"}</button></Heading>
      {showForm ? <PositionForm onDone={() => setShowForm(false)} /> : null}
      {groups.size === 0 ? <Empty>录入持仓后可查看浮盈亏、仓位和高点回撤。</Empty> : (
        <>
          <Panel className="monitor-metrics monitor-metrics-three">
            <div className="monitor-metric"><p className="text-xs text-[var(--dim)]">{complete ? "总市值" : "已报价市值"}</p><p className="num mt-1 break-words font-semibold">{money(valued.length > 0 ? totalValue : null)}</p></div>
            <div className="monitor-metric"><p className="text-xs text-[var(--dim)]">{complete ? "浮动盈亏" : "已报价盈亏"}</p><p className={`num mt-1 break-words font-semibold ${chgColor(valued.length > 0 ? totalPnl : null)}`}>{signedMoney(valued.length > 0 ? totalPnl : null)}</p></div>
            <div className="monitor-metric"><p className="text-xs text-[var(--dim)]">报价覆盖</p><p className="num mt-1 font-semibold">{symbolsValued}/{groups.size}</p></div>
          </Panel>
          {oldQuotes.size > 0 ? <p className="text-xs text-[var(--dim)]">部分报价待核对 · {[...oldQuotes].join("、")}</p> : null}
          <Panel className="monitor-rows">
            {[...groups].map(([symbol, lots]) => {
              const first = lots[0];
              if (!first) return null;
              const groupValue = first.marketValue == null ? null : lots.reduce((sum, lot) => sum + (lot.marketValue ?? 0), 0);
              const groupPnl = groupValue == null ? null : lots.reduce((sum, lot) => sum + (lot.pnl ?? 0), 0);
              const weight = complete && groupValue != null && totalValue > 0 ? groupValue / totalValue * 100 : null;
              const maxDrawdown = lots.reduce<number | null>((largest, lot) => lot.ddFromPeak == null ? largest : Math.max(largest ?? 0, lot.ddFromPeak), null);
              const watched = data.stocks.some((stock) => stock.symbol === symbol);
              return (
                <details key={symbol} className="monitor-disclosure">
                  <summary>
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span><strong>{symbol}</strong>{weight != null && weight >= 40 ? <span className="monitor-tag monitor-tag-risk ml-2">集中</span> : null}</span>
                      <span className={`num ${chgColor(groupPnl)}`}>{signedMoney(groupPnl)}</span>
                      <span className="w-full text-xs text-[var(--dim)]">
                        {groupValue == null ? "缺报价" : weight == null ? "组合仓位待完整报价" : `仓位 ${weight.toFixed(1)}%`}
                        {maxDrawdown != null ? ` · ${lots.length > 1 ? "各笔最大" : "持有期"}回撤 ${fmtDd(maxDrawdown)}` : ""}
                      </span>
                    </span>
                  </summary>
                  <div className="space-y-3 px-4 pb-4">
                    {watched ? <button type="button" className="monitor-link" onClick={() => openStock(symbol)}>查看标的详情</button> : null}
                    {lots.map((lot) => (
                      editing === lot.id ? <PositionForm key={lot.id} initial={lot} onDone={() => setEditing(null)} /> : (
                        <div className="rounded-lg bg-[var(--surface2)] p-3" key={lot.id}>
                          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span>{lot.horizon === "long" ? "长期核心" : "短中期"} · {lot.shares} 股 · 成本 {money(lot.cost)}</span>
                            <span className={`num ${chgColor(lot.pnl)}`}>{signedMoney(lot.pnl)}{lot.pnlPct != null ? ` · ${fmtPct(lot.pnlPct)}` : ""}</span>
                          </div>
                          <p className="mt-1 text-xs text-[var(--dim)]">现价 {money(lot.price)} · 期间高点 {money(lot.peakPrice)}{lot.note ? ` · ${lot.note}` : ""}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" className="monitor-link" onClick={() => setEditing(lot.id)}>编辑</button>
                            {confirmDelete === lot.id ? (
                              <>
                                <button type="button" className="monitor-secondary" disabled={del.isPending} onClick={() => del.mutate(lot.id)}>确认删除</button>
                                <button type="button" className="monitor-link" onClick={() => { setConfirmDelete(null); del.reset(); }}>取消</button>
                                {del.isError ? <span role="alert" className="text-sm text-[var(--up)]">删除失败，请重试。</span> : null}
                              </>
                            ) : <button type="button" className="monitor-link" onClick={() => setConfirmDelete(lot.id)}>删除</button>}
                          </div>
                        </div>
                      )
                    ))}
                  </div>
                </details>
              );
            })}
          </Panel>
        </>
      )}
    </>
  );
}

function NewsTab({ data, onBack }: { data: Dashboard; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [date, setDate] = useState("");
  const [timing, setTiming] = useState("");
  const [eps, setEps] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const add = useMutation({
    mutationFn: () => api.addEarnings({ symbol: symbol.trim().toUpperCase(), reportDate: date, timing, epsEst: eps.trim(), note: "" }),
    onSuccess: () => { setSymbol(""); setDate(""); setTiming(""); setEps(""); setAdding(false); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: number) => api.deleteEarnings({ id }), onSuccess: invalidate });
  const refresh = useMutation({ mutationFn: () => api.refreshNews({}), onSuccess: invalidate });
  const relevant = new Set([...data.stocks.map((stock) => stock.symbol), ...data.positions.map((position) => position.symbol)]);
  const today = data.calendar.todayET;
  const nextWeek = new Date(`${today}T12:00:00Z`);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  const nextWeekDate = nextWeek.toISOString().slice(0, 10);
  const earnings = data.earnings.filter((event) => event.reportDate >= today && (managing || (event.source === "手动录入" || relevant.has(event.symbol))));
  const near = earnings.filter((event) => event.reportDate <= nextWeekDate);
  const displayed = managing || showAll ? earnings : near;
  const news = data.news.filter((item) => !item.symbols || item.symbols.split(",").some((symbol) => relevant.has(symbol)));
  return (
    <>
      <Heading title="事件">
        <div className="flex gap-2">
          <button type="button" className="monitor-link" onClick={onBack}>返回自选</button>
          <button type="button" className="monitor-secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? "更新中…" : "更新资讯"}</button>
        </div>
      </Heading>
      {refresh.error || refresh.data?.errors.length ? <p role="alert" className="text-sm text-[var(--up)]">{refresh.error?.message ?? refresh.data?.errors.join(" · ")}</p> : null}
      <section>
        <Heading title={managing || showAll ? "即将发布的财报" : "未来 7 天财报"}>
          <button type="button" className="monitor-link" onClick={() => { setManaging(!managing); setAdding(false); }}>{managing ? "完成" : "管理"}</button>
        </Heading>
        {managing ? <button type="button" className="monitor-secondary mb-2" onClick={() => setAdding(!adding)}>添加财报</button> : null}
        {adding ? (
          <form className="monitor-panel mb-3 flex flex-wrap gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (symbol.trim() && date) add.mutate(); }}>
            <input {...FIELDS.addEarnings.symbol} className="monitor-input w-24" aria-label="财报股票代码" placeholder="代码" required value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
            <input {...FIELDS.addEarnings.reportDate} type="date" className="monitor-input" aria-label="财报日期" required value={date} onChange={(e) => setDate(e.target.value)} />
            <select className="monitor-input" value={timing} aria-label="财报时点" onChange={(e) => setTiming(e.target.value)}><option value="">时段待核实</option><option>盘前</option><option>盘后</option></select>
            <input {...FIELDS.addEarnings.epsEst} className="monitor-input w-28" aria-label="预期 EPS" placeholder="预期 EPS" value={eps} onChange={(e) => setEps(e.target.value)} />
            <button type="submit" className="monitor-primary" disabled={add.isPending}>保存</button>
            {add.error ? <p role="alert" className="w-full text-sm text-[var(--up)]">{add.error.message}</p> : null}
          </form>
        ) : null}
        {displayed.length === 0 ? <Empty>{showAll || managing ? "暂无即将发布的财报。" : "暂无未来 7 天的财报记录。"}</Empty> : (
          <Panel className="monitor-rows">
            {displayed.map((event) => (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm" key={event.id}>
                <div><strong>{event.symbol}</strong><span className="ml-2">{dayLabel(event.reportDate)} ET{event.timing ? ` · ${event.timing}` : ""}</span></div>
                <span className="text-xs text-[var(--dim)]">{earningsStatus(event)}{managing && event.epsEst ? ` · 预期 EPS ${event.epsEst}` : ""}</span>
                {managing ? <button type="button" className="monitor-link" aria-label={`删除 ${event.symbol} 财报记录`} disabled={del.isPending} onClick={() => del.mutate(event.id)}>删除</button> : null}
              </div>
            ))}
          </Panel>
        )}
        {del.isError ? <p role="alert" className="mt-2 text-sm text-[var(--up)]">删除失败，请重试。</p> : null}
        {!managing && earnings.length > near.length ? <button type="button" className="monitor-link mt-2" onClick={() => setShowAll(!showAll)}>{showAll ? "只看未来 7 天" : "查看较晚财报"}</button> : null}
      </section>
      <section>
        <Heading title="相关新闻" />
        {news.length === 0 ? <Empty>暂无相关新闻。</Empty> : (
          <Panel className="monitor-rows">
            {news.slice(0, 12).map((item) => (
              <div className="px-4 py-3" key={item.id}>
                <a href={item.url} className="text-sm font-medium underline decoration-[var(--border)] underline-offset-4" target="_blank" rel="noreferrer">{item.title}</a>
                <p className="mt-1 text-xs text-[var(--dim)]">{[item.source, item.publishedAt, item.symbols].filter(Boolean).join(" · ")}</p>
              </div>
            ))}
          </Panel>
        )}
      </section>
    </>
  );
}

function earningsStatus(event: Earnings) {
  return event.source === "手动录入" ? "手动录入" : "待核实";
}

function reportHighlights(content: string) {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line && !/^#|^>|^[-*_]{3,}$/.test(line));
  return lines.slice(0, 3).map((line) => line.replace(/^[-*]\s+|^\d+\.\s+/, "").replaceAll("**", ""));
}

function ReportsTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"daily" | "weekly">(data.reports[0]?.kind === "weekly" ? "weekly" : "daily");
  const [chosen, setChosen] = useState<number | null>(null);
  const [showActions, setShowActions] = useState(false);
  const reports = data.reports.filter((report) => report.kind === kind);
  const active = reports.find((report) => report.id === chosen) ?? reports[0];
  const report = useQuery({ queryKey: ["report", active?.id], queryFn: () => api.getReport({ id: active?.id ?? 0 }), enabled: active != null });
  const gen = useMutation({
    mutationFn: () => api.generateReport({ kind }),
    onSuccess: (value) => { setChosen(value.id); setShowActions(false); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); },
  });
  const content = report.data?.content;
  const degraded = content?.split("\n").some((line) => line.startsWith("> 本报告为降级版事实汇总"));
  const coverage = content?.match(/^> (报价覆盖 [^\n]+)/m)?.[1];
  return (
    <>
      <Heading title="报告"><button type="button" className="monitor-link" aria-expanded={showActions} onClick={() => setShowActions(!showActions)}>报告操作</button></Heading>
      <div className="monitor-filters">
        {([["daily", "日报"], ["weekly", "周报"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} disabled={gen.isPending} onClick={() => { setKind(value); setChosen(null); }}>{label}</button>)}
      </div>
      {showActions ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="monitor-secondary" disabled={gen.isPending} onClick={() => gen.mutate()}>{gen.isPending ? "生成中…" : kind === "daily" ? "生成日报" : "生成周报"}</button>
          {gen.error ? <span role="alert" className="text-sm text-[var(--up)]">{gen.error.message}</span> : null}
        </div>
      ) : null}
      {!active ? <Empty>暂无{kind === "daily" ? "日报" : "周报"}。</Empty> : (
        <>
          <Panel className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">{active.title}</h3>
              {degraded ? <span className="monitor-tag">事实汇总</span> : null}
            </div>
            <p className="text-xs text-[var(--dim)]">报告周期 {active.period} ET · 生成于 {fmtTime(active.createdAt)}（北京时间）</p>
            {content ? <p className="text-xs text-[var(--dim)]">{coverage ?? "报价覆盖未记录"}</p> : null}
            {report.isPending ? <p className="text-sm text-[var(--dim)]">加载报告…</p> : report.isError ? (
              <button type="button" className="monitor-link" onClick={() => report.refetch()}>报告加载失败，重试</button>
            ) : content ? (
              <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
                {reportHighlights(content).map((line, index) => <li className="line-clamp-2" key={index}>{line}</li>)}
              </ul>
            ) : null}
          </Panel>
          {content ? <Disclosure key={active.id} title="报告全文"><MdLite text={content} /></Disclosure> : null}
        </>
      )}
      {reports.length > 1 ? (
        <Disclosure title="历史报告">
          <ul>
            {reports.map((item) => (
              <li key={item.id}><button type="button" className="flex w-full items-center justify-between gap-2 py-1 text-left text-sm" aria-current={active?.id === item.id ? "true" : undefined} onClick={() => setChosen(item.id)}>
                <span>{item.title}</span><span className="shrink-0 text-xs text-[var(--dim)]">{active?.id === item.id ? "当前" : fmtTime(item.createdAt)}</span>
              </button></li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </>
  );
}

function AlertsTab({ data, openStock, onBack }: { data: Dashboard; openStock: OpenStock; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAlert({ id }),
    onSuccess: () => { setConfirmId(null); queryClient.invalidateQueries({ queryKey: ["dashboard",] }); },
  });
  return (
    <>
      <Heading title="预警记录"><button type="button" className="monitor-link" onClick={onBack}>返回首页</button></Heading>
      {data.alerts.length === 0 ? <Empty>暂无预警记录。</Empty> : (
        <Panel className="monitor-rows">
          {data.alerts.map((alert) => (
            <article className="space-y-1 px-4 py-3" key={alert.id}>
              <AlertTitle alert={alert} label={alert.kind === "test" ? "测试" : undefined} openStock={data.stocks.some((stock) => stock.symbol === alert.symbol) ? openStock : undefined} />
              {alert.detail ? <p className="text-sm text-[var(--dim)]">{alert.detail}</p> : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[var(--dim)]">{fmtTime(alert.createdAt)}（北京时间）</span>
                {confirmId === alert.id ? <div className="flex gap-2"><button type="button" className="monitor-link" disabled={remove.isPending} onClick={() => remove.mutate(alert.id)}>确认删除</button><button type="button" className="monitor-link" onClick={() => { setConfirmId(null); remove.reset(); }}>取消</button></div> : <button type="button" className="monitor-link" aria-label={`删除预警 ${alert.title}`} onClick={() => setConfirmId(alert.id)}>删除</button>}
              </div>
              {confirmId === alert.id && remove.isError ? <p role="alert" className="text-sm text-[var(--up)]">删除失败，请重试。</p> : null}
            </article>
          ))}
        </Panel>
      )}
    </>
  );
}
function RulesTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [move, setMove] = useState(String(data.rules.movePct));
  const [index, setIndex] = useState(String(data.rules.indexDropPct));
  const [vix, setVix] = useState(data.rules.vixLevels);
  const [drawdown, setDrawdown] = useState(String(data.rules.ddWatchPct));
  const save = useMutation({
    mutationFn: () => api.updateRules({ movePct: Number(move), indexDropPct: Number(index), vixLevels: vix, ddWatchPct: Number(drawdown) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  return (
    <>
      <Heading title="监控规则" />
      <form className="monitor-panel space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="monitor-field">
          <span>个股单日涨跌阈值 (%)</span>
          <input {...FIELDS.updateRules.movePct} required className="monitor-input" value={move} onChange={(e) => { setMove(e.target.value); save.reset(); }} />
          <small>行情刷新时检查，新跨越阈值才可能产生预警。</small>
        </label>
        <label className="monitor-field">
          <span>指数单日下跌阈值 (%)</span>
          <input {...FIELDS.updateRules.indexDropPct} required className="monitor-input" value={index} onChange={(e) => { setIndex(e.target.value); save.reset(); }} />
          <small>资讯刷新时检查标普 500 与纳指 100 的跌幅。</small>
        </label>
        <label className="monitor-field">
          <span>VIX 阈值</span>
          <input {...FIELDS.updateRules.vixLevels} required className="monitor-input" value={vix} onChange={(e) => { setVix(e.target.value); save.reset(); }} />
          <small>用逗号隔开多个阈值，资讯刷新时评估。</small>
        </label>
        <label className="monitor-field">
          <span>52 周回撤关注阈值 (%)</span>
          <input {...FIELDS.updateRules.ddWatchPct} required className="monitor-input" value={drawdown} onChange={(e) => { setDrawdown(e.target.value); save.reset(); }} />
          <small>用于自选筛选，行情刷新时评估预警。</small>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={save.isPending} className="monitor-primary">{save.isPending ? "保存中…" : "保存规则"}</button>
          {save.isSuccess ? <span role="status" className="text-sm text-[var(--dim)]">已保存。行情和资讯分别在下次刷新时评估。</span> : null}
          {save.error ? <span role="alert" className="text-sm text-[var(--up)]">{save.error.message}</span> : null}
        </div>
      </form>
      <Disclosure title="触发与冷却">
        <p className="text-sm leading-6 text-[var(--dim)]">首次观测建立基线。随后跨越阈值时评估是否触发，个股异动、指数与 VIX 冷却 6 小时，回撤类冷却 24 小时。已生成的预警可在首页打开记录。</p>
      </Disclosure>
    </>
  );
}

function SystemTab({ data, openAlerts, openInvesting }: { data: Dashboard; openAlerts: () => void; openInvesting: () => void }) {
  const queryClient = useQueryClient();
  const system = useQuery({ queryKey: ["system-status"], queryFn: () => api.getSystemStatus({}) });
  const test = useMutation({
    mutationFn: () => api.testNotification({}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["system-status"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); },
  });
  const status = system.data;
  const full = status?.tasks[0];
  const expectedDay = data.calendar.lastClosedTradingDay;
  const feedIssues = data.market.filter((item) => Object.hasOwn(MARKET_LABELS, item.key) && (item.value == null || (dataDate(item.asOf) ?? "") < expectedDay));
  const quotes = new Map(data.stocks.map((stock) => [stock.symbol, { price: stock.price, asOf: stock.asOf }]));
  for (const position of data.positions) quotes.set(position.symbol, { price: position.price, asOf: position.quoteAsOf });
  const quoteIssues = [...quotes].flatMap(([symbol, quote]) => {
    const label = quoteLabel(quote.price, quote.asOf, data.calendar);
    return label ? [{ symbol, label }] : [];
  });
  const failed = status?.runs.filter((run) => run.status === "error" || run.status === "partial").slice(0, 3) ?? [];
  return (
    <>
      <Heading title="系统状态"><button type="button" className="monitor-link" onClick={() => system.refetch()}>刷新状态</button></Heading>
      {system.isError ? <p role="alert" className="text-sm text-[var(--up)]">系统状态获取失败。</p> : null}
      <Panel className="monitor-rows">
        <div className="px-4 py-3">
          <p className="text-xs text-[var(--dim)]">最近一次盘后任务</p>
          <p className="mt-1 text-sm font-medium">{system.isPending ? "加载中…" : full?.lastRunAt ? `${statusLabel[full.lastStatus ?? ""] ?? "待核实"} · ${fmtTime(full.lastRunAt)} 北京时间` : "暂无可核实的执行记录"}</p>
          {full?.lastDetail ? <p className="mt-1 text-xs leading-5 text-[var(--dim)]">{full.lastDetail}</p> : null}
        </div>
        <div className="px-4 py-3">
          <p className="text-xs text-[var(--dim)]">数据覆盖</p>
          <p className="mt-1 text-sm">自选与持仓报价待核对 {quoteIssues.length} 项 · 市场指标缺失或日期待核对 {feedIssues.length} 项</p>
          {feedIssues.length ? <p className="mt-1 text-xs text-[var(--dim)]">{feedIssues.map((item) => MARKET_LABELS[item.key]).join("、")}</p> : null}
        </div>
        <div className="px-4 py-3">
          <p className="text-xs text-[var(--dim)]">聊天通知</p>
          <p className="mt-1 text-sm">送达待核实 · 查看 Muse 主助手的任务记录</p>
          <button type="button" className="monitor-link" onClick={openInvesting}>QQ 邮件状态</button>
        </div>
      </Panel>
      {failed.length > 0 ? (
        <section><Heading title="最近异常" />
          <Panel className="monitor-rows">
            {failed.map((run) => <div className="px-4 py-3" key={run.id}><p className="text-sm font-medium">{runLabel[run.kind] ?? run.kind} · {statusLabel[run.status]}</p><p className="mt-1 text-xs text-[var(--dim)]">{fmtTime(run.finishedAt)} · {run.detail}</p></div>)}
          </Panel>
        </section>
      ) : null}
      <Disclosure title="数据来源与时间">
        {quoteIssues.length ? <p className="text-sm text-[var(--dim)]">待核对报价 · {quoteIssues.map((stock) => `${stock.symbol}（${stock.label}）`).join("、")}</p> : null}
        {status?.dataStatus.map((item) => (
          <div className="border-b border-[var(--border)] pb-2 last:border-0 last:pb-0" key={item.name}>
            <p className="text-sm">{item.name} · {item.state}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--dim)]">来源 {item.source || "—"} · 数据时间 {item.quoteAsOf?.length === 10 ? `${item.quoteAsOf} ET` : fmtTime(item.quoteAsOf)} · 最近获取 {fmtTime(item.fetchedAt)} · 最近尝试 {fmtTime(item.lastAttemptAt)}</p>
          </div>
        ))}
      </Disclosure>
      <Disclosure title="任务、执行记录与预警测试">
        {status?.tasks.map((task) => (
          <div className="border-b border-[var(--border)] pb-2" key={task.name}>
            <p className="text-sm">{task.name} · {task.schedule}</p>
            <p className="mt-1 text-xs text-[var(--dim)]">上次成功 {task.lastSuccessAt ? fmtTime(task.lastSuccessAt) : "待核实"} · 下次执行 {task.nextRunAt ? fmtTime(task.nextRunAt) : "待核实"}</p>
          </div>
        ))}
        {status?.runs.map((run) => <p className="text-xs text-[var(--dim)]" key={run.id}>{fmtTime(run.finishedAt)} · {runLabel[run.kind] ?? run.kind} · {statusLabel[run.status] ?? run.status}{run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)} 秒` : ""}{run.detail ? ` · ${run.detail}` : ""}</p>)}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="monitor-secondary" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? "写入中…" : "测试预警写入"}</button>
          <button type="button" className="monitor-link" onClick={openAlerts}>查看预警记录</button>
        </div>
        {test.data ? <p role="status" className="text-sm text-[var(--dim)]">{test.data.message}</p> : null}
        {test.error ? <p role="alert" className="text-sm text-[var(--up)]">{test.error.message}</p> : null}
      </Disclosure>
      <Disclosure title="交易日历">
        <p className="text-sm">美东 {data.calendar.todayET} · {data.calendar.phaseLabel} · 下一交易日 {data.calendar.nextTradingDay}</p>
        {status?.upcomingCalendar.slice(0, 8).map((date) => <p className="text-xs text-[var(--dim)]" key={date.date}>{date.date} ET · {date.label} · {date.type}</p>)}
      </Disclosure>
    </>
  );
}

const TABS = [
  ["overview", "首页"], ["stocks", "自选"], ["positions", "持仓"], ["reports", "报告"],
] as const;

let autoRefreshTried = false;

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(() => new URLSearchParams(window.location.search).get("view") === "investing" ? "investing" : "overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [planSymbol, setPlanSymbol] = useState<string | null>(null);
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const refresh = useMutation({
    mutationFn: (force: boolean) => api.refreshMarket({ force }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["dashboard"] }); queryClient.invalidateQueries({ queryKey: ["system-status"] }); },
  });
  const data = dash.data;
  useEffect(() => {
    if (!data || autoRefreshTried) return;
    autoRefreshTried = true;
    const elapsed = Date.now() - Date.parse(data.lastMarketUpdate ?? "");
    if (!data.lastMarketUpdate || (data.calendar.phase === "open" && elapsed > 15 * 60 * 1000)) refresh.mutate(false);
  }, [data, refresh.mutate]);

  function navigate(next: Tab) {
    setTab(next);
    setSelected(null);
    window.scrollTo({ top: 0 });
  }
  function openStock(symbol: string) {
    if (!data?.stocks.some((stock) => stock.symbol === symbol)) return;
    setSelected(symbol);
    setTab("stocks");
    window.scrollTo({ top: 0 });
  }
  function openPlan(symbol: string | null = null) {
    setPlanSymbol(symbol);
    navigate("plan");
  }
  const activeTab = tab === "news" ? "stocks" : ["alerts", "investing", "plan"].includes(tab) ? "overview" : tab;
  return (
    <div className="monitor-app">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="monitor-header pt-safe">
        <div className="monitor-width flex min-h-14 items-center gap-3">
          <h1 className="mr-1 min-w-0 flex-1 text-base font-semibold sm:flex-none">美股监控</h1>
          <nav className="monitor-nav" aria-label="主要页面">
            {TABS.map(([value, label]) => (
              <button type="button" key={value} aria-current={activeTab === value ? "page" : undefined} onClick={() => navigate(value)}>{label}</button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="monitor-secondary" disabled={refresh.isPending} onClick={() => refresh.mutate(true)}>{refresh.isPending ? "刷新中…" : "刷新行情"}</button>
            <details className="monitor-settings" key={tab}>
              <summary className="monitor-secondary">设置</summary>
              <div className="monitor-panel monitor-settings-menu">
                <button type="button" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); navigate("rules"); }}>监控规则</button>
                <button type="button" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); navigate("system"); }}>系统状态</button>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main className="monitor-width monitor-content">
        {refresh.error || refresh.data?.failed.length ? <p role="alert" className="text-sm text-[var(--up)]">{refresh.error?.message ?? `行情获取失败 · ${refresh.data?.failed.join("、")}`}</p> : null}
        {!refresh.data?.failed.length && refresh.data?.warnings.length ? (
          <p className="text-xs text-[var(--dim)]">日线或前收待核对 · {refresh.data.warnings.join("、")}</p>
        ) : null}
        {dash.isPending ? <Empty>正在加载监控数据…</Empty> : dash.isError && !data ? (
          <Empty><button type="button" className="monitor-link" onClick={() => dash.refetch()}>数据加载失败，重试</button></Empty>
        ) : data ? (
          <>
            {tab === "overview" ? <Overview data={data} openStock={openStock} openAlerts={() => navigate("alerts")} openEvents={() => navigate("news")} openSystem={() => navigate("system")} openInvesting={() => navigate("investing")} /> : null}
            {tab === "stocks" ? <StocksTab data={data} selected={selected} setSelected={(symbol) => { setSelected(symbol); window.scrollTo({ top: 0 }); }} openEvents={() => navigate("news")} openPlan={openPlan} /> : null}
            {tab === "investing" ? <InvestmentCenter openPlan={() => openPlan()} /> : null}
            {tab === "plan" ? <InvestmentPlanEditor symbol={planSymbol} onBack={() => navigate("investing")} /> : null}
            {tab === "positions" ? <PositionsTab data={data} openStock={openStock} /> : null}
            {tab === "reports" ? <ReportsTab data={data} /> : null}
            {tab === "news" ? <NewsTab data={data} onBack={() => navigate("stocks")} /> : null}
            {tab === "alerts" ? <AlertsTab data={data} openStock={openStock} onBack={() => navigate("overview")} /> : null}
            {tab === "rules" ? <RulesTab data={data} /> : null}
            {tab === "system" ? <SystemTab data={data} openAlerts={() => navigate("alerts")} openInvesting={() => navigate("investing")} /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
