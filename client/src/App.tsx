import { useEffect, useRef, useState, type FormEvent } from "react";
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
const pnlColor = (v: number | null | undefined) =>
  v == null ? "text-[var(--dim)]" : v > 0 ? "text-[var(--up)]" : v < 0 ? "text-[var(--down)]" : "text-[var(--dim)]";

const TIER_LABELS = ["", "轻度回调", "开始关注", "重点研究", "深度回调", "重大回撤"];
const TIER_THRESHOLDS = [0, 5, 10, 15, 20, 30];
const GRP_LABELS: Record<string, string> = { core: "核心长期", opportunity: "机会观察", custom: "自定义" };

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

// ---------- 小组件 ----------

// 走势小图：独占一行、全宽、固定高度（44px），与任何文字分离，永不重叠
function Spark({ data, up }: { data: number[]; up: boolean }) {
  if (data.length < 2) return <span className="flex h-11 items-center text-xs text-[var(--dim)]">走势数据积累中</span>;
  const w = 300;
  const h = 44;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / range) * (h - 8)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" className="block h-11 w-full">
      <polyline points={pts} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TierBadge({ tier }: { tier: number }) {
  if (tier <= 0) return null;
  const cls =
    tier >= 4
      ? "bg-[var(--up)] text-white"
      : tier >= 3
        ? "bg-[var(--accent)] text-black"
        : "bg-[var(--surface2)] text-[var(--dim)] border border-[var(--border)]";
  return (
    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {TIER_LABELS[tier]} ≥{TIER_THRESHOLDS[tier]}%
    </span>
  );
}

function SectionTitle({ children, extra }: { children: string; extra?: string }) {
  return (
    <div className="mb-2 mt-6 flex items-baseline justify-between gap-3 first:mt-0">
      <h2 className="shrink-0 text-base font-semibold text-[var(--text)]">{children}</h2>
      {extra ? <span className="min-w-0 text-right text-xs text-[var(--dim)]">{extra}</span> : null}
    </div>
  );
}

// 极简 Markdown 渲染（标题/列表/加粗/段落），用于报告正文
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

function MarketStatusBanner({ data }: { data: Dashboard }) {
  const c = data.calendar;
  const quoteAsOf = data.stocks.reduce<string | null>((acc, s) => (s.asOf && (!acc || s.asOf > acc) ? s.asOf : acc), null);
  return (
    <div className="mb-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`rounded px-2 py-0.5 text-sm font-semibold ${c.phase === "open" ? "bg-[var(--down)] text-white" : c.phase === "closed" ? "bg-[var(--surface2)] text-[var(--dim)]" : "bg-[var(--accent)] text-black"}`}>
          当前：{c.phaseLabel}
        </span>
        <span className="text-sm text-[var(--text)]">美东 {c.todayET}{c.earlyClose ? ` · 提前收盘 ${c.closeTimeET} ET（${c.earlyCloseNote ?? ""}）` : ""}</span>
        <span className="text-xs text-[var(--dim)]">{c.dstLabel} · 交易时段 {c.beijingSession}</span>
      </div>
      <div className="num mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-[var(--dim)] sm:grid-cols-3">
        <span>最近有效交易日：{c.lastTradingDay}{c.nextTradingDay !== c.lastTradingDay ? ` · 下一交易日：${c.nextTradingDay}` : ""}</span>
        <span>行情时间（报价 asOf）：{quoteAsOf ? `${fmtTime(quoteAsOf)}（北京时间）` : "尚未刷新"}</span>
        <span>数据获取时间：{data.lastMarketUpdate ? `${fmtTime(data.lastMarketUpdate)}（北京时间）` : "尚未刷新"}</span>
      </div>
    </div>
  );
}

function Overview({ data, goTab }: { data: Dashboard; goTab: (t: string) => void }) {
  const sorted = [...data.stocks].filter((s) => s.changePct != null).sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  const movers = sorted.slice(0, 5);
  const totalPnl = data.positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const totalValue = data.positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
  return (
    <div>
      <MarketStatusBanner data={data} />
      <SectionTitle extra="数值旁标注数据时间；不可用表示数据源未提供">市场风险指标</SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {data.market.map((m) => (
          <div key={m.key} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="text-xs text-[var(--dim)]">{m.label}</div>
            <div className="num mt-1 text-2xl font-semibold text-[var(--text)]">
              {m.value == null ? "不可用" : m.key === "TNX10Y" ? `${m.value.toFixed(2)}%` : fmtNum(m.value, m.key === "FEAR_GREED" ? 0 : 2)}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs">
              {m.changePct != null ? <span className={`num ${chgColor(m.changePct)}`}>{fmtPct(m.changePct)}</span> : null}
              {m.note ? <span className="text-[var(--dim)]">{m.note}</span> : null}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--dim)]">
              {m.value != null
                ? <>{m.asOf ? `数据日期 ${m.asOf.length > 10 ? fmtTime(m.asOf) : m.asOf} · ` : ""}{m.source || "尚未刷新"}{m.fetchedAt ? ` · 获取于 ${fmtTime(m.fetchedAt)}` : ""}</>
                : <>来源：{m.source || "公开来源提炼"} · 最后尝试：{m.lastAttemptAt ? fmtTime(m.lastAttemptAt) : "尚未尝试"}（取不到不编造）</>}
            </div>
          </div>
        ))}
      </div>

      {data.positions.length > 0 ? (
        <>
          <SectionTitle>持仓概览</SectionTitle>
          <button
            type="button"
            onClick={() => goTab("positions")}
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-[var(--dim)]">总市值</span>
              <span className="num text-lg font-semibold text-[var(--text)]">{fmtMoney(totalValue)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-sm text-[var(--dim)]">浮动盈亏</span>
              <span className={`num text-lg font-semibold ${pnlColor(totalPnl)}`}>
                {totalPnl >= 0 ? "+" : ""}{fmtMoney(totalPnl)}
              </span>
            </div>
          </button>
        </>
      ) : null}

      <SectionTitle extra={data.lastMarketUpdate ? `行情更新于 ${fmtTime(data.lastMarketUpdate)}（北京时间）` : "尚未刷新行情"}>今日异动</SectionTitle>
      {movers.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
          暂无行情数据。点击右上角「刷新行情」获取第一批真实数据。
        </p>
      ) : (
        <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {movers.map((s) => (
            <div key={s.symbol} className="flex items-center justify-between gap-2 px-3 py-2.5">
              <div className="flex min-w-0 flex-wrap items-baseline">
                <span className="num whitespace-nowrap font-semibold text-[var(--text)]">{s.symbol}</span>
                <span className="ml-2 text-base text-[var(--dim)]">{displayName(s.symbol, s.name)}</span>
              </div>
              <div className="shrink-0 whitespace-nowrap text-right">
                <span className="num text-[var(--text)]">${fmtPrice(s.price)}</span>
                <span className={`num ml-2 ${chgColor(s.changePct)}`}>{fmtPct(s.changePct)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>最新预警</SectionTitle>
      {data.alerts.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无预警记录。刷新行情后，系统会按监控规则自动评估并在此留痕（同一事件同一交易日不重复）。</p>
      ) : (
        <div className="space-y-2">
          {data.alerts.slice(0, 5).map((a) => (
            <div key={a.id} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-sm font-medium text-[var(--text)]">{a.title}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${a.level === "critical" ? "bg-[var(--up)] text-white" : a.level === "warn" ? "bg-[var(--accent)] text-black" : "bg-[var(--surface2)] text-[var(--dim)]"}`}>
                  {a.level === "critical" ? "严重" : a.level === "warn" ? "警告" : "提示"}
                </span>
              </div>
              {a.detail ? <p className="mt-1 text-xs leading-5 text-[var(--dim)]">{a.detail}</p> : null}
              <p className="mt-1 text-xs text-[var(--dim)]">{fmtTime(a.createdAt)}（北京时间）</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 行情 ----------

function StockDetail({ stock, onClose }: { stock: Stock; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["symbol-detail", stock.symbol],
    queryFn: () => api.getSymbolDetail({ symbol: stock.symbol }),
  });
  const bars = detail.data?.bars ?? [];
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-start justify-between">
        <div>
          <span className="num whitespace-nowrap text-lg font-bold text-[var(--text)]">{stock.symbol}</span>
          <span className="ml-2 text-lg text-[var(--dim)]">{displayName(stock.symbol, stock.name)}</span>
          <div className="mt-0.5 text-xs text-[var(--dim)]">
            {GRP_LABELS[stock.grp]} · {stock.marketStatus ? `市场状态：${stock.marketStatus}` : ""} {stock.asOf ? `· 行情时间 ${fmtTime(stock.asOf)}` : ""}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="收起详情" className="rounded border border-[var(--border)] px-2 text-sm text-[var(--dim)]">收起</button>
      </div>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="num text-3xl font-semibold text-[var(--text)]">${fmtPrice(stock.price)}</span>
        <span className={`num text-base ${chgColor(stock.changePct)}`}>{fmtPct(stock.changePct)}</span>
        <span className={`num text-sm ${chgColor(stock.change)}`}>{stock.change == null ? "" : `${stock.change > 0 ? "+" : ""}${stock.change.toFixed(2)}`}</span>
      </div>

      {detail.isPending ? (
        <p className="mt-3 text-sm text-[var(--dim)]">正在加载近一年走势…</p>
      ) : bars.length >= 2 ? (
        <div className="mt-3 h-44 w-full" aria-label={`${stock.symbol} 近一年收盘价走势图`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--dim)" }} minTickGap={60} tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "var(--dim)" }} width={44} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip
                formatter={(v) => [`$${fmtPrice(typeof v === "number" ? v : null)}`, "收盘"]}
                labelFormatter={(d) => `日期 ${String(d)}`}
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }}
              />
              <Area type="monotone" dataKey="close" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.15} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="mt-3 text-sm text-[var(--dim)]">历史走势数据不足，刷新行情后自动积累。</p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2 text-center min-[480px]:grid-cols-3 sm:grid-cols-4">
        {[
          ["日高 / 日低", stock.dayHigh != null || stock.dayLow != null ? `$${fmtPrice(stock.dayHigh)} / $${fmtPrice(stock.dayLow)}` : "不可用"],
          ["52周高 / 低", stock.week52High != null || stock.week52Low != null ? `$${fmtPrice(stock.week52High)} / $${fmtPrice(stock.week52Low)}` : "不可用"],
          ["52周高日期", stock.week52HighDate ?? "—"],
          ["52周低日期", stock.week52LowDate ?? "—"],
          ["距52周高回撤", fmtDd(stock.dd52)],
          ["距20日高回撤", fmtDd(stock.dd20)],
          ["距60日高回撤", fmtDd(stock.dd60)],
          ["MA20", stock.ma20 == null ? "不可用" : `$${fmtPrice(stock.ma20)}`],
          ["MA50", stock.ma50 == null ? "不可用" : `$${fmtPrice(stock.ma50)}`],
          ["MA200", stock.ma200 == null ? "不可用" : `$${fmtPrice(stock.ma200)}`],
          ["RSI(14)", fmtNum(stock.rsi14, 1)],
          ["市值", fmtMoney(stock.marketCap)],
          ["Beta", fmtNum(stock.beta, 2)],
          ["回撤等级", stock.tier > 0 ? (TIER_LABELS[stock.tier] ?? "") : "无"],
        ].map(([k, v]) => (
          <div key={k} className="rounded bg-[var(--surface2)] px-1 py-2">
            <dt className="text-xs text-[var(--dim)]">{k}</dt>
            <dd className="num mt-0.5 text-sm font-medium text-[var(--text)]">{v}</dd>
          </div>
        ))}
      </dl>

      {detail.data && detail.data.earnings.length > 0 ? (
        <div className="mt-3">
          <h4 className="text-sm font-semibold text-[var(--text)]">财报日期</h4>
          <ul className="mt-1 space-y-1 text-sm text-[var(--dim)]">
            {detail.data.earnings.map((e) => (
              <li key={e.id}>{e.reportDate}{e.timing ? ` · ${e.timing}` : ""}{e.epsEst ? ` · 预期EPS ${e.epsEst}` : ""}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.data && detail.data.news.length > 0 ? (
        <div className="mt-3">
          <h4 className="text-sm font-semibold text-[var(--text)]">相关新闻</h4>
          <ul className="mt-1 space-y-1.5">
            {detail.data.news.map((n) => (
              <li key={n.id} className="text-sm">
                <a href={n.url} target="_blank" rel="noreferrer" className="text-[var(--text)] underline decoration-[var(--border)] underline-offset-2">{n.title}</a>
                <span className="ml-2 text-xs text-[var(--dim)]">{n.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-5 text-[var(--dim)]">
        52 周高/低口径：由该标的自身近 252 个交易日日K（最高/最低价）并入当日行情高/低后确定性计算，与日线同一数据源、同一复权口径；GOOG（C 类）与 GOOGL（A 类）分别计算、绝不混用。日期为极值出现的交易日。
      </p>
      <p className="mt-1 text-xs leading-5 text-[var(--dim)]">
        估值分位（历史 PE 分位）暂不可用：当前免费数据源不提供历史估值序列，报告中会明确标注，不做估算。
      </p>
    </div>
  );
}

function StocksTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newSymbol, setNewSymbol] = useState("");
  const [formError, setFormError] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const addSymbol = useMutation({
    mutationFn: (symbol: string) => api.addSymbol({ symbol }),
    onSuccess: () => { setNewSymbol(""); setFormError(""); invalidate(); },
    onError: (e) => setFormError(e instanceof Error ? e.message : "添加失败"),
  });
  const removeSymbol = useMutation({
    mutationFn: (symbol: string) => api.removeSymbol({ symbol }),
    onSuccess: invalidate,
  });
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    const s = newSymbol.trim().toUpperCase();
    if (!s) { setFormError("请输入股票代码"); return; }
    addSymbol.mutate(s);
  };
  const groups: [string, string][] = [["core", "核心长期投资"], ["opportunity", "重点机会观察"], ["custom", "自定义标的"]];
  return (
    <div>
      <form onSubmit={submitAdd} className="flex gap-2">
        <input
          {...FIELDS.addSymbol.symbol}
          aria-label="新股票代码"
          placeholder="输入代码，如 TSLA"
          value={newSymbol}
          onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
          className="num min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)]"
        />
        <button type="submit" disabled={addSymbol.isPending} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 font-medium text-black disabled:opacity-50">
          {addSymbol.isPending ? "验证中…" : "添加标的"}
        </button>
      </form>
      {formError ? <p className="mt-1 text-sm text-[var(--up)]">{formError}</p> : null}
      <p className="mt-1 text-xs leading-5 text-[var(--dim)]">移除标的将一并删除该标的的行情快照、技术指标与日线历史（不可恢复）；历史预警、新闻、财报记录与持仓不受影响。所有历史行情、预警、报告与运行记录都持久化保存在数据库中，刷新或重启不丢失。</p>

      {groups.map(([grp, label]) => {
        const rows = data.stocks.filter((s) => s.grp === grp);
        if (rows.length === 0) return null;
        return (
          <div key={grp}>
            <SectionTitle>{label}</SectionTitle>
            <div className="space-y-2">
              {rows.map((s) => (
                <div key={s.symbol}>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
                    {/* 第一行：代码（完整不截断）+ 中文名 + 回撤徽章 + 价格 + 涨跌幅 + 移除；空间不足时整组换行，绝不截断代码 */}
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => setSelected(selected === s.symbol ? null : s.symbol)}
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-left"
                        aria-label={`查看 ${s.symbol} 详情`}
                      >
                        <span className="num whitespace-nowrap text-base font-semibold text-[var(--text)]">{s.symbol}</span>
                        <span className="whitespace-nowrap text-base text-[var(--dim)]">{displayName(s.symbol, s.name)}</span>
                        <TierBadge tier={s.tier} />
                        <span className="ml-auto flex items-baseline gap-2 whitespace-nowrap">
                          <span className="num text-base text-[var(--text)]">${fmtPrice(s.price)}</span>
                          <span className={`num text-sm ${chgColor(s.changePct)}`}>{fmtPct(s.changePct)}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`移除 ${s.symbol}`}
                        onClick={() => removeSymbol.mutate(s.symbol)}
                        className="shrink-0 rounded border border-[var(--border)] px-2 text-sm text-[var(--dim)]"
                      >
                        移除
                      </button>
                    </div>
                    {/* 第二行：走势图独占一行，固定高度，与文字彻底分离 */}
                    <button
                      type="button"
                      onClick={() => setSelected(selected === s.symbol ? null : s.symbol)}
                      aria-label={`查看 ${s.symbol} 详情`}
                      className="mt-1.5 block w-full px-1"
                    >
                      <Spark data={s.spark} up={(s.changePct ?? 0) >= 0} />
                    </button>
                    {/* 第三行：指标文字，标签在上、数值在下，各占独立格子 */}
                    <div className="mt-1.5 grid grid-cols-3 gap-2 border-t border-[var(--border)] pt-2 text-center">
                      <div>
                        <div className="text-xs text-[var(--dim)]">RSI(14)</div>
                        <div className="num mt-0.5 text-sm font-medium text-[var(--text)]">{fmtNum(s.rsi14, 0)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-[var(--dim)]">距52周高回撤</div>
                        <div className="num mt-0.5 text-sm font-medium text-[var(--text)]">{fmtDd(s.dd52)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-[var(--dim)]">MA20</div>
                        <div className="num mt-0.5 text-sm font-medium text-[var(--text)]">{s.ma20 == null ? "—" : `$${fmtPrice(s.ma20)}`}</div>
                      </div>
                    </div>
                  </div>
                  {selected === s.symbol ? (
                    <div className="mt-2">
                      <StockDetail stock={s} onClose={() => setSelected(null)} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 回撤与机会 ----------

function refZone(s: Stock): string {
  if (s.price == null) return "价格不可用";
  const lo = Math.min(s.ma50 ?? s.price, s.price);
  const hi = Math.max(s.ma20 ?? s.price, s.price);
  if (s.ma20 == null && s.ma50 == null) return "均线数据积累中，暂不给区间";
  return `$${fmtPrice(lo)} – $${fmtPrice(hi)}（MA50 / MA20 参考带）`;
}

function OpportunitiesTab({ data }: { data: Dashboard }) {
  const board = [...data.stocks].filter((s) => s.dd52 != null).sort((a, b) => (b.dd52 ?? 0) - (a.dd52 ?? 0));
  const opps = board.filter((s) => s.tier >= 2 || (s.rsi14 != null && s.rsi14 <= 35));
  return (
    <div>
      <SectionTitle extra="按距52周高点回撤排序">回撤排行榜</SectionTitle>
      {board.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无回撤数据，刷新行情后生成。</p>
      ) : (
        <div className="space-y-2">
          {board.map((s, i) => (
            <div key={s.symbol} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-baseline">
                  <span className="num text-[var(--dim)]">{i + 1}. </span>
                  <span className="num whitespace-nowrap font-semibold text-[var(--text)]">{s.symbol}</span>
                  <span className="ml-2 text-base text-[var(--dim)]">{displayName(s.symbol, s.name)}</span>
                </div>
                <span className="num whitespace-nowrap text-lg font-semibold text-[var(--down)]">{fmtDd(s.dd52)}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded bg-[var(--surface2)]">
                <div className="h-full bg-[var(--down)]" style={{ width: `${Math.min(100, s.dd52 ?? 0)}%` }} />
              </div>
              <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                <span>现价 ${fmtPrice(s.price)}</span>
                <span>20日回撤 {fmtDd(s.dd20)}</span>
                <span>60日回撤 {fmtDd(s.dd60)}</span>
                <span>RSI {fmtNum(s.rsi14, 1)}</span>
                <span>52周高 ${fmtPrice(s.week52High)}</span>
              </div>
              <div className="mt-2"><TierBadge tier={s.tier} /></div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle extra="回撤≥10% 或 RSI≤35 进入研究清单">潜在投资机会（研究清单）</SectionTitle>
      {opps.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">当前没有标的触发回撤关注阈值或超卖条件。这不代表市场没有机会，只表示监控规则尚未触发。</p>
      ) : (
        <div className="space-y-2">
          {opps.map((s) => (
            <div key={s.symbol} className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="num font-semibold text-[var(--text)]"><span className="whitespace-nowrap">{s.symbol}</span> <span className="ml-1 text-base font-normal text-[var(--dim)]">{displayName(s.symbol, s.name)}</span></span>
                <TierBadge tier={s.tier} />
              </div>
              <dl className="mt-2 space-y-1.5 text-sm leading-6 text-[var(--text)]">
                <div><dt className="inline font-medium">分析依据：</dt><dd className="inline">距52周高回撤 {s.dd52?.toFixed(1)}%，RSI(14) {fmtNum(s.rsi14, 1)}，现价相对 MA200 {s.ma200 != null && s.price != null ? `${s.price >= s.ma200 ? "上方" : "下方"}（MA200 $${fmtPrice(s.ma200)}）` : "不可用"}。</dd></div>
                <div><dt className="inline font-medium">下跌类型判断：</dt><dd className="inline">需结合「资讯」页新闻与每日报告逐项区分——市场情绪 / 宏观 / 行业周期 / 基本面恶化 / 估值回归。证据不足时不下结论，回撤本身不等于买入机会。</dd></div>
                <div><dt className="inline font-medium">参考价格区间：</dt><dd className="num inline">{refZone(s)}</dd></div>
                <div><dt className="inline font-medium">分批建仓框架（通用方法，非个性化建议）：</dt><dd className="inline">分 3 批——现价附近试探 1/3；再回撤约 5% 加 1/3；再回撤约 10% 或 RSI 跌破 30 时加最后 1/3。每批执行前先复核基本面是否恶化。</dd></div>
                <div><dt className="inline font-medium">主要风险：</dt><dd className="inline">下跌可能源于基本面恶化而非情绪；财报与指引变化、行业周期下行、估值继续回归均可能使「便宜」变得更便宜。</dd></div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 持仓 ----------

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
    if (!(Number(cost) >= 0)) { setError("成本价不能为负"); return; }
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

function PositionsTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => api.deletePosition({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const totalValue = data.positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
  const totalCost = data.positions.reduce((s, p) => s + p.cost * p.shares, 0);
  const totalPnl = data.positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const concentrated = data.positions.filter((p) => (p.weightPct ?? 0) >= 40);
  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {[
          ["总市值", fmtMoney(totalValue)],
          ["总成本", fmtMoney(totalCost)],
          ["浮动盈亏", `${totalPnl >= 0 ? "+" : ""}${fmtMoney(totalPnl)}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-center">
            <div className="text-xs text-[var(--dim)]">{k}</div>
            <div className={`num mt-1 text-base font-semibold ${k === "浮动盈亏" ? pnlColor(totalPnl) : "text-[var(--text)]"}`}>{v}</div>
          </div>
        ))}
      </div>
      {concentrated.length > 0 ? (
        <p className="mt-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] p-3 text-sm text-[var(--text)]">
          集中度提示：{concentrated.map((p) => `${p.symbol} 占持仓 ${p.weightPct?.toFixed(1)}%`).join("；")}，单一标的占比偏高，请评估是否符合你的风险承受能力。
        </p>
      ) : null}

      <SectionTitle>持仓明细</SectionTitle>
      {data.positions.length === 0 && !showForm ? (
        <p className="text-sm leading-6 text-[var(--dim)]">
          尚未录入持仓。录入数量、成本价与投资周期后，这里会自动计算浮动盈亏、持仓占比、期间最高价与自高点回撤；长期核心与短中期持仓使用不同的回撤评估阈值（25% / 15%）。
        </p>
      ) : null}
      <div className="space-y-2">
        {data.positions.map((p) =>
          editing === p.id ? (
            <PositionForm key={p.id} initial={p} onDone={() => setEditing(null)} />
          ) : (
            <div key={p.id} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="num whitespace-nowrap font-semibold text-[var(--text)]">{p.symbol}</span>
                  <span className="ml-2 whitespace-nowrap rounded bg-[var(--surface2)] px-1.5 py-0.5 text-xs text-[var(--dim)]">{p.horizon === "long" ? "长期核心" : "短中期"}</span>
                </div>
                <span className={`num whitespace-nowrap font-semibold ${pnlColor(p.pnl)}`}>
                  {p.pnl == null ? "盈亏不可用" : `${p.pnl >= 0 ? "+" : ""}${fmtMoney(p.pnl)}（${fmtPct(p.pnlPct)}）`}
                </span>
              </div>
              <dl className="num mt-2 grid grid-cols-3 gap-x-2 gap-y-1 text-xs text-[var(--dim)] sm:grid-cols-6">
                <div>数量 <span className="text-[var(--text)]">{p.shares}</span></div>
                <div>成本 <span className="text-[var(--text)]">${fmtPrice(p.cost)}</span></div>
                <div>现价 <span className="text-[var(--text)]">${fmtPrice(p.price)}</span></div>
                <div>市值 <span className="text-[var(--text)]">{fmtMoney(p.marketValue)}</span></div>
                <div>占比 <span className="text-[var(--text)]">{p.weightPct == null ? "—" : `${p.weightPct.toFixed(1)}%`}</span></div>
                <div>距期间高点 <span className="text-[var(--text)]">{p.ddFromPeak == null ? "—" : `-${p.ddFromPeak.toFixed(1)}%`}</span></div>
              </dl>
              {p.note ? <p className="mt-1.5 text-xs text-[var(--dim)]">备注：{p.note}</p> : null}
              <p className="mt-1.5 text-xs leading-5 text-[var(--dim)]">
                参考评估：{p.horizon === "long"
                  ? "长期核心持仓——正常波动不触发卖出建议；仅当基本面恶化、估值极端或自高点回撤≥25% 时提示重新评估。"
                  : "短中期持仓——自期间最高价回撤≥15% 时提示评估分批止盈或减仓。"}以上为规则化参考，非买卖指令。
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setEditing(p.id)} className="rounded border border-[var(--border)] px-3 text-sm text-[var(--text)]">编辑</button>
                <button type="button" onClick={() => del.mutate(p.id)} className="rounded border border-[var(--border)] px-3 text-sm text-[var(--dim)]">删除</button>
              </div>
            </div>
          ),
        )}
      </div>
      {showForm ? (
        <div className="mt-3"><PositionForm onDone={() => setShowForm(false)} /></div>
      ) : (
        <button type="button" onClick={() => setShowForm(true)} className="mt-3 w-full rounded-[var(--radius)] bg-[var(--accent)] py-2.5 font-medium text-black">+ 录入持仓</button>
      )}
    </div>
  );
}

// ---------- 资讯（新闻 + 财报日历） ----------

function NewsTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState("");
  const [date, setDate] = useState("");
  const [timing, setTiming] = useState("");
  const [eps, setEps] = useState("");
  const [error, setError] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const addEarn = useMutation({
    mutationFn: () => api.addEarnings({ symbol: symbol.trim().toUpperCase(), reportDate: date, timing, epsEst: eps, note: "" }),
    onSuccess: () => { setSymbol(""); setDate(""); setTiming(""); setEps(""); setError(""); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : "添加失败"),
  });
  const delEarn = useMutation({ mutationFn: (id: number) => api.deleteEarnings({ id }), onSuccess: invalidate });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!symbol.trim()) { setError("请输入代码"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError("日期格式应为 YYYY-MM-DD"); return; }
    addEarn.mutate();
  };
  const inputCls = "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)]";
  return (
    <div>
      <SectionTitle extra="来自公开网页搜索提炼，附原文链接">重大新闻</SectionTitle>
      {data.news.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无新闻。点击顶部「刷新资讯」从公开来源获取监控标的相关重大新闻。</p>
      ) : (
        <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {data.news.map((n) => (
            <div key={n.id} className="px-3 py-2.5">
              <a href={n.url} target="_blank" rel="noreferrer" className="text-sm leading-6 text-[var(--text)] underline decoration-[var(--border)] underline-offset-2">{n.title}</a>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-[var(--dim)]">
                <span>{n.source || "未知来源"}</span>
                {n.publishedAt ? <span>{n.publishedAt}</span> : null}
                {n.symbols ? <span className="num">涉及：{n.symbols}</span> : <span>大盘/宏观</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle extra="日期来自公开财报日历，可能调整，请以公司公告为准">财报日历</SectionTitle>
      {data.earnings.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无财报记录。刷新资讯会自动提取监控标的的未来财报日期，也可以手动添加。</p>
      ) : (
        <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {data.earnings.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <span className="num whitespace-nowrap font-semibold text-[var(--text)]">{e.symbol}</span>
                <span className="num ml-3 text-sm text-[var(--text)]">{e.reportDate}</span>
                {e.timing ? <span className="ml-2 text-xs text-[var(--dim)]">{e.timing}</span> : null}
                {e.epsEst ? <span className="num ml-2 text-xs text-[var(--dim)]">预期EPS {e.epsEst}</span> : null}
                <div className="text-xs text-[var(--dim)]">{e.source ?? ""}{e.note ? ` · ${e.note}` : ""}</div>
              </div>
              <button type="button" aria-label={`删除 ${e.symbol} 财报记录`} onClick={() => delEarn.mutate(e.id)} className="shrink-0 rounded border border-[var(--border)] px-2 text-sm text-[var(--dim)]">删除</button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
        <input {...FIELDS.addEarnings.symbol} aria-label="财报股票代码" placeholder="代码" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className={`num w-24 ${inputCls}`} />
        <input {...FIELDS.addEarnings.reportDate} aria-label="财报日期" placeholder="YYYY-MM-DD" value={date} onChange={(e) => setDate(e.target.value)} className={`num w-36 ${inputCls}`} />
        <input {...FIELDS.addEarnings.timing} aria-label="财报时点" placeholder="盘前/盘后" value={timing} onChange={(e) => setTiming(e.target.value)} className={`w-24 ${inputCls}`} />
        <input {...FIELDS.addEarnings.epsEst} aria-label="预期EPS" placeholder="预期EPS" value={eps} onChange={(e) => setEps(e.target.value)} className={`num w-28 ${inputCls}`} />
        <button type="submit" disabled={addEarn.isPending} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 font-medium text-black disabled:opacity-50">添加财报</button>
      </form>
      {error ? <p className="mt-1 text-sm text-[var(--up)]">{error}</p> : null}
    </div>
  );
}

// ---------- 报告 + 预警历史 ----------

function ReportsTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<number | null>(null);
  const [genError, setGenError] = useState("");
  const report = useQuery({
    queryKey: ["report", openId],
    queryFn: () => api.getReport({ id: openId ?? 0 }),
    enabled: openId != null,
  });
  const gen = useMutation({
    mutationFn: (kind: "daily" | "weekly") => api.generateReport({ kind }),
    onSuccess: (r) => { setGenError(""); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); setOpenId(r.id); },
    onError: (e) => setGenError(e instanceof Error ? e.message : "生成失败，请先刷新行情"),
  });
  const delAlert = useMutation({
    mutationFn: (id: number) => api.deleteAlert({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={gen.isPending} onClick={() => gen.mutate("daily")} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-black disabled:opacity-50">
          {gen.isPending ? "生成中…" : "生成今日日报"}
        </button>
        <button type="button" disabled={gen.isPending} onClick={() => gen.mutate("weekly")} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-[var(--text)] disabled:opacity-50">
          生成周报
        </button>
      </div>
      {genError ? <p className="mt-1 text-sm text-[var(--up)]">{genError}</p> : null}
      <p className="mt-2 text-xs leading-5 text-[var(--dim)]">
        报告由已存储的真实行情、指标、新闻与持仓数据生成，区分事实与分析判断；定时任务在每个美股交易日盘后 05:30（北京时间，冬令时）自动生成日报，周五另生成周报。若 AI 生成失败，报告会自动降级为事实汇总并在正文与运行记录中写明失败原因，不会静默为空。
      </p>

      <SectionTitle>历史报告</SectionTitle>
      {data.reports.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无报告。先刷新行情与资讯，再生成第一份日报。</p>
      ) : (
        <div className="space-y-2">
          {data.reports.map((r) => (
            <div key={r.id} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
              <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left" aria-label={`查看 ${r.title}`}>
                <span className="min-w-0 text-sm font-medium text-[var(--text)]">
                  <span className="mr-2 rounded bg-[var(--surface2)] px-1.5 py-0.5 text-xs text-[var(--dim)]">{r.kind === "daily" ? "日报" : "周报"}</span>
                  {r.title}
                </span>
                <span className="shrink-0 text-xs text-[var(--dim)]">{fmtTime(r.createdAt)}</span>
              </button>
              {openId === r.id ? (
                <div className="border-t border-[var(--border)] px-3 py-2">
                  {report.isPending ? <p className="text-sm text-[var(--dim)]">加载中…</p> : report.data ? <MdLite text={report.data.content} /> : <p className="text-sm text-[var(--dim)]">报告内容不可用</p>}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <SectionTitle>历史预警记录</SectionTitle>
      {data.alerts.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无预警。</p>
      ) : (
        <div className="space-y-2">
          {data.alerts.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div>
                <div className="text-sm font-medium text-[var(--text)]">{a.title}</div>
                {a.detail ? <p className="mt-0.5 text-xs leading-5 text-[var(--dim)]">{a.detail}</p> : null}
                <p className="mt-0.5 text-xs text-[var(--dim)]">{fmtTime(a.createdAt)}（北京时间）</p>
              </div>
              <button type="button" aria-label="删除该预警" onClick={() => delAlert.mutate(a.id)} className="shrink-0 rounded border border-[var(--border)] px-2 text-sm text-[var(--dim)]">删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 规则与系统状态 ----------

function RulesTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [movePct, setMovePct] = useState(String(data.rules.movePct));
  const [indexDrop, setIndexDrop] = useState(String(data.rules.indexDropPct));
  const [vixLevels, setVixLevels] = useState(data.rules.vixLevels);
  const [ddWatch, setDdWatch] = useState(String(data.rules.ddWatchPct));
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => api.updateRules({ movePct: Number(movePct), indexDropPct: Number(indexDrop), vixLevels, ddWatchPct: Number(ddWatch) }),
    onSuccess: () => { setMsg("规则已保存，下次刷新行情时生效"); setError(""); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); },
    onError: (e) => { setError(e instanceof Error ? e.message : "保存失败"); setMsg(""); },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!(Number(movePct) > 0) || !(Number(indexDrop) > 0) || !(Number(ddWatch) > 0)) { setError("阈值必须为正数"); return; }
    save.mutate();
  };
  const inputCls = "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)]";
  const kindLabels: Record<string, string> = { market: "行情刷新", news: "资讯刷新", report: "报告生成", full: "盘后全量刷新" };
  return (
    <div>
      <SectionTitle>自定义监控规则</SectionTitle>
      <form onSubmit={submit} className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <label className="block">
          <span className="text-sm text-[var(--text)]">个股单日涨跌预警阈值（%）</span>
          <span className="block text-xs text-[var(--dim)]">任一监控标的当日涨跌幅达到该值时记录预警</span>
          <input {...FIELDS.updateRules.movePct} aria-label="个股异动阈值" value={movePct} onChange={(e) => setMovePct(e.target.value)} className={`num mt-1 ${inputCls}`} />
        </label>
        <label className="block">
          <span className="text-sm text-[var(--text)]">指数单日下跌预警阈值（%）</span>
          <span className="block text-xs text-[var(--dim)]">标普500 / 纳斯达克100 当日跌幅达到该值时记录预警</span>
          <input {...FIELDS.updateRules.indexDropPct} aria-label="指数下跌阈值" value={indexDrop} onChange={(e) => setIndexDrop(e.target.value)} className={`num mt-1 ${inputCls}`} />
        </label>
        <label className="block">
          <span className="text-sm text-[var(--text)]">VIX 预警阈值（逗号分隔）</span>
          <span className="block text-xs text-[var(--dim)]">VIX 升至任一阈值时记录预警（同一阈值同一交易日不重复）</span>
          <input {...FIELDS.updateRules.vixLevels} aria-label="VIX阈值" value={vixLevels} onChange={(e) => setVixLevels(e.target.value)} className={`num mt-1 ${inputCls}`} />
        </label>
        <label className="block">
          <span className="text-sm text-[var(--text)]">回撤关注阈值（距52周高 %）</span>
          <span className="block text-xs text-[var(--dim)]">回撤达到该值时记录预警并进入机会研究清单</span>
          <input {...FIELDS.updateRules.ddWatchPct} aria-label="回撤关注阈值" value={ddWatch} onChange={(e) => setDdWatch(e.target.value)} className={`num mt-1 ${inputCls}`} />
        </label>
        {error ? <p className="text-sm text-[var(--up)]">{error}</p> : null}
        {msg ? <p className="text-sm text-[var(--down)]">{msg}</p> : null}
        <button type="submit" disabled={save.isPending} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-black disabled:opacity-50">保存规则</button>
      </form>

      <SectionTitle>自动化执行状态</SectionTitle>
      <p className="text-sm leading-6 text-[var(--dim)]">后台任务清单、执行记录、耗时与失败原因已移至「系统状态」页（含测试通知功能）。最近一次执行：{data.runs[0] ? `${kindLabels[data.runs[0].kind] ?? data.runs[0].kind} · ${data.runs[0].status === "ok" ? "成功" : "失败"} · ${fmtTime(data.runs[0].finishedAt)}（北京时间）` : "暂无记录"}。</p>

      <SectionTitle>数据来源与能力边界</SectionTitle>
      <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm leading-6 text-[var(--dim)]">
        <p>个股/ETF 行情与日线历史来自平台行情数据通道（结构化，每标的标注行情时间，可能存在延迟，非实时逐笔）；52 周高/低、回撤、均线、RSI 全部由本标的日K在服务端确定性计算。标普500、纳斯达克100、VIX、10 年期收益率、美元指数、恐惧贪婪指数来自公开来源提炼（指数收盘口径，标注数据日期与获取时间），无法核实时显示「不可用」并记录最后尝试时间，绝不估算。</p>
        <p>预警采用状态机：只有指标实际跨越阈值时才触发，同一指标同日只保留最高等级一条；VIX/个股异动/指数下跌冷却 6 小时，回撤类冷却 24 小时；跌回阈值以下恢复后再次跨越才会重新触发，重复刷新不产生重复预警。</p>
        <p>定时任务：每个美股交易日盘后 05:30（北京时间，冬令时；夏令时 04:30）由 Space 定时任务自动全量刷新并生成日报，周五另生成周报；休市日自动跳过并记录原因。后台任务在服务端运行，关闭 Muse 客户端不影响执行（以「系统状态」页的执行记录为准）。页面打开时若数据超过 15 分钟未更新会自动补刷。</p>
        <p>盘前/盘中/周报的对话式推送由 Muse 主助手的 4 个后台任务承担（清单见「系统状态」页）。本应用不连接券商、不自动交易、不使用任何付费数据源。</p>
        <p>估值历史分位、美联储利率预期（CME FedWatch）暂无免费可靠结构化来源，标记为不可用；如需接入付费数据源请先与 Muse 沟通确认。</p>
      </div>
    </div>
  );
}

// ---------- 系统运行状态 ----------

function fmtDur(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function SystemTab({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const sys = useQuery({ queryKey: ["system-status"], queryFn: () => api.getSystemStatus({}) });
  const [testMsg, setTestMsg] = useState("");
  const [testError, setTestError] = useState("");
  const test = useMutation({
    mutationFn: () => api.testNotification({}),
    onSuccess: (r) => {
      setTestMsg(r.message);
      setTestError("");
      queryClient.invalidateQueries({ queryKey: ["system-status"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => { setTestError(e instanceof Error ? e.message : "测试通知发送失败"); setTestMsg(""); },
  });
  const c = data.calendar;
  const kindLabels: Record<string, string> = { market: "行情刷新", news: "资讯刷新", report: "报告生成", full: "盘后全量刷新" };
  const s = sys.data;
  return (
    <div>
      <SectionTitle extra="NYSE 官方日历（2026–2027）+ 美国法定夏令时规则">交易日历与市场状态</SectionTitle>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm leading-6 text-[var(--text)]">
        <p>当前状态：<strong>{c.phaseLabel}</strong>（美东 {c.todayET}）{c.earlyClose ? ` · 今日提前收盘 ${c.closeTimeET} ET（${c.earlyCloseNote ?? ""}）` : ""}</p>
        <p className="text-[var(--dim)]">时制：{c.dstLabel}；夏令时区间 2026 年 {c.dst2026}、2027 年 {c.dst2027}（美东 3 月第二个周日至 11 月第一个周日）。</p>
        <p className="text-[var(--dim)]">常规交易时段：美东 09:30–16:00，即{c.beijingSession}；提前收盘日美东 09:30–13:00。</p>
        <p className="text-[var(--dim)]">最近有效交易日：{c.lastTradingDay} · 下一交易日：{c.nextTradingDay}</p>
        {s && s.upcomingCalendar.length > 0 ? (
          <p className="text-[var(--dim)]">未来休市/提前收盘：{s.upcomingCalendar.slice(0, 8).map((u) => `${u.date} ${u.label}（${u.type}）`).join("；")}</p>
        ) : null}
      </div>

      <SectionTitle extra="Space 定时任务的执行记录来自本应用数据库；主助手任务仅列计划">后台任务列表</SectionTitle>
      {sys.isPending ? (
        <p className="text-sm text-[var(--dim)]">正在加载任务状态…</p>
      ) : sys.error ? (
        <p className="text-sm text-[var(--up)]">任务状态加载失败，请稍后重试。</p>
      ) : s ? (
        <div className="space-y-2">
          {s.tasks.map((t) => (
            <div key={t.name} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[var(--text)]">{t.name}</span>
                <span className="shrink-0 rounded bg-[var(--surface2)] px-1.5 py-0.5 text-xs text-[var(--dim)]">{t.owner}</span>
              </div>
              <dl className="num mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-[var(--dim)] sm:grid-cols-3">
                <div>频率：<span className="text-[var(--text)]">{t.schedule}</span></div>
                <div>上次成功：<span className="text-[var(--text)]">{t.lastSuccessAt ? fmtTime(t.lastSuccessAt) : "—"}</span></div>
                <div>上次执行：<span className="text-[var(--text)]">{t.lastRunAt ? fmtTime(t.lastRunAt) : "—"}</span></div>
                <div>下次计划：<span className="text-[var(--text)]">{t.nextRunAt ? fmtTime(t.nextRunAt) : "—"}</span></div>
                <div>上次耗时：<span className="text-[var(--text)]">{fmtDur(t.lastDurationMs)}</span></div>
                <div>上次状态：<span className={t.lastStatus === "error" ? "text-[var(--up)]" : "text-[var(--text)]"}>{t.lastStatus === "ok" ? "成功" : t.lastStatus === "error" ? "失败" : "—"}</span></div>
              </dl>
              {t.lastDetail ? <p className="mt-1 text-xs leading-5 text-[var(--dim)]">{t.lastStatus === "error" ? `失败原因：${t.lastDetail}` : t.lastDetail}</p> : null}
              <p className="mt-0.5 text-xs text-[var(--dim)]">数据来源：{t.source}</p>
            </div>
          ))}
        </div>
      ) : null}

      <SectionTitle>测试通知</SectionTitle>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <p className="text-sm leading-6 text-[var(--dim)]">写入一条标注为【测试通知】的预警记录（可在「报告」页的历史预警中看到），用于验证 Space 的记录链路；聊天侧主动推送由主助手任务负责，可让 Muse 在聊天里另发一条测试消息验证。</p>
        <button type="button" disabled={test.isPending} onClick={() => test.mutate()} className="mt-2 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-black disabled:opacity-50">
          {test.isPending ? "发送中…" : "发送测试通知"}
        </button>
        {testMsg ? <p className="mt-2 text-sm text-[var(--down)]">{testMsg}</p> : null}
        {testError ? <p className="mt-2 text-sm text-[var(--up)]">{testError}</p> : null}
      </div>

      <SectionTitle extra="行情时间 ≠ 获取时间，两者分开标注">数据来源与更新时间</SectionTitle>
      {s ? (
        <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {s.dataStatus.map((d) => (
            <div key={d.name} className="px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text)]">{d.name}</span>
                <span className="num text-xs text-[var(--dim)]">{d.state}</span>
              </div>
              <p className="num mt-0.5 text-xs leading-5 text-[var(--dim)]">
                来源：{d.source} · 行情/数据时间：{d.quoteAsOf ? (d.quoteAsOf.length > 10 ? fmtTime(d.quoteAsOf) : d.quoteAsOf) : "—"} · 获取时间：{d.fetchedAt ? fmtTime(d.fetchedAt) : "—"} · 最后尝试：{d.lastAttemptAt ? fmtTime(d.lastAttemptAt) : "—"}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {s ? (
        <p className="num mt-2 text-xs text-[var(--dim)]">数据库持久化：监控标的 {s.counts.watchlist} 个 · 日线 {s.counts.bars} 条 · 预警 {s.counts.alerts} 条 · 报告 {s.counts.reports} 份 · 新闻 {s.counts.news} 条 · 财报 {s.counts.earnings} 条。全部保存在数据库中，应用刷新/重启不丢失。</p>
      ) : null}

      <SectionTitle>最近执行记录</SectionTitle>
      {s && s.runs.length > 0 ? (
        <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {s.runs.map((r) => (
            <div key={r.id} className="px-3 py-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--text)]">{kindLabels[r.kind] ?? r.kind}</span>
                <span className={r.status === "ok" ? "text-[var(--down)]" : "text-[var(--up)]"}>{r.status === "ok" ? "成功" : "失败"}</span>
              </div>
              <p className="mt-0.5 text-xs leading-5 text-[var(--dim)]">{r.detail}</p>
              <p className="num text-xs text-[var(--dim)]">{fmtTime(r.startedAt)} 开始 · {fmtTime(r.finishedAt)} 完成 · 耗时 {fmtDur(r.durationMs)}（北京时间）</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--dim)]">暂无执行记录。</p>
      )}

      <SectionTitle>后台运行说明</SectionTitle>
      <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm leading-6 text-[var(--dim)]">
        <p>Space 定时任务与主助手任务都运行在服务端调度系统上，不依赖 Muse 客户端保持打开；客户端关闭后仍会按计划执行并把行情、预警与报告写入本 Space 数据库。验证方式：关闭客户端一段时间后重新打开本页，对照上方「执行记录」的时间戳与耗时即可确认（本轮迭代的真实执行记录也会出现在列表中）。</p>
        <p>数据采集、指标计算（MA/RSI/回撤）与阈值判断全部是确定性程序逻辑，不消耗 AI；AI 仅用于新闻/财报/指标提炼与日报、周报撰写，报告 AI 失败时自动降级为事实汇总并注明原因。</p>
      </div>
    </div>
  );
}

// ---------- 应用外壳 ----------

const TABS = [
  { key: "overview", label: "总览" },
  { key: "stocks", label: "行情" },
  { key: "opportunities", label: "回撤与机会" },
  { key: "positions", label: "持仓" },
  { key: "news", label: "资讯" },
  { key: "reports", label: "报告" },
  { key: "rules", label: "规则" },
  { key: "system", label: "系统状态" },
] as const;

let autoRefreshTried = false;

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<string>("overview");
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const refreshMarket = useMutation({
    mutationFn: (force: boolean) => api.refreshMarket({ force }),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const refreshNews = useMutation({
    mutationFn: () => api.refreshNews({}),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const data = dash.data;
  const lastUpdateRef = useRef<string | null>(null);
  lastUpdateRef.current = data?.lastMarketUpdate ?? null;
  const quoteAsOf = data?.stocks.reduce<string | null>((acc, s) => (s.asOf && (!acc || s.asOf > acc) ? s.asOf : acc), null) ?? null;
  const navRef = useRef<HTMLElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  // 切换页签时把选中页签滚到页签栏中央，保证在窄屏下完整可见
  useEffect(() => {
    const nav = navRef.current;
    const el = activeTabRef.current;
    if (nav && el) {
      nav.scrollTo({ left: Math.max(0, el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2), behavior: "smooth" });
    }
  }, [tab]);

  useEffect(() => {
    if (!data || autoRefreshTried) return;
    autoRefreshTried = true;
    const stale = !data.lastMarketUpdate || Date.now() - new Date(data.lastMarketUpdate).getTime() > 15 * 60 * 1000;
    if (stale) refreshMarket.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const busy = refreshMarket.isPending || refreshNews.isPending;

  return (
    <div className="min-h-screen overflow-x-clip bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 pt-safe backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-2.5">
          {/* 时间信息独占一行区：行情时间与获取时间分开写，完整显示不截断 */}
          <div className="num text-xs leading-5 text-[var(--dim)]">
            <div>行情时间：{quoteAsOf ? `${fmtTime(quoteAsOf)}（北京时间）` : "尚未刷新"}</div>
            <div>获取时间：{data?.lastMarketUpdate ? `${fmtTime(data.lastMarketUpdate)}（北京时间）` : "尚未刷新"}</div>
          </div>
          {/* 刷新区：只保留一个主按钮（刷新行情，整行）；资讯刷新降为右对齐的次级小按钮，永不溢出 */}
          <div className="mt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => refreshMarket.mutate(true)}
              className="w-full rounded-[var(--radius)] bg-[var(--accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50"
            >
              {refreshMarket.isPending ? "刷新中…" : "刷新行情"}
            </button>
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => refreshNews.mutate()}
                className="rounded border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--dim)] disabled:opacity-50"
              >
                {refreshNews.isPending ? "资讯刷新中…" : "刷新资讯"}
              </button>
            </div>
          </div>
        </div>
        {/* 页签栏：可横向滑动，右侧渐隐提示可滑动，选中页签自动滚入可见区 */}
        <div className="relative mx-auto max-w-5xl">
          <nav ref={navRef} aria-label="监控中心模块" className="no-scrollbar flex gap-1 overflow-x-auto scroll-smooth px-4 pb-2">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                ref={(el) => {
                  if (tab === t.key) activeTabRef.current = el;
                }}
                onClick={() => setTab(t.key)}
                aria-current={tab === t.key ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm ${tab === t.key ? "bg-[var(--accent)] font-medium text-black" : "border border-[var(--border)] text-[var(--dim)]"}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-[var(--bg)] via-[var(--bg)]/70 to-transparent pr-1 pb-2 text-base text-[var(--dim)]">›</div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-10 pt-4">
        {dash.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">正在加载监控数据…</p>
        ) : dash.error ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--up)]">数据加载失败</p>
            <button type="button" onClick={() => dash.refetch()} className="mt-3 rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]">重试</button>
          </div>
        ) : data ? (
          <>
            {tab === "overview" ? <Overview data={data} goTab={setTab} /> : null}
            {tab === "stocks" ? <StocksTab data={data} /> : null}
            {tab === "opportunities" ? <OpportunitiesTab data={data} /> : null}
            {tab === "positions" ? <PositionsTab data={data} /> : null}
            {tab === "news" ? <NewsTab data={data} /> : null}
            {tab === "reports" ? <ReportsTab data={data} /> : null}
            {tab === "rules" ? <RulesTab data={data} /> : null}
            {tab === "system" ? <SystemTab data={data} /> : null}
          </>
        ) : null}
        <footer className="mt-10 border-t border-[var(--border)] pt-3 text-xs leading-5 text-[var(--dim)]">
          价格为美元（USD）。行情可能延迟，请以行情时间标注为准；本页内容为研究参考，不构成投资建议，不自动交易。
        </footer>
      </main>
    </div>
  );
}
