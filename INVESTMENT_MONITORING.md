# 投资计划、风险监测与 QQ 邮件

## Space 中的操作

首页进入「投资信号」，点击「投资计划」，为持仓或自选标的设置持有目的、观察区、风险复核价和下一关键事件。风险复核价使用触及或跌破即提醒的口径。浮盈回吐和盘前盘后监测均可选。

| 事件 | 默认优先级 | 条件 |
| --- | --- | --- |
| 触及风险复核价 | 紧急 | 标的启用投资计划，报价校验通过 |
| 开盘后急跌 | 紧急 | 持仓在常规开盘一小时内较已保存的上一个交易日收盘跌 8% 或达到自定义线 |
| 个股暂停、全市场熔断或 8-K 的 1.03 / 4.02 | 紧急 | 影响持仓或涉及全市场，有监测标的且公告在最近三小时内 |
| 进入观察区、浮盈回吐、普通 8-K | 摘要 | 价格满足计划，或官方事件影响持仓或已启用计划 |

报价使用明确匹配的美元标的与带时区的观测时间，超过 15 分钟的报价不触发。盘前盘后需要单独开启，只检查观察价和风险价。浮盈峰值来自成功取得的常规时段报价，持仓数量、价格成本或笔数发生变化后重新积累。交易暂停以 feed 中当前尚未恢复的状态为依据，正式复牌和数据许可由实际环境验收。价格和财务公告只触发复核信息。

## 安装和任务

1. 保留既有 slug 和数据库。合入源码和追加迁移 `0004_investment_signals_and_mail.sql`，由 Muse 构建工具执行 build → audit → 发布。以 Space 所有者及其授权任务分别验证新增 Action 的身份和可调用性。
2. 把 `scripts/collect_investment_events.py` 放进 Muse VM 的工作区。在 Muse 私密设置中配置 `SEC_EDGAR_USER_AGENT`，值为服务名称加维护者联系方式。QQ 收件地址与已授权的邮件连接器放在 Muse 任务配置中。
3. 在 Muse 主助手上安排价格与官方事件检查。先实测能支持的间隔，再记录实际检测和邮件延迟。常规时段至少覆盖开盘第一小时，公告轮询应覆盖你关心的盘后时段。每天收盘后的摘要任务也可以合并到已有盘后任务，但发送由有连接器的主助手执行。

### 每轮检查

1. 调用 `scanInvestmentPrices({})`。结束后先发送已排队的紧急邮件。
2. 调用 `getInvestmentTargets({})`，仅把返回的 `targets` 数组交给采集脚本。使用任务私有的临时文件，在执行后删除。文件形状为 `{"targets":[{"symbol":"GOOG","held":true,"planned":true}]}`。
3. 先跑 `--source halt`。把 stdout 解析后的 JSON 对象原样传给 `importInvestmentEvents`，包括来源失败时的 `sourceErrors`。发送新入队的紧急邮件后，再跑 `--source sec`，导入结果并发送新入队的紧急邮件。这样 SEC 逐只查询不会拖住已发现的价格和停牌预警。Nasdaq RSS 每分钟最多查询一次。

   ```sh
   python3 scripts/collect_investment_events.py --targets /path/to/private-targets.json --source halt
   python3 scripts/collect_investment_events.py --targets /path/to/private-targets.json --source sec
   ```

   ETF 参与停牌监测。SEC 8-K 查询限可验证的普通公司标的。
4. 发送紧急邮件时调用 `claimInvestmentMail({"mode":"urgent"})`，每封处理完再领取下一封，直到返回 `mail: null`。盘后用 `mode: "digest"` 领取一次摘要。日期以 Space 的最近已收盘美东交易日为准。

### 发送一封邮件

- 确认当前时间早于 `mail.leaseUntil`，然后用已授权的连接器向配置的 QQ 地址发送 `mail.subject` 和 `mail.body`。保留主题中的 `[MSG-...]`。有已验证的 Space 打开链接时，可补上 `?view=investing&signal=<signalId>`，摘要和测试邮件使用 `?view=investing`。
- 发信服务明确接受时，立刻调用 `recordInvestmentMail`，传回 `id`、`claimToken`、`outcome: "sent"` 和邮件服务实际返回的 `providerRef`。
- 明确没发出时填 `outcome: "not_sent"` 和简短的 `error`。同一消息编号在有效期内最多尝试三次。服务超时、结果无法判断，或领取后任务中断，使用 `uncertain` 或等待领取失效。先凭消息编号查发件箱或收件箱，再补记结果。待核对状态会保留供人工查验。
- Space 记录服务接受和收件人确认的时间。收到 QQ 邮件后可以在「QQ 邮件与监测状态」按消息编号确认。邮箱地址、授权信息和测试邮件的内容留在 Muse 私密环境。

### 真实 QQ 验收

点击「加入 QQ 测试邮件」，由已授权任务领取并发送。到 QQ 收件箱核对主题的消息编号，再回 Space 确认收到。重跑同一轮任务，应没有同编号的第二封邮件。用严重事件模拟、常规交易时段报价、休市和数据源失败分别验收。工作区回放只验证应用链路，真实邮件时效以 QQ 收件箱为准。

来源与口径参考 [Nasdaq Trader 暂停交易 RSS](https://www.nasdaqtrader.com/Trader.aspx?id=TradeHaltRSS) 和 [SEC EDGAR Submissions API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)。
