# PLAN-STATE

> **执行依据**：`F:/AI/Qdor/review/multi-upstream-gateway/master-plan-v1.2.md`（v1.2.3 起含基准勘误修订）。
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

**已确认仍然有效的工作**：审计批次 B（`batch-b.patch`）在 v4.22.4 上**同样未应用**（无 `admin-guard.ts`），
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
  - 范围：把 `batch-b.patch`（ADMIN_API_KEY 分离 / Host 白名单 / 非回环拒启 / OAuth state / CSP）适配到 4.22.4（其 `dashboard.ts`/`chat.ts`/`config.ts`/`public/index.html` 均已演进）
  - blocked: —
- [ ] P0-PORT-C 新增文件移植（增量文件 + import 适配）
  - deps: P0-PORT-A
  - 范围：`providers/core/{interface,router,registry}.ts`、`utils/{unified-config,credential-store,rate-limiter,security-guard,sanitize,audit-log,safe-fetch,risk-gate}.ts`、`providers/freebuff/**`（T201 成果）及配套测试
  - blocked: —
- [ ] P0-PORT-D 接缝文件改造
  - deps: P0-PORT-B,P0-PORT-C
  - 范围：`index.ts`（安全链/风险门/凭据钩子/NODE_DEBUG/pino redact）、`routes/{chat,messages,sse-common}.ts`（safeFetch/requestId/provider 字段/风险门顺序）、`routes/dashboard.ts`（`/js/*`、status 字段、`/api/risk/accept`、审计钩子）、`utils/config.ts`（迁移钩子/加密优先/保存分支）、`utils/usage-store.ts`（provider 维度）、`utils/errors.ts`（+6 码）、`adapters/commandcode` → `providers/commandcode`
  - blocked: —
- [ ] P0-PORT-E 面板移植
  - deps: P0-PORT-D
  - 范围：在 4.22.4 的 1816 行面板上重做 JS 外置 + hash 路由 + 明暗主题 + 首启引导 + 风险告知弹窗（**保留 4.18~4.22 新增的面板功能**，如通道健康卡片、运行开关卡片）
  - blocked: —
- [ ] P0-PORT-F 全量回归 + 阶段门复验 + 部署
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
