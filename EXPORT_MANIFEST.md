# 导出清单 — 美股投资监控中心 Space 源码

导出日期：2026-11-26（北京时间）。来源：本机 Space
`mei-gu-tou-zi-jian-kong-zhong-xin`（美股投资监控中心，v3）。
导出方式：Muse 代理从 `~/workspace/ts-spaces/<slug>/` 复制源码文件，
未修改原 Space 的任何文件，未读取 `app.db`。

## 包含（24 个文件）

| 文件 | 说明 |
|---|---|
| `AGENTS.md` | 构建与数据规则（构建须走平台工具、勿直读 app.db） |
| `DATA-PLAN.md` | 数据来源、口径修正、预警状态机、被拒方案记录 |
| `MUSE_INTEGRATION.md` | 外部开发总规范（运行环境、部署、限制） |
| `space.json` | `runtime: typescript`，`platformVersion: 31`，`managedCronJobs` 每日 05:30 Asia/Shanghai 调 `scheduledRefresh` |
| `package.json` | 依赖基线；`@hatch/space-sdk` 为 `file:/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz`（仅 Muse 内有效，外部装不上） |
| `bunfig.toml` | Bun 安装配置（独立缓存） |
| `bun.lock` | 锁定版本 |
| `tsconfig.base.json` | 严格模式基线 |
| `icon.webp` | Space 图标（**二进制文件，GitHub 快照推送不支持二进制内容，传仓库时排除；需要时可另行上传**） |
| `client/build.mjs` | `buildClient()` 打包入口 |
| `client/index.html` | 入口 HTML |
| `client/tsconfig.json` | 前端类型检查配置 |
| `client/src/App.tsx` | 界面（1225 行） |
| `client/src/api.ts` | 类型化 RPC 客户端 |
| `client/src/globals.d.ts` | `*.css` 模块声明 |
| `client/src/main.tsx` | 根节点 + `spaceQueryClient` |
| `client/src/theme.css` | Tailwind + 明暗主题 |
| `server/tsconfig.json` | 服务端类型检查配置 |
| `server/src/actions.ts` | 全部 18 个 Server Actions（2200 行） |
| `server/src/schema.ts` | Drizzle 表定义（13 张表） |
| `drizzle/0001_initial.sql` | 模板遗留 `entries` 表 |
| `drizzle/0002_create_monitoring_tables.sql` | 监控表 |
| `drizzle/0003_alert_state_machine_and_data_quality.sql` | 预警状态机与数据质量修正 |
| `drizzle/meta/_journal.json` | 迁移清单 |

## 已排除

- `node_modules/`（约 133 MB，含真实 SDK 运行时——**不导出**）
- `app.db` / `app.db-wal` / `app.db-shm`（运行时数据库，含用户持仓与监控数据）
- `client/dist/`、`client/dist-cvm/`、`.space-build/`、`.space-build-cvm/`（构建产物）
- `audits/`（构建审计截图与报告）
- `.harness/`、`.tsbuildinfo.*`（构建中间态）
- 凭据与密钥：导出前对全部源码文件做密钥扫描
  （`api_key|secret|password|token|bearer|@qq.com` 等），**零命中**。
  源码中不含任何邮箱、Token 或用户个人数据；持仓为空（用户未录入）。

## 回导方式

外部改完后交给 Muse，由 Muse 合入 `~/workspace/ts-spaces/<slug>/`，
经平台构建工具 build → audit → 发布为新版本。不要直接覆盖目录
文件、不要手跑 `bun run build` 发布（AGENTS.md 原文要求）。
数据库随版本保留：v1→v3 的数据（截至导出时：预警 11 条、日线
2850 条、财报 6 条、新闻 4 条、报告 1 条）在升级后完整保留，
以 `getSystemStatus` Action 实测为准。
