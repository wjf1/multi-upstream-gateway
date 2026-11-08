# AGENTS.md

本文件为 AI 代理（ZCode / Claude Code 等）提供本项目级上下文。接手任务前先通读，再读 `HANDOFF.md`（含完整 14 条避坑清单与部署检查清单）。

## 项目概览

本地多上游 AI 网关：单一 OpenAI / Anthropic 兼容入口（`/v1/chat/completions`、`/v1/messages`），统一接入多个 AI 上游，带账号轮换、额度管理、管理员仪表盘（`public/`）与用量审计。源自 commandcode-proxy (MIT) v4.22.4 的语义化分化，自 v5.0.0 起另起产品版本线。

- 包名 `multi-upstream-gateway`，当前版本 **5.0.7**（2026-10-08，WorkBuddy 积分镜像收口 F07）。
- 技术栈：TypeScript（`src/`，编译到 `dist/`），fastify 5 + undici + zod + chokidar；测试 **vitest**（不是 jest）；构建链 tsc → esbuild bundle → @yao-pkg/pkg 出 Windows exe。
- **本目录就是生产部署**：9090 端口由 `dist/index.js` 常驻服务（计划任务 `CommandCodeProxy` → watchdog）。
- 部署形态：Windows 为主（`start.cmd` / `start_hidden.ps1` / pkg exe / 注册表通知），这也是 CI 加 windows 矩阵的原因；`.gitattributes` 统一 LF 行尾。
- 关键目录：`src/index.ts`（bootstrap，四条路由）、`src/utils/`（config/models/logger/version）、`public/`（面板骨架 + 外置 JS，`/js/*` no-cache）、`tests/`（vitest，90+ 用例）、`scripts/setup.mjs`。
- 状态文件：`PLAN-STATE.md`（阶段门 T310 进度与外部依赖阻塞项）、`HANDOFF.md`（接力 + 部署检查清单）、`HERMES_TEST_PROMPT.md`（验收材料）。

## 构建与测试命令

均已在 `package.json` scripts 与 `.github/workflows/ci.yml` 中验证真实存在：

```bash
npm ci                  # 安装
npm run dev             # tsx watch src/index.ts（本地开发）
npm run lint            # eslint .（scripts/*.mjs 也在 lint 范围内）
npm run typecheck       # tsc --noEmit 主配置 + tsconfig.test.json 双份
npm test                # pretest 先 npm run build 重建 dist/，再 vitest run
npm run test:coverage   # vitest run --coverage（statements 阈值 65，CI 同款）
npm run verify          # build + test 串跑
npm run build           # tsc 编译到 dist/
npm run build:exe       # build + esbuild 打 bundle.cjs
npm run build:win       # pkg 出 dist/multi-upstream-gateway-v5.exe（node22-win-x64，GZip 压缩）
node scripts/setup.mjs  # 初始化配置（npm run setup）
```

CI 流程：ubuntu + windows 双矩阵（Windows 是主要部署形态，必须同缸回归）→ lint → typecheck → build → `npx vitest run` → coverage（仅 ubuntu，65 阈值）→ **Node 20 smoke job**（只装生产依赖，起真实进程打 `/health` 与仪表盘 HTML，验证 engines >=20 下限不是空话）。

## 代码风格约定

- 缩进 2 空格，单引号，**语句末尾加分号**；`node:` 前缀引内置模块。
- 文件头用 `// === ... ===` 横线块注释写启动流程 / 模块职责（见 `src/index.ts` 头部七步流程），中文注释。
- 命名 camelCase，常量 UPPER_SNAKE_CASE；配置项沿用 env 变量前缀 `COMMANDCODE_*` / `USAGE_HISTORY_PATH` 等既有命名。
- 测试文件 `tests/*.test.ts` 与被测模块对应；集成测试 spawn 的是 `dist/index.js`，**先 build 再测**。
- 面板资源已全部本地化，**勿引入外链 CDN**（有测试守卫）；改面板标记注意 `tests/spa-a11y.test.ts` 与 `tests/dashboard-spa.test.ts` 两条正则型回归（`<label for=` 必须紧跟、动态渲染控件不能用 `getElementById` 回读）。

## 提交与发布规范

- 提交信息 Conventional Commits + 中文描述：`feat(panel): ...`、`fix(workbuddy): ...`、`docs(handoff): ...`、`chore: ...`、`merge: ...`。
- remote 布局：`origin` = 产品仓库 `wjf1/multi-upstream-gateway`（**唯一推送目标**）；`upstream` = `wjf1/commandcode-proxy`（**只 fetch，禁止 push**，否则污染上游）。
- 发布：测试通过 → 四文档（package.json / CHANGELOG / README / HANDOFF）齐备且版本一致 → `git tag -a vX.Y.Z -m "vX.Y.Z: 中文摘要"` → push tags → 建 GitHub Release（标题与 tag subject 逐字一致，正文按新增/变更/修复分类）。
- **所有 `gh` 命令必须显式 `--repo wjf1/multi-upstream-gateway`**：本目录 `gh` 默认会解析到上游 fork，`gh release list` 显示的是上游 v4.22.4，极易误判。

## 项目专属注意

1. **服务重启必须先征得用户确认**：`npm run build` 覆盖 `dist/` 对已加载进程无影响，但 `npm test` 的 `pretest` 也会重建 `dist/`（这是常态）——结题时确认工作区状态，避免服务恰好重启时加载未完成代码。
2. **`.gitignore` 的 `*.mjs` 会静默吞掉脚本**（两个树各踩一次）：新增脚本后必须 `git check-ignore -v <file>` 复核并补 `!<path>` 例外。
3. **测试隔离**：`COMMANDCODE_CONFIG_PATH` 等环境变量必须在**动态 import 之前**设置（配置路径是模块加载时求值的）；禁止先静态 import 再依赖 env 生效。
4. **并发写入者在场时禁止 `git add -A`**（会把他人的在制品一并提交）：提交前 `git status --short` 复核，只 add 明确路径；门禁断言禁用恒真链（`| tail -1 && echo 通过` 永远「通过」），按错误计数或退出码判定。
5. **lint 不忽略 `scripts/**/*.mjs`**：已显式配置 Node 全局，不要在脚本里写 `/* global ... */`（会报 `no-redeclare`）。
