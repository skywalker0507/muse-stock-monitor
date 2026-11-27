# MUSE_INTEGRATION.md — 外部代码接入 Muse Secure VM 与 Space 的技术规范

> 面向对象：在外部工具（如 OpenAI Codex）中开发代码、再交给 Muse 部署的开发者。
> 验证日期：2026-11-26（北京时间）。验证方式：在当前用户的 Muse Secure VM 内实际执行命令与最小实验，Space 部分以本机现存真实 Space「美股投资监控中心」的源码、配置与版本快照为样本核查。标注「实测」的结论均有本次运行输出为据；标注「平台规则」的结论来自 Muse 官方运行文档与该 Space 目录内的 `AGENTS.md`。
> 重要提醒：版本号、资源数字是验证当日的实测值，后续可能随平台镜像升级变化。代码不要把具体小版本写死为唯一兼容条件。

---

## 0. 先说结论：推荐的协作模式

Muse 不是一台可自由托管任意服务的通用云主机。它由两部分组成，两者的能力边界完全不同：

| 组成部分 | 本质 | 适合放什么 |
|---|---|---|
| Secure VM（Linux 工作区） | 持久化的文件系统 + 可执行脚本的沙箱环境，由 Muse 代理按需运行命令 | 数据抓取/计算脚本、批处理、文件与 SQLite 数据、Space 的数据源 |
| Space（原 Web Artifact） | 平台托管的前后端应用：静态页，或 TypeScript 全栈应用（React 前端 + Server Actions + 自带 SQLite 数据库） | 用户实际打开使用的界面与交互、需要长期保存并展示的数据 |

推荐架构只有一条主线：

```text
外部开发 (Codex) ──交付源码──▶ Muse 代理部署到 VM 的 ~/workspace/<project>/
                                   │  脚本运行，产出 JSON / CSV / SQLite 文件
                                   ▼
                        Space 的 Server Action 读取产出并写入 Space 自有数据库 (app.db)
                                   │
                                   ▼
                        Space 前端 (React) 通过类型化 RPC 读取 Action 并渲染
```

不要设计「VM 里常驻一个 HTTP 服务、Space 前端直接 fetch 它」这类架构：平台不支持，见第 10 问。不要设计「外部脚本直接读写 Space 的 app.db」：平台明确禁止，见第 8 问。

---

## 1. 十四个问题：逐项实测结论

### Q1. 是否支持从 GitHub 仓库导入用户提供的源代码？

**支持（由 Muse 代理用 git 克隆，不是平台提供一键「导入仓库」按钮）。实测通过。**

- VM 预装 `git 2.43.0`，出站网络可用。
- 实测：`git ls-remote https://github.com/octocat/Hello-World.git HEAD` 成功返回提交哈希；`git clone --depth 1` 同一公开仓库成功，文件完整落地。
- 私有仓库：需要凭据。VM 内有默认 SSH 密钥对（`~/.ssh/id_ed25519.pub` 可提供给 GitHub 作为 Deploy Key），或使用连接器/Secure Vault 的安全流程提供 Token。**禁止把 Token 写进代码、README、`.git/config` 示例或聊天明文里长期留存**，详见第 6 节密钥规范。
- 克隆后只是「源码进入 VM」。要变成 Space，仍须按第 5 节的 Space 结构移植并由 Muse 的构建工具发布，不存在「克隆完自动上线」。

### Q2. 是否支持上传 ZIP 源代码压缩包并解压运行？

**支持。实测通过。**

- VM 预装 `zip 3.0` / `unzip 6.00` / `tar 1.35`；实测打包、解压、读取文件全流程通过。平台文档亦确认：ZIP 与上传的项目可在工作区内解包检查（`~/docs/files-and-library.md`）。
- 上传通道限制（Web 端聊天附件，平台文档值）：非图片文件约 **25 MB** 上限、视频约 **100 MB**；整个文件夹不能直接上传，官方建议先压成 ZIP。大仓库优先走 Q1 的 git 方式，不要走 ZIP。
- 解压目标统一放在 `~/workspace/<project>/` 下，不要解压到 `~` 根目录或系统目录。

### Q3. 当前 Linux 环境、CPU 架构、Python、Node.js 版本是什么？

**实测值（2026-11-26）：**

| 项目 | 实测结果 |
|---|---|
| 操作系统 | Ubuntu 24.04.5 LTS (Noble Numbat)，镜像 `hatch-image 0.1.46` |
| 内核 | Linux 7.0.0-44-generic，KVM 全虚拟化 |
| CPU 架构 | **x86_64（amd64）**，AMD EPYC 9D25，VM 可见 4 vCPU |
| Python | **Python 3.12.3**，命令只有 `python3`（无 `python` 别名），`pip 24.0` |
| Node.js | **v24.22.1**，`npm 10.9.4` / `npx 10.9.4` |
| Bun | **1.4.4**（Space 模板的 `package.json` 声明 `bun@1.3.10` 为包管理器，以模板为准） |
| 编译器 | gcc / g++ 13.3.0 |
| SQLite | CLI 与 Python `sqlite3` 均为 **3.45.1** |
| 其他工具 | git 2.43.0、curl 8.5.0、wget 1.21.4、jq 1.7 |
| 未预装 | Go、Rust (rustc)、Java、Ruby、PHP、Docker、uv、pipx（均实测 `command not found`） |

代码含义：交付的二进制、原生扩展、Docker 镜像方案必须按 **Linux x86_64** 准备；需要 Go/Rust/Java 等工具链时，要在交付说明中明确提出，由 Muse 评估能否在用户区安装，不能假设存在。

### Q4. 是否支持 pip、npm 等第三方依赖安装？

**支持。实测通过，但 Python 有一条硬约束。**

- 实测：新建 venv 后 `pip install cowsay` 成功且可导入运行；`npm install is-odd` 成功且可 `require` 运行；现有 Space 的 `node_modules` 由 Bun 安装（含 React、Drizzle 等）。
- 实测 PyPI、npm Registry 均可达（HTTP 200）。
- **硬约束（实测报错）：系统级 `pip3 install` 被 PEP 668「externally-managed-environment」拒绝。** Python 依赖必须装进项目内虚拟环境：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

- Node 依赖：在项目目录用 `npm install`（普通 VM 项目）或 `bun install`（Space 项目，跟随模板的 `bunfig.toml` 与 `bun.lock`，不要混用包管理器、不要手改 lockfile 格式）。
- 所有依赖必须声明在 `requirements.txt` / `package.json` 中并锁定版本，不接受「部署时临时装一下某包」的不声明依赖。

---

### Q5. 是否支持 SQLite 等持久化数据库？

**SQLite：完整支持，实测通过。其他数据库服务：未预装，不要假设可用。**

- 实测：`sqlite3` CLI 建表、插入、查询成功；Python `sqlite3` 读取同一库成功。
- Space 自带数据库就是 SQLite：样本 Space 的 `app.db`（实测约 500 KB，含 `-wal`/`-shm`）位于其 Space 目录内，平台文档确认交互式应用的数据「跨重启与更新持久保存」。
- 实测 `psql`、`mysql`、`redis-server` 均不存在。需要 PostgreSQL/MySQL/Redis 的设计不成立；请改用 SQLite（单机场景足够）或外部托管数据库的 HTTPS API（凭据走第 6 节规范）。
- SQLite 使用规范：开启 WAL 时注意 `-wal`/`-shm` 伴随文件；数据库文件放在持久目录（见 Q11），不要放在 `/tmp`；写入要有事务与幂等设计，因为定时任务可能重复触发。

### Q6. 是否支持执行用户提供的 Python、JavaScript 或编译后的二进制程序？

**三者均支持，实测通过。**

- Python：`python3 hello.py` 正常输出。
- JavaScript：`node hello.js` 与 `bun run hello.js` 均正常输出。
- 编译二进制：实测用 gcc 将 C 源码编译为 ELF 64-bit x86-64 可执行文件并成功运行。
- 因此外部预编译交付也可以，但必须满足：**Linux x86_64 目标、依赖的系统库以 Ubuntu 24.04 为准、文件带可执行权限**。macOS/Windows/ARM 二进制无法运行。优先交付源码 + 构建说明，预编译二进制只作为备选。
- 执行方式是「Muse 代理按任务或定时任务拉起进程」，不是给外部开发者一个可直接登录的 Shell 账号或 SSH 入口。

### Q7. Spaces 使用什么前端技术栈？能否直接导入 HTML、React、Vue 等应用？

**Space 只有两种官方形态（以平台模板实测为准），不能把任意现成应用原样导入。**

| 形态 | `space.json` | 技术栈 | 适合 |
|---|---|---|---|
| 静态 Space | `"runtime": "static"`，入口 `index.html` | 单个自包含 HTML 文件，样式与脚本内联，静态资源放 `assets/` | 纯展示页、无后端数据的页面 |
| TypeScript 全栈 Space | `"runtime": "typescript"`，入口 `client/dist/index.html` | **React 19 + TypeScript 5.6 + Tailwind CSS 4 + @tanstack/react-query 5 + Recharts + Zod 4**；服务端 **Bun + Drizzle ORM (SQLite) + `@hatch/space-sdk`** | 有数据存储、服务端逻辑、定时刷新的应用 |

逐项回答「能否直接导入」：

- **HTML**：可以成为静态 Space，但须改造成「单个自包含 HTML」（内联 CSS/JS），多文件站点不能原样塞入。
- **React**：样本 Space 正是 React，但它遵循固定脚手架（`client/src/main.tsx`、`App.tsx`、`api.ts`，由 SDK 的 `buildClient()` 打包）。外部 React 项目（Vite/CRA/Next.js 结构）**不能直接导入**，需要把组件与业务逻辑移植进脚手架；Next.js 的 SSR/API Routes 模型在此不存在，对应能力用 Server Actions 替代。
- **Vue**：不在平台技术栈内，无 Vue 运行时与构建支持。Vue 应用只能重写为 React，或降级为静态页内嵌运行时（无构建保障，不推荐用于复杂功能）。
- 结论：外部开发应**直接按本规范第 3.2 节的 Space 结构写代码**，而不是先用任意框架开发再指望导入。

### Q8. 能否将 Secure VM 中的程序输出或数据库内容同步到 Space？

**能，但只能经由 Space 的 Server Action 中转，不存在直连通道。这是集成设计的核心约束。**

- 平台规则（样本 Space 的 `AGENTS.md` 原文要求）：Space 的数据位于其目录的 `app.db`，由应用自身管理；**外部不得用 sqlite 或脚本直接读写 `app.db`**。
- 前端与后端的唯一通道是类型化 RPC：前端 `client/src/api.ts` 用 `createActionClient` 以 `{action, args}` 调用 `./actions`，服务端在 `server/src/actions.ts` 用 `defineAction`（Zod 校验入参/出参）实现，内部通过 `ctx.db()` + Drizzle 访问数据库。
- 因此 VM 程序 → Space 的标准同步方式（二选一，详见第 5 节）：
  1. **文件交接（推荐用于批处理）**：VM 脚本把结果写成约定好的 JSON/CSV 文件到共享工作区目录；Space 的一个导入 Action（手动触发或定时触发）读取、校验、落库。
  2. **Action 内直算**：逻辑本身用 TypeScript 写进 Action，运行时通过 `ctx` 提供的工具（如行情、网页搜索、模型推理 `ctx.inference`）取数并落库——样本 Space 的全部刷新逻辑即如此实现，根本不需要 VM 侧常驻程序。
- 反方向（Space → VM）：Action 落库后，VM 脚本如需消费，应读 Action 导出的文件，或由 Muse 代理导出数据；同样不要直读 `app.db`。

---

### Q9. 能否通过定时任务执行外部代码，而不需要每次调用大模型？

**分两种情况，必须区分：**

- **Space 的托管定时任务（推荐，确定性执行）**：在 `space.json` 的 `managedCronJobs` 中声明，平台到时直接调用 Space 已发布的某个 Action。样本实测：

```json
"managedCronJobs": [
  { "id": "mei-gu-postmarket-refresh", "action": "scheduledRefresh",
    "schedule": "daily 05:30 Asia/Shanghai", "args": {} }
]
```

其在调度器中的记录为 `execution.kind: space_action`，即按时调用指定函数、保留运行历史。这条路径执行的是 Action 内的确定性代码；只有当 Action 自己调用 `ctx.inference` 时才涉及模型（样本中仅新闻提炼、报告撰写环节用模型，行情计算全部是确定性代码，模型失败时降级为事实汇总）。

- **Muse 通用定时任务（cron 任务）**：以任务说明书形式运行，**每轮由后台工作代理执行，通常涉及大模型**，适合「检查 + 判断 + 通知」类工作，不适合当作纯代码的 cron 替代品；触发时间是近似的（平台文档：可能有数分钟偏差，有时提前）。
- **不存在**用户可自维护的 Linux `crontab` / `systemd timer` 保证：不要把「写个 crontab」写进部署方案。纯代码、无模型、定时的需求，一律收敛为「Space Action + managedCronJobs」；VM 侧脚本的定时需求，则由 Muse 代理的定时任务拉起脚本，脚本本身应设计为可被反复调用、幂等、快速退出。

### Q10. 是否支持长期运行 HTTP Server？是否支持 Space 调用该 Server？

**不支持作为正式架构。实测边界如下：**

- 实测：在 VM 内启动 `python3 -m http.server` 绑定 `127.0.0.1` 后，本机 `curl` 可正常访问（HTTP 200）——说明进程在运行期间可以监听本地端口。
- 但平台没有提供：公网入站地址/端口映射、域名、反向代理配置、进程守护与开机自启。进程随会话/任务结束或 VM 重启而消失（见 Q11），无人保证其存活。
- Space 更不能调用它：Space 前端只能调用自身 `./actions` RPC；Space 的 Server Action 运行在平台运行时中，不是「与 VM 脚本同机的 Web 后端」，没有约定可达的 `localhost` 服务发现机制。把外部 API 密钥、抓取、计算放进 Action 或 VM 批处理，不要放进自建 HTTP 服务。
- 结论：**禁止**以「常驻 HTTP Server」为前提做设计。需要请求-响应语义时用 Server Actions；需要周期计算时用 Q9 的定时 Action；需要一次性计算时用 VM 脚本 + 文件交接。

### Q11. 文件、数据库及程序在 VM 重启后是否保留？

**文件与数据库保留；正在运行的进程不保留。**

- 平台文档确认：文件保存在这台专属计算机上，对话结束不清除、无到期删除；工件（Space）数据「跨重启与更新持久」。实测样本：Space 的 `app.db` 与三个历史版本快照（`~/workspace/space-versions/<slug>/v1…v3`）均在盘上。
- 持久目录：`~`（即 `/home/hatch`）及其下的 `~/workspace/`。该卷实测总量 150 GB、验证时可用约 149 GB（这是整卷观测值，不是对单个项目的配额承诺）。
- 非持久：`/tmp` 为 tmpfs（实测 512 MB），重启即失，**只能放临时文件**；系统目录（`/usr`、`/etc` 等）下的改动不保证保留，软件不要往那里写状态。
- 进程：VM 重启、会话结束后，后台进程、HTTP 服务、终端会话都不保留。所有长期能力必须设计成「被定时任务/Action 重新拉起即可续跑」，状态全部落盘。

### Q12. 是否支持安全存储 API Key 和环境变量？

**支持凭据的安全托管，但没有给任意用户代码用的通用 `.env` 保险箱。红线如下：**

- 平台机制（官方文档）：密码、API Key 等凭据通过 **Secure Vault 安全录入卡 / 连接器** 托管；代理只能确认凭据「存在」，**永远读不到、也不能复述存储的明文值**；一次性验证码以不透明引用短时（约 10 分钟）传递。
- 因此外部代码必须这样写：**密钥从运行环境注入读取（如 `os.environ["XXX_API_KEY"]`），代码库中只出现变量名**；交付物中禁止出现真实密钥、写死的 Token、含密钥的 `.env` 文件。
- 普通环境变量在单次命令执行中可用（实测 `FOO=bar python3 ...` 可读到），但它不是持久化密钥存储：不要指望在 VM 里 `export` 一次就长期有效，也不要把密钥写进 `~/.bashrc`、脚本或 JSON 配置留存。需要长期使用某服务的密钥时，在交付说明中列出「需要的变量名 + 用途 + 申请地址」，由用户通过 Muse 的安全流程提供，部署时由 Muse 代理在受控环节注入。
- Git 交付同理：仓库里只提交 `.env.example`（变量名 + 假值），真实 `.env` 永远不进仓库。

---

### Q13. CPU、内存、磁盘、网络及后台任务有哪些资源限制？

**实测与运行时观测值（非营销承诺，写代码时按保守值设计）：**

| 资源 | 实测/观测 | 设计含义 |
|---|---|---|
| CPU | VM 可见 4 vCPU（AMD EPYC 9D25）；代理执行单元的共享配额为 **1.5 核**（运行时 `sharedCpuMillis: 1500`） | 单次任务按约 1–2 核的有效算力设计，重计算要分片、可中断续跑 |
| 内存 | VM 总内存 7.7 GiB（+1 GiB Swap）；代理执行单元共享上限 **6 GB**（`sharedMemoryLimitBytes: 6442450944`） | 单进程内存控制在 2 GB 以内更稳妥；大文件流式处理，不要全量载入 |
| 磁盘 | 持久卷 150 GB（验证时可用约 149 GB）；`/tmp` 512 MB tmpfs；工作区当时占用约 164 MB | 持久卷空间充裕但不是无限对象存储；大媒体/大批量原始数据先与用户确认 |
| 文件句柄等 | `ulimit`：打开文件 4096、栈 8 MB、用户进程数 27114、CPU 时间不限 | 常规脚本足够；高并发连接池要设上限 |
| 网络 | 出站 HTTPS 可用，实测 GitHub、PyPI、npm Registry、example.com 均可达；无入站公网暴露 | 只能做「向外拉取/调用 API」，不能做「对外提供服务」；调用第三方 API 要遵守对方限频，遇 429 立即停 |
| 后台任务 | 定时任务触发时间近似（数分钟级偏差）；单次命令执行有产出与时长约束，长任务会被转入后台并回报结果 | 任务拆小、幂等、写进度文件；不要写无限循环或无退出条件的守护逻辑 |
| 容器/特权 | 无 Docker；实测当前会话为 root 身份，但这不构成「可改系统配置」的授权，系统层改动不持久（见 Q11） | 不用 Docker 方案交付；不依赖 systemd 服务、系统包全局安装 |

未在上表中的硬性数字（如 Space 单库大小上限、单 Action 超时秒数）平台未给出可引用值：设计时把单次 Action 控制在「秒级完成、批量分页」的量级，确需大批量处理时拆到 VM 脚本侧分批产出、Action 分批导入。

### Q14. 能否导出现有 Space 的用户应用源代码，交给外部开发工具修改后重新导入？

**能导出、能回导，但回导必须经 Muse 的构建流程发布，不能覆盖文件后直接生效。**

- 导出基础（实测）：全栈 Space 的源码就是普通文件，位于 `~/workspace/ts-spaces/<slug>/`，含 `client/src/`、`server/src/`、`drizzle/`、`package.json`、`space.json` 等；每次构建还留有完整版本快照 `~/workspace/space-versions/<slug>/v1…v3/tree/`（含 `files.json`/`version.json` 清单）。Muse 代理可以把源码打包为 ZIP 交给用户，用户再交给 Codex 修改。
- 数据与源码分离：`app.db` 是运行数据，不属于源码导出；外部修改时不要动它，也不要把快照里的构建产物（`client/dist/`、`server/dist/`、`.space-build/`）当源码改。
- 平台规则（样本 Space 的 `AGENTS.md`）：构建、审计、发布只能通过平台的 Web 工件工具完成；**不要手改构建产物目录，不要以为在目录里跑 `bun run build` 就能发布**。
- 回导流程：用户把修改后的源码交回 → Muse 代理比对/合入 `~/workspace/ts-spaces/<slug>/` 的源码区 → 通过构建工具重新构建、审计、发布为新版本。外部工具不要自行发明发布脚本。
- 给外部修改者的约束：保留 `space.json` 的 `slug`/`runtime`、保留 `client/src/main.tsx` 中 SDK 要求的根节点结构与 `QueryClientProvider` 包裹、保留 `api.ts` 的类型导入方式（`import type`），否则构建会失败或布局静默损坏（依据样本源码注释）。

---

## 2. 运行环境速查（给 Codex 的硬约束清单）

```text
OS / Arch     : Ubuntu 24.04.5 LTS, Linux x86_64 (amd64), KVM
Python        : 3.12.3 —— 命令名 python3；依赖必须进 .venv (PEP 668)
Node / npm    : Node v24.22.1 / npm 10.9.4
Bun           : 1.4.4 (Space 构建以模板声明的 bun@1.3.10 为准)
TypeScript    : 5.6.3 (Space)
React         : 19.2.5 (仅 Space 前端)
DB            : SQLite 3.45.1 (CLI + Python + Space/Drizzle)
Compilers     : gcc/g++ 13.3.0
Absent        : Docker, Go, Rust, Java, Ruby, PHP, PostgreSQL, MySQL, Redis
Timezone      : VM 系统时区以 UTC 为主；业务时间在代码中显式处理
                (用户时区 Asia/Shanghai；美股类业务用 America/New_York 计算交易日)
Encoding      : UTF-8；面向用户的文案默认简体中文，价格/金额须标明币种
```

编码时默认遵守：不写死绝对路径中的用户名，使用相对路径或环境变量；时间一律存 UTC 时间戳或带时区 ISO 字符串，展示层再转换；数值缺失用 `null` 并在界面显示「不可用」，禁止编造或用 0 冒充。

## 3. 目录结构规范

### 3.1 VM 侧项目（脚本/数据工程）

```text
~/workspace/<project-slug>/          # 小写连字符命名，与用户确认后固定
├── README.md                        # 目的、入口命令、输入/输出、所需环境变量名
├── requirements.txt                 # Python 依赖，锁定版本 (或 package.json)
├── .venv/                           # 本地虚拟环境，不交付、不进 git
├── src/                             # 源码
├── data/                            # 持久数据 (SQLite、中间结果)，进持久卷
│   └── app.sqlite3
├── out/                             # 给 Space 的交接产出 (见 5.2 文件交接协议)
│   └── latest.json
├── logs/                            # 运行日志，滚动清理，禁止写密钥
└── .env.example                     # 仅变量名与假值
```

禁止：把项目放在 `/tmp`、系统目录或 `~` 根目录散放文件；把数据写进 Space 目录内部（Space 目录由构建工具管理）。

### 3.2 Space 侧项目（全栈，固定脚手架，不可自创结构）

```text
~/workspace/ts-spaces/<slug>/
├── space.json            # runtime/name/slug/entry/managedCronJobs —— slug 不可改
├── package.json          # 依赖以模板为基线，新增依赖须说明理由
├── bunfig.toml / bun.lock
├── client/
│   ├── index.html
│   ├── build.mjs         # 固定调用 SDK buildClient()，不自写打包配置
│   └── src/
│       ├── main.tsx      # 保留 SDK 根节点与 QueryClientProvider 结构
│       ├── App.tsx       # 界面实现
│       ├── api.ts        # 固定模式: createActionClient<typeof Actions>()
│       └── theme.css
├── server/
│   └── src/
│       ├── actions.ts    # 全部服务端逻辑: defineAction(...) 导出 Actions
│       └── schema.ts     # Drizzle SQLite 表定义
├── drizzle/              # 数据库迁移 SQL，按序号递增，只增不改历史迁移
└── app.db                # 运行时数据库 (平台管理，外部勿碰)
```

静态 Space 只有一个自包含 `index.html`（+ `assets/`），无 server、无数据库、无定时任务能力；复杂功能一律用全栈形态。

---

## 4. 依赖管理规范

1. Python：`requirements.txt` 锁定版本（含次版本，如 `httpx==0.28.1` 的粒度按项目习惯统一）；部署命令固定为建 venv 后安装（见 Q4）。不使用全局 pip，不使用 `--break-system-packages` 作为常规方案。
2. Node/VM 项目：提交 `package.json` + lockfile；运行时选 Node 24 或 Bun 二选一并在 README 写明，不要混用。
3. Space 项目：包管理器固定 Bun；依赖基线为模板版本（React 19.2.5、drizzle-orm 0.45.2、zod 4.4.3、@tanstack/react-query 5.100.10、recharts 2.15.3、tailwindcss 4.1.13）；新增依赖要小而必要，UI/图表优先用已有库实现。
4. 原生依赖（需编译的 Python 包、C++ 扩展）必须在交付说明中标注，并在 x86_64 + Ubuntu 24.04 下可构建；优先选有 manylinux x86_64 wheel 的包。
5. 不引入需要 Docker、系统级服务、浏览器内核常驻或 GPU 的依赖。

## 5. 数据交互接口规范

### 5.1 Space 内部：Action 即 API

- 每个 Action 用 `defineAction` 定义，必须带 Zod 的 `request`/`response` 模式与一句 `description`；前端通过 `api.ts` 的类型化客户端调用，类型直接来自 `server/src/actions.ts` 的 `Actions` 导出，无代码生成步骤。
- 命名：读操作 `getXxx`/`listXxx`，写操作动词开头（`addSymbol`、`refreshMarket`）；定时入口统一命名 `scheduledRefresh` 并在 `space.json.managedCronJobs` 中引用。
- 服务端上下文 `ctx` 提供：`ctx.db()`（Drizzle 数据库）、平台工具（如行情 `ctx.tool.finance_ticker`、网页搜索）与 `ctx.inference`（模型提炼/生成）。模型只用于非确定性环节；计算、校验、去重、状态机必须写确定性代码，且模型失败时要有降级输出而不是静默为空。
- 数据库变更只走 `drizzle/` 新增迁移文件 + 同步更新 `schema.ts`；禁止改写已发布的历史迁移。

### 5.2 VM 脚本 ↔ Space：文件交接协议（外部代码接入的默认方式）

VM 侧程序不直接连 Space。产出文件写入项目 `out/` 目录，约定如下：

```json
// out/latest.json —— 单次产出的完整快照，UTF-8
{
  "schema_version": 1,
  "generated_at": "2026-11-26T09:30:00Z",
  "source": "<数据来源名称>",
  "records": [ { "...": "业务字段，缺失值用 null" } ]
}
```

- 文件写入采用「先写临时文件、再原子重命名」方式，避免 Action 读到半成品。
- 大批量数据用 JSONL 或 CSV 并在 README 中写明列定义；时间字段一律 ISO 8601 带时区；每条记录带来源与采集时间，禁止无来源数字。
- Space 侧提供 `importLatest` 类 Action 负责：读文件 → Zod 校验 → 去重/upsert 落库 → 记录导入日志（成功/失败原因、条数）。导入失败保留旧数据，不清空表。
- 若数据由 Action 自己能直接获取（平台工具可达），优先 5.1 的 Action 内直算，不要绕 VM 一圈。

### 5.3 状态与幂等

- 所有定时/重复执行的逻辑必须幂等：以业务唯一键 upsert；预警/通知类逻辑要有去重键与冷却状态（样本实现：同日同标的同规则只保留最高等级一条）。
- 长任务写进度与结果摘要到 `logs/` 或数据表，失败要留下可读的失败原因，不允许静默失败。

---

## 6. 密钥与环境变量规范

1. 代码只读环境变量：Python 用 `os.environ["NAME"]`，Node/Bun 用 `process.env.NAME`；缺失时报出变量名并退出，不写默认值密钥。
2. 仓库只含 `.env.example`；真实密钥不进 git、不进 ZIP 交付包、不进日志、不进 Space 前端代码（前端代码对用户可见，任何写进 `client/` 的密钥等于公开）。
3. Space 服务端 Action 同理：密钥不得出现在 `client/` 与构建产物中；需要密钥的第三方调用放在服务端 Action 或 VM 脚本中完成。
4. 交付时用一张表列明所需凭据：变量名、服务商、用途、权限范围、申请入口。由用户通过 Muse 的 Secure Vault/连接器流程提供，Codex 侧不收集、不保存用户密钥。

## 7. 部署方式（标准流程）

```text
1. 交付   Codex 产出源码包 (git 仓库链接或 ZIP) + README + 依赖清单 + 所需变量表
2. 落地   Muse 代理克隆/解压到 ~/workspace/<project>/ (Space 代码则合入 ts-spaces/<slug>/)
3. 装依赖 Python 建 .venv 并装 requirements；Node/Bun 按 lockfile 安装
4. 自测   代理运行项目自带测试/冒烟命令，核对 out/ 产出样例与本规范第 5 节协议
5. 集成   Space 侧补/改 Action 与迁移，经平台构建工具 build → audit → 发布新版本
6. 定时   需要周期运行时，在 space.json.managedCronJobs 声明或建 Muse 定时任务
7. 验收   用户在 Space 界面核对真实数据；版本快照自动留存，可回退到上一版本树比对
```

注意：不存在 SSH 直连部署、CI/CD 流水线接入点或 `git push` 自动发布；每一次发布都经 Muse 代理执行构建工具并留版本快照。

## 8. 持久化机制小结

| 内容 | 位置 | 重启后 | 备注 |
|---|---|---|---|
| VM 项目文件与数据 | `~/workspace/<project>/` | 保留 | 含 SQLite、out/ 产出、日志 |
| Space 源码 | `~/workspace/ts-spaces/<slug>/` | 保留 | 另有 `space-versions/<slug>/vN/tree/` 快照 |
| Space 业务数据 | Space 目录内 `app.db` | 保留 | 仅经 Action/Drizzle 访问 |
| 临时文件 | `/tmp` (512 MB tmpfs) | **丢失** | 只放可重建的中间文件 |
| 运行中进程 | 内存 | **丢失** | 靠定时/Action 重新拉起，状态落盘 |
| 系统层改动 | `/usr`、`/etc` 等 | 不保证 | 不依赖 |

## 9. 平台限制清单（设计前必读，违反即返工）

- [ ] 没有常驻 HTTP 服务、没有入站网络、没有公网地址。
- [ ] 没有 Docker、没有 systemd 服务托管、没有用户自维护 crontab 保证。
- [ ] Space 前端只有 React + TypeScript 一条路线（或静态单页 HTML）；无 Vue/Angular/Next.js。
- [ ] Space 数据库只有 SQLite，且只能经 Drizzle/Action 访问，外部禁直连 `app.db`。
- [ ] Python 系统级 pip 被锁（PEP 668），必须用 venv；无 Go/Rust/Java/Ruby/PHP 工具链。
- [ ] 二进制与原生扩展必须是 Linux x86_64 / Ubuntu 24.04 兼容。
- [ ] 定时触发是近似时间（分钟级偏差），不承诺秒级准时与实时流式处理。
- [ ] 单次执行算力按约 1.5 核 / 6 GB 共享配额保守设计；重任务分片、幂等、可续跑。
- [ ] 密钥不进代码与仓库；前端零密钥；凭据经 Secure Vault/连接器提供。
- [ ] 静态 Space 可对外发布公开链接；交互式（全栈）Space 不能公开发布，只能在用户自己的 Muse 内使用。

## 10. 给 Codex 的交付清单模板

每次交付请附：

```markdown
## 交付说明
- 目标与功能边界：
- 运行形态：[ ] VM 脚本  [ ] Space 全栈  [ ] Space 静态页  [ ] 两者集成
- 入口命令 / Action 列表：
- 依赖清单文件：requirements.txt / package.json (已锁定版本)
- 所需环境变量：变量名 | 用途 | 申请入口 (无真实值)
- 输入 / 输出：文件路径与格式 (遵循 5.2 协议)、样例各一份
- 定时需求：频率、时区、期望动作 (或注明无)
- 测试：自带测试/冒烟命令与预期输出
- 已知限制与未验证项：如实列出，不写推测性结论
```

---

*本文档基于 2026-11-26 在目标 VM 与现有 Space 上的实测结果编写。平台升级后版本号与资源数值可能变化；接入新项目时，先请 Muse 代理复测第 1 节中与该项目相关的条目，再开工。*
