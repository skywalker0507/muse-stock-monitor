import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiRequest, type ApiResponse } from "./api";

type InvestmentOverview = ApiResponse<typeof api, "getInvestmentOverview">;
type Signal = InvestmentOverview["signals"][number];
type MonitorHealth = InvestmentOverview["health"];
type Plan = ApiRequest<typeof api, "saveInvestmentPlan">;
type Target = ApiResponse<typeof api, "getInvestmentTargets">["targets"][number];

const times = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const overviewKey = ["investment-overview"];
const targetKey = ["investment-targets"];

export function useInvestmentOverview() {
  return useQuery({
    queryKey: overviewKey, queryFn: () => api.getInvestmentOverview({}), retry: false, staleTime: 30000, refetchInterval: 60_000,
  });
}

const jobNames: Record<MonitorHealth["jobs"][number]["job"], string> = {
  price: "盘中行情", halt: "交易暂停", sec: "SEC 公告", mail: "邮件任务",
};
const healthLabels: Record<MonitorHealth["jobs"][number]["state"], string> = {
  unconfigured: "未收到任务心跳", healthy: "正常", partial: "覆盖不全",
  error: "执行失败", overdue: "超时未更新", paused: "当前休市或未启用",
};

export function monitorIssue(health: MonitorHealth) {
  const failed = health.jobs.filter((job) => job.state !== "healthy" && job.state !== "paused");
  const names = failed.map((job) => jobNames[job.job]);
  if (!health.qqTestFresh) names.push(health.qqTestConfirmedAt ? "QQ 收件验证已过期" : "QQ 真实收件待验收");
  return names.join("、");
}

function HealthDetails({ health }: { health: MonitorHealth }) {
  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-3">
      <p className="text-sm font-medium">监测心跳</p>
      {health.jobs.map((job) => (
        <div className="text-xs leading-5 text-[var(--dim)]" key={job.job}>
          <p>{jobNames[job.job]} · {healthLabels[job.state]}{job.lastSuccessAt ? ` · 最近完整成功 ${times.format(job.lastSuccessAt)}` : ""}</p>
          {job.detail ? <p>{job.detail}</p> : null}
        </div>
      ))}
      <p className="text-xs text-[var(--dim)]">{health.qqTestConfirmedAt ? `QQ 测试收件：${times.format(health.qqTestConfirmedAt)}（北京时间）` : "QQ 测试收件待确认。"}</p>
    </div>
  );
}

export function InvestmentSignal({ signal, compact = false }: { signal: Signal; compact?: boolean }) {
  const urgent = signal.priority === "urgent";
  return (
    <article id={compact ? undefined : `signal-${signal.id}`} className="scroll-mt-20 space-y-1 px-4 py-3">
      <div className="flex items-start gap-2">
        <span className={`monitor-tag ${urgent ? "monitor-tag-risk" : ""}`}>{urgent ? "紧急复核" : "投资关注"}</span>
        <p className="min-w-0 text-sm font-medium leading-6">{signal.title}</p>
      </div>
      {compact ? null : <p className="text-xs text-[var(--dim)]">{signal.impact}</p>}
      <p className={`text-sm text-[var(--dim)] ${compact ? "line-clamp-1" : ""}`}>{signal.nextStep}</p>
      {compact ? null : (
        <p className="text-xs text-[var(--dim)]">
          {signal.sourceUrl ? <a href={signal.sourceUrl} target="_blank" rel="noreferrer" className="underline">{signal.source}</a> : signal.source}
          { ` · 证据 ${times.format(signal.observedAt)} · 发现 ${times.format(signal.detectedAt)} 北京时间`}
          {signal.expiresAt <= Date.now() ? " · 已过提醒有效期" : ""}
        </p>
      )}
    </article>
  );
}

const deliveryLabels: Record<string, string> = {
  sending: "发送处理中",
  sent: "邮件服务已接受",
  not_sent: "未发送",
  uncertain: "结果待核对",
  expired: "已过发送有效期",
};

export function InvestmentCenter({ openPlan }: { openPlan: () => void }) {
  const queryClient = useQueryClient();
  const overview = useInvestmentOverview();
  const update = () => queryClient.invalidateQueries({ queryKey: overviewKey });
  const scan = useMutation({ mutationFn: () => api.scanInvestmentPrices({}), onSuccess: update });
  const test = useMutation({ mutationFn: () => api.queueInvestmentMailTest({}), onSuccess: update });
  const confirm = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.confirmInvestmentMail({ id });
      if (!result.ok) throw new Error("这封邮件的状态已变化，请刷新后核对。");
    },
    onSuccess: update,
  });
  const linked = Number(new URLSearchParams(window.location.search).get("signal"));
  const [history, setHistory] = useState(linked > 0);
  const signals = overview.data?.signals ?? [];
  useEffect(() => {
    if (linked > 0 && overview.data) document.getElementById(`signal-${linked}`)?.scrollIntoView();
  }, [linked, overview.data]);
  const visible = history ? signals : signals.filter((signal) => signal.expiresAt > Date.now());

  return (
    <>
      <div className="monitor-heading">
        <h2>投资信号</h2>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="monitor-link" onClick={() => overview.refetch()}>刷新</button>
          <button type="button" className="monitor-secondary" onClick={openPlan}>投资计划</button>
        </div>
      </div>
      {overview.isError ? <p role="alert" className="text-sm text-[var(--up)]">{overview.error.message}</p> : null}
      <div className="monitor-filters items-center">
        <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>当前待复核</button>
        <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>历史</button>
        <button type="button" aria-pressed="false" disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? "检查中…" : "检查价格"}</button>
      </div>
      {scan.data ? <p role="status" className="text-xs text-[var(--dim)]">检查 {scan.data.checked} 个标的，新增 {scan.data.signals} 条，暂缓 {scan.data.deferred} 个{scan.data.unavailable.length ? ` · ${scan.data.unavailable.join("、")}` : ""}{scan.data.unverifiedClose.length ? ` · 前收待核对 ${scan.data.unverifiedClose.join("、")}` : ""}</p> : null}
      {scan.error ? <p role="alert" className="text-sm text-[var(--up)]">{scan.error.message}</p> : null}
      {!history && overview.data?.openRisks.length ? (
        <div className="monitor-panel monitor-rows">
          {overview.data.openRisks.map((risk) => (
            <article className="px-4 py-3" key={risk.symbol}>
              <p className="text-sm font-semibold"><span className="monitor-tag monitor-tag-risk">持续风险</span> {risk.symbol} · 风险线 ${risk.riskPrice.toFixed(2)} 美元</p>
              <p className="mt-1 text-xs text-[var(--dim)]">最近确认 {times.format(risk.observedAt)}（北京时间）{risk.price != null ? ` · ${risk.price.toFixed(2)} 美元` : ""}</p>
            </article>
          ))}
        </div>
      ) : null}
      <div className="monitor-panel monitor-rows">
        {visible.length ? visible.map((signal) => <InvestmentSignal signal={signal} key={signal.id} />) :
          <p className="px-4 py-4 text-sm text-[var(--dim)]">{overview.isPending ? "正在读取…" : !history && overview.data && monitorIssue(overview.data.health) ? "暂无已记录的投资信号，部分监测链路待核对。" : "暂无投资信号。"}</p>}
      </div>
      <details className="monitor-panel monitor-disclosure">
        <summary>QQ 邮件与监测状态</summary>
        <div className="space-y-3 px-4 pb-4">
          <p className="text-xs text-[var(--dim)]">待发紧急 {overview.data?.pendingUrgent ?? "—"} 封 · 待汇总 {overview.data?.pendingDigest ?? "—"} 条</p>
          <button type="button" className="monitor-secondary" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? "正在入队…" : "加入 QQ 测试邮件"}</button>
          {test.data ? <p role="status" className="text-xs text-[var(--dim)]">{test.data.added ? "测试已入队，等待 Muse 邮件任务发送。" : "最近 5 分钟已经添加过测试。"}</p> : null}
          {test.error ? <p role="alert" className="text-sm text-[var(--up)]">{test.error.message}</p> : null}
          {overview.data?.mail.map((mail) => (
            <div className="border-t border-[var(--border)] pt-3" key={mail.id}>
              <p className="text-sm font-medium">{mail.test ? "链路测试" : mail.mode === "urgent" ? "紧急邮件" : "投资摘要"} · {mail.confirmedAt ? "QQ 收件已确认" : deliveryLabels[mail.status]}</p>
              <p className="mt-1 text-xs text-[var(--dim)]">消息编号 {mail.id.slice(0, 8)} · 领取 {times.format(mail.capturedAt)}{mail.sentAt ? ` · 发出 ${times.format(mail.sentAt)}` : ""} · 尝试 {mail.attempts} 次</p>
              {mail.error && !mail.confirmedAt ? <p className="text-xs text-[var(--dim)]">{mail.error}</p> : null}
              {!mail.confirmedAt && (mail.status === "sent" || mail.status === "uncertain") ? (
                <button type="button" className="monitor-link" disabled={confirm.isPending} onClick={() => confirm.mutate(mail.id)}>确认 QQ 已收到</button>
              ) : null}
            </div>
          ))}
          {confirm.error ? <p role="alert" className="text-sm text-[var(--up)]">{confirm.error.message}</p> : null}
          {overview.data ? <HealthDetails health={overview.data.health} /> : null}
          <div className="border-t border-[var(--border)] pt-3">
            {overview.data?.runs.length ? overview.data.runs.map((run, index) => (
              <p className="mb-2 text-xs text-[var(--dim)]" key={`${run.at}:${index}`}>{times.format(run.at)} · {run.kind === "investment" ? "价格监测" : "官方事件"} · {run.detail}</p>
            )) : <p className="text-xs text-[var(--dim)]">暂无监测执行记录。</p>}
          </div>
        </div>
      </details>
    </>
  );
}

function PlanForm({ target, existing }: { target: Target; existing?: Plan }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (plan: Plan) => api.saveInvestmentPlan(plan),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: targetKey }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const string = (key: string) => String(fields.get(key) ?? "").trim();
    const number = (key: string) => string(key) ? Number(string(key)) : null;
    const purpose = string("purpose");
    save.mutate({
      symbol: target.symbol, enabled: fields.has("enabled"), purpose: purpose === "long" || purpose === "trade" ? purpose : "watch",
      thesis: string("thesis"), entryLow: number("entryLow"), entryHigh: number("entryHigh"), riskPrice: number("riskPrice"),
      peakGivebackPct: number("peakGivebackPct"), openingDropPct: number("openingDropPct"),
      includeExtended: fields.has("includeExtended"), nextEvent: string("nextEvent"), nextEventDate: string("nextEventDate") || null,
    });
  }
  return (
    <form className="monitor-panel space-y-4 p-4" onSubmit={submit}>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="enabled" defaultChecked={existing?.enabled ?? true} />启用该标的计划</label>
      <label className="monitor-field">持有目的
        <select className="monitor-input" name="purpose" defaultValue={existing?.purpose ?? (target.held ? "long" : "watch")}>
          <option value="long">长期核心</option><option value="trade">短中期交易</option><option value="watch">仅观察</option>
        </select>
      </label>
      <label className="monitor-field">投资理由
        <textarea className="monitor-input py-2" name="thesis" maxLength={400} rows={2} defaultValue={existing?.thesis ?? ""} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="monitor-field">观察区下限（美元）<input className="monitor-input min-w-0" type="number" name="entryLow" min="0.01" step="any" defaultValue={existing?.entryLow ?? ""} /></label>
        <label className="monitor-field">观察区上限（美元）<input className="monitor-input min-w-0" type="number" name="entryHigh" min="0.01" step="any" defaultValue={existing?.entryHigh ?? ""} /></label>
        <label className="monitor-field">风险复核价（美元）<input className="monitor-input min-w-0" type="number" name="riskPrice" min="0.01" step="any" defaultValue={existing?.riskPrice ?? ""} /></label>
        <label className="monitor-field">浮盈回吐阈值（%）<input className="monitor-input min-w-0" type="number" name="peakGivebackPct" min="1" max="100" step="any" defaultValue={existing?.peakGivebackPct ?? ""} /></label>
        <label className="monitor-field">开盘后跌幅提醒（%）<input className="monitor-input min-w-0" type="number" name="openingDropPct" min="1" max="35" step="any" placeholder="持仓默认 8%" defaultValue={existing?.openingDropPct ?? ""} /></label>
      </div>
      <p className="text-xs text-[var(--dim)]">浮盈峰值按常规交易的成功报价采样记录。录入数量、成本或持仓笔数改变后重新积累。</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeExtended" defaultChecked={existing?.includeExtended ?? false} />观察区与风险价也检查盘前、盘后</label>
      <div className="grid grid-cols-2 gap-2">
        <label className="monitor-field">下一关键事件<input className="monitor-input min-w-0" name="nextEvent" maxLength={140} defaultValue={existing?.nextEvent ?? ""} placeholder="如：财报与指引" /></label>
        <label className="monitor-field">事件日期（美东）<input className="monitor-input min-w-0" name="nextEventDate" type="date" defaultValue={existing?.nextEventDate ?? ""} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="monitor-primary" disabled={save.isPending}>{save.isPending ? "保存中…" : "保存计划"}</button>
        {save.isSuccess ? <span role="status" className="text-sm text-[var(--dim)]">已保存。</span> : null}
        {save.error ? <span role="alert" className="text-sm text-[var(--up)]">{save.error.message}</span> : null}
      </div>
    </form>
  );
}

export function InvestmentPlanEditor({ symbol, onBack }: { symbol: string | null; onBack: () => void }) {
  const [chosen, setChosen] = useState(symbol ?? "");
  const data = useQuery({ queryKey: targetKey, queryFn: () => api.getInvestmentTargets({}), retry: false });
  const options = data.data?.targets ?? [];
  const target = options.find((item) => item.symbol === chosen);
  return (
    <>
      <div className="monitor-heading"><h2>投资计划</h2><button type="button" className="monitor-link" onClick={onBack}>返回投资信号</button></div>
      <label className="monitor-field">标的
        <select aria-label="计划标的" className="monitor-input max-w-80" value={chosen} onChange={(event) => setChosen(event.target.value)}>
          <option value="">选择自选或持仓标的</option>
          {options.map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}{item.held ? " · 持仓" : ""}{item.planned ? " · 监测中" : ""}</option>)}
        </select>
      </label>
      {data.error ? <p role="alert" className="text-sm text-[var(--up)]">{data.error.message}</p> : null}
      {target ? <PlanForm key={target.symbol} target={target} existing={data.data?.plans.find((plan) => plan.symbol === target.symbol)} /> : null}
    </>
  );
}
