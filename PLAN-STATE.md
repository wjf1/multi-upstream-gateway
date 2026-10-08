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

- [x] P0-PORT-A 工程基座（2026-10-06 完成）
  - deps: 无
  - 范围：依赖精确化（去 `^`/`~`）、`npm run verify`、`tsconfig.test.json` 双工程 typecheck、脚本入树（setup/bench/collect-fixtures/soak）、文档入树
  - 验证：双工程 typecheck 0 错误；`npm run verify` 生效。
  - blocked: —
- [x] P0-PORT-B 审计批次 B 移植（2026-10-06~10-07 完成）
  - deps: P0-PORT-A
  - 范围：ADMIN_API_KEY 分离 / Host 白名单 / 非回环拒启 / OAuth state / CSP 适配到 4.22.4；配套测试（`admin-boundary.test.ts`、`security-guard.test.ts`、`safe-fetch.test.ts`、`sanitize.test.ts`、`rate-limiter.test.ts`）全部在树并通过
  - blocked: —
- [x] P0-PORT-C 新增文件移植（增量文件 + import 适配，2026-10-07 补齐收口）
  - deps: P0-PORT-A
  - 范围：`providers/core/{interface,router,registry}.ts`、`utils/{unified-config,credential-store,rate-limiter,security-guard,sanitize,audit-log,safe-fetch,risk-gate}.ts`、`providers/freebuff/**`（T201 成果）
  - 补齐：将旧树未带过来的 13 个配套测试文件与 T107 快照基础设施（`tests/snapshot/` 完整用例、scenarios 及 upstream/snapshots fixtures）复制进新树；解决 4.22.4 兼容性（`COMMANDCODE_ENV_PATH` 别名、`loadConfig` 路径接管迁移、`costUsd` null 与 0 语义分离、测试隔离临时凭据库路径）；14 个套件全部通过
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
- [x] P0-PORT-D2 接缝收尾（`providers/commandcode` 薄适配层决策 + T213 收口项）
  - deps: P0-PORT-D1
  - 决策：**不搬家、只做薄适配层**（D1 报告结论，本卡落地）。4.22.4 起
    `src/adapters/commandcode/` 已模块化（adapter / pipeline / request·stream·usage 子模块），
    整目录 `git mv` 到 `providers/commandcode/` 收益低、回归风险高（要动全部 import 与快照）。
  - 交付：新增 `src/providers/commandcode/provider.ts`（`CommandCodeProvider implements IProvider`，
    18 成员全集）—— 把既有翻译引擎（CommandCodeAdapter + sendToCC）、配置/账号层（`utils/config`）、
    模型注册表（`utils/models`）、用量采集（`adapters/commandcode/usage`）暴露为 Provider 契约，
    供 T213 统一接线消费；外部依赖全部经 `CommandCodeProviderDeps` 注入（不触网、不读写真实
    config.json/.env）；边界：不写持久化副作用（审计/落库/限流/modelAccess 留在 routes/，属 T213）。
  - 测试：`tests/commandcode-provider.test.ts` 19 例（先红后绿）—— 契约面 / 文本增量 / error 事件转
    ProxyError / 无凭据不发请求 / 用量口径（含 costUsd=null 语义）/ 探活禁止恒真 / 凭据脱敏 / 总闸与热重载。
  - 门禁：全量 **56 文件 / 732 用例全绿**；typecheck 双工程 0 错误；lint 零输出。
  - 提交：`1e011a5`
  - 遗留（T213 收口项，与 D1 登记一致，未在本卡实施）：①限流/modelAccess 双轨配置源
    （`utils/model-access.ts` / `rate-limit.ts` 直读 env vs `UnifiedConfigStore` 的
    `ModelAccessConfigSchema` / `RateLimitConfigSchema`）；②legacy 扁平分支 `syncEnvFile` 的
    `COMMANDCODE_API_KEY` 明文行（unified 分支已在 `stripEnvKeyLine` 摘除）；③`saveConfigFile`
    旧扁平分支明文回写。
- [x] P0-PORT-D 接缝文件改造（历史条目，已拆分为 D1/D2；D1 ✅ D2 ✅）
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
- [x] P0-PORT-E 面板移植（历史条目，已完成见上；与上方 [x] P0-PORT-E 同项）
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
- [x] T202 Freebuff Anthropic 桥 + schema 规范化（2026-10-07 于 v4.22.4 完成：T202a `providers/freebuff/tool-schema.ts` 接入 `buildUpstreamBody`；T202b `providers/core/anthropic-bridge.ts` 681 行 + 17 例）
  - 未接线：Freebuff 的 `/v1/messages` 端到端接线属 T213；故 DoD「Anthropic SDK 调 /v1/messages 通过」定于 T213 收口
- [x] T203 Freebuff 账号池与错误处理（2026-10-07 完成）
  - 交付：`errors.ts`(163, isSessionInvalid/isRunInvalid/classifyFreebuffError/softCooldownMs)、
    `account-store.ts`(138, 复用 T103 CredentialStore 落加密库)、`account-pool.ts`(142, FreebuffAccountPool 契约适配)、
    `run-manager.ts`(+59, TokenPool 健康分级 + `RunManager.selectStartIndex` 选号注入点)、`provider.ts`(726)；
    测试 +2 文件 20 例（account-pool 13 / provider-errors 7）
  - 三类错误按 Go 语义：session 失效→重建会话重试；run 失效→摘除轮换；401→30min 冷却并抛 INVALID_CREDENTIAL；
    会话端点恒 401 时 probe 稳定不健康（刻意不信任会话缓存，修掉 T201「缓存 active 但 Token 已吊销」漏判）
  - 凭据：新增 Token 落 T103 加密库（断言磁盘为 AES-256-GCM 密文、新实例可读回、与 commandcode 账号共库互不干扰）
  - 门禁：55 文件 / 709 用例全绿；typecheck 双工程 0 错误；lint 零输出
  - 遗留（T213 接线）——**2026-10-08 复核后的状态**：
    ① ✅ `preferredAccountId`/`onRetry` 未透传到选号 —— **已收口**（`X-Upstream-Account` 端到端接线：
    `routes/provider-dispatch.ts::resolvePreferredAccount` → chat/messages 两出口 →
    `RunManager.acquire(agentId, preferredAccountId?)` 选号优先级；重试侧消费 `onRetry`。见本轮阶段记录）；
    ② ✅ 面板账号页未消费 `snapshot()` —— **已由 T210 满足**（`FreebuffProvider.listAccounts()`
    本身即基于 `runs.snapshots()`，`/api/providers/:name/accounts` 与面板多源账号页消费它）；
    ③ ⬜ `FreebuffAccountPool`（`providers/freebuff/account-pool.ts`）尚未接入 provider/路由 ——
    **评估后不接**：它与 RunManager 自身选号构成双轨，接入要同时成立两套调度，理由同 D2「不搬家只薄包装」；
    ④ ⬜ `updateConfig` 不热改 Token（凭据变更需重新 initialize）—— 仍待。
- [x] T203 Freebuff 账号池与凭据持久化（历史条目，已完成见上）
- [x] T204' WorkBuddy 透传 Provider + Sidecar 管理（联邦，见 `docs/wb-source-diff-report.md` §7）
  - 完成：2026-10-07，提交 `47f8a3a`。按 §3.11-1/2 落地：
    `src/providers/workbuddy/sidecar.ts`（子进程拉起 Go 二进制 + `/healthz` 就绪轮询 +
    崩溃自动重启 5min×3 策略 + stop 有意停止 + 随主进程退出）；
    `src/providers/workbuddy/provider.ts`（`WorkBuddyProvider implements IProvider`：
    chatCompletion 透传 + conversation_id 原样透传 + rewriteMode 总开关、listModels、
    probe 真实 `/healthz` 并刷新池快照、sidecarStatus 供面板卡片）。
    sidecar 端点为 Go 源码实测口径（`internal/server/handler.go`、`internal/panel/panel.go`）。
  - 测试：`tests/workbuddy-{sidecar,provider}.test.ts` 22 例（先红后绿）。
  - 门禁：全量 **58 文件 / 754 用例全绿**；typecheck 双工程 0 错误；lint 零输出。
  - 未接线：接入 `src/index.ts` / `src/routes/` 属 T213（与 Freebuff 同口径）。
- [x] T205' WorkBuddy 账号管理委托 sidecar（并入 T204'）
  - 完成：随 T204'（提交 `47f8a3a`）——listAccounts 读 `/status` 池快照、
    pause/resume/remove 打 `/panel/api/accounts/{uid}/*`、addAccount 明确不支持
    （OAuth 设备授权属 T301，抛可执行提示）。
- [ ] T206 WorkBuddy 熔断状态机 —— 已取消（sidecar 内置承接）
- [ ] T207 WorkBuddy 会话粘性 —— 已取消（sidecar 内置承接）
- [x] T208~T212 面板五页（2026-10-07 完成，提交 `85b0ed9` + `d2611c7`）
  - T208/T209：新「上游」页签（Provider 卡片：健康/可用/冷却/停用计数、WorkBuddy sidecar 进程行、
    initError 摘要；启停总闸热生效；设为默认）+ 总览异常横幅（已配置+已初始化+已启用但 health 不健康
    → 告警出现，恢复消失——**T213 最后一项未勾 DoD 由此收口**）；取证源清单声明式扩容（Phase E 先例）
  - T210：账号页多上游账号分栏（GET /api/providers/:name/accounts，凭据脱敏/不出 sidecar）
  - T211：模型目录命名空间徽章（freebuff/<id>、workbuddy/<id>，数据来自 /v1/models 聚合）
  - T212：用量页分上游口径表（GET /api/usage/by-provider → summarizeByProvider；
    commandcode 美元 / freebuff 免费时长 / workbuddy 积分，不跨上游混加；表头 scope=col）
  - 新增测试：spa-upstream 12 例 + multi-source-panel 6 例；门禁 **63 文件 / 793 用例全绿**
- [x] T213 统一 API 层三源接线 + P1 手动降级（2026-10-07；阶段 1 `9b98d9d` + 阶段 2 `af6db03`，横幅随 T208 `85b0ed9` 收口）
  - **阶段 1 完成**（2026-10-07，提交 `9b98d9d`）：ProviderRuntime 装配三源 + registry/router 实例 +
    `GET /api/providers` + `POST /api/providers/:name/enable|disable`（总闸热生效）+
    `POST /api/providers/registry/refresh` + `/v1/models` 命名空间聚合
    （门控 = 分片存在且 `enabled !== false` 且总闸开启；存量 config.json 无 freebuff/workbuddy 分片 →
    行为与接线前一致）。按需初始化：无配置的 Provider 不执行 initialize（启动零变化）。
    门禁：`npm run verify` **60 文件 / 767 用例全绿**；typecheck 双工程 0 错误；lint 零输出。
    CommandCode 目录刻意不入注册表（兜底上游经 priority 命中，入表徒增歧义面）。
  - DoD 实测（对照 master-plan）：①三上游专属模型分别请求来源正确（prefix/registry/priority/header
    四路断言）✅；②混合并发 50 无跨 Provider 污染 ✅（tests/provider-dispatch.test.ts）；③面板切换
    默认上游对新请求立即生效（热 + routing 分片持久化 + 重启等价读回）✅；④上游 health 异常横幅
    出现/恢复消失 ✅（overview 横幅，spa-upstream 锁定条件）。**真上游端到端联调（Freebuff Token /
    WorkBuddy sidecar 二进制）归 T214 三源 E2E** —— 协议层已由假 Provider 端到端锁定。
  - **阶段 2 完成**（2026-10-07，提交 `af6db03`）：chat/messages 在 translate 前做六步路由决策
    （剥前缀回写 body.model）；commandcode 走既有通路（零回归），freebuff/workbuddy 经
    `routes/provider-dispatch.ts` 渲染双出口（chat=OpenAI chunk、messages=AnthropicStreamEncoder）；
    `x-actual-upstream` 响应头（reply.header + raw.setHeader 双保险）；persistCompletion 增 provider 维度；
    面板切换默认上游 `POST /api/providers/default`（热生效 + routing 分片持久化 + 重启等价读回）。
    门禁：`npm run verify` **61 文件 / 777 用例全绿**；typecheck/lint 0 错误。
    DoD 实测：三上游来源正确（prefix/registry/priority/header 四路断言）✅、混合并发 50 无污染 ✅、
    切换立即生效 ✅。
  - 剩余一项改立独立卡「T213b 配置源收口」（见下）。

- [x] T213b 配置源收口（2026-10-07，提交 `5658065`）
  - deps: T213
  - 交付：`utils/config-store-runtime.ts`（UnifiedConfigStore 进程单例：start + chokidar 热重载；
    非空 `rateLimit` 分片注入 security-guard 限流器，空分片回退 env，双向确定性；bootstrap 失败
    不阻断启动）；`model-access.ts` / `rate-limit.ts` 切为「store 分片非空优先、env 回退」；
    `syncEnvFile`（legacy 扁平分支）加密库可用时不写明文 `COMMANDCODE_API_KEY` 并摘除旧行
    （T103 残留的最后一个明文写入点）。index.ts 装配（测试进程跳过）+ 退出释放。
  - 测试：`tests/config-source-closure.test.ts` 8 例（store 赢/env 回退/热重载/明文行两态）；
    门禁 **64 文件 / 801 用例全绿**；typecheck / lint 0 错误。
  - 遗留（登记 → P2 T304/T307 评估）：**判定路径合一**——modelAccess 现有两条执行路径
    （security-guard preHandler 的 `MODEL_ACCESS_ALLOW/BLOCK` 通配 vs 路由级守卫的
    `MODEL_ALLOWLIST` 精确）与两条限流路径（security-guard 全局+per-provider vs 路由级全局）；
    配置源已统一为 store 优先，执行路径合一会改错误码/环境变量语义，需独立评审。
- [ ] T214 P1 阶段门（自动化项全绿，剩余 3 项外部 blocker 挂起待办）
  - deps: T201~T213（全部完成）
  - 范围：三源 E2E、面板逐页验收、错误注入降级（strict 语义）、5 分钟泄漏监控
  - 自动化项验收（2026-10-07 已全部达标）：
    - `npm run verify`：**78 文件 / 984 用例全绿**（1 skipped），零红用例
    - 覆盖率：**Statements 80.97%**（5003/6179）、Conditionals 68.30%、Methods 82.70%，远超 ≥55% 门槛
    - 安全审计：`npm audit --omit=dev` **0 vulnerabilities**
    - 静态检查：`npm run typecheck` 双工程 0 错误；`npm run lint` 零告警零输出
    - 5 分钟泄漏监控：专用独立压测 `scripts/soak.mjs` 跑满 300s，400/400 请求成功，RSS 114.8MB → 83.0MB（增长 -31.9MB），无内存泄漏
    - 快照测试：CommandCode 端到端流式/非流式快照通过；Freebuff 快照测试通过
  - 剩余 Blocker：
    - ① Freebuff 真实线上 Token（`FREEBUFF_TOKENS`）待配置
    - ② WorkBuddy sidecar 缺少 Go 运行时 / 预构建二进制（需环境补齐以完成端到端三方通信）
    - ③ master-plan §0.4 强制项：项目负责人签字确认 `DECISION` 行（`continue | pause | pivot-federated`）
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
- ✅ **T202b Freebuff Anthropic 桥**（2026-10-07 完成）：`src/providers/core/anthropic-bridge.ts`（681 行）
  + `tests/anthropic-bridge.test.ts`（17 例）。走**修复路径 (b)**：桥只服务 Anthropic 出口，
  放弃 subagent 那次引入 `runChatChunks` 的重构（那正是它中断时留下的破损点）。
  实现：`anthropicToOpenAIRequest`（system 前置 / tool_use→tool_calls / tool_result→role:tool /
  tools→function / thinking→reasoning_effort / image→data URL）、`openAIResponseToAnthropicMessage`、
  `AnthropicStreamEncoder`（**块生命周期**：message_start → content_block_start → delta… →
  content_block_stop → message_delta → message_stop，thinking 与 tool_use 块各自成对开闭、index 互斥）、
  `sseFrame` / `mapFinishReason` / `sanitizeToolId`（均带 Go `anthropic.go` 行号注释）。
  **未接线**：Freebuff 的 `/v1/messages` 端到端接线属 T213（统一 API 层），
  故 T202 卡的"DoD：Anthropic SDK 调 /v1/messages 通过"仍待 T213 收口。
  门禁：**53 文件 / 689 用例全绿**（672→689）；typecheck 双工程 0 错误；lint 零输出。
  取材自 subagent 的 WIP 存档（`T202b-anthropic-bridge.ts.wip`），其类型错误已修、并补齐测试。
- ⬜ P0-PORT-D2（此前推迟）：`providers/commandcode/provider.ts` 外壳 —— 建议**不搬家、只做薄适配层**
  （D1 报告结论：4.22.4+ 已把适配器模块化，整目录平移收益低、回归风险高）。它是 T213 统一接线的前置。
- ⬜ T203 → T204'（WorkBuddy 联邦透传）→ T208~T212 面板五页 → T213 → T214

### 代理端口：最终结论（2026-10-07 收尾）

端口在这两个值之间**来回漂移过**，是本次排查反复的直接原因：
- 上一轮我改配置前**实测确认 7900 在监听**（PID 22752），据此把三处配置改为 7900；
- 其后 Clash 内核曾退出，恢复后监听端口变成 **7897**，导致配置指向死端口、服务静默回退直连
  （功能不受影响，实测仍能完成真实调用）；
- 经用户确认并**在 Clash Verge 中把混合端口固定为 7900**，配置与应用重新一致。

最终状态（实测）：`Outbound HTTP(S) proxy armed: http://127.0.0.1:7900/ (probe: 3ms)`，
真实对话经该链路成功。三处配置（`.env` / `config.json` 的 `upstream.proxy` / `watchdog.ps1`）均为 7900。

**运维建议**：Clash 的混合端口已在界面固定为 7900，请不要再改回 7897——本机有四处编码该端口，
任何一处不同步都会造成"改了不生效"或"静默回退直连"。若要变更，请同时更新
`watchdog.ps1`（环境变量，需重载看门狗）与 `.env`/`config.json`（需重启服务）。

## 阶段记录 — P0-PORT-D2 完成（2026-10-07）

**决策**：`providers/commandcode` **不搬家、只做薄适配层**（D1 报告结论落地）。依据：4.22.4 起
`src/adapters/commandcode/` 已模块化（`adapter.ts` + `pipeline/` + request/stream/usage 子模块），
整目录迁移要动全部 import 与快照，收益低、回归风险高。

**交付**：`src/providers/commandcode/provider.ts`（`CommandCodeProvider implements IProvider`，18 成员）
+ `tests/commandcode-provider.test.ts`（19 例，先红后绿）。提交 `1e011a5`。
门禁：全量 **56 文件 / 732 用例全绿**、typecheck 双工程 0 错误、lint 零输出。

**信息**：`providers/commandcode` 现为 T213 统一接线的直接前置；Freebuff（T201/T202a/T202b/T203）与
CommandCode（D2）两个 Provider 均已具备 IProvider 外壳，但**都尚未接入运行时**
（`providers/*` 仍只被自身与测试引用，未接 `src/index.ts` / `src/routes/`）。

## 阶段记录 — P1 阶段门复验与移植测试完整收口（T214，2026-10-07）

**背景与排查发现**：
在推进 T214 阶段门验收时，复核发现旧树中此前未移植至 4.22.4 树的 13 个关键单元/集成测试与 T107 快照基础设施（`tests/snapshot/`，包含 scenarios、helpers、fixtures）遗漏，直接导致移植队列 §1 的 P0-PORT-A/B/C 仍为未勾选状态。
本轮对 13 个测试与快照基础设施进行了完整的代码级兼容移植与行为修复：
1. `src/utils/config.ts`：支持 `COMMANDCODE_ENV_PATH` 作为 `COMMANDCODE_ENV_FILE_PATH` 的兼容别名（与 `credential-store.ts` 对齐），防止旧测试读取仓库根 `.env` 中的真实凭据；放行显式接管 `COMMANDCODE_CONFIG_PATH` 时的配置迁移测试。
2. `src/utils/usage-store.ts`：按 §3.9 严格区分 `costUsd` 的 `null`（积分无 USD 记录）与 `0`（免费上游）语义，修复多上游分口径聚合。
3. `tests/credential-store.test.ts` / `tests/snapshot/snapshot.test.ts`：显式隔离 `CREDENTIAL_STORE_PATH`，防止测试进程感知本机生产 `~/.commandcode/credentials.enc` 造成假红。

**验收指标矩阵与实测数据**：
- **全量门禁**：`npm run verify` **78 测试文件 / 984 用例全绿**（1 skipped），零失败用例（比此前 64 文件 / 801 用例新增 14 个测试文件 / 183 个用例全部变绿）。
- **测试覆盖率**：Statements **80.97%**（5003/6179）、Conditionals **68.30%**、Methods **82.70%**，远超 ≥55% 门槛（此前 74.84%）。
- **代码规范与类型**：`npm run typecheck` 双工程（src + tests）0 错误；`npm run lint` 零告警零输出。
- **安全审计**：`npm audit --omit=dev` **0 vulnerabilities**（无高危/严重漏洞）。
- **5 分钟泄漏监控**：独立自动化脚本 `scripts/soak.mjs` 运行 300s 施压（20 并发非流式，共 400 请求），400/400 成功率 100%，RSS 内存首样本 114.8MB → 末样本 83.0MB（净增长 -31.9MB），无内存泄漏（PASS）。
- **快照测试**：CommandCode 端到端流式与非流式快照通过；Freebuff 快照测试通过。

**T214 剩余外部 Blocker 状态记录**：
1. **Freebuff 线上真实 Token**：环境变量 `FREEBUFF_TOKENS` 待用户配置真实可用密钥。
2. **WorkBuddy sidecar 真实通信**：环境中缺少 Go 编译工具链与预构建二进制（sidecar），单元契约与 Provider 契约均已全绿，端到端需环境具备 Go 运行时。
3. **master-plan §0.4 决议行**：`DECISION: continue | pause | pivot-federated` 待项目负责人确认签字。


**T213 收口项（D2 登记，未实施）**：
1. 限流/modelAccess 双轨配置源：`utils/model-access.ts` 与 `utils/rate-limit.ts` 直读 env，
   而 `UnifiedConfigStore` 已定义 `ModelAccessConfigSchema` / `RateLimitConfigSchema`；T213 统一到一个源。
2. legacy 扁平分支 `syncEnvFile` 的 `COMMANDCODE_API_KEY` 明文行（unified 分支已由
   `stripEnvKeyLine` 摘除，仅旧形态残留）。
3. `saveConfigFile` 旧扁平分支明文回写（unified 分支已走加密库）。

## 阶段记录 — T203 账号池遗留收口与全新克隆门禁缺陷修复（2026-10-08）

**背景**：接手复核时，把「唯一可用上游仍是 CommandCode」之外的遗留项逐条对照源码，发现两条与文档描述不一致：

1. **`X-Upstream-Account` 契约空转**：`providers/core/interface.ts` 的 `ChatOptions` 定义了
   `preferredAccountId` / `onRetry`，但 `src/routes/` 下 grep 零命中 —— 路由层从不解析账号指定头、
   也从不构造这两个字段，Provider 侧自然也无从消费。本次将其打通（路由解析 → 两出口透传 →
   `RunManager` 选号优先级 → 重试期 `onRetry` 回调决定下一轮账号），并把「指定不存在/已暂停账号」
   定为**告警回退**而非失败。测试 `tests/freebuff-preferred-account.test.ts` 9 例。
2. **`tests/snapshot/scenarios.mjs` 从未入库（阻塞级）**：`.gitignore:17` 的全局 `*.mjs` 规则把它吞掉，
   而它是 T107 快照基建的场景单源（被 `tests/snapshot/helpers.ts`、`snapshot.test.ts`、
   `tests/freebuff-snapshot.test.ts`、`scripts/collect-fixtures.mjs` 四路 import）。后果：
   开发机上文件在磁盘（未跟踪）→ 门禁全绿；任何**全新克隆**跑 `npm run typecheck` 必报 3 条 `TS2307`。
   这是避坑 #2 记录的 `*.mjs` 坑第三次复现。已补 `.gitignore` 例外并按契约重建该文件；
   重建产物 `renderScenario('commandcode-chat-basic')` 与既有 upstream fixture **逐字节一致**（回放基线未被改写）。

**另办**：构建产物 `build:win` 改名 `dist/multi-upstream-gateway-v5.exe`（README 中英双语同步）；
对齐 `package-lock.json` 中滞留的上游包名/版本（`commandcode-proxy-v4`/4.22.4 → `multi-upstream-gateway`/5.0.3）。

**门禁**：`npm run verify` **79 文件 / 993 用例全绿（1 skipped）**（984 + 新增 9 例）；`typecheck`
双工程 0 错误（修复前 3 条 `TS2307`）；`lint` 零输出；`npm audit --omit=dev` **0 vulnerabilities**。

**未做（有意，已登记）**：`FreebuffAccountPool` 不接入（双轨，理由同 D2）；`updateConfig` 热改 Token 仍待；
T214 的三个外部 blocker（Freebuff 真实 Token / WorkBuddy sidecar Go 二进制 / 负责人 `DECISION` 签字）不变。

