# Data Plan

## Context provenance
- `核心长期投资：GOOG、MSFT、QQQ / QQQM、SPY / VOO；重点机会观察：NVDA、AMD、AVGO、AMZN、META、AAPL、MU` (prior user statement; verbatim request section 1 — seeds the default watchlist exactly as given, user-editable in UI)
- `市场风险指标：VIX、纳斯达克100、标普500、美国10年期国债收益率、美元指数 DXY、美联储利率预期、CNN Fear & Greed Index` (prior user statement; defines the market-indicator panel; unavailable ones are labeled 不可用, never fabricated)
- `所有报告使用简体中文。股票价格使用美元。不得编造行情、财务数据、估值或新闻。无法获取的数据明确标记为不可用。` (prior user statement; governs all copy, null handling, and provenance labels)
- `允许我手动录入持仓数量、成本价和投资周期` (prior user statement; positions start EMPTY — user-entered only, no sample holdings)
- Refresh trigger from build brief: `每个美股交易日盘后更新一次，北京时间约04:30（冬令时）` (drives the single scheduled refresh)
- MEMORY.md commitment (updated during this build): 盘前/盘中/周报节奏由主代理的后台任务承担；本 artifact 负责持久化监控中心 + 每日盘后刷新，盘中高频监控的平台限制在「系统状态」页如实说明。

## Tested sources
### ctx.tool.finance_ticker (primary quotes + history)
**Used by**: refreshMarket, addSymbol validation, getSymbolDetail
**Test command**: `bun /opt/muse/assets/spaces/ts-runtime/dist/probe-ctx.js < /tmp/probe-finance.ts` (and probe2–5)
**Sample output**: GOOG instrument {price 270.98, prev close 276.58, change_percent -2.0247, market cap 3.48T, PE 14.78, beta 1.2467, 52w high 408.61 / low 264.22, market_status closed, as_of ISO}; QQQ {price 633.93, chg -0.6535%}; NVDA interval 1d since 2025-06-01 → 260 daily points (2025-11-12…2026-11-24) — enough for MA20/50/200, RSI(14), 20/60-day and 52-week drawdowns computed server-side.
**Processing**: one call per symbol via Promise.all; indicators computed deterministically from daily closes/highs; every row stores as_of + source label; null fields render as 不可用.
**Symbol resolution limits (probed)**: `^VIX`/`^GSPC` rejected (single-ticker only); `VIX`,`NDX`,`DXY` → matched none; `TNX` → wrong Italian stock (rejected); `SPX`/`US500` → SPX500/USD (S&P 500 quote, 7220.4); `NAS100` → NAS100/USD (Nasdaq-100 quote, 26190). So 标普500/纳斯达克100 use SPX/NAS100 quotes labeled as index quotes; SPY/QQQ ETF rows provide the tradable cross-check.

### ctx.tool.web_search (+ ctx.inference distillation)
**Used by**: refreshNewsEarnings (major news per symbol, earnings calendar, VIX / 10Y yield / DXY / Fear & Greed values), generateReport drafting
**Test command**: probe-ctx snippet calling ctx.tool.web_search('NVDA earnings date next report November 2026')
**Sample output**: 8 results with title/url/source/snippet/published_at; Zacks result carried a concrete confirmed report date + consensus EPS — distillation into typed rows is viable.
**Processing**: search snippets distilled by ctx.inference.complete with a strict schema; values that cannot be grounded are stored as null and displayed 不可用; news deduped by URL hash; every news/earnings row keeps its source URL verbatim.

## 第二轮迭代核查（2026-11-26，probe-ctx 实测）
- **MSFT**：finance_ticker 当前可正常返回（$489.93，as_of 2026-11-25 收盘）；v1 失败为瞬时故障。修复：报价拉取加一次重试，运行记录写明每个失败标的的具体原因。
- **GOOG 52 周高/低**：行情源 instrument.week_52 返回 408.61/264.22（GOOGL 口径，错误）；GOOG 自身近 252 日日K计算为高 404.47、低 262.27（低点日 2026-11-20），与用户核查的 Finnhub 值一致。修复：52 周高/低一律由本标的近 252 个交易日日K（high/low）并入当日行情高/低确定性计算，并保存极值日期；quotes.week_52 字段不再采用。
- **MU 52 周低**：同一日K口径计算为 212.36（2025-11-24），介于旧值 192.59（instrument 字段）与 MarketBeat 221.69 之间；按用户要求以日K口径为准并在详情页标注极值日期，不静默采用无依据数值。
- **AVGO 52 周低**：日K截至 11-24 + 当日（11-25）行情低点并入后可得 278.00，口径已覆盖。
- **指数 SPX/NAS100**：finance_ticker 只能解析到 OANDA 差价合约 SPX500/USD、NAS100/USD（7221/+0.62% 等），与真实指数收盘（SPX 7182.78 -0.25%、纳指100 26046.90 -0.64%，2026-11-25）不符，结构化通道无真实指数（^GSPC/^NDX 被拒）。修复：SPX/NAS100 改与 VIX/TNX10Y/DXY/FEAR_GREED 一起走定向搜索提炼（指数收盘口径），提炼提示明确禁止用 CFD 冒充指数；每次尝试记录 last_attempt_at，成功记录 fetched_at，取不到显示不可用。
- **交易日历**：NYSE 2026/2027 休市与提前收盘日内置于代码（确定性），夏令时按法定规则（3 月第二个周日–11 月第一个周日）计算并与 Intl 美东偏移交叉校验：2026 为 03-08–11-01，2027 为 03-14–11-07（注：用户简报写 2027 夏令时止于 10-31，与法定规则不符——2027-11-01 是周一，第一个周日是 11-07；页面按规则计算并明示区间）。
- **预警状态机**：alert_state 表保存 prev_value/fired_level/last_fired_at；跨越才触发、同日同指标只留最高等级（插入前删除低等级旧条）、冷却 VIX/异动/指数 6h、回撤 24h、跌回恢复；迁移 0003 删除旧的同日重复 VIX 预警（每日期只留最高阈值一条）。
- **报告降级**：generateReport 的 AI 调用加 timeout_secs=240 并 try/catch；失败时以已存储数据确定性生成事实汇总报告，失败原因写入报告正文与 refresh_runs.detail。
- **定时任务**：Space 自带任务 mei-gu-postmarket-refresh 已由主助手改为每日 05:30 Asia/Shanghai（space_action → scheduledRefresh，cron.view 已核实），space.json 记录同步为 05:30，未改回 04:30。scheduledRefresh 增加交易日历守卫：休市日跳过并记录原因。

## Rejected approaches
- **Tried**: Stooq CSV API `curl https://stooq.com/q/l/?s=...`
  **Why rejected**: returned a 'page does not exist' HTML page for the quote endpoint; finance_ticker is the supported channel and returned richer structured data.
- **Tried**: direct index symbols ^VIX/^TNX/DX-Y.NYB via finance_ticker
  **Why rejected**: rejected or unmatched in probes (see above); VIX/10Y/DXY/Fear&Greed fall back to web-search distillation with explicit source + as-of labels, or 不可用.

## Long-term data behavior
- **Refresh policy**: page load serves cached rows from ctx.db and refreshes when stale (>15 min during US session awareness, manual 刷新 button always available); scheduled refresh daily ~04:30 Asia/Shanghai runs full market + news/earnings + daily report (weekly report appended on the last US trading day of the week); refresh_runs logs every run's status/failure reason.
- **Growth**: history_daily keeps ≤400 daily bars per symbol; quotes/indicators upsert latest per symbol; alerts deduped by (symbol, rule, US trading date); news capped by dedup + prune to latest 200; reports accumulate (daily/weekly history is a requested feature).
- **Ordering**: watchlist core group first then opportunity then custom; drawdown board sorted by 52-week drawdown desc; news/alerts/reports newest first.
- **Time semantics**: US session math in America/New_York via Intl; all timestamps rendered in Asia/Shanghai (北京时间) with the quote's own as_of shown; prices USD.

## Imagery
Imagery not needed: this is a data-dense monitoring dashboard; all visuals are computed charts (price history, drawdown bars) drawn from real stored series — no photographic subjects in the request.
