# commandcode-proxy 架构与质量审查

**审查对象**: `wjf1/commandcode-proxy` v4.17.0 @ commit `a22e678`
**本地副本**: `F:\AI\Qoder\repos\commandcode-proxy`
**审查日期**: 2026-09-20
**审查方式**: 架构证据 + 实际执行验证（`npm ci`、`tsc`、`eslint`、`vitest --coverage` 均在本机 Windows 实跑）+ GitHub API 实况核验 + 主流同类项目横向对比
**产出约定**: 仅审查，未修改仓库任何文件
**生成工具**: `architecture-visualization:risk-quality-reviewer`（风险/质量审查），对比部分为独立 Web/GitHub 核验

---

## 0. 结论先行

这是一个**工程质量显著高于同体量开源项目平均水平**的代码库。以下判断有实测支撑，不是客套：

- 本机实测：`tsc --noEmit` 0 错误、`eslint .` 0 错误、**288 项测试全通过**（17.7s）
- 运行时依赖只有 **1 个**（fastify 5.12.3），`npm audit --omit=dev` **0 个漏洞**
- `strict: true` 且无任何子开关放宽；全仓 **0 处 `@ts-ignore` / `@ts-expect-error`**
- 集成测试使用本地 mock upstream，**零真实网络调用**，是真正的 hermetic 测试
- CI 矩阵同时覆盖 `ubuntu-latest` + `windows-latest`，且 lint/typecheck/build/test 全部为阻断门禁
- CHANGELOG 26 个版本手写维护，包含"已知问题（本次排查中发现，未修）"章节——这种自我披露在开源项目里少见

**但审查发现 4 个应当立即处理的问题**，其中 3 个是"功能静默失效"类（用户和 CI 都看不到），1 个是鉴权边界设计问题。它们的共同特征是：**都不是写错的代码，而是没人验证过的代码路径**。

风险容忍度假设：本项目定位是**个人/小团队自托管的单上游网关**（README 明确无多租户/多供应商野心）。本报告的严重度均按此定位判断，不按 LiteLLM 的标准判断。若该假设不成立（例如你打算公网多用户部署），第 2 节 P0-2 需上调至 Critical。

---

## 1. 系统现状模型

### 1.1 容器视图（L2）

```
客户端(IDE/CLI: OpenAI SDK / Anthropic SDK / OpenWebUI / Aider)
   │  HTTP + SSE
   ├── /v1/chat/completions ──> src/routes/chat.ts (344) ──┐
   ├── /v1/messages          ──> src/routes/messages.ts(378)├──> CommandCodeAdapter
   ├── /v1/messages/count_tokens                           │      (adapter.ts 888)
   ├── /v1/models[?plan]      ──> src/routes/models.ts(93) ─┘           │
   ├── /api/*  (16 管理面)  ──> src/routes/dashboard.ts(424)            │
   └── /       (SPA 仪表盘) ──> public/index.html (1239 行)             │
                                                                       v
                                              upstream.ts (508) ── fetch ──> commandcode.ai
                                                    │  有界重试 + 流内 error 预探测
                                                    v
                              本地态: config.json / auth.json / .env
                                      usage-history.jsonl (20MB 轮转)
                                      models.json (定价目录缓存, 6h TTL)
```

**规模**（本人实测 `wc -l`）：`src/` 22 个 `.ts` 共 **6,837 行**，`tests/` 18 个文件，`public/index.html` 1,239 行。

### 1.2 关键架构决策与评价

| 决策 | 证据 | 评价 |
|---|---|---|
| 单运行时依赖（只用 fastify，HTTP client 用 Node 内置 fetch，自研 semver/SSE/日志） | `package.json:60-62` | **优点**。供应链面积极小，这是 0 个生产依赖漏洞的直接原因 |
| 文件态而非数据库（JSONL 追加 + 内存写队列 + 轮转） | `usage-store.ts:271,774` | **契合定位**。单用户场景合理；但见 P2-3 关于并发与迁移 |
| 协议翻译集中在 Adapter，路由只做 I/O | `adapter.ts:272,395,585,785` | **意图正确但执行不彻底**——见 P1-4，Anthropic 出口编码器实际留在路由层 |
| 鉴权为可选开关 | `chat.ts:53-55` | **核心风险源**——见 P0-2 |
| 崩溃自愈：3 次/5 分钟未捕获异常即主动退出交给看门狗 | `index.ts:30-43` | **优点**。比"记日志继续跑"诚实 |
| 优雅退出前 flush 用量写队列 | `index.ts:98-109` | **优点**。避免 Ctrl+C 丢会话记录 |

---

## 2. 最高优先级发现（P0）

### P0-1 `npm test` 在未构建时会静默跳过 42 项最关键的测试，并报"全绿"

**严重度**: 高 · **可能性**: 高（默认开发流程即触发） · **置信度**: **高（本人两次实跑复现）** · **影响面**: 全部推理路由、SSE 流、重试循环、错误契约、16 个管理面 handler 的回归保护

`tests/integration.test.ts:30` 定义 `const distReady = existsSync(DIST_ENTRY)`，随后 8 个 `describe.skipIf(!distReady)`（`:348,537,583,750,1001,1017,1048`）。`dist/` 被 gitignore（`.gitignore:2`）。

本机实测对照：

| 我执行的命令 | 结果 |
|---|---|
| `npx vitest run --coverage`（未先 build） | **244 passed \| 42 skipped**，退出码 0（"全绿"） |
| `npm run build` 后 `npx vitest run` | **288 passed**，无跳过 |

也就是说，占推理链路核心保护的全部 42 项端到端用例（真实 spawn `dist/index.js` + 真实 HTTP），在未构建的克隆上**完全不执行且不报错**。

**必须澄清的边界**：CI 的顺序是 Lint→Typecheck→**Build**→Test（`ci.yml:31-38`），所以 **CI 本身是安全的**，main 分支目前确实真绿。此问题的实际受害者是：新贡献者/你在本机跑 `npm test` 得到的假绿反馈，以及任何直接调 `npm test` 的下游自动化。这是我实测中踩到的第一个坑，也是本次审查里唯一有"执行证据"的 P0。

顺带修正两个我自己的初判错误，记录在此以免误导后续判断：
- 最初未 build 时的那 2 个 `EPERM rename` 失败，在干净重跑后通过——是**间歇性抖动**，不是硬故障（根因见 P2-2）。
- 我曾判断"git tag 停在 v4.9.2、8 个版本没打 tag"——**错误**。`git tag -l` 默认按字典序排，`v4.10.0 < v4.9.2`。用 `--sort=-v:refname` 后确认 tag 打到 **v4.17.0**，与 `package.json` 一致。发布纪律没有问题。

**验收标准**: `npm test` 在缺少 `dist/index.js` 时报错退出（或 `package.json` 增加 `"pretest": "npm run build"`）；CI 增加"skipped 测试数必须为 0"断言。

---

### P0-2 管理面默认零鉴权，且 `/v1` 数据面与 `/api` 管理面共用一把密钥

**严重度**: 高 · **可能性**: 中（取决于 host 绑定） · **置信度**: 高（代码直读） · **影响**: 账号增删、密钥切换、历史清空、上游指向改写、配额盗用

`src/routes/chat.ts:53-58`：

```ts
const requiredKey = process.env.PROXY_API_KEY?.trim();
if (!requiredKey) return;                      // 未设置 → 整个鉴权钩子不注册
fastify.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/v1/') && !req.url.startsWith('/api/')) return;
```

两个后果：
1. **不设 `PROXY_API_KEY` 时，`/api/*` 的 16 个管理端点完全无鉴权**。绑定 `0.0.0.0` 时只在启动时打一条 warning（`index.ts:194-200`）而不阻止启动。
2. **设置了 `PROXY_API_KEY` 时，能调 `/v1` 的每个 IDE 客户端同时也拿到完整管理权**——一把密钥同时是"消费额度的凭证"和"改配置的凭证"，权限没有分离。

`tests/auth.test.ts:77-85` 实际上把"开放模式"作为契约锁定了，所以这是**有意的设计**（本地单机优先）。项目对这一点的自觉程度也很高——`index.ts:196` 的告警文案明确写出"局域网内任何人都可以…增删账号、切换 Key、清空历史"。**问题在于：既然已知后果这么严重，防线却只是一条日志。**

**已存在的缓解（必须一并承认，否则结论失真）**：管理面有 CSRF 防护 `isSameOriginIfPresent`（`sse-common.ts:19-26`，在 `dashboard.ts:53` 对所有 `/api` 写操作生效），跨站网页无法直接 POST 驱动管理面；`guard.test.ts` 6 项锁定该行为。所以**默认回环绑定 + 同源检查**这个组合，对"本地个人使用"这一定位是站得住的。

**残余缺口——DNS rebinding**：该检查把 `new URL(origin).host` 与 **`req.headers.host`** 比对，而 Host 头正是重绑定攻击者可控的。攻击者让 `evil.tld` 的 A 记录以短 TTL 指向 `127.0.0.1`，浏览器发出的请求 Origin 与 Host 同为 `evil.tld:9090` → 判定同源通过。全仓无 Host 白名单（`grep -i "rebind|allowedHost"` 仅命中上游 SSRF 相关代码，非入站）。这把 P0-2 的触发条件从"必须绑 0.0.0.0"降低为"用户访问过一个恶意网页"。置信度：高（逻辑可静态确认，但未做 PoC 实打）。

**验收标准**:
- 引入独立 `ADMIN_API_KEY`；验收：持有效 `/v1` 密钥调用 `POST /api/accounts/delete` 必须 403。
- Host 头白名单只允许回环名（或非回环 Host 直接 404）；验收：`Host: evil.tld:9090` + `Origin: http://evil.tld:9090` 打 `HOST=127.0.0.1` 必须 403。
- 非回环绑定且未设密钥时，由"警告后继续"改为"拒绝启动，除非显式 `ALLOW_INSECURE_BIND=1`"。

---

### P0-3 应用内"发现新版本"能力自 v4.13.0 起永久失效

**严重度**: 高（功能正确性）/ 低（安全） · **可能性**: 确定 · **置信度**: **高（GitHub API 实测）**

`src/utils/update-check.ts:11` 轮询 `releases/latest`，但本项目只打 tag、不创建 GitHub Release 对象。API 实况：

```
releases/latest  →  {"tag":"v4.12.0","published":"2026-09-16"}
最新 tag         →  v4.17.0
```

`isNewerVersion(latest, current)` 拿 v4.12.0 与本机 v4.17.0 比 → 永远返回 false。**v4.13.0 之后的 5 个版本，用户侧看不到任何升级提示**——包括 v4.17.0 那个"上游把错误伪装成 200 流"的重要修复。对自托管工具，静默不更新 = 已知缺陷长期在野。

**验收标准**: 发布流程改为 tag-push 触发 workflow 自动创建 Release；或 `update-check` 改读 `tags` 端点。验收：`curl -s https://api.github.com/.../releases/latest | jq .tag_name` 与最新 tag 一致。

---

### P0-4 额度耗尽时的账号轮换从未发生（`onRetry` 死代码）

**严重度**: 高 · **可能性**: 中（配额撞顶时触发） · **置信度**: 高（三点闭合验证） · **影响**: 计费/连续性——这是资金路径

`SendOptions.onRetry` 在 `upstream.ts:116` 声明类型，两条路由都传入了"额度错误则轮换账号"的回调（`chat.ts:140`、`messages.ts:116`），但 `upstream.ts` 的重试循环**从未调用它**（grep `onRetry` 在 `src/` 仅命中这 3 处 + 0 个调用点）。

CHANGELOG 4.17.0 自己记录了这个已知问题，并说明为什么不顺手修：`onRetry` 会在重试途中换掉 `apiKey`，属于有实际后果的行为变更，需先确认。**这个"不擅自改动"的判断是对的**，但它已经跨了 1 个版本未闭环。

注意这与 `index.ts:141-148` 那个真实存在、每 30 分钟跑一次的 `auto-quota` 轮换调度器**是两条不同路径**：定时轮换在工作，请求中途的即时轮换失效。所以现象是"最长 30 分钟内额度耗尽不会自动切号"。

**验收标准**: 在重试循环内调用 `onRetry`，并新增测试断言重试后 `apiKey` 已切换；或删掉这条死路径，并在 README 说明轮换粒度只有 30 分钟。

---

## 3. P1（本迭代内处理）

| # | 发现 | 证据 | 严重度/置信度 | 验收标准 |
|---|---|---|---|---|
| P1-1 | **`upstreamTimeoutMs` 是空配置**：被加载、被写入默认值、并在仪表盘展示给用户，但没有任何一处 fetch 真正应用它 | 定义/加载 `config.ts:36,294,319`；展示 `dashboard.ts:143`；`grep upstreamTimeoutMs src/` → **0 个消费点** | 中/高 | 要么接入总时限，要么从 UI 与类型中删除（保留"UI 承诺了一个不存在的能力"是最坏组合） |
| P1-2 | **出站重定向不复核 SSRF 白名单**：`assertSafeUpstreamUrl` 只在发请求前校验初始 URL，Node fetch 默认 `redirect:'follow'`，二跳可指向 `169.254.169.254`/内网 | `upstream.ts:318,383`；`config.ts:523`；`grep -rn redirect src/` → **零命中** | 中/高（跨域凭据转发已被 Fetch 规范阻断，此点已核实为**非**风险） | `redirect:'manual'` + 逐跳校验；补 mock 302→元数据地址的测试（现有 `url-safety.test.ts` 完全未覆盖重定向） |
| P1-3 | **管理面存储型 DOM-XSS**：`badge()` 对 `title` 调了 `esc()`，但把 `text` 裸拼进 innerHTML，而 `text` 来自抓取的上游定价页字段；全站无 CSP | `public/index.html:670-672`（`+ text +`）；调用点 `:746` `badge('DEAL '+m.deal.discountPercent+'%')`；数据源 `models.ts:202`；`grep Content-Security-Policy` → **0 命中** | 中/高 | `text` 同样 `esc()` + 数值强制转换；加 `Content-Security-Policy` 头（`default-src 'self'`）作纵深防御。注意：作者**已经知道**要用 `esc`（title 参数用了），这是漏了一处而非不懂 |
| P1-4 | `/api/auth/manual-login` 把**完整明文 apiKey** 回传前端（`AccountInfo.apiKey` 字段），而其它出口都做了 mask | `dashboard.ts:225-234` `return {account: acc}`；`types/index.ts:17-25` `apiKey: string`；对照正确做法 `dashboard.ts:192,265` 的 `apiKeyMasked` | 中/高 | 只回 `apiKeyMasked`。同一文件内已有正确范式，属未对齐 |
| P1-5 | OAuth 回调在 `state` **缺失时直接放行**，登录流程窗口期（约 3 分钟）内任何人可向 `localhost:5959/callback?token=<attacker>` 表单 POST，注册并激活攻击者账号 | `config.ts:678-683` `if (cbState && cbState !== stateToken)`；注释明示是为兼容旧版 CLI 的有意取舍 | 中/高（代码事实）· 中（可利用性） | 缺 `state` 应 400；若确需兼容旧 CLI，用开关隔离并默认关闭 |
| P1-6 | 无请求级关联 ID，日志为字符串插值非结构化；`timestamp()` 用 `toLocaleTimeString` → **无日期无时区**，跨天日志无法排序 | `chat.ts:107`、`messages.ts:80` 各自临时造 traceId；`logger.ts:24-26,47,53-62` 只接 string；`dashboard.ts` 15 个 handler 与 `upstream.ts` **零** 关联 ID；无 `x-request-id` 响应头 | 中/高 | 单一 `onRequest` 钩子分配 requestId，随 `x-request-id` 返回，覆盖 100% 日志行；日志改 JSON lines + 完整时间戳带时区 |
| P1-7 | 上游总时限缺失 + 无入站速率限制：`MAX_UPSTREAM_CONCURRENCY` 默认 0 = 不限并发，`bodyLimit` 默认 64MB，入站 socket `setTimeout(0)` | `index.ts:55-61`；`config.ts:41,49-56`；`sse-common.ts:58-61` | 中/高 | 每请求一个挂钟上限（与 P1-1 一并解决）+ 非零默认并发。注：默认回环绑定使此项现实风险降低 |
| P1-8 | **Node 运行时三处互相矛盾，且交付的是已 EOL 的运行时**：`engines >=18.17`、CI 只测 **20**、`pkg --target node18-win-x64` 产出 **Node 18** exe，而 `@types/node ^26.5.1` 提供 Node 26 的类型面 | `package.json:7-9,27`；`ci.yml:22`；lock 实测 `@types/node 26.5.1` | **高**/高 | Node 18 EOL **2025-04-30**、Node 20 EOL **2026-04-30**、当前 Active LTS 为 24（来源见第 6 节）。→ 升级到 Node 22/24：`pkg --target node22-win-x64`、CI 矩阵 `[20,22,24]`、`engines >=20`、`@types/node` 对齐到目标主版本。这是本次审查里"可更新项"最硬的一条 |
| P1-9 | TypeScript 7 升级被依赖图卡死：dependabot PR 在 `npm ci` 阶段即 **ERESOLVE** 失败（非测试失败） | 实测 `gh run view 35464727765 --log-failed`：`typescript-eslint@8.70.0` → `ts-api-utils@2.5.0` peer 不接受 TS 7 | 中/高 | 先升 `typescript-eslint` 主版本再吃 TS 7；否则这个 PR 会长期挂着且持续红灯 |
| P1-10 | `pkg.assets` 引用 `models.json`，而该文件被 gitignore 且只在运行时生成 → 全新克隆上 `build:win` 静默缺资产 | `package.json:34-37`；`.gitignore:7`；`ls models.json` → **不存在** | 中/高 | 从 `pkg.assets` 移除，或构建期生成占位；`build:win` 在 CI 里真跑一次 |

---

## 4. P2（排期处理）

| # | 发现 | 证据 | 严重度 |
|---|---|---|---|
| P2-1 | 覆盖率只报告不门禁：实测 **48.36% 语句 / 42.12% 分支 / 51.5% 函数**；CI 只有 `--coverage.reporter=text-summary`，**无 threshold**，且仓库根本没有 `vitest.config.*` | 实测输出；`ci.yml:41-44` | 中 |
| P2-2 | `rewriteSafely`（数据维护工具，**不在服务路径**）三处健壮性问题：`renameSync` 无 try/catch → Windows `EPERM` 直接抛出且 `tmp` 文件泄漏；重试 `continue` 时把哨兵行永久留在生产用量文件里；tmp 名只用 `process.pid`。本人实测首次跑命中 2 例 EPERM，重跑通过 → 确认为间歇抖动 | `usage-history-io.mjs:58-93`（`:89` 抛出点）；调用方仅 `bench-models.mjs:149` 与测试，`grep rewriteSafely src/` → **0 命中** | 低-中 |
| P2-3 | **测试从不被 typecheck**：`tsconfig.json:16-17` 只 include `src/**`、显式 exclude `**/*.test.ts` → 18 个测试文件 + 3 个根 `.mjs` 工具游离在类型门禁外 | `tsconfig.json`；`tests/integration.test.ts:33,68` 存在 `any[]` | 高（回归防护） |
| P2-4 | 两条推理路由重复：**66 行归一化代码字节级相同**。`noteUpstreamError` 闭包整块重复（`chat.ts:116-125` ≡ `messages.ts:98-108`，只差一个日志前缀）、`persistOnce`、15s 保活 ping、`finishReason` 映射均逐字重复。`sse-common.ts` 的**文件头注释明确说是为消除这类重复而生**（`:1-7`），但只收编了 4 个助手 | 实测 diff；`sse-common.ts:1-7` | 高（可维护性） |
| P2-5 | `adapter.ts` 是 god-file：888 行，`encodeOpenAIChunk` 跨 `:585-766` 约 180 行含 7 路 switch，最大缩进 10 层为全仓最深。Anthropic 出口 SSE 编码内联在 `messages.ts:131-300`，与 OpenAI 侧委托给 adapter 的做法**不对称** | 行数实测 | 高（可测试性）——这也是 `buildAnthropicResponse`（约 90 行）**只有 1 项测试** 的直接原因（`adapter.test.ts:318`） |
| P2-6 | 117 处 `any`（热点 `adapter.ts` 26、`config.ts` 21、`models.ts` 15），且 `eslint.config.js:16` 把 `no-explicit-any` 显式关掉；29 处空 `catch {}`（`usage-store.ts` 6 处、`config.ts` 4 处）；`ignores: ['public/**','*.mjs']` 使 1,239 行 SPA 与 3 个根工具完全不过 lint | 实测 grep 计数 | 中 |
| P2-7 | 零死代码卫生：`getReasoningEfforts`、`EMPTY_REQUEST_CONTEXT`、`resetActivePlanCache`、`resetAumidState` 等跨文件 0 引用；`types/index.ts` 446 行里约 20 个未使用导出类型 | grep 验证 | 低-中 |
| P2-8 | 包发布卫生：无 `files` 白名单、无 `private: true`、无 `bin`。误 `npm publish` 会产出 `main` 指向不存在文件的坏包（`.gitignore` 兜底使 `dist/` 被排除），并连带 `tests/`、`HERMES_TEST_PROMPT.md`。已核实 `npm view commandcode-proxy-v4` → **404，当前并未发布**，故为潜在而非既存问题 | 实测 | 低 |
| P2-9 | 无 Dockerfile / Linux 发行路径，而 README 声称的客户端（OpenWebUI、Aider）典型跑在 Linux/Docker；桌面通知、计划任务、`.exe` 全为 Windows 中心 | 目录无 Dockerfile；`notifier.ts` Windows toast | 中 |
| P2-10 | 第三方 JS 全部内联 vendored 且不受依赖管理：Tailwind **Play CDN** 3.4.17（运行时编译器，407KB，本不该用于生产）、Chart.js 4.4.1、Font Awesome 6.4.0，从管理面同源提供且无 `integrity`；dependabot/`npm audit` 都看不见它们 | `public/vendor/*`；`public/index.html:8-10` | 低 |
| P2-11 | `start.cmd:17` 的 `logs\console.log` 只追加不轮转（logger 只轮转 `proxy.log`）；`notifier.ts:132-139` 的 `spawnSync powershell.exe`（≤15s）可从用量写入路径**同步阻塞事件循环** | 实测 | 低-中 |
| P2-12 | 上游错误体原文反射给客户端 / 并入 SSE 正文（`reply.status(500).send({error: err.message})`，`dashboard.ts:232,243`；`upstream.ts:390-405`） | 实读确认 | 低 |
| P2-13 | 无依赖审计步骤（公开仓库、`npm ci`），尽管目前 `--omit=dev` 结果为 0 漏洞；无分支保护证据（未核验） | `ci.yml` 全文；`gh api .../branches/main/protection` 未执行 | 低 |
| P2-14 | `permissionMode` 对每个请求强制 `auto-accept`，客户端无法要求工具调用审批。CHANGELOG:220 说明这是有意设计——但对一个**可被提示注入**的 agent 链路，这移除了最后一道人工闸门 | `upstream.ts:324-326`、`adapter.ts:367` | 低（设计取舍，但应显式记录风险） |
| P2-15 | 15 处定时器仅 2 处 `unref()`（`index.ts:142,153` 的两个 interval 未 unref）；Vitest  transform 缓存未持久化（首次实测 4.85s，占 35% 运行时长） | 实测 | 低 |

---

## 5. 与主流同类项目的横向对比

### 5.1 竞品实况（2026-09 经 GitHub API/页面核验）

| 项目 | Stars | 最新版本 | 近期活跃度 | License |
|---|---|---|---|---|
| LiteLLM | 59.2k | v1.103.0-rc.1 (2026-09-20) | ≥100 commits/月 | MIT + 商业 `enterprise/` |
| new-api | 48.5k | v1.0.0-rc.38 (2026-09-18) | ≥100 commits/月 | AGPL-3.0 |
| claude-code-router | 37.3k | v3.1.1 (2026-09-16) | ≥100 commits/月 | MIT |
| one-api | 37.0k | v0.6.10 (2025-02-02) | **0 commits/月**，已停滞 | MIT |
| Portkey gateway | 13.0k | v1.15.2 (2026-01-12) | **0 commits/月**，放缓 | MIT |
| **commandcode-proxy** | 6 | v4.17.0 (2026-09-18) | 活跃 | MIT |

### 5.2 能力矩阵（关键行；`✓`具备 / `P`部分 / `A`缺失）

| 能力 | 本项目 | LiteLLM | new-api | claude-code-router |
|---|---|---|---|---|
| 上游 provider 数 | **A** 1（设计如此） | ✓ 100+ | ✓ ~30 | ✓ ~15 + 自定义 |
| OpenAI Chat / Anthropic Messages | ✓ / ✓ **两侧真流式** | ✓ | ✓ | ✓ |
| OpenAI **Responses API** | **A** | ✓ | ✓ (+WS) | ✓ |
| embeddings / images / audio / realtime | **A** 全缺 | ✓ | ✓ | P |
| `json_schema` 结构化输出 | **A**（`response_format` **静默忽略**） | ✓ | P | P |
| 重试 + 退避 | ✓ `upstream.ts:350-412` | ✓ | ✓ | ✓ |
| **对"藏在 HTTP 200 流里的错误"重试** | ✓ **五者中唯一** | A | A | A |
| 跨渠道负载均衡 / 熔断 | A（单上游不需要） | ✓ 7 策略 | ✓ | ✓ |
| 虚拟密钥 / 多租户 / 充值 | **A**（一把共享 `PROXY_API_KEY`） | ✓ | ✓ | P |
| 每请求成本核算 | ✓ **本生态位最佳之一**（优先取上游权威金额 + 峰谷价 + 缓存读写分账） | ✓ | ✓ | ✓ 估算 |
| Prometheus `/metrics` / OTel / Langfuse | **A** 全缺 | ✓ | P | ✓ |
| DB 后端 / 迁移工具 | A（JSONL 文件） | ✓ | ✓ | ✓ |
| Docker / Helm | **A** | ✓ | ✓ | ✓ |
| 单二进制分发 | ✓ **五者中唯一**（`pkg` exe） | A | P | ✓ 桌面 |
| 桌面通知 | ✓ 独有 | A | A | A |
| 热重载 config | A | ✓ | ✓ | ✓ |

### 5.3 对比结论：什么该补，什么明确不该跟风

**真正该补（因为它们是缺陷，不是缺功能）**：P0-1..P0-4 全部，以及 P1-1/P1-3/P1-4/P1-8。这些和"是否做成大网关"无关。

**生态位内的高价值差距**（claude-code-router 是唯一同赛道对手：本地、单用户、编码 agent 网关、中文生态）：
1. **`response_format: json_schema` 静默忽略**（README:140 已诚实列出被忽略字段）。这是最可能让某个 agent 直接坏掉的一项，且主流五者全部尊重该字段。**最低成本方案：不实现也要显式 400 `UNSUPPORTED_OPTION`**——这个错误码项目里已经有了。
2. **单上游内的 fallback 模型链**：撞到 `MODEL_NOT_IN_PLAN` 时自动退到下一档位。这是本生态位真正需要的韧性，且**不需要**引入多供应商。
3. **Dockerfile**：目标客户端多在 Linux，CI 也已经在 ubuntu 上跑，边际成本极低。
4. **`/metrics`**：一个端点、零依赖，和已有的成本核算能力天然互补。

**明确不应模仿主流方向**（本项目的小而正确是资产，不是落后）：
- 多供应商抽象、虚拟密钥/团队/自助充值/兑换码、表达式定价、插件市场、MCP/A2A 网关、Postgres/ClickHouse。代价参照：new-api 仍在 rc 阶段并声明"不建议生产使用"、RC 之间要重配定价；LiteLLM 有 5,197 个 open issues。本项目 288 项测试 + 6.8k 行的可信度恰恰来自规模小。
- 语义缓存、优先级队列、流式续传——单上游单用户场景下无意义。
- **one-api 和 Portkey 是前车之鉴而非目标**（各自近一月 0 commit）。

---

## 6. 已核实为"做对了"的部分

审查中主动验证并**确认成立**的防御与设计（列出以防后续重构时被当作噪音移除）：

- **SSRF 白名单质量高于同类实现**：fail-closed、校验协议/embedded 凭据/私有与保留段（含 `100.64/10` CGNAT、`169.254/16` 云元数据）、IPv6 ULA 与链路本地、子域后缀匹配可正确抵御 `commandcode.ai.evil.com`（`config.ts:83-134`）。`url-safety.test.ts` 13 项与实现一致。唯一盲点是二跳重定向（P1-2）与"允许域名解析到内网 IP"（**unknown**，需实打验证）。
- **仓库历史上从未提交过任何 secret**：`git log --all --name-only`（56 commits/70 paths）+ 全 revision token 模式搜索，零命中；`config.json`/`auth.json`/`.env`/`pricing.json` 均已 gitignore。
- **不落盘 prompt 内容**：全部 `logger.*` 调用只记 model/token 数/status/截断 300 字符的错误文本，无请求体。隐私姿态正确。
- **路径穿越已阻断**：`/assets/vendor/*` 是唯一无鉴权文件读取路径，先 decode 再拒绝 `..`/`\`/前导 `/`（`dashboard.ts:83-87`）。
- **常量时间密钥比较**，且长度不等时仍做等长比较以保持耗时与内容无关（`chat.ts:36-44`）。
- **无 eval / new Function / 服务端动态 import**；`openBrowser` 用数组参数 `shell:false`，无命令注入面；PowerShell toast 的注入被 `escapeXml`（连单引号一起编码）挡住。
- **不抓取客户端提供的 URL**：图片 `source.url` 只转发给上游，服务端从不 fetch（`adapter.ts:506-515`）。
- **CORS 只作用于 `/v1/*` 和 `/health`，管理面 `/api/*` 无 CORS**（避免跨源可读管理面）。
- 用量文件 20MB 轮转、配额采样环形缓冲 200 项 → 内存有界。
- 错误分类学扎实：`ErrorCode` + `codeForStatus` + `terminalCodeFor`，且 21 项测试专门锁定"确定性错误绝不重试"（`errors.test.ts:53`）——v4.17.0 的 29 万 token 白花 $0.26 事故复盘已固化进测试。
- GitHub 元数据完备：issue 模板、dependabot（npm + github-actions，weekly，且把 typescript 单独分组以便观察主版本破坏性变更——分组注释见 `dependabot.yml:8-16`，考虑周到）。

---

## 7. 假设、局限与下一步核验

- **未做任何运行时渗透**。P0-2 的 DNS rebinding、P1-2 的重定向逃逸、P1-3 的 XSS 链均为**代码/逻辑层静态确认**，未打 PoC。三条都给了可直接执行的验收用例。
- **覆盖率 48.36% 是被低估的**。集成测试 spawn 的是子进程 `dist/index.js`，V8 不采集子进程命中率，因此 `chat.ts`/`messages.ts`/`dashboard.ts` 的**行为覆盖远高于其数字覆盖**。报告数字时不以此夸大问题——真正的缺口在 P2-1（无门禁）而非百分比本身。
- **未知项**：① 上游 `/alpha/generate` 自身是否支持结构化输出（只有 adapter 代码证据，无上游文档）；② CommandCode 服务条款对多账号轮换的态度；③ 是否启用分支保护。三者都需人工确认，已在第 5 节标注。
- **风险图源码**：`risk-map.dot`（同目录）。

**建议顺序**：先做 P0-1 + P0-3 + P1-4 + P1-3（四项都是小改动、可当天验证、且消除"静默失效"），再一次性处理 P0-2 的鉴权边界（需要设计决策，会动 API 契约），P1-8 的 Node 升级单独开分支。第 8 节给出完整排期。

---

## 8. 批次 A 实施后的更正（2026-09-20，分支 `fix/audit-batch-a`）

实施时对本报告有三处修正，以实施结果为准：

1. **P0-4 比报告描述的更严重**。本报告写的是"`onRetry` 从未被调用"，建议"在重试循环内调用它"。实际有**三层**缺陷，只补第 1 层依然不会切号：`headers` 在循环外构建一次（`upstream.ts:328`）；且路由回调给局部 `apiKey` 赋值，而 `opts.apiKey` 已在构造参数对象时快照了旧值。修复改成了让 `onRetry` **返回**新 key。
2. **P1-1 被低估了**。`upstreamTimeoutMs` 不只是"没接线"：它是仪表盘上唯一的上游时长承诺，而实际唯一生效的 `idleTimeoutMs` 每收到一个字节就重置，所以一个持续 trickle 的上游可以无限挂住连接。
3. **P1-3 有一处报告口误是好的方向**：`esc()`（`index.html:393`）确实完整转义了 `"` 与 `'`，`title` 上下文是安全的——本报告的判断正确，但我在实施中一度因测试脚手架写了恒等函数兜底而得出相反结论，该兜底已删除。真正的缺陷只有 `text` 未转义一处。

新增 5 个测试文件 / 15 项，全量 **303 项通过**，`tsc`/`eslint` 干净，语句覆盖率 48.36% → 57.8%。**A5 与 A6 是行为变更**，尤其 600s 挂钟上限此前从不执行，长推理请求可能受影响——详见 CHANGELOG 的 Unreleased 段。

---

## 9. 批次 A 对日常使用的影响核查（2026-09-20，恢复复验阶段）

判据来自运行中的实例与它自己的数据，不靠推测。

**环境实况**：`127.0.0.1:9090` 上跑的是 **v4.13.0**（`node dist/index.js`），`authRequired:false`、`boundNonLoopback:false`、`accountsCount:1`、`rotationMode:manual`。也就是说批次 A 的任何改动都要等它从 4.13.0 升级后才生效。

| 项 | 对这套配置的实际影响 | 依据 |
|---|---|---|
| A5 600s 挂钟上限 | **无感**。12 天 3089 条真实请求：p50 5.8s、p95 22.8s、p99 52.2s、**最长 117.1s**，超过 120s 的 0 条；上限距最慢请求有 5 倍余量。且这些请求里最大输入 38.1 万 token（>25 万 token 的有 262 条），不是轻流量。config.json 本身就写着 `timeoutMs:600000`，是用户自己声明的值 | `~/.commandcode/usage-history.jsonl` |
| A6 重试途中换号 | **无感**。`checkAndRotateAccountsOnQuota` 首行 `rotationMode !== 'auto-quota' \|\| accounts.length <= 1 → return false`（`config.ts:479`），当前 manual + 1 账号必然走 false 分支 → `onRetry` 返回 undefined → 沿用原 key（该行为有专门用例锁定） | `config.ts:477-481`、`chat.ts:140-149` |
| A3 manual-login 不再回传明文 key | **无感**。SPA 只读 `data.status`/`data.error`（`public/index.html:471`），账号列表用的是 `apiKeyMasked`（`:493`、`:523`），没有任何前端消费被删掉的字段 | `index.html:465-523` |
| A2 更新检查改读 `/tags` | **这是唯一会被看见的变化**：修好后「发现新版本」会真的开始提示。现行实例即为活证据——v4.13.0 的 `/api/status` 返回 `update.latest:"v4.12.0"`、`available:false`，而 tag 早已到 v4.17.0 | 实测 `GET /api/status` |
| A4 `badge()` 转义 / A1 pretest / A7 pkg.assets | 无感（A4 仅影响异常渲染路径，A1 是开发流程，A7 只影响 pkg 产物而这台机器跑的是 `node dist/index.js`） | — |

**核查中新发现的两个缺陷（都不在本次改动引入，已另记 CHANGELOG 已知问题）**

1. `syncEnvFile`（`config.ts:342-343`）把 `COMMANDCODE_API_BASE`/`COMMANDCODE_VERSION` 写成**硬编码默认值**，而回注时 env 优先级高于 `config.json`（`config.ts:264`）。用自建/反代上游的人只要从仪表盘动一次账号，`.env` 就会钉住公网默认 apiBase，下次重启自定义值被静默吞掉。默认部署两者取值相同，所以本机不触发——属潜伏 P1。
2. 进程内测试（`app.inject` 那一类）的状态文件落在 `getProjectRootDir()`=cwd，即**仓库根**；`.env`/`logs`/`models.json` 全部命中 `.gitignore`，`git status` 看不见。基线跑测试只留 `logs/`+`models.json`，`.env` 是批次 A 新增的 `admin-key-mask` 引入的，已用 `COMMANDCODE_ENV_PATH` 收口。附带结论：`loadEnvFile()` 的解析路径此前**没有直接测试覆盖**，之前读数里那 12 条语句是靠污染顺带跑出来的。
