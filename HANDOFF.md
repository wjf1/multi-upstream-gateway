# HANDOFF — 多上游 AI 网关（commandcode-proxy 底座）

> 跨会话/跨 Agent 接力首要读物。先读本文 → `PLAN-STATE.md`（进度唯一事实）→ 执行依据方案。
> **本文件所在目录 = 唯一工程仓库 = 真实部署目录**。

## 1. 项目概况与当前状态

- **定位**：以 commandcode-proxy 为底座，把 Freebuff2API 与 workbuddy2api-panel 两个 Go 项目重写为 TS Provider 适配器，形成单面板三源（CommandCode / Freebuff / 腾讯 CodeBuddy）统一 AI 网关。
- **产品仓库（2026-10-07 建立）**：`https://github.com/wjf1/multi-upstream-gateway`（**PUBLIC**，默认分支 `main`）。
  产品线已与上游分化为独立仓库，但**完整保留上游历史**（`main` = 上游 v4.22.4 `87b1a05`），故仍可 `git merge upstream/main` 吸收上游改动。
  **版本线自 v5.0.0 起**（勿与上游 v4.22.x 撞号）。
- **工程仓库（唯一工作副本）**：`C:\Users\admin\Doubao\chats\2026-09-03\new-chat-5\commandcode-proxy`
  —— 上游 **v4.22.4** 基线 + Phase A~F 移植（**已部署**），当前分支 **`feat/p0-port`**。
  remote 布局：`origin` = 产品仓库（推送目标）、`upstream` = `wjf1/commandcode-proxy`（**仅 fetch，禁止 push**）、`ghproxy` = 上游镜像。
- **执行依据（SSOT）**：`docs/master-plan-v1.2.md`（已纳入仓库）（v1.2.3 起含基准勘误）。
  审计与评审材料（已随仓库分发）：`docs/review/`（`batch-b.patch`、`architecture-review.md`、`remediation-plan.md`）。
- **当前状态（2026-10-07）**：**P0 移植已完成并部署，产品首发 v5.0.0；随后发布 v5.0.1（上游流中断重试修复）、
  v5.0.2（产出内容前的空闲超时也纳入重试）、v5.0.3（把该判据从「有没有字节」下沉到「有没有内容事件」——
  v5.0.2 的延窗门槛因 CC 流以 `start` 开场而永不成立，等于没生效）**。见 §4 首条。
  - **Phase A~F 全部完成**：A 工程基座 / B 审计批次 B 安全语义 / C 新增模块 / D1 接缝接线 / E 面板移植 / F 阶段门复验。
  - **门禁数据（F）**：`npm run verify` **50 文件 / 658 用例全绿**；覆盖率 65.87%；`npm audit --omit=dev` **0 漏洞**；50 并发 P99 126ms / 468rps / 0 错误。
  - **门禁数据（v5.0.1）**：`npm run verify` **51 文件 / 667 用例全绿**、`npm run lint` 零输出、`npm run typecheck` 双工程通过；新增 1 文件 9 用例锁定「内容产出前中断必重试 / 内容产出后必不重试」。
  - **门禁数据（v5.0.2，未推送）**：`build` / `lint` 零输出、src 工程 `tsc --noEmit` 通过；
    `npx vitest run --exclude '**/commandcode-provider.test.ts'` **55 文件 / 713 用例全绿**（+4 例）。
    ⚠️ 该条目写作时的 tests 工程 typecheck 红项（并行会话未跟踪的 `tests/commandcode-provider.test.ts`）
    **已消除**：`src/providers/commandcode/provider.ts` 已由 P0-PORT-D2 交付（见 §4），全量门禁恢复全绿。
  - **门禁数据（v5.0.3，本次）**：`npm run typecheck`（src+tests 双工程）0 错误、`npm run build`（经 `pretest`）通过；
    仅**跟踪**文件（CI 视角 `git ls-files 'tests/*.ts'`）**64 文件 / 804 用例全绿**。
    全量跑的 3 个红项全在**未跟踪**的并行会话 WIP 文件（`tests/credential-store.test.ts` / `usage-provider.test.ts` /
    `snapshot/`，且两次跑动红项集合不同），与探测/流路径无交集。
  - **门禁数据（P1 D2/T204'/T205' 后，最新）**：全量 **58 文件 / 754 用例全绿**（713 + D2 19 例 + workbuddy 22 例）；
    `npm run typecheck`（src+tests 双工程）0 错误；`npm run lint` 零输出。
  - **已部署（2026-10-07）**：看门狗第 5 秒拉起新代码；`config.json` flat→unified 迁移完成、凭据落 `credentials.enc`（`.env` 明文行已摘除）；
    **风险门经用户在面板确认后放行**。详见 §7 部署检查清单。
  - **代理端口已收敛（2026-10-07）**：Clash 混合端口经用户在界面固定为 **7900**，四处编码（`.env` / `config.json` 的 `upstream.proxy` /
    `watchdog.ps1` / `start.cmd`）现已一致；重启后日志 `Outbound HTTP(S) proxy armed: http://127.0.0.1:7900/ (probe: 3ms)`，
    真实对话经该链路成功。**教训**：该端口在本机有四处副本且**环境变量优先级高于配置文件**，任一处不同步都会
    「改了不生效」或静默回退直连；端口曾在 7897/7900 间来回变更过，故请保持固定。
  - **基准勘误（保留为教训）**：方案基线事实曾基于过期检出 v4.17.0，真实基准是 v4.22.4；基线事实必须「版本号 + 验证命令」同引。
  - **多上游进度（2026-10-07）**：实际可用上游**仍是 CommandCode 一个**。三源 Provider 外壳均已就位：
    CommandCode（P0-PORT-D2 薄适配层）/ Freebuff（T201、T202a、T202b、T203）/ WorkBuddy（T204' 联邦透传 + T205' 账号委托）。
    **T213 阶段 1（运行时接线，`9b98d9d`）与阶段 2（数据面切路由，`af6db03`）均已完成**：
    ProviderRuntime 装配三源 + registry/router、`/api/providers` 状态/总闸/默认上游切换（热生效 +
    routing 分片持久化）、`/v1/models` 命名空间聚合（分片门控，缺省行为不变）；chat/messages 经
    六步路由分发三 Provider，commandcode 走既有通路（零回归），freebuff/workbuddy 走文本增量契约
    双出口（OpenAI chunk / Anthropic 桥）。**实际可用上游仍是 CommandCode 一个**——Freebuff 需配置
    `providers.freebuff` 分片 + FREEBUFF_TOKENS，WorkBuddy 需 sidecar 二进制（联邦）。
  - **P1 已完成七卡 + T213 两阶段**：T201 / T202a / T202b / T203 / P0-PORT-D2（`1e011a5`）/
    T204'（`47f8a3a`）/ T205'（并入）/ T213·阶段 1+2（`9b98d9d`/`af6db03`）。
  - **当前门禁与远端（2026-10-08）**：`npm run verify` **79 文件 / 993 用例全绿（1 skipped）**；
    `typecheck` 双工程 0 错误、`lint` 零输出、`npm audit --omit=dev` 0 漏洞。
    产品仓库为 **PUBLIC**（`wjf1/multi-upstream-gateway`）。**`main` 与 `feat/p0-port` 已快进合并并推送成功，
    远端两者同为 `8340e68`**（含 T208~T213b、v5.0.3 与本轮 5 个提交）。
    公开前已核查：无敏感文件被跟踪、无凭据模式命中、历史中亦从未提交过 `.env`/`config.json`/`credentials.enc`。
- **分支模型**：**`main` = 产品主线**（默认分支）；`feat/p0-port` = 移植集成分支。
  **2026-10-08：`main` 已快进合并 `feat/p0-port` 并推送**（基点 `8168a54` → 合并后同点 `8340e68`）——
  此前 `main` 落后集成分支 14 个提交（T208~T213b 与 v5.0.3），"产品主线"名不副实的问题已消除。
  后续从 `main` 或新建 `feat/*` 拉起皆可，合回 `main` 时保持快进（线性历史，与既有习惯一致）。
  上游基线**不再占用 `main`** —— 需要吸收上游时直接用 `upstream` remote（`git fetch upstream && git merge upstream/main`），合并基点即上游 v4.22.4 `87b1a05`。
  **版本线已定**：自 **v5.0.0** 起另起序列（破坏性变更：风险门默认 403 / 凭据加密启动前置 / 配置形态迁移）；
  四文档（`package.json` / `CHANGELOG.md` / 中英双语 `README.md` / 本文件）已同步，Release 按 `v<版本>: <中文摘要>` 规范。

## 2. 技术栈与运行基线

- 运行时：Node **>=20**（4.22.4 已满足；本机 v22.23.2）；TypeScript **5.9.3** strict；ESM（`"type":"module"`）。
- 运行时依赖：`fastify 5.12.3`、`undici 7.29.1`（**4.22.4 已有**，出站统一走它 + `proxy-agent.ts`）；
  移植新增：`zod 3.25.76`、`chokidar 5.0.0`（chokidar 5 为移除 braces 高危，chokidar 4+ 不再依赖 braces）。
- dev 依赖：vitest 5.0.0、typescript-eslint 8.70.0、eslint 10.10.0、esbuild 0.28.2、
  **`@yao-pkg/pkg` 6.22.0**（维护中的 pkg fork——此前担忧的 "vercel/pkg 停维护" 风险在本线已解决，`build:win` 目标已是 node22）。
- 依赖策略：全部精确版本（本次 Phase A 已去 `^`/`~`）。
- **门禁三件套**：`npm run verify`（build + test）、`npm run typecheck`（src+tests 双工程，经 `tsconfig.test.json`）、`npm run lint`（零输出）。
- 测试基线：**78 文件 / 984 用例全绿（1 skipped）**（P0 测试补齐与 T214 阶段门自动化取证后；此前 64/801、63/793、61/777、60/767、58/754、v5.0.2 为 55/713、v5.0.1 为 51/667、v5.0.0 为 50/658、v4.22.4 原始基线 48/626；红线只升不降）。
- 其它脚本：`npm run dev` / `start` / `build:win` / `setup`（启动向导，移植自 P0）/ `test:coverage`。

## 3. 核心架构与文件拓扑

- 入口 `src/index.ts`（含 4.22.4 的代理自愈初始化、崩溃保护、自动额度轮换调度）。
- `src/routes/`：`chat.ts`（OpenAI `/v1/chat/completions`）、`messages.ts`（Anthropic）、`dashboard.ts`（`/api/*` 管理面 + 面板静态资源）、`sse-common.ts`。
- `src/adapters/commandcode/`：**4.22.4 已模块化** —— `adapter.ts`、`anthropic-response.ts`、`reasoning.ts`、`pipeline/`。
  （方案原计划 "T108 整目录 3 文件平移" 的前提已失效，Phase D 需重新决定是否搬到 `providers/commandcode/`。）
- `src/utils/`：4.22.4 既有 `proxy-agent.ts`（出站代理 + IPv4 优先自愈）、`config.ts`、`errors.ts`、`logger.ts`、`paths.ts`、`request-context.ts`、`usage-store.ts`、`models.ts`、`quota-tracker.ts`、`notifier.ts`、`update-check.ts` 等；
  **移植新增**：`unified-config.ts`（统一配置+Zod+热重载）、`credential-store.ts`（AES-256-GCM 凭据加密）、`rate-limiter.ts`、`security-guard.ts`、`sanitize.ts`、`audit-log.ts`、`safe-fetch.ts`（SSRF 二跳）、`risk-gate.ts`（合规风险门）、`admin-guard.ts`（批次 B 管理面鉴权）。
- `src/providers/`：**移植新增** —— `core/{interface,router,registry}.ts`（Provider 契约/六步路由/模型命名空间注册表）、`freebuff/**`（T201，7 文件 2,388 行）。
- `public/index.html`（**1816 行**）+ `public/vendor/`（Tailwind/Chart.js/FA 已本地化）。面板脚本外置与 `/js/*` 路由属 Phase E。
- `scripts/`：`extract-release-notes.mjs`（4.22.4 既有）、`setup.mjs`、`bench-baseline.mjs`、`collect-fixtures.mjs`（移植）。
- `docs/wb-source-diff-report.md`：G0-T2 的 WorkBuddy 源码差异核实与**架构裁决（联邦）**。
- SSOT 链：执行依据方案 → `PLAN-STATE.md` → `CHANGELOG.md` → commit body（DoD 证据）。

## 4. 最近一轮变更与交付成果

- **T203 账号池遗留收口 + 全新克隆门禁阻塞缺陷修复（2026-10-08）**：
  - **① 指定上游账号（`X-Upstream-Account`）端到端接线**（收口 T203 登记的
    「`preferredAccountId`/`onRetry` 未透传到选号」）：此前这两个字段只存在于
    `providers/core/interface.ts` 的 `ChatOptions` 里，`src/routes/` 下 grep 零命中 —— 契约空转。
    现打通三段：`routes/provider-dispatch.ts` 导出 `resolvePreferredAccount()` 解析请求头
    （重复头取首值、空白视为未指定）→ `chat.ts`/`messages.ts` 两个出口透传 →
    `RunManager.acquire(agentId, preferredAccountId?)` 在 `selectStartIndex()` 里把「指定账号」
    置于 selector 与 round-robin 之上；**未命中/已暂停时告警回退**（不让坏账号把请求打挂）。
    重试侧 `FreebuffProvider.chatCompletion` 在三类换号重试前调用 `opts.onRetry(attempt, err)`，
    返回值决定下一轮账号（与 commandcode 适配器 `onRetry` 同契约）。
    测试 `tests/freebuff-preferred-account.test.ts` 9 例。
  - **② `tests/snapshot/scenarios.mjs` 被 `.gitignore` 的 `*.mjs` 吞掉、从未入库**（阻塞级）：
    开发机上该文件只在磁盘（未跟踪）→ 门禁全绿；**全新克隆**跑 `npm run typecheck` 必报 3 条
    `TS2307`、快照套件 import 失败。这是避坑 #2 记的 `*.mjs` 坑**第三次复现**。
    已补 `.gitignore` 例外并按其调用契约重建该文件，`renderScenario('commandcode-chat-basic')`
    与既有 fixture **逐字节比对通过**（未改写任何 fixture）。
  - **③ 构建产物改名**：`build:win` 输出 `commandcode-proxy-v4.exe` → `multi-upstream-gateway-v5.exe`
    （README 中英双语同步）；顺带对齐 `package-lock.json` 中滞留的上游包名/版本（`commandcode-proxy-v4` /
    4.22.4 → `multi-upstream-gateway` / 5.0.3）。
  - **门禁**：`npm run verify` **79 文件 / 993 用例全绿（1 skipped）**（984 + 新增 9 例）；
    `typecheck` 双工程 0 错误（修复前 3 条 `TS2307`）；`lint` 零输出；
    `npm audit --omit=dev` **0 vulnerabilities**。
  - **未做（有意）**：`FreebuffAccountPool`（`providers/freebuff/account-pool.ts` 契约适配层）
    仍未接生产代码 —— 它与 RunManager 自身选号是双轨，接入要成立两套调度，理由与 D2「不搬家只薄包装」同；
    `updateConfig` 热改 Token 仍待（凭据变更目前需重新 initialize）。

- **P0 移植测试完整补齐与 T214 阶段门自动化指标全绿（2026-10-07）**：
  - **背景**：推进 T214 阶段门验收时，复核发现旧树中此前未移植至 4.22.4 树的 13 个关键单元/集成测试与
    T107 快照基础设施（`tests/snapshot/` 完整用例、scenarios 及 upstream/snapshots fixtures）遗漏，
    导致移植队列 §1 的 P0-PORT-A/B/C 滞后未闭环。
  - **移植与修复**：将 13 个测试文件及快照套件完整搬入新树，并适配 4.22.4 行为漂移：
    ① `src/utils/config.ts`：支持 `COMMANDCODE_ENV_PATH` 兼容别名（与 `credential-store.ts` 对齐），
       并在显式接管 `COMMANDCODE_CONFIG_PATH` 时放行配置迁移测试；
    ② `src/utils/usage-store.ts`：§3.9 口径修复，`costUsd` 严格区分 `null`（积分计费无 USD）与 `0`（免费），
       禁止把积分混加为 $0；
    ③ `tests/credential-store.test.ts` / `tests/snapshot/snapshot.test.ts`：显式隔离 `CREDENTIAL_STORE_PATH`，
       防止测试感知本机操作者真实的 `~/.commandcode/credentials.enc` 造成假红。
  - **门禁与覆盖率（全绿）**：
    - 全量 `npm run verify`：**78 测试文件 / 984 用例全绿（1 skipped）**，零失败用例；
    - 覆盖率：**Statements 80.97%**（5003/6179）、Conditionals 68.30%、Methods 82.70%，远超 ≥55% 门槛；
    - 静态门禁：`npm run typecheck` 双工程 0 错误；`npm run lint` 零告警零输出；
    - 安全审计：`npm audit --omit=dev` 0 vulnerabilities；
    - 5 分钟泄漏监控：独立脚本 `scripts/soak.mjs` 跑满 300s，400/400 请求成功（0 失败），
      RSS 114.8MB → 83.0MB（净增长 -31.9MB），无内存泄漏；
    - 快照测试：CommandCode 端到端流式/非流式快照通过；Freebuff 快照通过。
  - **队列状态更新**：`PLAN-STATE.md` §1 移植队列中 P0-PORT-A/B/C 全部勾选标记完成；
    T214 阶段门完成自动化指标取证，登记剩余外部 Blocker（Freebuff Token / WB sidecar Go 二进制 / 负责人签字）。

- **T213b 配置源收口（2026-10-07，`5658065`）**：`utils/config-store-runtime.ts` —— UnifiedConfigStore
  进程单例（chokidar 热重载），非空 `rateLimit` 分片注入限流器、`modelAccess` 分片驱动模型访问守卫
  （**store 非空优先、env 回退**，缺省部署零破坏；bootstrap 失败不阻断启动）；legacy 扁平分支
  `syncEnvFile` 在加密库可用时不再写明文 `COMMANDCODE_API_KEY` 并摘除旧行（T103 残留最后一个
  明文写入点收口）。测试进程跳过装配（同 loadConfig 迁移守卫口径）。**遗留登记**：判定路径合一
  （security-guard 与路由级守卫的两套 modelAccess/限流执行路径）→ P2 评估。
  门禁：`npm run verify` **64 文件 / 801 用例全绿**；typecheck 双工程 / lint 0 错误。

- **T208~T212 面板五页（2026-10-07，`85b0ed9` + `d2611c7`）**：
  - 「上游」页签（第 6 个 tab）：Provider 卡片（健康/可用/冷却计数、WorkBuddy sidecar 进程行、initError）、
    启停总闸（热生效）、设为默认（持久化）；总览异常横幅（health 异常出现/恢复消失，**T213 DoD 全项收口**）。
  - 账号页多上游账号分栏（凭据脱敏/不出 sidecar）；模型目录命名空间徽章；用量页分上游口径表
    （`GET /api/usage/by-provider`，§3.9 不跨上游混加）。
  - 取证源清单（dashboard-spa / spa-risk-gate / spa-a11y）声明式扩容 'upstream'（Phase E 先例，断言不改）；
    新增 spa-upstream 12 例 + multi-source-panel 6 例。
  - 门禁：`npm run verify` **63 文件 / 793 用例全绿**；typecheck 双工程 / lint 0 错误。

- **T213 阶段 2：数据面切路由 + 默认上游切换（2026-10-07，`af6db03`）**：
  - `routes/provider-dispatch.ts`——非 commandcode 决策的渲染层：chat 出口（OpenAI chunk 序列 +
    非流式聚合）与 messages 出口（AnthropicStreamEncoder 块生命周期）；错误语义对齐既有路由
    （未产出字节回 HTTP 信封 / 流中并入内容 / 客户端中止不落用量）；15s 空闲防断。
  - chat.ts / messages.ts 在 translate **之前**做六步路由决策（剥前缀回写 body.model）；
    commandcode 走既有通路零回归；`x-actual-upstream` 响应头双保险
    （**教训**：流式出口 raw.flushHeaders 直接刷头，fastify 延迟应用的 reply.header 赶不上，
    必须 raw.setHeader）。
  - `persistCompletion` 增可选 provider 维度（缺省 commandcode 同旧），用量按真实来源落库；
    分发路径用量为本地估算（文本增量流无上游 usage 事件）——面板分口径聚合的输入已就绪。
  - 默认上游切换：`POST /api/providers/default` 热生效（runtime.setDefaultProvider 就地改
    priority 序，修掉 initialize 重赋值导致 router 读旧序的隐患）+ `routing.defaultProvider`
    经 saveConfigFile 持久化（deepMergeKeepUnknown 保住其余键）+ initialize 读回（重启等价）。
  - 门禁：`npm run verify` **61 文件 / 777 用例全绿**；typecheck 双工程 / lint 0 错误。

- **T213 阶段 1：三源 Provider 运行时接线（2026-10-07，`9b98d9d`）**：
  - `src/providers/runtime.ts`——ProviderRuntime：装配 IProvider 三源 + T104 的 ProviderRegistry/RequestRouter
    实例；**按需初始化**（无分片/环境变量的 Provider 不执行 initialize，缺省部署启动路径与接线前一致）；
    `status()` 暴露健康/总闸/WorkBuddy sidecar 进程视图（§3.11-4）；`enable/disable` 面板总闸（热生效）；
    `namespacedModels()` 走注册表缓存（热路径不打 sidecar）。
  - 管理面：`GET /api/providers`、`POST /api/providers/:name/enable|disable`、
    `POST /api/providers/registry/refresh`（写端点走既有 x-admin-token 鉴权；未装配 runtime 时优雅降级）。
  - `/v1/models` 追加 `freebuff/<id>`、`workbuddy/<id>` 命名空间条目；**门控 = 分片存在且 enabled!==false
    且总闸开启**——存量 config.json 只有 providers.commandcode，行为与接线前一致。
  - **数据面刻意不动**：chat/messages 仍走 CommandCode 既有通路（零回归）；切路由属阶段 2（见 PLAN-STATE T213 卡）。
  - 门禁：`npm run verify` **60 文件 / 767 用例全绿**；typecheck 双工程 0 错误；lint 零输出。

- **P1 交付（2026-10-07 第二轮，D2 + T204'/T205'，三卡）**：
  - **P0-PORT-D2 CommandCode Provider 薄适配层**（`1e011a5`）：落地 D1 报告决策「**不搬家、只做薄包装**」——
    4.22.4 起 `src/adapters/commandcode/` 已模块化，整目录迁移收益低、回归风险高。
    新增 `src/providers/commandcode/provider.ts`（IProvider 18 成员全集），复用既有翻译引擎/配置/模型/用量层；
    `tests/commandcode-provider.test.ts` 19 例（先红后绿）。T213 收口项已登记（限流/modelAccess 双轨配置源、
    legacy 扁平分支 `syncEnvFile` 明文行、`saveConfigFile` 旧分支明文回写）。
  - **T204' WorkBuddy 联邦透传 Provider + Sidecar 管理**（`47f8a3a`）：按 G0-T2 联邦裁决与 §3.11 落地——
    `providers/workbuddy/sidecar.ts`（子进程拉起 + `/healthz` 就绪轮询 + 崩溃自动重启 5min×3 + 随主进程退出）+
    `providers/workbuddy/provider.ts`（透传 chatCompletion、conversation_id 原样透传、rewriteMode 总开关、
    probe 真实 `/healthz`、sidecarStatus 面板数据源）；sidecar 端点按 Go 源码实测口径
    （`internal/server/handler.go` / `internal/panel/panel.go`）。
  - **T205' 账号委托**（并入 `47f8a3a`）：listAccounts 读 `/status`、pause/resume/remove 打面板 API、
    addAccount 明确不支持（OAuth 设备授权属 T301，抛可执行提示）。
  - **纪律记录**：本轮执行期间检测到**活跃并发写入者**（v5.0.2 修复会话正改 CHANGELOG/HANDOFF/package.json），
    按避坑 #9 只显式 `git add` 自制品提交，本文件与 CHANGELOG 的条目在该会话提交后补齐（即本条与 [Unreleased] 段）。
  - 两卡合计 +41 用例；全量 **58 文件 / 754 用例全绿**，typecheck 双工程 0 错误，lint 零输出。

- **v5.0.3 内容事件判据修正（2026-10-07，v5.0.2 的补正 —— 上次的修复其实没生效）**：用户再报
  `No data from upstream for 120s` / `STREAM_IDLE_TIMEOUT` / `retryable=false`
  （`requestId 17e161fe-f15f-420a-9f1b-47c5a03fbf9f`，20:36:52，会话 `sess_95d71fac`，`timingMs=151274`、`in=0/out=0`）。
  **为什么 v5.0.2 没拦住（本条最值得记）**：`probeUpstream` 的延窗门槛写成「`consumedBytes === 0`」，
  而 **CC 的流以 `start` 事件开场**（`stream-encode.ts` 的 `event.type === 'start'`）——字节在第一毫秒就到，
  门槛**永不成立**，探测 30s 后照旧无条件放行；放行后看门狗在 120s 处注入 `retryable=false`
  （按「有没有字节」给，字节到过 → false），探测层 `isRetryableProbeFailure` 据此放行 → 客户端拿到不可重试的 504。
  **时序指纹**：151.3s ≈ 1s 建连 + 30s 探测 + 120s 看门狗，且日志里**没有任何** `Upstream failure …, retry` 行
  （延窗分支从未进入）——排障时这条「无重试日志 + 精确 150s」组合可直接定位到本缺口。
  改动（`src/adapters/commandcode/pipeline/stream.ts` 九处 + `upstream.ts` 三处）：
  延窗门槛改为 `state.verdict === 'ignore'`（还没有**内容事件**）；二轮窗口到期时按
  `Date.now() - lastDataAt >= idleWaitMs` 区分死流（丢弃）与仍流动的活流（保守放行）；
  成因 `first-byte-stall` → **`content-stall`**；`capturedError` 分支对 `idleStall && verdict === 'ignore'`
  覆盖 `retryable=true`（预读字节只在本地 `head`、从未转发，丢弃安全；挂钟超时与内容已产出不改判）。
  验证：**跟踪文件 64 文件 / 804 用例全绿**（含新增 `stall-after-start` 端到端剧本与 3 条探测判定用例）；
  运行日志可见 `Upstream failure (Upstream produced no content before stalling (model claude-sonnet-5): No data from upstream for 5s), retry 1/2`。
  **推翻**：v5.0.2「已知限制」写的「已收到过字节但没到内容事件后静默不重试」作废（该保守与事实不符，代价是每次故障白等 150s）。
  **仍未做**：`start`-后静默这类请求的客户端等待上限仍是 `idleTimeoutMs`（放行也无内容可发）；要缩短须把 SSE 握手提前到取流之前。

- **v5.0.2 空闲超时重试修复（2026-10-07，接 v5.0.1 同族第二形态）**：用户报
  `No data from upstream for 120s` / `STREAM_IDLE_TIMEOUT`（`requestId 8eaae6bb-34ec-481c-b500-408f3c0b9788`，10:03）。
  **排障链路（可复用）**：ZCode 报错卡里的 `TraceID` 是它的**应用启动** traceId（对不上代理），
  唯一能对齐两端的是 `request=`；代理侧 `logs/proxy.log` 命中同名请求行
  `POST /v1/messages -> 200 (150788201ms)`（**注意括号里其实是微秒却标成 ms**），上一行即
  `[MESSAGES] Upstream stream error | Trace msg_fb2f95f3 | No data from upstream for 120s`。
  成因：150.8s ≈ 32s（上游才回响应头）+ 120s（看门狗）。本次尝试 `textDeltaChars=0`，**什么都没产出**；
  而 ZCode 侧 `retryable=false`、`canRetry=false`（`maxAttempts: 11` 一次没用）。
  改动：`pipeline/stream.ts` 注入的 `UpstreamError` 的 `retryable` 按「是否收到过上游字节」条件化
  （零字节→`true`）；`probeUpstream` 对**零字节**的流不再按 30s 窗口放行，改等看门狗定性
  （新成因 `first-byte-stall`）；`upstream.ts` 接住新成因并修正「两种超时在探测窗口内不可能触发」
  这条**已被证伪**的注释。
  **关键认知（勿再踩）**：`ProxyError.anthropicPayload()` **不下发 `retryable` 字段**，且 ZCode 包里
  `STREAM_IDLE_TIMEOUT` **0 次出现** —— 「改代理标志让客户端重试」这条路不通，**修复必须落在代理自身的重试循环**。
  验证：`build`/`lint` 零输出、src 工程 `tsc --noEmit` 通过、**55 文件 / 713 用例全绿**（v5.0.1 基线 55/709，+4 例）。
  **已发布并部署（2026-10-07）**：commit `e106bf4`（分支 `feat/p0-port` 与 `main` 同点）、annotated tag
  `v5.0.2: 产出内容前的空闲超时纳入重试`、Release 由 CI 自动创建且标题/正文合规
  （https://github.com/wjf1/multi-upstream-gateway/releases/tag/v5.0.2）；推送前按 CI 视角
  （仅已跟踪测试文件）复跑 **58 文件 / 754 用例全绿**（含并行会话已提交的 WorkBuddy 用例）。
  部署：16:57 重建 dist → 16:58:02 看门狗拉起 PID 19748，`/api/status` 报 `version 5.0.2`。

- **P1 交付（2026-10-07，四卡）**：
  - **T201 Freebuff 核心移植**：`src/providers/freebuff/` 7 文件 2,388 行（`run-manager` 含 RunManager/TokenPool：
    lease / inflight / draining / prewarm / 多 Token 轮询；`free-session` 会话缓存与等待室；`models` 远程注册表
    `free-agents.ts` 6h 刷新 + 硬编码 fallback；`upstream` 出站；`provider` IProvider 外壳）。Go→TS 逐函数对应并注释 `源文件:行号`。
    实测：预热后首请求 0ms（冷启 421ms）；START/FINISH 计数守恒（新增幂等 `finishRunOnce`；`invalidate` 路径按 Go 原版刻意不发 FINISH）。
  - **T202a tools schema 规范化**：`tool-schema.ts` 311 行 + 测试 5 例，接入 `buildUpstreamBody`；
    `$ref` 内联与 `definitions/$defs` 清理、nullable 三形态简化、深拷贝不改调用方对象。
  - **T202b Anthropic 桥**：`src/providers/core/anthropic-bridge.ts` 681 行 + 测试 17 例；
    `anthropicToOpenAIRequest` / `openAIResponseToAnthropicMessage` / `AnthropicStreamEncoder`
    （块生命周期 message_start → content_block_start → delta… → content_block_stop → message_delta → message_stop，
    thinking 与 tool_use 块各自成对开闭、index 互斥）/ `sseFrame` / `mapFinishReason` / `sanitizeToolId`。
  - **T203 账号池与错误处理**：`errors.ts`(三类错误分类 isSessionInvalid/isRunInvalid/classifyFreebuffError)、
    `account-store.ts`(复用 T103 加密库)、`account-pool.ts`(契约适配层)、`run-manager.ts`(+TokenPool 健康分级与选号注入点)；
    测试 20 例。401→30min 冷却；probe 不信任会话缓存（修掉 T201「缓存 active 但 Token 已吊销」的漏判）。
  - **执行方式与教训**：本批由 subagent 执行，其间**agent 基础设施连续失败多次**（配额超限 / 进程被终止 / 上游 120s 无数据）；
    但**两次"失败"实际产物已完整落盘**（把工作区回退到已验证状态并回收产物即可，T202a 即由此交付）。
    因此派发时要求 subagent **尽早落盘**，接受方在失败后**先查工作区再决定回退或回收**。
    唯一真半成品是 T202b 首轮（`runChatChunks` 重构未完成、引用未定义函数）：已把 WIP 存档到
    `F:/AI/Qdor/backup-deploy-20261006-220835/T202b-*.wip`，并改走"只做出口桥、不动 provider 流式重构"的路径交付。

- **v5.0.1 上游流中断重试修复（2026-10-07）**：修复一次线上事故 —— 上游在**产出任何内容之前**把 SSE 流掐断
  （客户端侧 `TypeError: terminated`）时，首事件探测把它判成「放行」，一个**已经死掉的流**被交给路由，
  外层重试循环（当时 `maxRetries=2`、预算充足）根本没被触发，用户直接看到一轮
  `PROVIDER_PROTOCOL_ERROR / retryable=false` 失败；代理日志只留一行
  `[MESSAGES] Upstream stream error | Trace msg_… | terminated`。改动：
  - `pipeline/stream.ts` —— `probeUpstream` 记录预读期间的流错误并落判定 `stream-error`（可重试）；
    其在 `reflow()` 里交接「已断的流」改用 `setImmediate` 投递错误（同步 `destroy` 的错误走 nextTick，
    在部分时序下抢在调用方挂 `error` 监听之前抛出，会升级成 `[CRITICAL] Uncaught Exception`）。
  - `upstream.ts` —— 按拒绝成因生成准确文案（`… before producing any content (model …): terminated`）；
    客户端已断开时**不重试**（不替一个被放弃的对话白耗额度）。
  - `start.cmd` —— 出站代理默认端口 7897 → **7900**，与 `.env` / `config.json` / `watchdog.ps1` 对齐
    （端口共四处各存一份，只改配置不改启动脚本会静默漂移成「探活失败 → 回退直连」）。
  - 新增 `tests/upstream-stream-retry.test.ts`（端到端复现事故形态 + 「内容已流出不重试」边界）与
    `probeUpstream` 判定表用例；门禁见 §1。
  - **边界（属设计约束，未做）**：内容**已经流出后**的中途失败仍不重试（会重复投递内容）；
    上游「干净收尾但未产出内容」（无 error 的 `end`）也不重试 —— 正常 SSE 必带 `finish` 事件，
    理论上可判为截断，但拿不出证据就重试会白耗一次上游额度（29 万 token 单次约 $0.087）。
  - 事故证据链（会话 `sess_7430d017`）：ZCode provider 指向本地 `127.0.0.1:9090`；proxy.log 同一秒的
    `Upstream stream error | Trace msg_edb441fe | terminated` + `requestId=253dcac0-…`；
    `watchdog.err.log` 的 `Configured proxy 127.0.0.1:7897 is unreachable … falling back to direct`。

- **仓库分离（2026-10-07）**：产品线自上游 `wjf1/commandcode-proxy` 分化为独立私有仓库 `wjf1/multi-upstream-gateway`。
  采用 **clone 保留完整历史**的方式（非重建），上游 v4.22.4 为 `main` 现状，故 `git merge upstream/main` 能力未丢失；
  已推送 `main` + `feat/p0-port` + 全部 29 个历史 tag。判定依据：本次为产品分化（多上游/Freebuff/风险门/面板五页）而非补丁系列，
  且 `batch-b.patch` 对 4.22.4 全冲突，继续骑在上游分支上无收益。
- **基准重大更正（2026-10-06）**：发现真实部署与上游 main 为 v4.22.4，而全部工作基于过期检出 v4.17.0。
  方案 §1.2「底座事实勘误表」因此整表失效（"48 个测试文件" 本就是正确数字，被误"勘误"成 23；面板实为 1816 行；适配器已模块化；undici 已是运行时依赖；engines 已是 >=20；pkg 已换 `@yao-pkg/pkg`）。
  证据与影响见 `PLAN-STATE.md` §0。
- **Phase A 完成**（`cab6282` / `4b2a134`）：依赖精确化、`npm run verify`、`tsconfig.test.json` 双工程 typecheck、
  三个工具脚本解禁入版本库（`.gitignore` 的 `*.mjs` 例外——**这个坑在两个树上各踩过一次**）、
  顺修上游基线自带的一处 lint 错误（`tests/proxy-agent.test.ts` 未使用的 `node:dns`）与 `integration.test.ts` 两处动态 import 类型噪音。
- **安全网**：部署副本的 `dist/`、`config.json`、`package.json` 已备份至 `F:/AI/Qdor/backup-deploy-20261006-220835`。
- **4.17.0 树的历史成果**（作为移植来源保留，不丢弃）：
  G0-T1~T3 + T101~T111 + T201 共 15 项，其 commit 序列与 DoD 证据在 `F:/AI/Qdor/repos/commandcode-proxy` 的 git 历史中
  （`466b9b6` 基线 → … → `878cb6a` T201），该树测试基线 40 文件 / 516 用例。

## 5. 接力开发指引与待办（Next Steps / Backlog）

**接手第一步**：读本文 → `PLAN-STATE.md`（含 §0 基准勘误 + §1 移植任务队列）→ 执行依据方案第 0 章（agent 执行协议）。

**已办（2026-10-08）**：`main` ← `feat/p0-port` 快进合并**并推送成功**，远端 `main` 与 `feat/p0-port`
同为 `8340e68`。

> **踩坑记录（本次最大的时间浪费，勿重演）**：本机 `git` 默认走 Windows 的 `schannel`，对 github.com 报
> `schannel: failed to receive handshake, SSL/TLS connection failed`；叠加当时 Clash 的 7900 端口无出网，
> 一度被误判成"本机根本连不上 GitHub、只能读镜像"。**实际只需**：
> `git -c http.sslBackend=openssl -c http.proxy= -c https.proxy= push https://github.com/<repo>.git` ——
> 换 OpenSSL 后端 + 置空代理即直连成功（凭据由 Git Credential Manager 提供）。
> **结论：TLS backend 的报错不等于网络不可达；判定"推不上去"之前，先把 sslBackend 与代理两个变量各试一次。**

**待办·第一优先级（2026-10-08 起转为发布流程）**：

- **发布 `v5.0.4`**：`CHANGELOG.md` 的 `[Unreleased]` 已累积实质内容（三源运行时接线 T213/T213b，
  加上本轮账号指定接线、快照单源入库修复、构建产物改名）。按 AGENTS.md 的发布硬门禁走：
  ① 版本号（`package.json`）与四文档齐备 → ② 打 annotated tag
  `v5.0.4: <中文摘要>` → ③ `git push origin main --tags` → ④ 核验 CI 自动创建的 Release 标题/正文
  （标题必须 `v<版本>: <中文摘要>`，正文与 CHANGELOG 对应版本对齐）。
  **本轮刻意未打 tag、未改版本号**：合并推送是主线同步，发布是独立动作，混在一起会让 tag 指向一个
  还能再改的中间状态。

- **当前队列**（严格按 `PLAN-STATE.md` §1 的顺序与 deps）：
  - ✅ `P0-PORT-A~F` **全部完成**（A 基座 / B 批次 B 语义 / C 新增模块 / D1 接线 / D2 薄适配层 / E 面板移植 / F 阶段门），**已部署**。
  - ✅ **P1 已完成七卡**：`T201`、`T202a`、`T202b`、`T203`、`P0-PORT-D2`（`1e011a5`）、`T204'`（`47f8a3a`）、`T205'`（并入）。
  - ⬜ **下一批**：`T214`（P1 阶段门：三源 E2E、面板逐页验收、错误注入降级、5 分钟泄漏监控、
    `npm audit --omit=dev`、`DECISION` 行）。
    **T214 前置（需用户/外部提供）**：三源 E2E 需要 **Freebuff Token（`FREEBUFF_TOKENS`）** 与
    **WorkBuddy sidecar Go 二进制**（从 `F:/AI/Qdor/review/workbuddy2api-panel` 构建）；
    CommandCode 源 E2E 无前置。
    **登记的遗留**：判定路径合一（modelAccess/限流的两套执行路径，见 T213b 卡）——**仍待**；
    限流/modelAccess 双轨配置源与 legacy 扁平分支明文行——**已由 T213b 收口**。
    **T203 账号池遗留**：`preferredAccountId` / `onRetry` 透传入选号 —— ✅ **已收口**
    （`X-Upstream-Account` 端到端接线，见 §4）。**同卡另两项仍未做**：
    ① `providers/freebuff/account-pool.ts` 的 `FreebuffAccountPool` 契约适配层仍未被生产代码引用
    （评估后**不接**：与 RunManager 自身选号双轨，理由同 D2「不搬家只薄包装」）；
    ② `FreebuffProvider.updateConfig` 仍不热改 Token（凭据变更需重新 initialize）。
    **注意**：T202 卡 DoD「Anthropic SDK 调 /v1/messages 通过」的协议层已由阶段 2 锁定
    （假 Provider 端到端），真上游联调待 Freebuff Token/sidecar 配置后补验。
  - ✅ 遗留小项已办：构建产物改名 `dist/multi-upstream-gateway-v5.exe`（`build:win` + README 双语同步）。
  - ⬜ **新登记（2026-10-08 发现，阻塞级）**：`tests/snapshot/scenarios.mjs` 曾被 `.gitignore` 的
    `*.mjs` 吞掉、从未入库 —— 开发机上无感，全新克隆的 `typecheck`/`verify` 必红。本轮已补例外并重建
    （逐字节比对通过），见 §4。**同类风险未根除**：任何新增的被测试/脚本引用的 `.mjs`，
    提交前都要 `git check-ignore -v <file>` 复核（避坑 #2 已第三次踩中）。
- **重启 9090 必须再次征得用户确认**（AGENTS.md 服务启停硬约束）。上线后用户会在面板点确认风险告知——在此之前 `/v1/*` 会 403。
- **P1 后续**（移植完成后）：T202（Anthropic 桥——注意新树已有 `anthropic-response.ts`/`pipeline/`，须先评估复用而非另写）→ T203 → T204'（WorkBuddy 联邦透传，见 `docs/wb-source-diff-report.md` §7）→ T208~T212 面板五页 → T213 接线 → T214 阶段门。

## 6. 关键避坑与运行约束

1. **本目录就是生产部署**：9090 由 `dist/index.js` 常驻服务（计划任务 `CommandCodeProxy` → `wscript watchdog_launcher.vbs` → watchdog）。
   `npm run build` 覆盖 `dist/` 对已加载进程无影响，**但服务重启必须用户确认**；移植期间保持 `dist/` 可运行（安全网备份在案）。
2. **`.gitignore` 的 `*.mjs` 会静默吞掉脚本**（两个树各踩一次）：新增脚本后必须 `git check-ignore -v <file>` 复核，并补 `!<path>` 例外。
3. **本树的 eslint 不忽略 `scripts/**/*.mjs`**，而是显式为其配置 Node 全局（globals 里已有 console/process/fetch/AbortSignal）。
   因此**不要**在脚本里写 `/* global ... */` 声明——会报 `no-redeclare`。
4. **测试隔离**：`COMMANDCODE_CONFIG_PATH`/`COMMANDCODE_ENV_PATH`/`USAGE_HISTORY_PATH`/`COMMANDCODE_MODELS_CACHE_PATH`
   等环境变量必须在**动态 import 之前**设置（`CONFIG_FILE_PATH` 等是模块加载时求值的）；测试里禁止先静态 import 再依赖 env 生效。
5. **`boot()` 类 spawn 测试的竞态**：`tests/admin-boundary.test.ts` 的 B3 用例在 `boot()` 里一看到横幅首行 `is ACTIVE` 就 SIGKILL，
   而要断言的 `Admin token:` 行打印在它之后 → 高负载下管道投递与 SIGKILL 竞争导致偶发失败（4.17.0 树已定位，**本树移植该测试时建议直接修好**：等待更靠后的横幅标记）。
6. **Git Bash 约束**：cwd 每条命令后重置（内联 `cd <dir> && …`）；禁止裸 `&`/`nohup` 起常驻进程；阻塞命令包 `timeout`；
   不要把 `/c/...` POSIX 路径交给 node（用 `C:/...`）。
7. **git 代理 / remote 布局**：全局 `http.proxy=http://127.0.0.1:7900`。
   `origin` = 产品仓库 `wjf1/multi-upstream-gateway`（唯一推送目标）；`upstream` = `wjf1/commandcode-proxy`（**只 fetch，禁止 push**，否则污染上游）；
   `ghproxy` = 上游 `gh-proxy.com` 镜像，仅作 fetch 备用。产品 tag 继承上游全部历史 tag，自 **v5.0.0** 起另起产品版本线。
8. **面板 / CDN**：Phase E 后面板为 `public/index.html`（骨架约 560 行）+ `public/js/*.js`（外置，`/js/*` no-cache 路由），资源已本地化；**勿引入外链**（有测试守卫）。
9. **⚠️ 有并发写入者时禁止 `git add -A`**（2026-10-07 实际踩坑）：subagent / 并行会话正在往工作区写文件时，
   `git add -A` 会把它的**在制品**一并纳入并推送，破坏「一个任务一个 commit」纪律。
   **做法**：提交前 `git status --short` 复核，只 `git add <明确路径>`；若已误提交，**不要 force-push 改写历史**（难以挽回），
   改为补一个规范提交并在提交信息里写明归属，把选择权交给仓库负责人。
10. **门禁断言禁止用恒真链**（同一次踩坑）：`npm run lint | tail -1 && echo "零输出"` 里 `tail` 总会成功，`echo` 必然执行，
    于是**带错误也会打印"通过"**——2026-10-07 就这样把 T202b 的 2 个 lint 错误当成通过推了出去。
    **做法**：按**错误计数**判定（如 `npm run lint 2>&1 | grep -c "error"` 应为 0；`tsc` 同理数 `error TS`），
    或直接让命令的非零退出码决定成败。
11. **`npm test` 的 `pretest` 会重建 `dist/`**（生产产物）：这是本仓库常态（无需紧张），但意味着**测试结束时的 `dist/`
    来自当前工作区**。若工作区含未完成代码，服务若恰好重启就会加载它——所以结题时应确认工作区状态，
    必要时从安全网恢复 `dist/`（`F:/AI/Qdor/backup-deploy-20261006-220835/`）。
    另外 `npm run test:coverage` **不会**触发 `pretest`（npm 的 pre 钩子只对同名脚本生效），已补 `pretest:coverage`。
12. **subagent 基础设施本环境不稳定**：2026-10-07 连续多次失败（配额超限 / 进程被终止 / 上游 120s 无数据），
    但**多数"失败"的产物是完整可回收的**（先查工作区再决定）。派发时要求对方**尽早落盘**，
    接收方在失败后**先评估产物完整性**（编译 + 门禁），再决定回收还是回退。


---

## 7. 部署检查清单（P0-PORT-F 完成后，2026-10-07）

**服务与运维机制（实测确认）**
- 进程：`node dist/index.js`，工作目录 = 本仓库，监听 `127.0.0.1:9090`。
- 自动拉起：计划任务 `CommandCodeProxy` → `wscript watchdog_launcher.vbs` → `watchdog.ps1`（**每 30s 检测端口，未监听即 `Start-Process node dist/index.js`**）。
- **重启方式：结束 node 进程即可，看门狗会在 ≤30s 内用新代码自动拉起**（无需手工 start）。
- 停机窗口：≤ 30s（轮询间隔）+ 约 2s 启动。

**重启前必须满足**
1. ✅ `CREDENTIAL_ENCRYPTION_KEY` 已写入部署 `.env`（64 hex = 32 字节）。
   **⚠️ 此密钥必须单独备份**：丢失即无法解密 `credentials.enc`，等于丢失账号凭据。
2. ✅ `dist/` 已用新代码构建（`npm run verify` 通过，50 文件 / 658 用例）。
3. ✅ 备份就位：`F:/AI/Qdor/backup-deploy-20261006-220835/`（`dist/`、`config.json{,.pre-deploy}`、`.env{.post-incident,.pre-deploy}`）。

**重启后会发生什么（已在副本上干跑验证）**
1. `config.json` 由 flat 迁移为 unified（`providers.commandcode`），账号凭据移出 config.json；
2. 凭据加密落盘 `credentials.enc`，`.env` 的 `COMMANDCODE_ACCOUNTS_V1` 明文行被自动摘除（日志：`env line removed: true`）；
3. 面板与 API 正常，但 **`/v1/*` 一律返回 403 `RISK_DISCLAIMER_NOT_ACCEPTED`**，直到在面板确认风险告知（或设 `ACCEPTED_RISK_DISCLAIMER=1`）。

**回滚路径（任一步出错）**
`rm -rf dist && cp -r <备份>/dist dist`；`config.json` 用 `.pre-deploy` 版还原；`.env` 同理。看门狗会在 ≤30s 内拉起还原后的版本。

**已知残留（非阻塞，登记待收口）**
- `.env` 的 `COMMANDCODE_API_KEY` 明文行仍在（4.22.4 既有通道，`syncEnvFile` 会回写）——加密库之外的兜底通道，建议 T213 一并收口。
- ~~`.env` 的代理指向 7897 而 Clash 在 7900~~ —— **已解决（2026-10-07）**：Clash 混合端口经用户固定为 7900，
  四处配置（`.env` / `config.json` / `watchdog.ps1` / `start.cmd`）已一致，服务重启后实测 `proxy armed … 7900 (probe: 3ms)`。
  **保持该端口固定**；若必须变更，四处同改且记得看门狗需重载（其环境变量在进程启动时快照）。
