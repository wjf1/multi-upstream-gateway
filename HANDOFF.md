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
- **当前状态（2026-10-07）**：**P0 移植已完成并部署，产品首发 v5.0.0**。
  - **Phase A~F 全部完成**：A 工程基座 / B 审计批次 B 安全语义 / C 新增模块 / D1 接缝接线 / E 面板移植 / F 阶段门复验。
  - **门禁数据（F）**：`npm run verify` **50 文件 / 658 用例全绿**；覆盖率 65.87%；`npm audit --omit=dev` **0 漏洞**；50 并发 P99 126ms / 468rps / 0 错误。
  - **已部署（2026-10-07）**：看门狗第 5 秒拉起新代码；`config.json` flat→unified 迁移完成、凭据落 `credentials.enc`（`.env` 明文行已摘除）；
    **风险门经用户在面板确认后放行**；代理端口改 7900（`.env` 已改，`config.json` 侧下次重启生效）。详见 §7 部署检查清单。
  - **基准勘误（保留为教训）**：方案基线事实曾基于过期检出 v4.17.0，真实基准是 v4.22.4；基线事实必须「版本号 + 验证命令」同引。
  - **多上游尚未完成**：实际可用上游**仅 CommandCode 一个**；Freebuff 模块已入树但**未接入运行时**（接线属 P1/T202+），WorkBuddy 仍在规划。
- **分支模型**：**`main` = 产品主线**（默认分支，已含 P0 移植与 v5.0.0 发布）；`feat/p0-port` = 移植集成分支（与 `main` 同点）。
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
- 测试基线：**50 文件 / 658 用例全绿**（v4.22.4 原始基线 48/626；移植后红线只升不降）。
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

- **当前队列**（严格按 `PLAN-STATE.md` §1 的顺序与 deps）：
  - ✅ `P0-PORT-A~F` **全部完成**（A 基座 / B 批次 B 语义 / C 新增模块 / D1 接线 / E 面板移植 / F 阶段门），**已部署**。
  - ⬜ **下一批（P1）**：`T202`（Freebuff Anthropic 桥 + tools schema 规范化）→ `T203` → `T204'`（WorkBuddy 联邦透传，见 `docs/wb-source-diff-report.md` §7）→ `T208~T212`（面板五页）→ `T213`（三源接线）→ `T214`（P1 阶段门）。
    **注意**：Freebuff 模块（`src/providers/freebuff/`）已入树，但 `providers/core` 当前只被其自身引用、**未接入 `src/index.ts` / `src/routes/`**——T202 首先要做的是接线，而非新写。
  - ⬜ 遗留小项：构建产物名仍为 `commandcode-proxy-v4.exe`，产品改名后待重命名（含 `build:win` 脚本与相关测试）。
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
- `.env` 的 `HTTPS_PROXY/HTTP_PROXY` 指向 `127.0.0.1:7897`，而本机 Clash 混合端口已改为 **7900**（见用户级 AGENTS.md）。
  实测：代理不可达时代码会**自动回退直连**（4.22.4 的 Auto-fallback），因此不阻塞使用，但出站代理实际处于**静默失效**状态。
  **建议**：把 `.env` 的 `HTTP(S)_PROXY` 改为 `http://127.0.0.1:7900` 以恢复代理链路。
