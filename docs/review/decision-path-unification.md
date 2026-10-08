# 判定路径合一：评审材料（modelAccess / 限流）

> **状态：材料已备，待负责人裁决。** 对应 `PLAN-STATE.md` 登记的「判定路径合一……需独立评审」。
> 本文只陈述**现状事实**与**候选方案**，不含任何行为改动 —— 合一动作会改变错误码与环境变量语义，
> 属需要决策的破坏性变更，故先出材料。

## 1. 结论摘要

网关上「谁能用哪个模型」与「请求是否超限」两类判定，目前由**两条独立链路**执行：全局 `preHandler`
（下称**路径 A**）与路由 handler 内的守卫（**路径 B**）。二者按 A→B 顺序串联，行为性质并不相同。

| 维度 | 路径 A：`registerSecurityGuards()` | 路径 B：路由内守卫 |
|---|---|---|
| 装配/位置 | 全局 `preHandler`（`src/index.ts:198`，**不传 opts**） | `routes/chat.ts:90-91`、`messages.ts` 等 handler 内 |
| 执行顺序 | 先（body 解析后、鉴权之后） | 后（A 放行后才进入 handler） |
| modelAccess 配置源 | env `MODEL_ACCESS_ALLOW` / `MODEL_ACCESS_BLOCK`（`resolveModelAccessConfigFromEnv`，**只读 env**） | `config.json` 的 `modelAccess` 分片（store 优先）；回退 env `MODEL_ALLOWLIST` / `MODEL_BLOCKLIST` |
| modelAccess 匹配语义 | **支持尾部通配**（`glm-5*`） | **精确匹配**（大小写不敏感，无通配） |
| modelAccess 拒绝码 | 403 `MODEL_ACCESS_DENIED` | 403 `MODEL_NOT_IN_PLAN` |
| 限流实现 | `rate-limiter.ts`：全局桶 + **per-provider 桶** | `rate-limit.ts`：全局桶（按凭据尾 4 位分桶） |
| 限流配置源 | `rateLimit.global` / `perProvider` 分片（`config-store-runtime` 经 `reconfigureRateLimiter` 注入）；空则回退 env `RATE_LIMIT_GLOBAL_RPM/TPM`、`RATE_LIMIT_PROVIDER_<NAME>_*` | `rateLimit.global` 分片；空则回退 env `RATE_LIMIT_RPM` / `RATE_LIMIT_TPM` |
| 限流拒绝 | 429 `RATE_LIMIT` + `Retry-After` | 429 `RATE_LIMIT` |

**两类判定的性质不同，必须分开看**：

- **限流：配置源已统一，执行仍是两套。** T213b 把路径 A 的限流器改由 `UnifiedConfigStore` 的
  `rateLimit` 分片驱动（`config-store-runtime.ts:42` → `reconfigureRateLimiter`），路径 B 也已
  「分片优先、env 回退」。但**两套限流器是各写各的独立实现**，同一份 `rateLimit.global` 被两个桶
  同时执行。
- **modelAccess：配置源与执行都还是两套。** 一条走 `MODEL_ACCESS_*`（env，通配），另一条走
  `modelAccess` 分片 / `MODEL_ALLOWLIST`（精确），互不联动。

## 2. 已构成真实风险的三点

**R1｜限流「一个配置、两套执行」，阈值不等于实际边界。** 用户在 `rateLimit.global` 里设 `rpm=60`
后，路径 A 的全局桶与路径 B 的全局桶会**各自独立计数并各自拒绝**：两者的分桶维度（A 全局 + per-provider；
B 按凭据尾号）、滑动窗口实现与日志均独立。实际生效边界是两套的交集，而排障时需要同时看两处 ——
"我明明调高了 rpm 还是被拒"这类困惑由此而来。

**R2｜modelAccess 双轨导致「设了却没生效」。** 同一意图要在不同通道配置，且通道不同则语义不同：

- 设 `MODEL_ACCESS_ALLOW=glm-5*`（env，路径 A）→ 通配生效，但 `config.json` 的 `modelAccess` 分片
  对它无影响；面板/T213b 的配置面走的是分片（路径 B），**在这个通道里看不到**。
- 设 `modelAccess.allowlist`（分片，路径 B）→ 精确生效，但通配写法（`glm-5*`）在这里不成立，
  会按字面量精确比较而**不匹配任何模型**。

两条通道都"能拦请求"，所以用户往往不会立刻发现配置走错了通道，只看到"这个模型有时候被拦、有时候没有"。

**R3｜错误码与文档分叉。** 两条路径的拒绝码不同（`MODEL_ACCESS_DENIED` vs `MODEL_NOT_IN_PLAN`），
而 **README 的错误码表里没有 `MODEL_ACCESS_DENIED`**（实测 `grep -c MODEL_ACCESS_DENIED README.md` = 0）——
走路径 A 被拦的请求，客户端拿到的码在文档里查不到，排障只能翻源码。

## 3. 候选方案

| | 方案 1：保持现状 + 补文档 | 方案 2：合一到分片，**保留通配** | 方案 3：合一到分片，只留精确 |
|---|---|---|---|
| 动作 | 只补 README 错误码表与本材料链接；不动代码 | `modelAccess` 分片成**唯一配置源**；匹配统一为「精确 + 尾部通配」；`MODEL_ACCESS_*` 保留一个版本的兼容读取（含弃用告警） | 同左，但匹配只保留精确 |
| 风险 | 双轨继续存在，R1/R2 不解决 | 需改路径 A 的配置读取与匹配；通配是精确的**超集**，既有精确名单行为不变 | 会让现有使用通配的用户配置**静默失效**（依赖通配的名单不再匹配） |
| 客户端影响 | 无 | 错误码可统一为一个、另一个作为兼容别名保留 | 同左 |
| 工作量 | 0.5 天 | 2~3 天（含两套路径的回归测试与迁移说明） | 2~3 天 |

## 4. 建议

**先执行方案 1（立即，无风险），再按方案 2 排期。** 理由：

1. 方案 1 中的 README 补码是**纯缺口修复**（R3），可以现在就做，与决策无关 —— 本文已把事实固定下来。
2. 方案 2 是唯一能同时消掉 R1/R2 的方向：`rateLimit` 侧已经统一了配置源，把执行也收敛到一套，
   才与"单一事实来源"一致；`modelAccess` 侧以分片为唯一源，能直接消除"设了没生效"。
3. **匹配语义取"精确 + 通配"而不是只留精确**：通配是精确匹配的超集，纯精确名单迁移后行为完全等价
   （零破坏），而依赖通配的配置不会失效。反向选择（只留精确）会静默废掉一部分用户的名单。
4. 错误码统一为 `MODEL_NOT_IN_PLAN`（既有、已在 README 与 errors.ts 的对外映射中），
   `MODEL_ACCESS_DENIED` 保留为**兼容别名**至少一个版本，并在 CHANGELOG 与 README 的错误码表里注明。

## 5. 未确认事项（决策前需确认）

1. 路径 A 的 per-provider 限流分桶用 `predictProviderForRateLimit()`（按 `X-Upstream-Provider` / 模型前缀
   **预判**）。T213 已把路由决策接入数据面，此处是否应改为消费**真实 `decision.provider`**？——
   预判与实际决策不一致时会把请求计进错误的桶。
2. `rateLimit` 分片同时驱动 A 的 per-provider 桶与 B 的凭据桶，合一后是否只保留 per-provider 维度？
3. 是否有外部集成方已经依赖 `MODEL_ACCESS_DENIED`（本仓库为公开仓库，需确认无下游硬依赖后再改码）。
