# Snapshot 测试基建(T107)

> 目的:为「把 Freebuff2API / workbuddy2api-panel 两个 Go 项目移植为 TS Provider 适配器」
> (T201 / T204)提供**移植保真度锁**——把「客户端实际收到的 HTTP/SSE 字节」与 fixture
> 逐字节对比(易变字段先 normalize),移植前后行为漂移直接变红。

## 目录结构与工作原理

```
tests/snapshot/
├── scenarios.mjs          # 场景单源:CC wire 事件序列 + 哨兵工具(录制与内置渲染共用)
├── helpers.ts             # mock 上游(回放/录制)+ normalize 白名单 + fixture 对比工具
├── snapshot.test.ts       # 用例:spawn dist/index.js 端到端(与 integration.test.ts 同模式)
└── fixtures/
    ├── upstream/          # 上游录制件:<场景名>.json —— 「上游返回了什么」
    └── snapshots/         # 客户端快照:<场景名>-<形态>.txt/.json —— 「客户端收到了什么」
```

两层 fixture 的关系:

1. **upstream fixture**(`fixtures/upstream/<场景>.json`):mock 上游的**回放源**。
   记录上游返回的原始 SSE/JSON(逐字节)。移植 Go Provider 时,它就是「Go 原版输出」
   的载体——把 mock 上游换成 Go 原版采集即可。
2. **client snapshot**(`fixtures/snapshots/<场景>-<形态>.*`):**断言目标**。
   客户端经网关(`/v1/chat/completions` 等)实际收到的响应体,经 normalize 后逐字节
   与文件对比。不一致 = 红。

数据流(mock 上游可注入,走 `COMMANDCODE_API_BASE` 环境变量):

```
用例 → spawn 的 dist/index.js(:随机端口) → mock 上游(fixture 回放) → 客户端字节
                                                                    → normalize
                                                                    → 与 snapshot fixture 对比
```

## 常用命令

```bash
# 日常:跑快照用例(fixture 缺失/不一致即红)
npx vitest run tests/snapshot

# 生成/更新 fixture(同时录制 upstream fixture + 重写客户端快照)
UPDATE_SNAPSHOTS=1 npx vitest run tests/snapshot
#   PowerShell: $env:UPDATE_SNAPSHOTS="1"; npx vitest run tests/snapshot

# 全量门禁
npm run verify
```

设计约定:**测试不允许静默改写仓库文件**。`UPDATE_SNAPSHOTS=1` 是显式动作,生成后必须
人工检查产物再随代码提交。这里不用 vitest 内置的 `toMatchFileSnapshot`:它在 fixture
缺失时会静默创建并让用例通过,拿不到「缺失必须显式生成」的红灯门槛,也无法把 upstream
录制统一进同一个环境变量入口(自定义 normalize 之后再落盘同样做不到)。

## 易变字段白名单(normalize 约定)

`helpers.ts` 的 `DEFAULT_NORMALIZERS` 把以下字段替换为占位符,然后才做逐字节对比:

| 占位符 | 语义 | 匹配正则 |
| --- | --- | --- |
| `__CHATCMPL_ID__` | OpenAI chunk/响应 id(`chatcmpl-<8位hex>`,流式全程同值) | `chatcmpl-[0-9a-f]{8}` |
| `__CREATED__` | Unix 秒时间戳(`"created":1759...`) | `"created":\d{9,12}` |
| `__ACCOUNT_ID__` | 网关账号 id(`acc_<hex>`,防御性保留) | `acc_[0-9a-f]{4,32}` |
| `__TIMESTAMP__` | ISO8601 UTC 时间戳 | `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z` |

规则:

- **白名单要窄**:正则必须锚定字段名/位数,防止误伤模型正文里的同形文本。
- Provider 专属易变字段(如 Freebuff 的 request id)在该 Provider 的用例里传
  `extra` normalizer(`normalizeSnapshot(text, extra)`),不污染全局默认表;若确认
  跨 Provider 通用,再提升到 `DEFAULT_NORMALIZERS` 并同步本表。
- fixture 一律 **LF** 行尾写入;对比时容忍 CRLF(对抗 git autocrlf 的 checkout 污染)。
- SSE 空闲注释行(`:\n\n`,网关每 15s 一条防 CDN 断开)在快照里不会出现——流毫秒级
  完成;若未来出现超长回放体需留意。

## 后续移植任务如何添加 fixture(T201 Freebuff / T204 WorkBuddy)

新增一个 Provider 用例 = 三步:**场景 → 采集 → 断言**。

### 第 1 步:定义场景(或从 Go 原版采集)

- 场景单源在 `scenarios.mjs` 的 `CC_SCENARIOS`:场景名 → CC wire 事件序列。
  内置渲染只用于**无 Go 原版时的占位/对照**;移植验收应以 Go 原版采集件为准。
- 哨兵约定:请求体用户文本里携带 `__SNAPSHOT:<场景名>__`,mock 上游据此选场景
  (哨兵只进上游请求,不进任何响应体)。

### 第 2 步:采集 upstream fixture(Go 原版输出怎么采)

用 `scripts/collect-fixtures.mjs`(见下节)把目标实现的响应落成
`fixtures/upstream/<场景名>.json`:

- **T201 Freebuff**:跑 Go 二进制(Freebuff2API,监听本地端口),然后
  ```bash
  node scripts/collect-fixtures.mjs --target http://127.0.0.1:<go端口> \
    --scenario freebuff-chat-basic --out tests/snapshot/fixtures/upstream
  ```
  脚本对 Go 服务发 CC wire 请求(`POST /alpha/generate`,含哨兵),把响应体
  逐字节写入 fixture。Go 二进制的构建/启动方式见 Freebuff2API 仓库 README。
- **T204 WorkBuddy(联邦路线,Go sidecar)**:同样用 `--target` 指向 sidecar
  监听端口。sidecar 由 TS 网关按需拉起(见 `docs/wb-source-diff-report.md`),
  采集时先手动启动 sidecar 并保持其就绪,再执行同一命令;脚本内已留
  `collectFromSidecar()` 框架钩子,sidecar 生命周期托管成熟后把「手动启动」
  替换为自动拉起。
- 产物结构(关键字段逐字节保留,易变头一律不录):

  ```json
  {
    "name": "freebuff-chat-basic",
    "source": "Freebuff2API Go 二进制采集(scripts/collect-fixtures.mjs)",
    "request": { "match": { "sentinel": "__SNAPSHOT:freebuff-chat-basic__" } },
    "response": { "status": 200, "headers": { "content-type": "text/event-stream" }, "body": "data: {...}\n\n..." }
  }
  ```

### 第 3 步:加断言用例

在 `snapshot.test.ts` 里仿照现有两条用例:

1. `postChat(...)` 的用户内容换成 `sentinelFor('freebuff-chat-basic')`;
2. 客户端字节 `normalizeSnapshot(raw)`(Freebuff 专属易变字段在此传 `extra`);
3. `compareWithFixture(actual, <新 snapshot 路径>)` 断言;
4. 首次 `UPDATE_SNAPSHOTS=1` 生成客户端快照,人工检查后入库。

## scripts/collect-fixtures.mjs(采集脚本)

```bash
# 演示模式(默认):脚本内起一个内置场景的本地 mock 上游,自采自录,
# 验证采集链路通畅(不依赖任何真实 Go 程序)。
node scripts/collect-fixtures.mjs

# 真实采集:--target 指向 Go 二进制 / sidecar 的地址(见上文 T201/T204)。
node scripts/collect-fixtures.mjs --target http://127.0.0.1:8080 --scenario freebuff-chat-basic
```

参数:`--target <url>`(缺省=demo 上游)、`--scenario <name>`(默认
`commandcode-chat-basic`)、`--out <dir>`(默认 `tests/snapshot/fixtures/upstream`)、
`--model <name>`(默认 `claude-sonnet-5`)。脚本场景数据与 vitest 侧共用
`tests/snapshot/scenarios.mjs`,单源不漂移。

## 当前用例清单

| 用例 | 场景 | snapshot |
| --- | --- | --- |
| 流式 SSE 逐字节快照 | `commandcode-chat-basic` | `fixtures/snapshots/commandcode-chat-basic-stream.txt` |
| 非流式 JSON 快照 | `commandcode-chat-basic` | `fixtures/snapshots/commandcode-chat-basic-nonstream.json` |
