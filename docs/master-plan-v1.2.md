# 多上游 AI 网关 —— 统一开发方案与计划 v1.2

> **📍 规范位置（2026-10-07 起）**：本文件已纳入工程仓库，规范副本为 `docs/master-plan-v1.2.md`。
> 此前位于 `F:/AI/Qdor/review/multi-upstream-gateway/master-plan-v1.2.md` 的副本**已作废**，
> 后续所有修订一律以仓库内本文件为准（避免两份漂移）。文中出现的其它绝对路径同理已改写为仓库内相对路径。

> **本文档是唯一的执行依据。** 与《…v1.0.pdf》《master-plan-v1.1.md》及其飞书源文档冲突之处，一律以本文档为准。
> 版本：v1.2.3 ｜ 日期：2026-10-06 ｜ 状态：**基准重定中（G0/P0/T201 成果从 v4.17.0 移植到 v4.22.4）**
> 进度唯一事实源：工作副本根 `PLAN-STATE.md`；接力首选读物：工作副本根 `HANDOFF.md`
> **唯一工程仓库（=真实部署目录）**：`C:\Users\admin\Doubao\chats\2026-09-03\new-chat-5\commandcode-proxy`（v4.22.4，分支 `feat/p0-port`）
> 技术底座：commandcode-proxy v4.17.0（审计批次 A 已合入，23 个测试文件 / 304 用例，G0-T1 实跑确认全绿；v1.2 勘误已实地复核：`F:/AI/Qdor/repos/commandcode-proxy`，engines `>=18.17`、运行时依赖仅 fastify、adapter 3 文件、index.html 1239 行、无 git，全部属实）
> 合并来源：Freebuff2API（Go → TS Provider）、workbuddy2api-panel（Go → TS Provider，源码核实见 G0-T2）
> 上游需求文档（仅作背景，不承载执行指令）：PRD `docx/Uv4DdxUC1oEamgxPrEecZ7oFnl7`、界面设计 `docx/Waphdk2y8o2iuSxuSUIcJRyqnQg`（链接可用性在 G0-T1 顺手用 `lark-cli docs +inspect` 验证）

**v1.2 修订摘要**（评审驱动，详见第 10 章变更记录）：
① 工作量汇总修正 86 → **≈101.5 人天**（v1.1 算术错误），重排关键路径并声明每日投入假设；
② T204 与"双链并行"的依赖矛盾修正，P1 按 Freebuff→WorkBuddy 串行段重排；
③ **G0-T2 升级为架构最终裁决点**，新增 3.11 联邦回退最小路径；
④ 新增体验任务：启动向导（T106/T110 扩展）、P1 手动降级+异常横幅（T213 扩展）、T204 改写总开关；
⑤ 阶段门增加 `npm audit` 检查与"继续/止损"决策行；T110 JS 按页拆分前移；
⑥ pkg 停维护风险标注，T503 增加 Node SEA 评估；G0-T3 patch 按新路径适配。

---

## 0. AI Agent 执行协议（每个任务开工前重读本节）

### 0.1 启动循环

1. 读仓库根 `PLAN-STATE.md`，找到**第一个依赖全部满足且未勾选**的任务卡；
2. 读该任务卡 + 第 3 章对应契约 + 其"参照文件"列出的现有源码；
3. **先写测试**（snapshot / 单元），确认红；
4. 实现，确认绿；
5. 跑全量门禁：`npm run verify`（= `npm run build && npm test`，pretest 必须先 build——这是审计 P0-1"假绿测试"的教训，禁止绕过）；
6. 按 DoD 逐项自检，全部属实后勾选 `PLAN-STATE.md`，按 0.3 提交；
7. 任何一项 DoD 无法验证 → 在 `PLAN-STATE.md` 该任务下写 `BLOCKED: <原因>`，跳到下一个无阻塞任务，**禁止把未验证项标绿**。

### 0.2 状态文件

`PLAN-STATE.md` 由 G0-T1 创建，格式：

```markdown
- [ ] T101 Provider 接口与类型体系
  - deps: 无
  - blocked: —
```

### 0.3 提交与证据规范

- 一个任务一个 commit：`<任务ID>: <一句话标题>`（例：`T103: 凭据 AES-256-GCM 加密-at-rest`）；commit body 粘贴 DoD 勾选结果与测试输出摘要；
- 每个任务同步追加 `CHANGELOG.md` 条目（Keep a Changelog 格式）；
- 依赖一律精确版本（无 `^`/`~`），lockfile 必须随 commit 更新；新增运行时依赖必须在任务卡里预先列名，任务外新增依赖 = 违规，需先改本文档；
- 分支模型：`main` + 每阶段一个集成分支（`feat/p0-foundation` 等）；任务分支不合入集成分支前必须 `npm run verify` 绿。

### 0.4 阶段门（Gate）

每阶段最后一个任务是该阶段 Gate（T111/T214/T310/T406/T504），Gate 不过（任何验收项红、覆盖率低于门槛、性能基线劣化）**不得开始下一阶段任务**。Gate 结果写入 `PLAN-STATE.md` 的"阶段记录"。

**v1.2 新增——阶段门两项强制内容**：
1. **依赖安全检查**：Gate 执行 `npm audit --omit=dev`（high/critical = 0 为过），补丁版本升级走 `TASK-UPGRADE-<n>` 快速通道（仅 patch 号变更免 snapshot 全量回归，只跑受影响模块测试）；
2. **继续/止损决策行**：阶段记录必须含一行 `DECISION: continue | pause | pivot-federated`（pivot-federated 仅允许在 T214 前依 G0-T2 裁决触发），由项目负责人签字确认后才能开始下阶段——用于对 R5/R7（封号/合规）与 R1（保真失败）保留分阶段退出余地。

---

## 1. 项目概述与底座事实（已勘误并实地复核）

### 1.1 目标

以 commandcode-proxy 为底座，把 Freebuff2API 与 workbuddy2api-panel 重写为 Provider 适配器，形成统一界面的多上游 AI 网关：单面板管理三源（CommandCode / Freebuff / 腾讯 CodeBuddy），支持请求级路由与全局启停，含用量统计、账号池调度、定时任务。

### 1.2 底座事实勘误表（⚠️ **v1.2.3 整表作废，见下方更正**）

> **⚠️ v1.2.3 更正（2026-10-06）**：下表基于**过期检出** `F:/AI/Qdor/repos/commandcode-proxy`（v4.17.0）。
> 真实部署与上游 main 均为 **v4.22.4**，因此**下表每一行都需要反过来读**。请以本节的「更正后基准」为准。

**更正后基准（v4.22.4 实测）**：

| 事实项 | v4.17.0（下表所依据的过期检出） | **v4.22.4（真实基准）** |
|---|---|---|
| 测试规模 | 23 文件 / 304 用例 | **48 文件 / 626 用例**（全绿） |
| `public/index.html` | 1239 行 | **1816 行** |
| `src/adapters/commandcode/` | 3 个文件 | **已模块化**：`adapter.ts`、`anthropic-response.ts`、`reasoning.ts`、`pipeline/` |
| 出站 HTTP 客户端 | 内置 fetch | **undici 7.29.1 已是运行时依赖** + `proxy-agent.ts`（含 IPv4 优先自愈） |
| `engines` | `>=18.17` | **`>=20`**（`build:win` 目标 node22） |
| 打包工具 | `pkg 5.8.1`（vercel/pkg，已停维护） | **`@yao-pkg/pkg 6.22.0`**（维护中；R8 风险在本线已解除） |
| 审计批次 B | 未应用 | **同样未应用**（无 `admin-guard.ts`）→ G0-T3 仍然必要 |

**教训（写入流程）**：勘误前必须先确认"工作副本是否等于部署与上游 main 的最新状态"——
本次错误源于拿一份 5 个版本前的检出当作底座，导致方案勘误表把正确数字（48 文件）改成了错的（23 文件）。
**今后凡引用基线事实，须同时标注版本号与验证命令。**

<details>
<summary>v1.2.2 时期的下表（已作废，仅作留痕）</summary>

| v1.0 说法 | 事实（✅ = 已实地复核） | 影响 |
|---|---|---|
| "48 个测试文件" | **23 个文件、304 个用例**（v1.2 G0-T1 实跑确认；早先记录的 298 为过时口径）✅ | 所有"全部 48 个测试通过"的 DoD 改为：`npm run verify` 全绿且用例数 ≥304 |
| TASK-004 "13 个文件" | `src/adapters/commandcode/` 仅 **3 个文件**（adapter.ts 888 行、upstream.ts 566 行、usage.ts）✅ | T108 按 3 文件整目录平移，拆分推迟到 P4 |
| "undici 7.x 保留底座现有客户端" | 底座唯一运行时依赖 fastify，HTTP 客户端为**内置 fetch** ✅ | undici 7.x 为**新引入**，统一出站客户端（含 ProxyAgent） |
| "Node ≥20 与底座一致" | 底座 `engines: >=18.17` ✅ | G0-T1 抬至 `>=20`，pkg 目标同步改 node20（衔接审计批次 C） |
| 面板 "1,800 行" | `public/index.html` **1,239 行** ✅ | v1.2：T110 落地时即按页外置 JS，不再等 3,500 行阈值（见 T110） |
| TASK-006 六个"保留" | 限流、模型访问控制、审计日志、DNS rebinding 防护、非回环警告**均不存在** | 全部按"新建"排任务（T105）；鉴权分离直接承接现成 `batch-b.patch`（G0-T3） |
| 工作副本无 git | `fatal: not a git repository` ✅ | G0-T1 恢复仓库与规范；上游 remote 确认为 `github.com/wjf1/commandcode-proxy` |

</details>

**运行环境事实（v1.2 新增）**：本机 9090 端口由 `node dist/index.js` 常驻运行（计划任务拉起）；**任何构建只写 dist、绝不重启该服务**；服务重启属用户确认事项。

### 1.3 架构选择（维持 v1.0 方案 A，v1.2 增加 G0-T2 裁决点）

单进程 Node.js/TS 底座 + 三 Provider 适配器。

**v1.2 新增——架构最终裁决点**：G0-T2 的源码核实报告必须包含"架构裁决"一节，按以下阈值给出 `方案A（全量移植）` 或 `联邦（Sidecar）` 的明确推荐：
- payload 改写管线中**不可离线复现的行为事件链 >3 条**，或改写点 >10 处且互相耦合 → 推荐联邦；
- Classify/冷却状态机无法从源码逐行对照（源码缺失或严重混淆）→ 推荐联邦；
- 其余情况 → 维持方案 A。

裁决结果写入 `PLAN-STATE.md` 阶段记录（DECISION 行），触发联邦时按 **3.11 联邦回退最小路径** 执行 T204~T208/T308 的替换任务（走第 10 章变更流程重排，预估减少约 14.5 人天）。

---

## 2. G0 开工门（P0 任何任务之前完成，合计约 2.5 人天）

### G0-T1 工程仓库与规范恢复 ｜ 模块：工程 ｜ 依赖：无 ｜ 预估 0.5

- 恢复 git：`git init` + `git remote add origin https://github.com/wjf1/commandcode-proxy.git`（推送时机由项目负责人决定；代理不可用时 `git -c http.proxy= …`；`fix/audit-batch-a` 分支内容以工作副本现状为准）；
- `engines` 抬至 `>=20`；`build:win` pkg 目标 `node18-win-x64` → `node20-win-x64`；创建 `PLAN-STATE.md`；定义 `npm run verify` 脚本（build → test）；
- 依赖精确化：package.json 全部去 `^`/`~`（**按 lockfile 已解析版本写死，不触发重装**）；
- 顺手验证第 0 页脚两条飞书链接可用性（`lark-cli docs +inspect`），不可用则把 PRD/UI 设计导出 PDF 存入 `docs/` 并在此登记。

DoD：
- [ ] `git log` 可见基线 commit；`npm run verify` 绿（298 用例）；
- [ ] `PLAN-STATE.md` 存在且含全部任务 ID；
- [ ] package.json 无浮动版本。

### G0-T2 workbuddy2api-panel 源码核实与架构裁决（关闭 P0-3） ｜ 模块：调研 ｜ 依赖：无 ｜ 预估 1

- 完整 clone `https://github.com/linguo2625469/workbuddy2api-panel`（zip 下载亦可；代理走 `http.proxy=127.0.0.1:7900`）；
- 逐目录核对 `internal/upstream/`、`internal/panel/` 与本文档 3.4/3.5 契约所依据的 README 推断：文件清单、关键函数签名（选号、Classify、冷却状态机、payload 改写管线）、行为差异；
- 产出 `docs/wb-source-diff-report.md`，**必须含"架构裁决"一节**（阈值见 1.3）；
- **差异 >20% 时，必须修订 T204~T207 的范围与预估后再开工**，修订走第 10 章变更记录；若裁决为联邦，按 3.11 重排 P1 任务。

DoD：
- [ ] 差异报告存在，含"契约影响"与"架构裁决"两节；
- [ ] T204~T207 被标记为"确认"或"已按报告修订"；
- [ ] `PLAN-STATE.md` 阶段记录新增 DECISION 行（方案 A 或 pivot-federated）。

### G0-T3 应用审计批次 B（关闭 P0-5 主体、P0-6 一部分） ｜ 模块：安全 ｜ 依赖：G0-T1 ｜ 预估 1

- 应用 `docs/review/batch-b.patch`：ADMIN_API_KEY 分离、Host 白名单（DNS rebinding）、非回环绑定拒绝启动、OAuth state 强制、CSP；
- **v1.2 明确：patch 基于旧目录路径，应用时就按 T108 迁移方向就地适配路径**（`src/adapters/commandcode/` 引用按原样应用，T108 整目录 `git mv` 时自然携带，不产生第二次改写）；
- 全量回归 + 手工验证：`/api/*` 写请求无 token → 401；携带正确 `x-admin-token` → 200；伪造 Host（即使 token 正确）→ 403；
- 冲突处按 T108 的迁移方向就地解决。

DoD：
- [ ] `npm run verify` 绿且新增 admin-boundary 测试通过；
- [ ] 面板 `/api/*` 读写鉴权矩阵（读=PROXY 或 ADMIN，写=仅 ADMIN）有测试覆盖。

---

## 3. 契约与设计（单一事实源，任务卡引用本节编号）

### 3.1 Provider 接口（`src/providers/core/interface.ts`）

维持 v1.0 定义，逐字段有效：

```ts
export interface IProvider {
  readonly name: string;            // 'commandcode' | 'freebuff' | 'workbuddy'
  readonly displayName: string;
  initialize(config: unknown): Promise<void>;
  health(): Promise<ProviderHealth>;      // { healthy,total,cooldownCount,disabledCount,queueDepth? }
  probe(): Promise<ProbeResult>;          // 轻量真实探活，禁止恒真实现
  listModels(): Promise<OpenAIModel[]>;
  chatCompletion(req: OpenAIChatRequest, opts: ChatOptions): AsyncIterable<string>;
  extractUsage(events: unknown[]): UsageSnapshot;
  listAccounts(): AccountInfo[];
  addAccount(credentials: unknown): Promise<AccountInfo>;
  removeAccount(id: string): void;
  pauseAccount(id: string): void;
  resumeAccount(id: string): void;
  enable(): void; disable(): void; isEnabled(): boolean;
  updateConfig(config: unknown): void;
  destroy(): Promise<void>;
}
export interface ChatOptions {
  abortSignal?: AbortSignal;
  requestId: string;                      // v1.1 新增：必传，见 3.7
  conversationId?: string;
  preferredAccountId?: string;
  onRetry?: (attempt: number, err: Error) => string | undefined | Promise<string | undefined>;
}
export interface IAccountPool<T extends BaseAccount> {
  selectAccount(ctx: RoutingContext): Promise<AccountLease<T>>;
  releaseLease(lease: AccountLease<T>, result: 'success' | 'error' | 'ratelimit'): void;
  snapshot(): PoolSnapshot;
}
```

错误码：继承底座 `src/utils/errors.ts` 分类，新增 `NO_PROVIDER_AVAILABLE(503)`、`PROVIDER_DEGRADED(503)`、`RISK_DISCLAIMER_NOT_ACCEPTED(403)`、`UPSTREAM_ACCOUNT_UNAVAILABLE(409)`、`MODEL_AMBIGUOUS(400)`。

### 3.2 统一配置（`config.json` + Zod 校验，`src/utils/config.ts`）

```ts
interface UnifiedConfig {
  port: number;                       // 默认 9090
  host: string;                       // 默认 "127.0.0.1"
  logLevel: 'debug'|'info'|'warn'|'error';
  maxBodySize: number;                // 默认 10MB
  acceptedRiskDisclaimer: boolean;    // 默认 false；false 时网关拒绝处理任何 /v1 请求（3.7）
  providers: {
    commandcode: CommandCodeConfig;   // 迁移旧版顶层字段
    freebuff: FreebuffConfig;         // { tokens[], apiBase?, modelRegistryUrl?, … }
    workbuddy: WorkBuddyConfig;       // { authDir, rewriteMode: 'full'|'passthrough', tasks: { checkin:{enabled:false,…} }, pointsPerUsdRate?: number|null, … }
  };
  routing: {
    defaultProvider: string;
    fallbackStrategy: 'strict'|'auto'|'same-model';   // 默认 'strict'（auto 必须显式开启，见 3.6）
    upstreamPriority: string[];
    sessionStickyEnabled: boolean;
    modelPrefixRouting: boolean;      // 默认 true
  };
  degradation: {                      // 级联防护（3.6）
    rampStartPercent: number;         // 默认 10
    rampStepPercent: number;          // 默认 10（每分钟）
    fallbackAbortHits: number;        // 备选上游窗口内 429 次数达到即摘除，默认 2
    fallbackAbortWindowMs: number;    // 默认 30000
    queueMaxDepth: number;            // 全局在途上限，默认 128，超出 503+Retry-After
  };
  rateLimit: {
    global: { rpm: number; tpm: number; windowMs: number };
    perProvider: Record<string, { rpm: number; tpm: number } | 'inherit'>;
  };
  modelAccess: { allowlist: string[]; blocklist: string[] };
  alerts: { webhookUrl: string; dailyBudgetUsd: number; errorRateThreshold: number };
  storage: {
    usageHistoryPath: string;         // 默认 ~/.commandcode/usage-history.jsonl
    logPath: string;
    retentionDays: number;
    statePath: string;                // 默认 data/state.json（本地 + 文件锁，见 3.4）
  };
  security: { corsOrigins: string[]; ssrfBlocklist: string[] };
}
```

**v1.2 新增 `workbuddy.rewriteMode`**：`'full'`（默认，提示词体系/指纹脱敏/reasoning 注入全生效）｜`'passthrough'`（跳过全部行为改写，仅透传 + 流式重建）。**任何一项改写特性引发上游错误或 snapshot 失败时，面板一键切 passthrough 保可用**；若 G0-T2 报告判定改写管线风险为高，则默认值改 `'passthrough'` 并在面板显著标注。

**v1.1 明确删除（v1.2 维持）**：`storage.redisUrl`、`storage.redisToken`（多实例非本项目目标，接口层预留 `StickyStore`/`StateStore` 抽象即可，实现只有本地）。密钥类字段（`proxyApiKey`、`adminApiKey`、各 provider token）**只从环境变量读取**，config.json 不落任何明文凭据（3.7）。

### 3.3 请求路由（`src/providers/core/router.ts`，六步决策）

1. `X-Upstream-Provider` Header 显式指定；2. `extra_body.upstream_provider`；3. 模型名前缀（`codebuddy/glm-5.2` → 剥前缀路由 workbuddy）；4. 模型注册表隐式映射；5. 会话粘性（WorkBuddy）；6. `upstreamPriority` 取第一个 enabled。全部落空 → `NO_PROVIDER_AVAILABLE` 503+Retry-After。响应头回 `X-Actual-Upstream`、`X-Request-Id`。

**命名空间规则（P1-8）**：`GET /v1/models` 返回的模型 ID 一律带 `provider/` 前缀；裸模型名在注册表中重名时，无前缀请求返回 `MODEL_AMBIGUOUS` 400 并提示带前缀重试；唯一时才允许裸名。

**安全边界**：`X-Upstream-Provider`/`X-Upstream-Account` 属于数据面能力，任何持 PROXY_API_KEY 的客户端可把流量导向任意已配置账号池——这是设计意图（个人工具），但必须在审计日志中记录指定行为（3.7）。

### 3.4 账号池与状态持久化（WorkBuddy，`pool.ts` + `pool-framework.ts`）

选号算法维持 v1.0 伪代码（成本分层 → 积分加权 Top-5 → 防惊群），两点收紧：

- 所有状态变更（selectAccount/releaseLease/冷却迁移）在 `async-mutex` 临界区内完成，**锁内禁止 IO**；selectAccount 采用"预占租约"（锁内 `inFlight++`，锁外发请求，失败回滚）；
- `data/state.json` 写入走 `proper-lockfile` + 临时文件 rename 原子替换；损坏时从 usage 记录重建并告警（关闭 P2-2）。

熔断状态机：`HEALTHY → SOFT_COOL`（429/5xx 指数退避 1→2→4→8→max 30min）、`SOFT_COOL → HARD_COOL`（连续 N 次）、`402 → HARD_COOL`（至次日 00:00）、`BROKEN`（阈值熔断，手动或 24h 恢复）、404 → 固定 5min。每次迁移写状态转换日志（供面板与审计）。

### 3.5 会话粘性（`session-sticky.ts`）

`conversation_id` 绑定账号，TTL 30min 滚动续期，绑定账号不可用时自动解绑重选。客户端未提供时派生规则：

```
sha256(model + "|" + system.slice(0,200) + "|" + firstUserMsg.slice(0,200)).hex.slice(0,16)
```

存储为本地 JSON（StateStore 抽象，见 3.2 删除 Redis 说明）。

### 3.6 降级与级联防护（T303）

- **默认策略 `strict`**：上游不可用直接 503，`auto` 必须用户在配置显式开启并在面板标注风险；
- **P1 空窗缓解（v1.2 新增，T213）**：P2 自动降级上线前，T213 先交付面板**手动切换默认上游**按钮（改 `routing.defaultProvider` 热生效）与**上游异常横幅**（health 接口驱动），保证 P1 期间"任一上游故障 ≠ 手改配置文件"；
- **渐进切换**：降级发生时，备选上游在切换后第 1 分钟只承接 10% 流量，每分钟 +10% 直至 100%（ramp 参数见 3.2）；
- **429 熔断摘除**：`fallbackAbortWindowMs` 内备选上游累计 `fallbackAbortHits` 次 429 → 立即停止向其降级并标记 degraded，流量继续按优先级下移；
- **全局队列深度**：在途请求数达 `queueMaxDepth` → 新请求 503+Retry-After，禁止排队堆积；
- **流式降级语义**：**仅首字节（首个 SSE 帧写出）之前允许降级重试**；一旦响应流已开始，禁止跨 Provider 切换，只能中断并返回错误。此规则写入 T303/T304 的 DoD 与测试。

### 3.7 安全基线（贯穿各任务，验收在 T105/T111/T310）

1. **鉴权矩阵**（G0-T3 落地，T105 扩展）：`/v1/*` = PROXY_API_KEY（回环绑定可选、非回环必填）；`/api/*` 读 = 回环 + Host 白名单内开放；`/api/*` 写 = 仅 ADMIN_API_TOKEN（env 可固定，否则启动生成并经 `<meta name="ccproxy-admin-token">` 注入面板，写请求携带 `x-admin-token` 头；v1.2 依 batch-b.patch 实现对齐命名，原 `ADMIN_API_KEY` 表述作废）。
2. **凭据加密-at-rest**（T103）：AES-256-GCM，密钥来自 `CREDENTIAL_ENCRYPTION_KEY` 环境变量；存在凭据而密钥未设置 → **拒绝启动并给出迁移指引**；首次带密钥启动自动把明文 `auths/*.json`/token 列表加密，旧文件改名 `*.plain.bak` 并告警提示删除；POSIX chmod 0600，Windows 文档说明依赖用户目录 ACL。
3. **全路径日志脱敏**（T105，关闭 P0-6）：统一 `sanitizeLog()`；Fastify logger 配置 `redact`（`req.headers.authorization`、`cookie`、`x-api-key`）；启动时剥离 `NODE_DEBUG` 中的 undici/http 项并告警；错误消息与堆栈同样过 sanitize；**验收测试：发起一次带错误 Bearer 的请求后，断言日志文件与 stdout 捕获中无 `Bearer sk-` / 20+ 位 key 片段**。
4. **SSRF 二跳**（T105）：undici 出站统一 `redirect: 'manual'`，逐跳重校验 Location 对 allowlist，最多 3 跳。
5. **请求 ID**（T105）：入口生成 `crypto.randomUUID()`，经 `request-context.ts` 传播到日志/用量记录/审计/响应头 `X-Request-Id`。
6. **审计日志**（T105 建、T502 完善）：`audit-log.jsonl` 记录全部 `/api/*` 写操作与凭据相关事件（查看/复制/导出/增删/启停/指定上游），字段：时间、操作类别、目标、来源 IP、requestId、结果；不落消息正文与任何明文凭据；按 `retentionDays` 清理。
7. **合规风险门**（T106，关闭 P0-2）：`acceptedRiskDisclaimer=false` 时 `/v1/*` 返回 403 `RISK_DISCLAIMER_NOT_ACCEPTED`、面板首屏强制弹风险告知（列出三上游均为非公开/逆向接口、封号与法律风险自担），确认后写 true；README 增加"免责声明"章节；WorkBuddy 全部自动化任务默认 `enabled:false` 且逐个开关旁注明风险。
8. **自动化任务风控缓解**（T401，关闭 P1-3 高影响）：调度加 ±30% 随机 jitter；同类任务连续失败 3 次自动暂停并 Webhook 告警。
9. **启动向导**（v1.2 新增，T106 主责、T110 面板侧承接）：`npm run setup` 交互式向导一次性完成——生成/引导 `CREDENTIAL_ENCRYPTION_KEY`、`PROXY_API_KEY`、`ADMIN_API_KEY`（写入用户级环境变量或 `.env`，`.env` 加入 .gitignore）、最小 config.json、风险门确认；面板首次打开检测缺项给引导卡片。目标是把首次跑通从"翻文档配 6 处"降到"一条命令"。

### 3.8 协议能力矩阵（验收以此为准）

| 能力 | CommandCode | Freebuff | WorkBuddy |
|---|---|---|---|
| OpenAI `/v1/chat/completions`（流/非流） | ✅ 存量 | T201 | T204（上游强制 `stream:true`，非流本地聚合） |
| Anthropic `/v1/messages` + `count_tokens` | ✅ 存量 | T202 | T308（复用 core 通用桥，P2） |
| tools 调用 | ✅ 存量 | T202（schema 规范化） | T204（上游支持以 G0-T2 报告为准） |
| 视觉输入 | ✅ 存量 | 待 G0-T2/B3 验证，矩阵暂标 ⚠️ | 待 G0-T2 验证，暂标 ⚠️ |
| embeddings / images / realtime | ❌ 非目标（第 9 章） | ❌ |  |

### 3.9 成本模型契约（关闭口径混搭）

```ts
interface UsageRecord { /* 既有字段 */ provider: 'commandcode'|'freebuff'|'workbuddy';
  costUsd: number | null;               // null = 不参与美元聚合
  native?: { points?: number; freeSessionSec?: number };
}
```

- commandcode：按定价目录计 USD（存量逻辑）；freebuff：`costUsd=0` 且面板标注"免费额度"；workbuddy：积分 → `costUsd=null` + `native.points`，仅当用户配置 `pointsPerUsdRate` 时折算；
- 面板"今日成本"卡只聚合 `costUsd != null`，其余上游以原生单位并列展示，禁止混加。

### 3.10 目录结构

维持 v1.0 第三节结构，五处修正：`auths/` 注释改"加密 JSON（T103 后不再出现明文）"；删除 Redis 相关条目；`core/` 下新增 `anthropic-bridge.ts`（通用桥，T202 抽出、T308 复用）与 `state-store.ts`；`utils/` 新增 `rate-limiter.ts`、`audit-log.ts`、`security-guard.ts`（SSRF/redirect/rebinding 收口）、`sanitize.ts`；**前端 `public/` 下 JS 按页外置（`public/js/<page>.js` + `core.js`，T110 落地），`index.html` 仅保留骨架与入口引用**。P0 阶段 CommandCode 仅整目录 `git mv`（T108），文件拆分属 P4。

### 3.11 联邦回退最小路径（v1.2 新增，仅 G0-T2 裁决触发）

触发条件见 1.3。最小实现（替换 T204~T207/T308，预估 ≈14.5 → ≈4 人天）：

1. **Sidecar 管理**（`src/providers/workbuddy/sidecar.ts`）：以子进程拉起 Go 二进制（路径/端口可配），健康检查 + 崩溃自动重启（5min 3 次），随主进程退出；
2. **透传 Provider**：实现 3.1 接口的薄壳——`chatCompletion` = 向 `http://127.0.0.1:<sidecarPort>/v1/chat/completions` 透传（流式直接 pipe），`listModels` = sidecar `/v1/models` 映射加前缀，账号管理委托 sidecar 面板 API；
3. **用量采集**：从 sidecar 日志或其面板 API 定时拉取聚合，落 `UsageRecord`（`costUsd=null` + `native.points`，口径按 3.9）；
4. **面板**：上游卡片显示 sidecar 进程状态与透传延迟，账号管理跳转 sidecar 原生面板。

Freebuff 同理适用（Go 二进制可跑，`run_manager` 若移植验证失败即切换）。联邦下 T501 版本化 = sidecar 二进制版本替换。

---

## 4. 技术选型（锁定版本，精确号）

| 层 | 项 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Node.js | 20.x（engines `>=20`） | G0-T1 抬版本；pkg 目标 node20 |
| 语言 | TypeScript | 5.9.3 | strict（lockfile 实际版本，G0-T1 精确化） |
| HTTP | Fastify | 5.12.3 | 存量 |
| 出站 | undici | 7.x 精确号 | **新增直接依赖**，统一客户端 + ProxyAgent |
| 校验 | zod | 3.x | 新增，配置校验（T102） |
| 锁 | async-mutex / proper-lockfile | 0.5.x / 4.x | 池内锁 / 状态文件锁 |
| 热重载 | chokidar | 3.x | config.json |
| 定时 | node-cron | 3.x | 调度状态持久化见 T401 |
| Token 估算 | js-tiktoken | 精确号 | 用量兜底 |
| 前端 | 原生 HTML+JS + Tailwind 3.4.x + Chart.js 4.x + FA 6.x | — | **T110 资源全部本地化 + JS 按页外置**（F24 离线可用） |
| 测试 | vitest | 5.0.0 | 存量（lockfile 实际版本，G0-T1 精确化）；snapshot 基建 T107 |
| 打包 | pkg | 5.x | 存量。**⚠️ v1.2 风险标注：vercel/pkg 已 archived 停维护**，T503 须评估 Node SEA 备选并在部署文档标注；过渡期维持 pkg node20 |

版本变更须走 `TASK-UPGRADE-<n>` 任务单并回归全部 Provider snapshot。

---

## 5. 任务卡

> 卡片格式：**范围 / 参照 / DoD / 预估**。DoD 全部可机器验证或有明确人工步骤。

### P0 底座与单源可用（G0 之后；日历参考 2026-10-12 ~ 2026-11-02）

**T101 Provider 接口与类型体系** ｜ API+PVD ｜ 依赖：G0-T1
范围：按 3.1 建 `interface.ts`、`IAccountPool`、共享类型、错误码扩展。
DoD：[ ] `tsc --noEmit` 通过；[ ] 每接口有 JSDoc；[ ] 类型编译测试存在且绿。｜ 1 人天

**T102 配置体系扩展 + 校验 + 热重载** ｜ CFG ｜ 依赖：T101
范围：按 3.2 扩展 config.json（含 `workbuddy.rewriteMode`）；Zod 校验；旧版配置自动迁移（含 `authTokens` 迁入环境变量/凭据存储的引导）；chokidar 热重载（深合并+原子替换+保留未知键）。
DoD：[ ] 旧配置启动自动迁移且测试覆盖；[ ] 改配置 2s 内热生效（测试断言）；[ ] 校验失败输出具体字段路径并拒绝加载；[ ] 配置中不残留任何密钥字段（3.7-2）。｜ 2 人天

**T103 凭据加密-at-rest** ｜ CFG ｜ 依赖：T102
范围：CredentialStore（File 加密/Memory/Env 后端），AES-256-GCM，明文→密文一次性迁移，无密钥拒启。
DoD：[ ] `auths/*.json` 与凭据文件 cat 为密文；[ ] 未设密钥+有凭据 → 启动失败并指引；[ ] 迁移后生成 `*.plain.bak` 且日志告警；[ ] 加解密往返测试。｜ 1.5 人天

**T104 请求路由层** ｜ API ｜ 依赖：T101,T102
范围：按 3.3 六步决策 + 前缀剥离 + 统一模型注册表 + 命名空间规则 + `X-Actual-Upstream`/`X-Request-Id` 响应头。
DoD：[ ] Header/前缀/默认三种路由 curl 断言；[ ] 全 disabled → 503+Retry-After；[ ] 同名模型裸名请求 → 400 MODEL_AMBIGUOUS；[ ] 六步逻辑单测全覆盖。｜ 2 人天

**T105 鉴权扩展与安全中间件链（新建，非"保留"）** ｜ API ｜ 依赖：G0-T3,T102
范围：按 3.7-1 鉴权矩阵覆盖 provider-admin 路由；rate-limiter（全局+per-provider 桶，TPM/RPM 滑动窗）；modelAccess allow/block；请求 ID 生成传播；audit-log 基础版；sanitizeLog + Fastify redact + NODE_DEBUG 剥离；undici `redirect:'manual'` 逐跳校验。
DoD：[ ] 无 Key 401 / 超频 429+Retry-After / blocklist 403；[ ] 429 按上游分别统计互不误伤（测试模拟 A 上游 429，B 不受限）；[ ] 脱敏验收测试（3.7-3）通过；[ ] SSRF 二跳用例被拦截；[ ] 每条 `/api/*` 写操作产生审计记录。｜ 2.5 人天

**T106 合规风险告知门 + 启动向导** ｜ API+UI ｜ 依赖：T102 ｜ **v1.2 预估 1 → 1.5 人天**
范围：按 3.7-7 风险门 + **3.7-9 `npm run setup` 交互式向导**（生成密钥/写 env/最小 config/风险确认一次完成，`.env` 入 .gitignore）。
DoD：[ ] 未确认时 `/v1` 403、面板弹窗、确认后放行；[ ] README 免责声明章节存在；[ ] `acceptedRiskDisclaimer` 默认 false 有测试；[ ] 全新环境 `npm run setup` 一条命令后可直接 `npm run dev` 跑通 CC 单源请求。

**T107 Snapshot 测试基础设施（关闭 P1-4）** ｜ 测试 ｜ 依赖：G0-T1
范围：mock 上游录制/回放、逐字节对比（时间戳/ID 字段白名单忽略）、Go 原版 fixture 采集脚本（Freebuff 可跑 Go 二进制，WorkBuddy 以 G0-T2 报告样例为准）。
DoD：[ ] `tests/snapshot/` 骨架可运行；[ ] 一条 CommandCode 用例先行通过；[ ] 文档写明移植任务如何添加 fixture。｜ 1.5 人天

**T108 CommandCode Provider 整目录迁移** ｜ PVD ｜ 依赖：T101,T102
范围：`git mv src/adapters/commandcode src/providers/commandcode`（3 文件不拆分不改逻辑），实现 IProvider 外壳（initialize/probe/账号管理/启停/updateConfig/destroy），用量记录补 provider 字段。
DoD：[ ] `npm run verify` 全绿且用例数 ≥298；[ ] SSE 输出 snapshot 逐字节一致；[ ] 面板账号/用量 API 正常；[ ] 启停开关生效。｜ 2 人天

**T109 用量统计 provider 维度** ｜ USG ｜ 依赖：T108
范围：jsonl 记录加 provider 字段（旧记录默认 commandcode）、查询按 provider/时间/模型筛选、聚合缓存带 provider 维、20MB 轮转不变、按 3.9 落 costUsd/native。
DoD：[ ] 三态兼容读写测试；[ ] 筛选结果正确；[ ] 轮转仍有效。｜ 1 人天

**T110 面板基础设施扩展（含 JS 外置与首启引导）** ｜ UI ｜ 依赖：G0-T1 ｜ **v1.2 预估 2 → 2.5 人天**
范围：hash 路由、上游选择器组件、明暗主题 CSS 变量、数据刷新策略（总览 30s/账号 60s/日志 5s）、CDN 资源本地化（Tailwind/Chart.js/FA 落 `public/vendor/`）；**JS 按页外置（`public/js/<page>.js` + `core.js`，index.html 仅骨架，不再等 3,500 行阈值）**；面板首启引导卡片（检测缺 env/config 项，衔接 3.7-9）。
DoD：[ ] 断网打开面板功能完整（F24 前移）；[ ] 主题切换、路由跳转可用；[ ] `public/index.html` ≤1,500 行且页面逻辑 JS 全部外置；[ ] 缺配置时首启引导可见。

**T111 P0 阶段门** ｜ 全模块 ｜ 依赖：T101~T110
范围：E2E（启动→CC 请求→响应→用量→面板）；性能基线：单并发 P50<500ms、50 并发 P99<3s、1h 内存增长<100MB（关闭 P2-5）；全量回归；覆盖率门槛 ≥55%（现 57.57%，防退化）。
DoD：[ ] 第 6 章 A-M 组（P0 部分）全绿；[ ] 基线数据写入阶段记录；[ ] 0.4 两项强制内容（npm audit、DECISION 行）完成。｜ 1.5 人天

### P1 三源全接入与核心面板（参考 2026-11-03 ~ 2026-12-07，约 5 周）

> **v1.2 依赖修正**：T204 依赖"T201 完成核心移植并沉淀移植模板（snapshot 模式/Go 对照注释规范）"——两链**非完全并行**，P1 关键路径为 T201→T202→T204→T205→T206→T207→T213→T214 串行段；面板 T208~T212 与该串行段并行。若 G0-T2 裁决为联邦，T204~T207/T308 按 3.11 替换。

**T201 Freebuff 核心移植** ｜ PVD ｜ 依赖：T101~T104,T107 ｜ 5 人天
范围：run_manager（START→chat→FINISH、租约、inflight、draining）、free_session 缓存刷新、远程模型注册表（GitHub raw `free-agents.ts`，6h 刷新+硬编码 fallback）、upstream-client；函数级对应移植，注释标注 Go 源文件:行号；**沉淀《移植方法模板》（snapshot 模式 + Go 对照注释规范）供 T204 复用**。
DoD：[ ] 流/非流响应正确；[ ] 多 Token 轮询；[ ] Run 预热首请求无额外延迟（并发 50 TTFB 测试）；[ ] 所有创建的 Run 有对应 FINISH（mock 计数）；[ ] snapshot 与 Go 原版逐字节一致。

**T202 Freebuff Anthropic 桥 + schema 规范化** ｜ PVD ｜ 依赖：T201 ｜ 3 人天
范围：Anthropic↔OpenAI 转换（流式块生命周期完整）、`$ref` 解析/nullable 简化、客户端指纹随机化；**通用部分抽 `core/anthropic-bridge.ts`**（供 T308 复用）。
DoD：[ ] Anthropic SDK 调 `/v1/messages` 通过；[ ] tools schema 规范化后上游接收正确；[ ] 桥模块 snapshot 测试。

**T203 Freebuff 账号池与错误处理** ｜ POOL ｜ 依赖：T201,T202 ｜ 2 人天
范围：Round-robin+预热、session invalid/run invalid/auth rejected 分类冷却重试、probe()。
DoD：[ ] 三类错误注入行为符合；[ ] Token 失效 probe 返回不健康。

**T204 WorkBuddy 上游 Client 与协议改写** ｜ PVD ｜ 依赖：T202（移植模板）；**以 G0-T2 报告修订** ｜ 5 人天
范围：payload 改写管线（强制 stream:true、SSE 帧白名单重建、非流本地聚合）、桌面端行为事件链、DeepSeek 思维链注入与 reasoning_content 回填、effort 降级、提示词体系（custom/append/passthrough+拦截自动降级）、指纹脱敏黑名单；**全部改写特性受 `workbuddy.rewriteMode` 总开关控制（3.2），故障一键切 passthrough**。
DoD：[ ] 流/非流正确；[ ] reasoning 回填格式正确；[ ] 三模式提示词生效；[ ] 出站体无黑名单字段；[ ] rewriteMode=passthrough 时出站体与直连 sidecar/原版逐字节一致；[ ] snapshot 锁定。

**T205 WorkBuddy 账号池调度** ｜ POOL ｜ 依赖：T204 ｜ 4 人天
范围：按 3.4（锁规则、预占租约、成本分层、Top-5 加权、防惊群、Classify 错误分类逐条移植）。
DoD：[ ] 权重分布统计测试；[ ] 并发 10 无惊群；[ ] Classify 每类错误单测覆盖；[ ] 状态变更全部在锁内（代码审查项）。

**T206 WorkBuddy 熔断状态机** ｜ POOL ｜ 依赖：T205 ｜ 3 人天
范围：按 3.4 状态机 + 转换日志。
DoD：[ ] 429/402/404/连续失败/手动恢复五路径测试；[ ] maxInFlight 生效；[ ] 转换日志可查。

**T207 WorkBuddy 会话粘性（本地）** ｜ POOL ｜ 依赖：T205 ｜ 1.5 人天
范围：按 3.5（派生规则、TTL、自动解绑、StateStore 本地实现）。
DoD：[ ] 同 ID 固定账号；[ ] TTL 与解绑行为；[ ] 无 Redis 依赖。

**T208~T212 面板五页**（总览 3 ｜ 上游管理 3 ｜ 账号-Token 3 ｜ 模型目录 2 ｜ 用量统计+CSV(BOM) 2）｜ UI ｜ 依赖：T110 + 对应后端
范围：按 v1.0 排期方案 TASK-016~020 的清单执行，收紧：SecretField 复制动作必须写审计（T105 通道）；用量页按 3.9 分口径展示。
DoD：[ ] 各页数据与后端一致；[ ] 启停 2s 内生效；[ ] 脱敏默认开启、明文显示 3s 自动恢复；[ ] CSV 中文 Excel 打开无乱码。

**T213 统一 API 层三源接线 + P1 手动降级** ｜ API ｜ 依赖：T201~T207 ｜ **v1.2 预估 1 → 1.5 人天**
范围：chat/messages/models 路由接三 Provider，X-Upstream-Provider 全链路；**面板手动切换默认上游（热生效）+ 上游异常横幅（health 驱动），关闭 P1→P2 之间的体验空窗（3.6）**。
DoD：[ ] 三上游专属模型分别请求来源正确；[ ] 混合并发 50 无跨 Provider 污染；[ ] 面板切换默认上游 2s 内对新请求生效；[ ] 某上游 health 异常时横幅出现且恢复后消失。

**T214 P1 阶段门** ｜ 依赖：T201~T213 ｜ 3 人天
范围：三源 E2E、面板逐页验收、错误注入降级（strict 语义）、5 分钟泄漏监控。
DoD：[ ] 第 6 章 A-M 组全绿；[ ] 覆盖率 ≥55%；[ ] snapshot 三源全过；[ ] 0.4 两项强制内容完成（本 Gate 的 DECISION 行含架构复核结论）。

### P2 账号池深化与路由策略（参考 2026-12-08 ~ 2026-12-28，3 周）

**T301 WorkBuddy OAuth 设备授权 + 刷新** ｜ PVD+CFG ｜ 依赖：T204,T103 ｜ 3 人天
范围：设备授权全流程、面板内添加账号、refreshToken 到期前预刷、失败告警（Webhook+面板）+ 3 次指数退避重试 + "待刷新"状态（非静默失效）、auths/*.json 走 T103 加密。
DoD：[ ] 面板完成授权加账号；[ ] 模拟 refresh 500：重试→告警→状态"待刷新"；[ ] 过期前 1h 自动预刷；[ ] 文件无明文 token。

**T302 余额刷新与池状态持久化** ｜ PVD ｜ 依赖：T301 ｜ 2 人天
范围：5min 余额刷新、state.json 原子写+锁+损坏重建。
DoD：[ ] 积分按期刷新；[ ] kill -9 后重启状态一致；[ ] 损坏文件恢复测试。

**T303 健康探测 + 自动降级 + 级联防护** ｜ API+PVD ｜ 依赖：T214 ｜ 3 人天
范围：按 3.6 全量实现（probe 调度 30s、degraded 标记、ramp、429 摘除、队列深度、首字节前降级）。
DoD：[ ] 断网 30s 内面板 degraded、恢复 30s 内 healthy；[ ] 降级流量曲线无瞬时尖峰（压测输出直方图）；[ ] 备选 429×2 摘除测试；[ ] 流式中途失败不切换上游；[ ] queueMaxDepth 503 生效。

**T304 路由策略高级配置** ｜ API ｜ 依赖：T303 ｜ 2.5 人天
范围：strict/auto/same-model、X-Upstream-Account（写审计）、粘性开关、路由规则配置页。
DoD：[ ] 三模式行为 curl 断言；[ ] 强制账号指定生效且留痕；[ ] 规则页配置热生效。

**T305 Freebuff 等待室与队列** ｜ PVD ｜ 依赖：T201 ｜ 2 人天
范围：waitingRoom 排队、位置提示透传、轮询、超时处理。
DoD：[ ] 高负载模拟排队与位置更新；[ ] 超时错误语义正确。

**T306 面板运行日志页** ｜ UI ｜ 依赖：T105(请求ID),T108 ｜ 2 人天
范围：独立页（B1 决议），频道/上游/关键词筛选，requestId 关联详情。
DoD：[ ] 三筛选正确；[ ] 详情含 requestId/模型/账号/状态/耗时；[ ] 5s 刷新。

**T307 面板系统设置页** ｜ UI+CFG ｜ 依赖：T102 ｜ 2 人天
范围：独立页，网络/安全/告警/存储/面板五区块，热生效、需重启项标红、危险操作二次确认。
DoD：[ ] 保存 2s 热生效；[ ] 校验失败字段级标红；[ ] 清空用量需确认+审计。

**T308 WorkBuddy Anthropic 通用桥接入** ｜ PVD ｜ 依赖：T202,T204 ｜ 1 人天
范围：core/anthropic-bridge 复用，矩阵补齐。（联邦裁决时随 T204 系一并按 3.11 替换）
DoD：[ ] `/v1/messages` 对 workbuddy 模型可用；[ ] snapshot。

**T310 P2 阶段门** ｜ 依赖：以上 ｜ 2 人天
范围：安全复测（SSRF/rebinding/脱敏断言）、100 并发 WB 池无惊群 P99<2s、OAuth 全链路演练。
DoD：[ ] 第 6 章 A-F 组（P2 部分）全绿；[ ] 覆盖率 ≥60%；[ ] 0.4 两项强制内容完成。

### P3 定时任务与高级功能（参考 2026-12-29 ~ 2027-01-11，2 周）

**T401 调度框架 + WorkBuddy 任务体系** ｜ CRON ｜ 依赖：T301 ｜ 3 人天
范围：node-cron + lastRunAt 持久化与重启补偿（关闭 P2-3）、±30% jitter、独立开关默认关、连败 3 次自动暂停+告警；签到/活跃/旅行/保活/黑猫五类。
DoD：[ ] 任务前 1min 重启仍补偿执行；[ ] 开关即时生效；[ ] jitter 有统计测试；[ ] 连败自动暂停。

**T402 成长任务一键完成 + 连登管家** ｜ CRON+PVD ｜ 依赖：T401 ｜ 3 人天
范围：任务序列上报（数量以 G0-T2 报告为准）、连登兑换抽奖、执行队列。
DoD：[ ] 一键完成推进进度；[ ] 失败留详细日志且不崩队列；[ ] 默认关闭。

**T403 面板任务中心页** ｜ UI ｜ 依赖：T401,T402 ｜ 2 人天
范围：独立页（B1 决议）：定时任务状态/成长任务矩阵/连登面板/任务日志筛选。
DoD：[ ] 下次执行时间与上次结果准确；[ ] 开关即时；[ ] 队列进度展示。

**T404 性能面板与成本可视化** ｜ UI+USG ｜ 依赖：T212 ｜ 2 人天
范围：P50/P95、吞吐（≥32 token 过滤）、缓存节省与峰谷（仅 CommandCode）、按 3.9 分口径成本卡。
DoD：[ ] 指标与 usage 记录一致；[ ] 美元/积分分列不混加。

**T405 Webhook 告警与预算** ｜ API+USG ｜ 依赖：T109 ｜ 1 人天
范围：日预算、错误率阈值、告警历史。
DoD：[ ] 阈值触发 JSON 正确；[ ] 历史可查。

**T406 P3 阶段门** ｜ 依赖：以上 ｜ 1 人天
DoD：[ ] A-F 组（P3 部分）全绿；[ ] 定时任务实跑一轮留痕；[ ] 0.4 两项强制内容完成。

### P4 完善与终验（参考 2027-01-12 ~ 2027-01-25，2 周）

**T501 Provider 版本化 Adapter** ｜ PVD ｜ 依赖：全部 ｜ 2 人天
范围：`upstreamVersion` 配置、多版本并存、按实例灰度（R2 缓解项；联邦下 = sidecar 二进制版本替换）。
DoD：[ ] 版本切换路由正确；[ ] 双版本并存测试。

**T502 审计完善与合规留痕** ｜ API ｜ 依赖：T105 ｜ 1 人天
范围：凭据查看/复制/导出全事件覆盖、retentionDays 清理、审计自脱敏。
DoD：[ ] 全部 `/api/*` 写与凭据事件有记录；[ ] 超期自动清理。

**T503 部署与迁移文档** ｜ 文档 ｜ 依赖：T111 起 ｜ 2 人天
范围：Dockerfile（node:22-alpine，secrets 走 `/run/secrets` 文件读取，`.env` 禁止入镜像）、pkg 单二进制 + **Node SEA 备选评估（pkg 已停维护，结论写入部署文档）**、三项目迁移指南（**含 T106 风险门对存量用户的 403 升级提示**）、config 全字段参考、OpenAPI 文档。
DoD：[ ] 按文档 docker 构建运行成功；[ ] 三项目配置迁移各走通一次；[ ] Swagger 可读；[ ] SEA 评估结论留档。

**T504 全量终验门** ｜ 测试 ｜ 依赖：T501~T503 ｜ 2 人天
范围：A-M+A-F 全项、并发 10/50/100/200 基线、24h soak（内存增长<50MB）、崩溃保护回归（5min 3 异常退出，存量能力）。
DoD：[ ] 全矩阵绿；[ ] 覆盖率 ≥60%；[ ] 基线对比 P0 无退化（P50 变化<10%）。

**T505 代码审查与文档补全** ｜ 文档 ｜ 依赖：T504 ｜ 1 人天
范围：strict 无错、eslint 零告警、JSDoc、README/FAQ/CHANGELOG。
DoD：[ ] `tsc --noEmit` 与 eslint 干净；[ ] README 快速开始可复制执行。

---

## 6. 验收矩阵（统一编号，每项标注验证任务与方法）

### A-M（MVP，P0+P1 门后全部通过；共 14 项）

| ID | 内容 | 验证 | 方法 |
|---|---|---|---|
| M01 | CommandCode 单源 OpenAI 接口 | T108/T111 | curl 流/非流 |
| M02 | 模型名隐式路由三源 | T213/T214 | 三专属模型来源断言 |
| M03 | X-Upstream-Provider 路由 | T104 | curl |
| M04 | 前缀路由+剥离 | T104 | curl |
| M05 | 面板三上游状态卡片 | T208 | 人工+API 比对 |
| M06 | 面板启停上游即时生效 | T209 | 2s 内新请求生效 |
| M07 | CC 多账号额度轮换 | T108 | 存量测试+回归 |
| M08 | Freebuff 多 Token 轮换 | T201 | 连续请求断言 |
| M09 | WB 多账号调度+粘性 | T205/T207 | conversation_id 复现 |
| M10 | 模型目录三源合并（带前缀） | T211 | 数量与来源比对 |
| M11 | 用量统计含 provider 维度 | T209→T212 | 请求后刷新验证 |
| M12 | 错误码语义（503/429/403/400） | T104/T105 | curl 断言 |
| M13 | PROXY/ADMIN 鉴权矩阵 | G0-T3/T105 | 401/403/200 矩阵 |
| M14 | 合规门与离线面板 | T106/T110 | 未确认 403；断网开面板 |

### A-F（完整版，P2~P4 门后全部通过；共 16 项）

| ID | 内容 | 验证 |
|---|---|---|
| F01 | 三源 Anthropic `/v1/messages` | T202/T308/T214 |
| F02 | 三源 tools | T202/T204 |
| F03 | 视觉（CC 必过；FB/WB 按矩阵） | T108/T201/T204 |
| F04 | strict/auto/same-model 三档 | T304 |
| F05 | X-Upstream-Account + 审计留痕 | T304/T502 |
| F06 | WB OAuth 全流程+预刷+待刷新态 | T301 |
| F07 | 账号池可视化+积分条 | T302/T210 |
| F08 | Freebuff 等待室 | T305 |
| F09 | 级联防护（ramp/摘除/队列/首字节） | T303 |
| F10 | 用量成本分口径+CSV 导出 | T212/T404 |
| F11 | 性能面板 P50/P95/缓存节省/峰谷 | T404 |
| F12 | 运行日志页三筛选+requestId | T306 |
| F13 | 定时任务（补偿+jitter+自动暂停） | T401 |
| F14 | 成长任务一键完成 | T402 |
| F15 | 任务中心页 | T403 |
| F16 | Webhook 告警+预算 | T405 |

安全/性能横切项（T310/T504 复验）：SSRF 含二跳、DNS rebinding、日志全路径脱敏断言、50 并发 P99<3s、100 并发 P99<2s 无惊群、24h 内存<50MB、覆盖率≥60%。

---

## 7. 排期与里程碑（单人 + AI agent 基线，v1.2 修正）

- **总工作量 ≈ 101.5 人天**（G0 2.5 + P0 18.5 + P1 41 + P2 19.5 + P3 12 + P4 8；v1.1 的"86"为算术错误，任务卡逐项求和见各章）；
- **关键路径重估 ≈ 65 人天**：G0(2.5) → T101(1)→T102(2)→T104(2)→T108(2)→T109(1)→T111(1.5) ＋ P1 串行段 T201→T202→T204→T205→T206→T207→T213→T214(≈22.5，面板 13 人天部分并行计 6) ＋ P2 T303→T304→T310(7.5) ＋ P3 T401→T402→T403→T406(9) ＋ P4(8)；
- **每日投入假设（v1.2 新增）**：日历窗口按"agent 双链并行 + 项目负责人每日 ≥1.5 人天等效投入（验收+集成）"折算；业余节奏（每日 <1 人天）时日历按 ×2 预估，**阶段门是硬约束，日历窗口仅参考**；
- 可并行组（agent 可同开多分支）：P0 内 T101/T102/T110 先行，T103~T107 依赖链随后；P1 内 T204 起可与 T203 后的面板/收尾并行（依赖修正见 P1 章首注），面板 T208~T212 与后端串行段并行；P2 内 T305/T306/T307 独立；
- v1.0 的"2.5–3.5 人 staffing 表"废止；B1（信息架构归属）已决议：任务中心、运行日志、系统设置为独立页面（T306/T307/T403）。

---

## 8. 风险登记

| ID | 风险 | 概率/影响 | 缓解 | 回退 |
|---|---|---|---|---|
| R1 | Go→TS 移植保真度 | 中/高 | 函数级移植注行号、snapshot 先行（T107）、先 Freebuff 验证方法、**G0-T2 架构裁决点（1.3）** | 联邦 Sidecar（3.11 最小路径） |
| R2 | CodeBuddy 协议不稳（已删库一次） | 高/高 | Provider 隔离、T501 版本化灰度、T303 探测降级、协议版本检测、**G0-T2 报告归档源码快照** | disable WorkBuddy 不影响他源；联邦切换 |
| R3 | 池状态机复杂度 | 中/高 | 逐函数翻译、Classify 全覆盖、转换日志 | 先简单轮询，加权随机后置迭代 |
| R4 | OAuth refresh 批量失效 | 中/高 | T301 告警+预刷+待刷新态+加密 | 手动重授权+备份脚本 |
| R5 | 自动化任务风控封号 | 高/高 | 默认关、jitter、连败暂停、风险弹窗、rewriteMode 总开关（3.2） | 关任务保聊天 |
| R6 | agent 执行漂移 | 中/高 | 0.1 启动循环、每任务 commit+证据、Gate 硬约束、禁止标绿未验证项 | 回滚至上一 Gate 记录点 |
| R7 | 合规/ToS 追责 | 低/高 | T106 风险门、README 免责、个人学习用途定位、不内置分发凭据 | 移除对应 Provider 目录 |
| R8 | **pkg 停维护导致打包链路失效**（v1.2 新增） | 中/中 | T503 评估 Node SEA 并留档；过渡期 pkg node20 | Docker 部署为主、单二进制降级为可选 |
| B2 | workbuddy 源码结构差异 | — | 转为 G0-T2 门任务，>20% 差异触发重估 | 按报告重排 P1 或联邦切换 |

---

## 9. 非目标（明确不做，防范围蔓延）

Redis/多实例共享状态；数据库后端（SQLite 仅在 state 损坏问题实测发生后再议）；虚拟 Key/多租户；OpenAI Responses/embeddings/images/realtime；前端框架迁移（JS 按页外置不等于引框架，T110 的拆分是文件组织而非技术栈变更）；Provider 内部协议逻辑拆分（P0 只搬家，拆分在 P4 后另议）。

---

## 10. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-06 | 初版（PRD+架构+UI+排期+复核合并 PDF） |
| v1.1 | 2026-10-06 | 按意见书重写：①6 项 P0 全部落任务；②底座事实勘误；③接入审计批次 B 并映射 C/D 项；④验收统一 A-M(14)/A-F(16)+横切项；⑤排期改单人+agent 基线、废止 staffing 表、B1 决议；⑥删除 Redis、增成本模型 3.9 与协议矩阵 3.8；⑦新增第 0 章 agent 执行协议与 R6/R7 |
| v1.2 | 2026-10-06 | 评审修订：①**工作量汇总修正 86→≈101.5 人天**（v1.1 算术错误），重排关键路径 ≈65 人天，新增每日投入假设；②修正 T204 与"双链并行"依赖矛盾（P1 关键路径改串行段）；③**G0-T2 升级为架构最终裁决点**（1.3 阈值 + DECISION 行），新增 3.11 联邦回退最小路径（≈14.5→≈4 人天）；④体验任务：T106+T110 启动向导（3.7-9）、T213 手动降级+异常横幅、T204 rewriteMode 总开关（3.2）；⑤阶段门新增 npm audit 检查与继续/止损决策行（0.4）；⑥T110 JS 按页外置（不等 3,500 行阈值，3.10）；⑦R8 pkg 停维护风险、T503 Node SEA 评估、T503 存量用户 403 升级提示；⑧G0-T3 patch 路径适配说明；⑨底座事实 2026-10-06 实地复核标注（含 9090 常驻进程约束） |
| v1.2.1 | 2026-10-06 | **G0-T2 架构裁决落地：DECISION = pivot-federated**（报告 `docs/wb-source-diff-report.md`：源码 41,857 行无混淆、综合差异 ≈50%、阈值②触发——payload 改写点 >25 处且 ≥6 处顺序敏感耦合）。T204/T205 替换为透传 Provider + 账号委托（合计 ≈2.5 人天），T206/T207 取消（状态机/粘性由 sidecar 内置承接），T308/T401/T402 联动调整；P1 预估 41 → ≈31 人天，总工作量 ≈101.5 → ≈91.5 人天。任务卡正文修订以报告第 7 节为准；项目负责人复核推翻时按报告第 6 节契约修订文本回方案 A。G0-T3 落地后鉴权契约命名对齐实现（ADMIN_API_TOKEN / `x-admin-token`，3.7-1 已改） |
| v1.2.2 | 2026-10-06 | ①**G0 + P0 全部完成**（G0-T1/T2/T3 + T101~T111 共 14 张卡交付）并**阶段门通过**：单并发 P50 31ms、50 并发 P99 151ms/383rps/0 错误、覆盖率 67.97%、`npm audit --omit=dev` 0 漏洞、eslint 零告警；**DECISION: continue**（完整数据见工程仓库 `PLAN-STATE.md` 阶段记录）。②**补记 Freebuff2API 源仓库坐标**（v1.1/v1.2 遗漏，P1 必需）：`https://github.com/Quorinex/Freebuff2API`（Go，4,066 行，HEAD `a1c1035`），已 clone 至本机 `F:/AI/Qdor/review/Freebuff2API`（**第三方 Go 源码，未随本仓库分发**）；经逐项核对与 T201/T202/T305 描述吻合（`run_manager.go` 的 lease/inflight/draining、`free_session.go` 的 waitingRoomErrorFromSession、`models.go:18` 的 `free-agents.ts` 远程注册表地址）。③P0 落地中的偏离与新增登记：T110 面板 JS 暂落 `public/vendor/js/`（服务端无 `/js/*` 静态路由，待 P1 加路由后平移）；T105 新增 `MODEL_ACCESS_DENIED(403)` 错误码（§3.1 外最小扩展）；新增 `npm run setup` 启动向导（§3.7-9 落地）；新增 `scripts/bench-baseline.mjs` 基线工具；TASK-UPGRADE-1 依赖安全升级（chokidar 5.0.0 移除 braces 高危、fastify 5.12.5）。④**T106 风险门是破坏性变更**：存量部署升级后未确认前 `/v1/*` 一律 403，T503 迁移指南须显著标注。⑤P0 遗留 5 项（1h soak→T504、B3 用例抖动、面板 JS 路由、T213 收口项 ×2）已登记于 `PLAN-STATE.md` |
| **v1.2.3** | 2026-10-06 | **基准重大更正 + 重定基决策**。发现真实部署与上游 main 均为 **v4.22.4**，而方案自 v1.0 起的全部基线事实（含 §1.2 勘误表）都基于一份**过期检出** `F:/AI/Qdor/repos/commandcode-proxy`（v4.17.0）。**§1.2 勘误表整表作废**（"48 个测试文件"本就是正确数字，被误改为 23；面板实为 1816 行；`adapters/commandcode` 已模块化为 `pipeline/`+`anthropic-response.ts`+`reasoning.ts`；undici 已是运行时依赖；engines 已是 `>=20`；pkg 已换 `@yao-pkg/pkg` → R8 在本线解除）。①**用户决定：重定基到 v4.22.4**，唯一工程仓库改为 `C:\Users\admin\Doubao\chats\2026-09-03\new-chat-5\commandcode-proxy`（分支 `feat/p0-port`，基线 48 文件 / 626 用例全绿已确认）。②**移植计划**：Phase A 工程基座 → B 审计批次 B 语义移植 → C 新增模块文件 → D 接缝接线 → E 面板移植 → F 全量回归+阶段门+部署；队列见工作副本 `PLAN-STATE.md` §1。③**9090 部署未动**，移植完成并经用户确认后才重启（上线后用户需在面板确认风险告知，此前 `/v1/*` 返回 403）。④**T108 前提失效**：原"3 文件整目录平移"不成立，去留在 Phase D 重新决策。⑤**T202 需重评**：新树已有 `anthropic-response.ts` 与 `pipeline/`，须先评估复用而非另写桥。⑥新流程约束：**今后引用基线事实必须同时标注版本号与验证命令**（本次错误的根因） |
