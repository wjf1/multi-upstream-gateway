# PLAN-STATE

> **执行依据**：`docs/master-plan-v1.2.md`（v1.2.3 起含基准勘误修订）。
> **工程仓库（唯一工作副本）**：`C:\Users\admin\Doubao\chats\2026-09-03\new-chat-5\commandcode-proxy`
> —— v4.22.4，git 分支 `feat/p0-port`，与上游 `wjf1/commandcode-proxy` main 同步（HEAD `87b1a05`）。
>
> 规则：第一个依赖全部满足且未勾选的任务卡开工；DoD 全部验证后才可勾选；无法验证写 `BLOCKED: <原因>`。
> 门禁：`npm run verify`（= build + test）全绿 + `npm run typecheck`（src+tests 双工程）+ `npm run lint` 零输出。

---

## 0. 基准勘误（2026-10-06 重大更正，务必先读）

**本次更正推翻了方案 v1.1/v1.2 的基线事实。** 方案作者当时核查的是 `F:/AI/Qdor/repos/commandcode-proxy`，
那是一份 **v4.17.0 的过期检出**；真实部署与上游 main 均已到 **v4.22.4**。因此方案 §1.2「底座事实勘误表」
本身是错的，且 G0+P0+T201 的全部工作都做在了过期基线上。

| 方案 §1.2 的断言 | 真相（v4.22.4 实测） |
|---|---|
| "v1.0 说的 48 个测试文件是错的，实际 23 个文件 / 298 用例" | **反了**：48 文件 / 626 用例 才是真实基线（4.22.4 实测全绿） |
| "`public/index.html` 1239 行" | 实测 **1816 行** |
| "`src/adapters/commandcode/` 仅 3 个文件" | 实测已模块化：`adapter.ts`、`anthropic-response.ts`、`reasoning.ts`、`pipeline/` |
| "undici 7.x 为**新引入**，底座 HTTP 客户端为内置 fetch" | 4.22.4 **已将 undici 作为运行时依赖**（7.29.1），并有 `proxy-agent.ts` |
| "engines 抬至 >=20" | 4.22.4 **已是 `>=20`**（且 `build:win` 目标已是 node22） |
| "pkg 已停维护（R8）" | 4.22.4 已切换到**维护中的 `@yao-pkg/pkg` 6.22.0** |
| "TASK-006 六项『保留』均不存在" | 部分已被 4.18~4.22 补齐（需在 Phase D 逐项重新核对，不可照搬旧结论） |

**处置**（用户 2026-10-06 决定）：**重定基到 v4.22.4**，把已完成的成果移植过去；移植完成并验证后才重启 9090。

**已确认仍然有效的工作**：审计批次 B（`docs/review/batch-b.patch`）在 v4.22.4 上**同样未应用**（无 `admin-guard.ts`），
故 G0-T3 依旧需要。P0 的成果多为**新增文件**，移植冲突集中在少量接缝文件。

**安全网**：部署副本的 `dist/`、`config.json`、`package.json` 已备份至
`F:/AI/Qdor/backup-deploy-20261006-220835`（移植期间 9090 继续由当前进程服务，未中断）。

---

## 1. 移植任务（当前执行队列）

- [ ] P0-PORT-A 工程基座
  - deps: 无
  - 范围：依赖精确化（去 `^`/`~`）、`npm run verify`、`tsconfig.test.json` 双工程 typecheck、脚本入树（setup/bench/collect-fixtures）、文档入树
  - blocked: —
- [ ] P0-PORT-B 审计批次 B 移植
  - deps: P0-PORT-A
  - 范围：把 `docs/review/batch-b.patch`（ADMIN_API_KEY 分离 / Host 白名单 / 非回环拒启 / OAuth state / CSP）适配到 4.22.4（其 `dashboard.ts`/`chat.ts`/`config.ts`/`public/index.html` 均已演进）
  - blocked: —
- [ ] P0-PORT-C 新增文件移植（增量文件 + import 适配）
  - deps: P0-PORT-A
  - 范围：`providers/core/{interface,router,registry}.ts`、`utils/{unified-config,credential-store,rate-limiter,security-guard,sanitize,audit-log,safe-fetch,risk-gate}.ts`、`providers/freebuff/**`（T201 成果）及配套测试
  - blocked: —
- [x] P0-PORT-D1 安全链 / 风险门 / 审计 / 用量维度接线（2026-10-07）
  - 完成：`registerSecurityGuards`（鉴权前）+ `registerRiskGate`（鉴权后）、T103 凭据启动钩子、NODE_DEBUG 剥离、
    pino redact + genReqId、`/api/status.acceptedRiskDisclaimer`、`POST /api/risk/accept`、管理面审计钩子、
    请求 ID 全链路、`config.ts` 迁移/加密接缝、`usage-store` provider 维度
  - 实跑（隔离端口 9196）：未确认 → `/v1` 403 RISK_DISCLAIMER_NOT_ACCEPTED（带 x-request-id）→
    `/api/risk/accept` 无 token 401 / 带 token 200 → 热生效后 `/v1` 越过风险门
  - **事故已处置**：首次 `npm test` 因 `health-check.test.ts` 探活调用 `loadConfig()`（`CONFIG_FILE_PATH` 为
    模块加载期常量、测试无法覆盖）**误迁移了真实 config.json**。已从备份逐字节还原（md5 一致）、清除 `.env`
    中残留的 `COMMANDCODE_ACCOUNTS_V1`、并加固：`loadConfig` 在 `NODE_ENV=test`/`VITEST` 下跳过迁移。
    9090 全程未重启（uptime 连续、账号正确）。
  - 遗留：限流/modelAccess 双轨配置源 → T213 收口；`providers/commandcode` 建议不搬家只做薄适配（D2 决策）
  - blocked: —
- [ ] P0-PORT-D2 接缝收尾（`providers/commandcode` 薄适配层决策 + T213 收口项）
  - deps: P0-PORT-D1
  - blocked: —
- [ ] P0-PORT-D 接缝文件改造（历史条目，已拆分为 D1/D2）
  - deps: P0-PORT-B,P0-PORT-C
  - 范围：`index.ts`（安全链/风险门/凭据钩子/NODE_DEBUG/pino redact）、`routes/{chat,messages,sse-common}.ts`（safeFetch/requestId/provider 字段/风险门顺序）、`routes/dashboard.ts`（`/js/*`、status 字段、`/api/risk/accept`、审计钩子）、`utils/config.ts`（迁移钩子/加密优先/保存分支）、`utils/usage-store.ts`（provider 维度）、`utils/errors.ts`（+6 码）、`adapters/commandcode` → `providers/commandcode`
  - blocked: —
- [x] P0-PORT-E 面板移植（2026-10-07）
  - 完成：`public/index.html` **1840 → 560 行**，内联 JS（原 474–1839 行）外置为 `public/js/{core,overview,accounts,usage,models,logs}.js`；
    新增 `/js/*` 静态路由（与 vendor 共用穿越拒绝逻辑，`Cache-Control: no-cache` 以免"新页面配旧脚本"）；
    5 个现有 tab 的 hash 路由、明暗主题（CSS 变量 + localStorage + 防闪屏）、**风险告知硬门弹窗**、首启引导卡片
  - 原有 90 个顶层函数零丢失；既有面板测试 6 个文件语义等价适配（取证源平移，正则逐字未改），
    **唯二有意改写的断言已声明**：①`spa-phase012` 的"不引入主题切换"否定断言被 T110 需求取代，改为正向断言；
    ②`spa-a11y` 弹窗计数 3→4（新增风险弹窗同样具 dialog 语义）
  - 新增 `tests/spa-risk-gate.test.ts`（14 例）；全量 **50 文件 / 658 用例全绿**
  - blocked: —
- [ ] P0-PORT-E 面板移植（历史条目，已完成见上）
  - deps: P0-PORT-D
  - 范围：在 4.22.4 的 1816 行面板上重做 JS 外置 + hash 路由 + 明暗主题 + 首启引导 + 风险告知弹窗（**保留 4.18~4.22 新增的面板功能**，如通道健康卡片、运行开关卡片）
  - blocked: —
- [x] P0-PORT-F 全量回归 + 阶段门复验 + 部署（2026-10-07 完成）
  - deps: P0-PORT-E
  - 范围：`npm run verify`（≥626+移植新增）、`typecheck`、`lint`、`npm audit --omit=dev`、`scripts/bench-baseline.mjs` 基线；通过后按用户确认重启 9090
  - blocked: 重启动作需用户逐个确认（AGENTS.md 服务启停硬约束）

## 2. P0 原任务卡（成果已在 4.17.0 实现，按上表移植）

- [x] T101 Provider 接口与类型体系（已实现，待 PORT-C 移植）
- [x] T102 配置体系扩展 + 校验 + 热重载（待 PORT-C/D）
- [x] T103 凭据加密-at-rest（待 PORT-C/D）
- [x] T104 请求路由层（待 PORT-C）
- [x] T105 鉴权扩展与安全中间件链（待 PORT-C/D）
- [x] T106 合规风险告知门 + 启动向导（待 PORT-C/D/E）
- [x] T107 Snapshot 测试基础设施（待 PORT-C）
- [x] T108 CommandCode Provider 迁移（待 PORT-D；**注意 4.22.4 已模块化，原「3 文件整目录平移」前提失效，需重新决定是否搬家**）
- [x] T109 用量统计 provider 维度（待 PORT-D）
- [x] T110 面板基础设施扩展（待 PORT-E）
- [x] T111 P0 阶段门（**需在 v4.22.4 上重做**）

## 3. P1 任务卡

- [x] T201 Freebuff 核心移植（已实现于 4.17.0，待 PORT-C 移植）
- [ ] T202 Freebuff Anthropic 桥 + schema 规范化（**在 v4.22.4 上重做**；注意新树已有 `anthropic-response.ts` 与 `pipeline/`，须先评估复用）
- [ ] T203 Freebuff 账号池与凭据持久化
- [ ] T204' WorkBuddy 透传 Provider + Sidecar 管理（联邦，见 `docs/wb-source-diff-report.md` §7）
- [ ] T205' WorkBuddy 账号管理委托 sidecar（并入 T204'）
- [ ] T206 WorkBuddy 熔断状态机 —— 已取消（sidecar 内置承接）
- [ ] T207 WorkBuddy 会话粘性 —— 已取消（sidecar 内置承接）
- [ ] T208~T212 面板五页（总览/上游管理/账号-Token/模型目录/用量统计）
- [ ] T213 统一 API 层三源接线 + P1 手动降级
- [ ] T214 P1 阶段门
- [ ] T301~T310 / T401~T406 / T501~T505（见执行依据方案）

## 4. 阶段记录

- 2026-10-06：**基准重大更正**。发现真实部署与上游 main 为 v4.22.4，此前全部工作基于过期检出 v4.17.0。
  已完成：新工作副本侦察、安全网备份、`feat/p0-port` 分支、基线 **48 文件 / 626 用例全绿**确认。
  用户决定：重定基到 v4.22.4；移植完成后再重启 9090。
- 2026-10-06：**P0-PORT-A 完成**。依赖精确化（无浮动版本）、新增 `verify` 脚本、`tsconfig.test.json`
  双工程 typecheck（顺修 `integration.test.ts` 两处动态 import 类型噪音）、脚本与文档入树。
- 2026-10-06（历史，4.17.0 树）：G0 三项 + T101~T111 + T201 已交付，其测试基线 40 文件 / 516 用例；
  该树的 commit 序列见 HANDOFF「P0 交付总表」。这些成果作为移植来源保留。


## 阶段记录 — 移植后的 P0 阶段门复验（P0-PORT-F，2026-10-07）

**结果：门禁全部通过，1 项部分验证（与旧树同）。部署待用户确认。**

| 验收项 | 门槛 | 实测（v4.22.4 移植后） | 结论 |
|---|---|---|---|
| 全量回归 | `npm run verify` 绿 | **50 文件 / 658 用例全绿**（基线 48/626 + 32 新增） | ✅ |
| 覆盖率 | ≥55% | **65.87%** 语句 | ✅ |
| `npm audit --omit=dev` | high/critical = 0 | **0 vulnerabilities**（fastify 5.12.3→5.12.5 + `npm audit fix` 清 fast-uri） | ✅ |
| typecheck（src+tests） | 干净 | 通过 | ✅ |
| eslint | 零告警 | 零输出 | ✅ |
| E2E（启动→请求→响应→用量→面板→静态资源） | 全链通 | 全部通过 | ✅ |
| 单并发 P50 | <500ms | 31ms 量级（同旧树） | ✅ |
| 50 并发 P99 | <3000ms | **126ms**（468 rps，0 错误） | ✅ |
| 内存增长 | 1h <100MB | 短时 ~30s 采样无增长 | ⚠️ 部分（1h soak 归 T504） |

**过程中修复的两个真实缺陷（都不是"抖动"，值得记录）**：
1. **`npm run test:coverage` 不会触发 `pretest`**（npm 的 pre 钩子只对同名脚本 `test` 生效）→ 它以**上次还原的旧 dist** 运行，
   凡 spawn `dist/` 的用例全部假红。表现极具误导性（"B3 拒启用例失败"看起来像安全回归）。已补 `pretest:coverage`。
   **教训**：任何 spawn 编译产物的测试都依赖"先构建"，脚本名带冒号时 pre 钩子不会自动生效。
2. `tests/admin-boundary.test.ts` 的 `boot()` 存在**等待谓词竞态**（看到横幅首行 `is ACTIVE` 就 SIGKILL，
   而要断言的 `Admin token` 行打印在其后）。已改为可传谓词 + 上限 20s→60s。

**部署前置条件（Phase F 之后、重启之前必须完成）**：
- 新代码启动时若存在明文凭据且未设 `CREDENTIAL_ENCRYPTION_KEY` → **拒绝启动**。
  故重启前必须在部署 `.env` 中设好该密钥（详见 HANDOFF「部署检查清单」）。
- 重启后 `/v1/*` 会先返回 403，直到在面板确认风险告知（用户已知并同意）。


## 部署记录（2026-10-07）

- **门禁**：`npm run verify` 50 文件 / 658 用例全绿；typecheck 双工程；lint 零输出；覆盖率 **65.87%**；
  `npm audit --omit=dev` **0 漏洞**；E2E 全链；50 并发 **P99 126ms** / 468 rps / 0 错误。
- **重启方式**：结束 node 进程 → 看门狗（`watchdog.ps1`，30s 轮询）自动拉起新代码。实测**第 5 秒**恢复。
- **迁移结果（实测）**：`config.json` flat → unified（`providers.commandcode`，账号凭据移出）；
  凭据加密写入 `credentials.enc`（1 账号）；`.env` 的 `COMMANDCODE_ACCOUNTS_V1` 明文行被自动摘除。
- **风险门**：重启后 `/v1` 先返回 403；用户在面板点击确认（审计日志 `/api/risk/accept` 01:14:30 一条 200
  来自 127.0.0.1），配置写回 `acceptedRiskDisclaimer: true` 并热生效，`/v1` 恢复放行。
- **代理端口修正**：`.env` 的 `HTTP(S)_PROXY` 与 `config.json` 的 `upstream.proxy` 均已由 7897 改为 **7900**
  （本机 Clash 混合端口）。**注意**：代理在启动时初始化，`config.json` 的改动**下次重启才生效**；
  当前进程仍按 7897 尝试并自动回退直连（不影响可用性）。
- **推送**：`feat/p0-port` 已推送至 `https://github.com/wjf1/multi-upstream-gateway`（private），
  远端 `18b0a56..0b23beb`。推送前审计并补齐 `.gitignore`：`credentials.enc`、`auths/`（原先未被忽略，
  首次 `git add -A` 会把加密凭据库一起推上远端）。

### 部署后的代理端口排查（2026-10-07，重要运维发现）

现象：把 `.env` 与 `config.json` 的代理都改成 7900 并重启后，服务**仍读 7897**。

根因：**代理有三处编码，且优先级是「进程环境变量 > config.json/.env」**——
真正生效的是 `watchdog.ps1` 第 18-19 行**硬编码**的 `$env:HTTP(S)_PROXY = http://127.0.0.1:7897`，
而它正是重启服务的那一环（计划任务 `CommandCodeProxy` → `watchdog_launcher.vbs` → `watchdog.ps1`）。
`start.cmd` 早已改为 7900（还带注释说明 Clash 端口变更），**唯独 watchdog 这份漏改**——典型配置漂移。

处置：`watchdog.ps1` 已改为 7900（含注释说明，备份于 `F:/AI/Qdor/backup-deploy-20261006-220835/watchdog.ps1.bak`，
语法校验通过）。**但运行中的看门狗进程持有旧脚本的内存副本，文件改动不会热生效**：
要让 7900 真正生效，必须「停看门狗 → 由计划任务重启看门狗 → 再重启服务」三步。

影响与现状：当前服务按 7897 探活失败后**自动回退直连**（4.22.4 Auto-fallback），功能不受影响，
但出站代理实际未走通。**该三步操作涉及看门狗进程，需用户单独确认**（AGENTS.md 服务启停硬约束）。

教训：排查"改了配置不生效"时必须覆盖**环境变量来源**，而不只是配置文件；本机代理配置散落在
`watchdog.ps1` / `start.cmd` / `.env` / `config.json` 四处，任何一处未同步都会造成静默漂移。

## 现场交接（2026-10-07 第二轮）

**并行会话已关闭**，它关闭前提交了两笔（`500ca41` 分支模型更正、`7983adc` 上游流掐断重试修复），
提交状态在 `7983adc`。此前它留下的"未提交改动"经核实**已由其自行提交**，非孤儿代码。

**本轮核验结论**：
- 全量 `npm run verify` = **51 文件 / 667 用例全绿**；typecheck（src+tests）与 lint 零输出
  → **这同时解决了"v5.0.0 上线构建的测试验证归属"这一待确认项**：当前提交状态已被验证。
- **线上 `dist/` 与已提交源码一致**（曾发现 dist 编入了当时的未提交改动，现已对齐；
  `capturedError`/`clientGone` 在已提交源码与 dist 中均可查到）。
- 服务 v5.0.0 在线、真实对话与面板/静态资源正常、出站代理以 **7900** 启动（watchdog 修正生效）。
- 远端 `main` 与 `feat/p0-port` 均在 `7983adc`。

**P1 起点与待办**：
- ✅ T201 Freebuff 核心移植（已在树中：`providers/freebuff/**` 7 文件）
- ✅ **T202a tools schema 规范化**（2026-10-07 完成）：`src/providers/freebuff/tool-schema.ts`（311 行）
  + `tests/freebuff-tool-schema.test.ts`（231 行，5 例），接入 `buildUpstreamBody`（注释标注 Go `server.go:364-366`/`:408`）。
  覆盖 `$ref` 内联 + definitions/$defs 清理、nullable 简化（anyOf[null,T] / type:["T","null"] / nullable 字段）、
  非 tools 直通、深拷贝不改调用方对象，以及**mock 上游实际收到体**的集成断言。全量 **52 文件 / 672 用例全绿**。
- ⬜ **T202b Freebuff Anthropic 桥**（剩余一半；注意 v5.0.0 已有 `adapters/commandcode/anthropic-response.ts`
  与 `pipeline/`，须先评估复用而非另写桥）
- ⬜ P0-PORT-D2（此前推迟）：`providers/commandcode/provider.ts` 外壳 —— 建议**不搬家、只做薄适配层**
  （D1 报告结论：4.22.4+ 已把适配器模块化，整目录平移收益低、回归风险高）。它是 T213 统一接线的前置。
- ⬜ T203 → T204'（WorkBuddy 联邦透传）→ T208~T212 面板五页 → T213 → T214
