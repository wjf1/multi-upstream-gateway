# commandcode-proxy 整改清单（按优先级）

配套 `architecture-review.md`。严重度依据本项目自身定位（个人/小团队自托管单上游网关），非 LiteLLM 标准。

工作量：S ≤0.5 天 · M 0.5–2 天 · L >2 天。

---

## 批次 A —— 消除"静默失效"（建议本周内，全部 S，可独立验证）

这一批的共同点：改动很小，但都能把"看起来在工作、实际没工作"的东西变成真话。

| 序 | 项 | 动作 | 证据 | 量 | 完成判据 |
|---|---|---|---|---|---|
| A1 | P0-1 未构建时假绿 | `package.json` 加 `"pretest": "npm run build"`；并把 `describe.skipIf(!distReady)` 改为 `distReady ? describe : describe.fails`（或显式 throw） | `tests/integration.test.ts:30,348,537,583,750,1001,1017,1048` | S | 删除 `dist/` 后 `npm test` 退出码非 0；CI 断言 skipped == 0 |
| A2 | P0-3 更新检查失效 | 二选一：tag-push workflow 自动建 GitHub Release（推荐，同时补上缺的 5 个）；或 `update-check.ts:11` 改读 `/tags` | `update-check.ts:11`；实测 `releases/latest`=v4.12.0 vs tag=v4.17.0 | S | `releases/latest` 与 `tags` 末项一致；仪表盘能显示新版本 |
| A3 | P1-4 明文回传密钥 | `manual-login` 响应改为只含 `apiKeyMasked`，复用同文件 `:192` 已有范式 | `dashboard.ts:225-234` → `types/index.ts:20` | S | 该端点响应体不含长度 >16 的连续 key 片段；新增断言测试 |
| A4 | P1-3 `badge()` XSS | `text` 走 `esc()`，`discountPercent` 先 `Number()` 再渲染；顺带给 `index.html:746` 这类上游字段做数值收敛 | `public/index.html:670-672,746`；源 `models.ts:202` | S | 注入 `discountPercent:"<img src=x onerror=alert(1)>"` 的 fixture 渲染为纯文本 |
| A5 | P1-1 空配置 `upstreamTimeoutMs` | 决策项：接入总时限（与 A7 同做）或从 `types`/`config`/仪表盘三处删除 | `config.ts:36,294,319` / `dashboard.ts:143` / 0 消费点 | S | 配置项要么影响可观测行为，要么不存在 |
| A6 | P0-4 `onRetry` 死路径 | 决策项：接上（重试循环内 `await opts.onRetry?.(attempt, err)`）或删除 + README 说明轮换只有 30 分钟粒度。CHANGELOG:18 已把决策权交给你 | `upstream.ts:116` / `chat.ts:140` / `messages.ts:116` | S | 若接上：新测试断言重试后 `apiKey` 已切换；若删除：`grep onRetry src/` 为空 |
| A7 | P1-10 `pkg.assets` 缺文件 | 从 `pkg.assets` 移除 `models.json`（运行时生成物不该打包）；CI 增加一次 `npm run build:win` 冒烟 | `package.json:34-37` vs `.gitignore:7` | S | 全新克隆上 `build:win` 成功且无 missing-asset 告警 |

---

## 批次 B —— 鉴权边界（需要一次设计决策，会动 API 契约）

单独开 PR。这块不能散着改。

| 序 | 项 | 动作 | 量 | 完成判据 |
|---|---|---|---|---|
| B1 | P0-2 权限未分离 | 引入 `ADMIN_API_KEY`，`/api/*` 写操作只认它；`PROXY_API_KEY` 仅覆盖 `/v1/*` | M | 持有效 `/v1` 密钥调 `POST /api/accounts/delete` → 403 |
| B2 | P0-2 DNS rebinding | 校验入站 `Host` 属于回环名白名单；或改用每次启动随机 token 要求管理面写操作携带；或采纳 `Sec-Fetch-Site: same-origin` | M | `Host: evil.tld:9090` + 同源 `Origin` 打 `HOST=127.0.0.1` → 403；新增 `guard.test.ts` 用例 |
| B3 | P0-2 默认开放 | 非回环绑定且无密钥时由"警告后继续"改为"拒绝启动"，逃生阀 `ALLOW_INSECURE_BIND=1` | S | 无 env 时 `HOST=0.0.0.0` 启动即失败并打印原因 |
| B4 | P1-5 OAuth state | 缺 `state` 返回 400；若须兼容旧 CLI，用显式开关隔离且默认关闭 | S | 无 `state` 的回调 POST 被拒；回调窗口内第三方无法激活自己账号 |
| B5 | P1-3 纵深防御 | 管理面加 `Content-Security-Policy: default-src 'self'`（全站现无任何 CSP） | S | 响应头存在且 SPA 正常渲染 |

---

## 批次 C —— 运行时与供应链（"可以更新的"主要落点）

| 序 | 项 | 动作 | 量 | 完成判据 |
|---|---|---|---|---|
| C1 | **P1-8 Node EOL** | `pkg --target node22-win-x64`（或 24）、CI 矩阵 `[20,22,24]`、`engines >=20`、`@types/node` 与目标主版本对齐。注意 Node 18 已于 2025-04-30、Node 20 已于 2026-04-30 EOL，当前 Active LTS 是 24 | M | 产物 exe 内嵌运行时非 EOL；CI 三版本全绿；`@types/node` 主版本 ≤ 目标运行时主版本 |
| C2 | P1-9 TS7 被卡 | 先升 `typescript-eslint` 主版本解开 peer 冲突，再吃 TS 7；期间把该 dependabot PR 关掉或标注，避免长期红灯 | M | dependabot PR CI 转绿，或明确记录"等上游支持" |
| C3 | P1-2 重定向逃逸 | 所有出站 fetch 改 `redirect:'manual'` + 逐跳 `assertSafeUpstreamUrl` | S | mock 302→`169.254.169.254` 必须失败；补进 `url-safety.test.ts` |
| C4 | P2-10 vendored JS | Tailwind **Play CDN**（运行时 JIT 编译器，407KB）换成预编译静态样式表；三个 vendor 加 `integrity`+`crossorigin`；版本记入清单文件由 CI 校验；考虑接 `pnpm audit`/Dependabot 对 npm 外的源 | M | `public/vendor` 内版本号有单一事实源并可被 CI 比对 |
| C5 | P2-13 审计门禁 | CI 增 `npm audit --omit=dev --audit-level=high`（当前实测 0 漏洞，正好可锁基线） | S | 高危新增即红 |
| C6 | P1-7 DoS 面 | 每请求挂钟上限 + `MAX_UPSTREAM_CONCURRENCY` 非零默认 | M | 慢速 trickle 流在设定上限处被主动终止并有日志 |

---

## 批次 D —— 结构与可测试性（与功能开发错开做）

| 序 | 项 | 动作 | 量 | 完成判据 |
|---|---|---|---|---|
| D1 | P2-4 路由重复 | 把 `noteUpstreamError`、`persistOnce`、保活 ping 生命周期、`finishReason` 映射下沉进 `sse-common.ts`（它本来就是为此写的）；目标 `jscpd` chat↔messages 共享行 <15（现 66 行字节级相同） | M | jscpd 阈值达标；两路由差异仅剩协议编码 |
| D2 | P2-5 拆 god-file | `adapter.ts` 按 translate(OpenAI/Anthropic) / encode(OpenAI/Anthropic) 拆四模块，Anthropic 出口 SSE 编码器从 `messages.ts:131-300` 移入 adapter 与 OpenAI 侧对称；`encodeOpenAIChunk` 180 行 switch 拆 handler 表 | L | 单函数 ≤80 行、最大深度 ≤5；`buildAnthropicResponse` 测试从 1 项增至 ≥5 项（thinking-only / tool_use / 混合 / 流内 error / 无 usage） |
| D3 | P2-3 测试纳入类型门禁 | 新增 `tsconfig.test.json`（strict）+ CI 步骤 `tsc -p tsconfig.test.json --noEmit` | S | 18 个测试文件与 3 个 `.mjs` 工具全部通过类型检查 |
| D4 | P2-1 覆盖率门禁 | 建 `vitest.config.ts`，`coverage.thresholds.lines >= 60` 起步（当前实测 48.36%），先只卡不降；并开启 `fsModuleCache` 消掉每次 4.85s 的重复 transform | S | 覆盖率回退即 CI 红 |
| D5 | P1-6 可观测性 | `logger.info(fields, msg?)` 输出 JSON lines；时间戳补日期与时区（现 `toLocaleTimeString` 无日期）；单一 `onRequest` 钩子生成 requestId + `x-request-id` 响应头，覆盖管理面 15 个 handler 与 `upstream.ts` | M | 任一条日志可由 requestId 串起；跨天日志可按时序排序 |
| D6 | P2-6 `any` 收敛 | `no-explicit-any` 由 `off` 改 `warn` 并记录 117 为基线，只允许单调下降；`no-empty` 去掉 `allowEmptyCatch`，空 catch 要么降 debug 日志要么注释原因；从 eslint ignores 中移除 `*.mjs` 与 `public/**` | M | 基线数下降且 lint 变严不倒退 |
| D7 | P2-2 `rewriteSafely` 健壮性 | `renameSync` 包 try/catch + 指数退避重试（Windows EPERM 抖动）；抛错路径也 `rmSync(tmp)`；哨兵写入失败/重试时清理残留；tmp 名加随机后缀 | S | 连续 20 轮全量测试在 windows-latest 零抖动；失败后目录无 `.` 开头残留 |
| D8 | P2-7 死代码 | 删除 `getReasoningEfforts`、`EMPTY_REQUEST_CONTEXT`、`resetActivePlanCache`、`resetAumidState`/`resetToastEnabledCache`/`resetNotifyState`（若非测试专用）及 `types/index.ts` 约 20 个未用类型 | S | 跨文件引用为 0 的导出不存在 |
| D9 | P2-8 打包卫生 | 加 `"private": true`（或 `files: ["dist","public"]` + `prepare`）；把 `bench-models.mjs`/`purge-test-usage.mjs`/`usage-history-io.mjs` 移入 `scripts/` 并取消 `.gitignore` 的 `!*.mjs` 例外，纳入 lint；清理无用的 `*.py` 忽略规则 | S | `npm publish --dry-run` 进入 CI 且包内含 `dist/index.js` |
| D10 | P2-11 事件循环阻塞 | `notifier.ts:132` 的 `spawnSync`（≤15s）改异步；`start.cmd:17` 的 `console.log` 纳入轮转 | S | 通知路径不阻塞用量写入；console 日志有上限 |

---

## 批次 E —— 生态位内的功能补齐（来自横向对比）

| 序 | 项 | 动作 | 量 | 为什么值得 |
|---|---|---|---|---|
| E1 | 结构化输出 | `response_format`/`json_schema` 被**静默忽略**（README:140 诚实列出）。最低成本：不实现也显式 `400 UNSUPPORTED_OPTION`（错误码现成）；完整方案：prompt 约束 + 后置解析模拟 | S→M | 最可能让下游 agent 直接坏掉的一项；对比的 5 个主流项目全部尊重该字段 |
| E2 | 单上游 fallback 链 | 撞 `MODEL_NOT_IN_PLAN` 时自动退到下一档位模型重试 | M | 本生态位真正需要的韧性，**不需要**引入多供应商抽象 |
| E3 | Dockerfile / Linux 路径 | 提供镜像与 compose；把桌面通知做成 win32 条件特性的同时保证 Linux 无 toast 可用 | M | 声称的客户端 OpenWebUI/Aider 典型跑 Linux；CI 已有 ubuntu job |
| E4 | `/metrics` | Prometheus 文本端点，复用现有 usage/cost 核算数据，零新依赖 | S | 与已有能力互补；LiteLLM 证明有需求。注意：new-api/CCR 也没有，属加分项非差距 |
| E5 | 配置热重载 | `config.json` 变更后免重启生效（现需重启；`grep` 确认无 fs watcher） | M | 管理面已能改配置，文件侧却不能，行为不一致 |

---

## 明确不做（避免被"对比主流"误导）

多供应商抽象层、虚拟密钥/团队/自助充值/兑换码、表达式定价、插件市场、MCP/A2A 网关、Postgres/ClickHouse 与迁移工具、语义缓存、优先级队列、流式续传。

理由：new-api 仍处 rc 且声明"不建议生产使用"（RC 之间需重配定价）、LiteLLM 挂 5,197 个 open issues；one-api 与 Portkey 近一月均 0 commit（是前车之鉴而非目标）。本项目 288 项测试、6.8k 行、1 个生产依赖、双 OS 门禁 CI 的可信度**正是来自范围克制**。唯一真正的同赛道对手是 claude-code-router（37.3k stars，v3.1.1，2026-09-16），若要对标它，缺的是 agent profile 管理、有序 fallback、凭据池与跨平台打包——而不是变成计费 SaaS。
