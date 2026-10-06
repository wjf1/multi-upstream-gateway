# HANDOFF — 多上游 AI 网关（commandcode-proxy 底座）

> 跨会话/跨 Agent 接力首要读物。先读本文 → `PLAN-STATE.md`（进度唯一事实）→ 执行依据方案。
> **本文件所在目录 = 唯一工程仓库 = 真实部署目录**。

## 1. 项目概况与当前状态

- **定位**：以 commandcode-proxy 为底座，把 Freebuff2API 与 workbuddy2api-panel 两个 Go 项目重写为 TS Provider 适配器，形成单面板三源（CommandCode / Freebuff / 腾讯 CodeBuddy）统一 AI 网关。
- **工程仓库（唯一工作副本）**：`C:\Users\admin\Doubao\chats\2026-09-03\new-chat-5\commandcode-proxy`
  —— **v4.22.4**，git 分支 **`feat/p0-port`**，与上游 `wjf1/commandcode-proxy` main 同步（base `87b1a05`，remote 经 gh-proxy 镜像）。
- **执行依据（SSOT）**：`F:/AI/Qdor/review/multi-upstream-gateway/master-plan-v1.2.md`（v1.2.3 起含基准勘误）。
  评审与审计材料：`F:/AI/Qdor/review/commandcode-proxy/`（`batch-b.patch`、`architecture-review.md`、`remediation-plan.md`）。
- **当前状态（2026-10-06）**：**基准重定进行中**。
  - **重要**：方案的基线事实基于过期检出（`F:/AI/Qdor/repos/commandcode-proxy` = v4.17.0）。真实基准是 v4.22.4。
    G0+P0+T201 的全部成果都做在 4.17.0 上，现正**按 Phase A~F 移植到 4.22.4**（详见 `PLAN-STATE.md`）。
  - 已完成：**Phase A**（工程基座，commit `cab6282` + `4b2a134`）；**Phase B+C** 进行中（批次 B 安全语义 + 新增模块文件）。
  - 待做：Phase D（接缝接线）→ Phase E（面板移植）→ Phase F（回归+阶段门+**经用户确认后**重启 9090）。
  - **9090 部署未动**：仍在跑 v4.22.4 原进程；移植期间不重启、不部署（用户已明确）。
- **目标分支模型**：`main`（= 上游同步线） + `feat/p0-port`（本次移植集成分支）。移植完成后合回 main 再考虑部署。

## 2. 技术栈与运行基线

- 运行时：Node **>=20**（4.22.4 已满足；本机 v22.23.2）；TypeScript **5.9.3** strict；ESM（`"type":"module"`）。
- 运行时依赖：`fastify 5.12.3`、`undici 7.29.1`（**4.22.4 已有**，出站统一走它 + `proxy-agent.ts`）；
  移植新增：`zod 3.25.76`、`chokidar 5.0.0`（chokidar 5 为移除 braces 高危，chokidar 4+ 不再依赖 braces）。
- dev 依赖：vitest 5.0.0、typescript-eslint 8.70.0、eslint 10.10.0、esbuild 0.28.2、
  **`@yao-pkg/pkg` 6.22.0**（维护中的 pkg fork——此前担忧的 "vercel/pkg 停维护" 风险在本线已解决，`build:win` 目标已是 node22）。
- 依赖策略：全部精确版本（本次 Phase A 已去 `^`/`~`）。
- **门禁三件套**：`npm run verify`（build + test）、`npm run typecheck`（src+tests 双工程，经 `tsconfig.test.json`）、`npm run lint`（零输出）。
- 测试基线：**48 文件 / 626 用例全绿**（v4.22.4 原始基线；移植新增为净增，红线只升不降）。
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
  - ✅ `P0-PORT-A` 工程基座
  - 🔄 `P0-PORT-B` 审计批次 B 语义移植 + `P0-PORT-C` 新增模块文件移植（进行中）
  - ⬜ `P0-PORT-D` 接缝接线：`index.ts`（安全链/风险门/凭据钩子/NODE_DEBUG/pino redact）、`routes/{chat,messages,sse-common}.ts`、`routes/dashboard.ts`（`/js/*`、status 字段、`/api/risk/accept`、审计钩子）、`utils/config.ts`（迁移钩子/加密优先/保存分支）、`usage-store.ts`（provider 维度）、`providers/commandcode` 去留决策
  - ⬜ `P0-PORT-E` 面板移植（1816 行面板上重做 JS 外置/hash 路由/主题/引导卡/风险弹窗，**保留 4.22.4 既有面板功能**）
  - ⬜ `P0-PORT-F` 全量回归 + 阶段门复验（verify/typecheck/lint/audit/bench）+ 部署
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
7. **git 代理**：全局 `http.proxy=http://127.0.0.1:7900`；本树 remote 走 `gh-proxy.com` 镜像。
8. **面板 / CDN**：4.22.4 面板 1816 行、资源已本地化；Phase E 移植外置时勿引入外链（有测试守卫）。
