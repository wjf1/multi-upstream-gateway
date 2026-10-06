# workbuddy2api-panel 源码差异核实报告(G0-T2)

> 任务依据:《多上游 AI 网关统一开发方案 v1.2》G0-T2(第 2 章),比对基准 1.3 / 3.4 / 3.5 / 3.8。
> 报告日期:2026-10-06 ｜ 执行:G0-T2 调研(只读,未运行上游代码)
> 结论速览:**仓库存在,源码完整可逐行核对;与方案推断综合差异约 50%(>20% 阈值,T204~T207 必须修订);架构裁决按 1.3 阈值字面判定 → 推荐联邦(3.11)**。

---

## 1. 源码获取方式与 commit / 版本信息

- 获取方式:`git clone https://github.com/linguo2625469/workbuddy2api-panel` 经代理 `http://127.0.0.1:7900` 一次成功,无 404,无需 zip 兜底。
- 本地路径:`F:/AI/Qdor/review/workbuddy2api-panel`
- HEAD commit:`947828777c4496e6b3d6b6dee987be75056f7925`(`chore: 版本号 1.12.0-panel`)
- 近期提交示例:`b1a2284 fix(scheduler): 暂停号口径修正`、`ea3a51c Merge PR #113 paused-account-state`、`beb0a1b Merge PR #116 model-blocked-status`
- README 自述:Sliverkiss/workbuddy2api 的增强 fork(**上游已删库**,本项目同步至上游删库前最后一次更新 `ea8b1e5` 后独立演进);Go 1.22.5;版本 1.12.0-panel
- 代码规模:Go 源码 41,857 行(含测试约 9,600 行);面板 `index.html` 1,242 行 + `app.js` 2,772 行;README 862 行

**R2 风险缓解建议**:上游已删库一次,本 clone 即为当前可得快照,建议将 `9478287` 归档为只读基线(方案 R2 缓解项"报告归档源码快照"已满足)。

## 2. 实际目录结构与文件清单(非测试 Go 文件,带行数)

方案预期 `internal/upstream/`、`internal/panel/` 两个关键目录均存在,但实际结构比预期多 9 个包,账号池在 `internal/pool/`(**不是** upstream 内),会话粘性独立于 `internal/session/`。

```
cmd/
  server/       main.go 563 / config.go 658 / wiring.go 24      (config_test.go 861 等)
  login|credit|signin|trial/   OAuth 登录器与 CLI 工具 133~336
internal/
  upstream/     上游协议层(核心,T204 对应物)
    client.go 2103 ｜ sse.go 670 ｜ global_models.go 668 ｜ desktop.go 588
    headers.go 411 ｜ payload.go 439 ｜ tool_pairing.go 347 ｜ modelsdev.go 358
    sanitize.go 220 ｜ thinking.go 204 ｜ model_catalog.go 320 ｜ tasks.go 272
    global_register.go 232 ｜ school.go 242 ｜ report.go 206 ｜ travel.go 166
    effort_catalog.go 145 ｜ hint.go 149 ｜ usage.go 149 ｜ streak.go 106
    cache_key.go 88 ｜ idle.go 87 ｜ device_token.go 83 ｜ transport.go 116
    blackcat.go 126 ｜ profile.go 51 ｜ truncation.go 47 ｜ trial.go 49 ｜ model.json
  pool/         账号池(T205/T206 对应物)
    state.go 655 ｜ entry.go 545 ｜ cooldown.go 486 ｜ pick.go 444 ｜ pool.go 390
    persist.go 345 ｜ transition.go 96 ｜ realm.go 99 ｜ degrade.go 60
  panel/        管理面板后端(含自动化任务)
    autotask.go 1265 ｜ panel.go 842 ｜ taskcenter.go 521 ｜ tasks.go 185
    login.go 322 ｜ import.go 181 ｜ index.go 61 ｜ config.go 57 ｜ ring.go 94
    index.html 1242 ｜ app.js 2772
  server/       HTTP 服务层(错误策略执行点)
    handler.go 1475 ｜ logging.go 607 ｜ backoff.go 75 ｜ degrade.go 55
    resolve_model.go 26 ｜ wafip.go 80
  session/      会话粘性(T207 对应物)
    session.go 505 ｜ ids.go 229
  scheduler/    定时任务(签到/活跃/旅行/保活/夜猫子/成长)
    scheduler.go 675 ｜ travel.go 170 ｜ streak.go 116 ｜ blackcat.go 50
  auth/ auth.go 378 ｜ httpauth/ 43 ｜ prompt/ prompt.go 153 + defaultprompt.md
  usage/ usage.go 795 ｜ reqlog/ 650 ｜ redisstore/ 269 ｜ livecfg/ 48 ｜ logfmt/ 166
```

## 3. 逐项核对结果

### 3.1 选号算法(方案 3.4"成本分层 → 积分加权 Top-5 → 防惊群")

| 方案推断 | 源码事实 | 证据 |
|---|---|---|
| 成本分层 | **存在,超预期**:tier 0(实测免费)/1(无观测)/2(实测收费)硬过滤,只保留最优层;另加"条件探索"(tier 0 垄断时搭车改道探 tier 1,窗口默认 30min)、收费判据含上游目录倍率兜底(按 (realm, 模型) 分桶) | `internal/pool/pick.go:100-142`、`pick.go:260-287` |
| 积分加权 Top-5 | **存在**:Top-5 按权重降序截断 + 层内单价升序,Top-5 内加权随机抽签(`pickWeighted`,int64 定点 ×1e6 保确定性);权重 = 1 + credits 比例×10 + idleWeight(0.5/h 封顶 5.0);**快过期账号 ×3 虚拟实例**;成功率因子已删(上游 success-ema-review 对齐) | `pick.go:165-198`、`pick.go:365-397`、`pick.go:400-424`、`pick.go:436-442`、`internal/pool/realm.go:11` |
| 防惊群 | **存在,三重**:① `minPickGap` 100ms 锁内防并发撞号;② 等权重 Fisher-Yates 洗牌防字典序饿死;③ `usedSeq` 单调序号 LRU 兜底(Windows 时钟精度规避) | `pick.go:200-233`、`pick.go:351-353` |
| (方案未提及) | realm 双域分池(global/cn);积分保底 floor(触底号不接收费模型,粘性路径同判据);6004 模型级冷却豁免选号(issue #31);11102 (账号,模型) 负缓存避让;inFlight 在途上限按域分档;全冷却兜底选最早到期;连败 5 次降权临时出池(issue #114) | `pick.go:38-56`、`state.go:332-371/377-406`、`cooldown.go:243-274`、`pool.go:67-72`、`degrade.go:15` |

**判定**:骨架一致,机制面为方案描述的约 3 倍。方案伪代码可作 T205 骨架,但"预占租约+锁内禁 IO"(3.4)与源码 `p.mu` 单锁内完成全部门径不同,需按方案收紧重写。

### 3.2 错误分类 Classify

方案推断:"429/402/404/5xx/auth 失效等"。**实际 14 类枚举 + 11 层判定顺序**:

- 枚举(`internal/upstream/client.go:31-44`):`ErrNone / ErrHardCredit / ErrSoftRate / ErrSessionDead / ErrNotFound / ErrServer / ErrContentBlocked / ErrBadParams / ErrAccountFault / ErrModelBlocked / ErrWafBlock / ErrPromptTooLong / ErrImageInvalid / ErrClient`
- 判定顺序(`client.go:489-596`,11 层,顺序即语义):① 11102 模型不存在(最先)→ ② 402 → ③ sessionDeadMarkers(12153 精确词)→ ④ accountFaultMarkers(11140/14017,先于 429)→ ⑤ 429+code14018 → ⑥ 429 → ⑦ hardMarkers(计费关键词,双语 12 词)→ ⑧ softRateMarkers(限流文案)→ ⑨ 11115 prompt 超长 → ⑩ 404/5xx → ⑪ WAF 403(无信封)→ 11135 图片无效 → contentBlocked → badParams → ErrClient
- 每类处置(`internal/server/handler.go:1274-1362` `applyErrorPolicy`,12 分支):ErrHardCredit→硬冷却到次日 04:00;ErrSoftRate→优先对齐上游重置墙钟(6004 走模型级豁免/账号级),Retry-After 头次之,最后才有界退避;ErrWafBlock→60s±25% 抖动软冷却不 Disable;ErrSessionDead→Disable;ErrNotFound→固定 60s;ErrAccountFault→11140 禁用 / 14017 软冷却;ErrServer→喂熔断;ErrContentBlocked/BadParams/PromptTooLong/ImageInvalid→零动作;ErrModelBlocked→负缓存;ErrClient→只换号+喂连败

### 3.3 冷却/熔断状态机(方案 3.4 状态机描述)

**实际不是单链状态机,是四维正交模型**(`internal/pool/transition.go:1-27` 迁移矩阵为唯一权威):禁用(disabled 终态)/暂停(paused 瞬时态)/账号级冷却(until + CoolSoft|CoolHard)/模型级冷却(modelCooldowns)/熔断器(fails+breakerUntil,与冷却正交)/连败降权(consecutiveFails+degradeUntil)/12153 计数(sessionDeadFails)。

| 方案推断 | 源码事实 | 证据 |
|---|---|---|
| 429/5xx 指数退避 1→2→4→8s→max 30min | **不符**。429 与 5xx 分道:429=软冷却,优先对齐上游重置墙钟(不指数堆加),无墙钟才 softStreak 翻倍、封顶 **2h**、冷却中兜底探测不翻倍;5xx=喂熔断,熔断阈值 **3 次**、基数 **30min** 指数×2、封顶 **6h**(与"秒级退避→30min"完全不同);另有轮转退避 500ms·2^n 封顶 8s ±25% 抖动(请求级,非状态机) | `cooldown.go:374-392/417-438`、`entry.go:499-506`、`handler.go:1322-1326`、`backoff.go:20-27/62-78` |
| 402 → HARD_COOL 至次日 00:00 | **不符**:冷却至下一个 **04:00**(本地时区,对齐签到任务 09:00/21:00 恢复节奏;凌晨 0-4 点触发时当天 04:00) | `cooldown.go:462-479` |
| 404 → 固定 5min | **不符**:固定 **60s**(`notFoundCooldown`),不随 soft_rate 退避 | `handler.go:102-106/1323-1325` |
| BROKEN(阈值熔断,手动或 24h 恢复) | **无 BROKEN 枚举**:对应物是 `disabled` 终态(12153 连续 **3** 次才禁用,refresh 路径一次即禁)+ 熔断 `breakerUntil`(成功即清,NoteSuccess);24h 自动恢复不存在 | `state.go:32-56`、`handler.go:775-777`、`state.go:173-188` |
| SOFT_COOL → HARD_COOL(连续 N 次) | **无此迁移**:CoolSoft/CoolHard 是即时赋值,互不晋级;"连续失败"由独立的熔断器/连败降权承接 | `transition.go:19-27` |
| 每次迁移写状态转换日志 | **无专门转换日志**:状态可见性走 `/status` API(`state.go:519-580`)+ reqlog 请求日志 + 关键事件 log.Printf;方案该条属**新增增强项** | `transition.go`(全文件无日志调用) |

其余默认参数:`softRateMax=2h`、`shiftMax=16`、`degradeThreshold=5/10min/封顶2h`、`idleWeight 0.5/h 封顶5`、`expiringVirtualSlots=3`、`costExploreInterval=30min`、`wafCooldownBase=60s`、`modelBlock TTL 6h→24h`、`MaxRotate=3`、粘性 `TTL 30min/GC 5min`(`entry.go:499-543`、`backoff.go:20-27`、`handler.go:125-126`、`session.go:60-65`)。

### 3.4 payload 改写管线(方案 T204 七项)

| 方案推断项 | 判定 | 证据 |
|---|---|---|
| 强制 stream:true | **存在** | `payload.go:38` |
| SSE 帧白名单重建 | **存在**:白名单仅 id/object/created/model/system_fingerprint/service_tier + delta 白名单(role/content/reasoning_content/refusal/tool_calls/function_call),finish_reason ""→null,usage 缺失→null,默认 id `chatcmpl-wb2api`;error 帧附加 gateway_hint 变体 | `sse.go:391-467`、`sse.go:500-643` |
| 非流式本地聚合 | **存在**:`Aggregate` 消费上游 SSE 合成为完整 chat.completion;tool_calls 按 index/id/最近槽位四路合并;空流防御 | `sse.go:30-273` |
| 桌面端行为事件链 | **部分存在且不在 chat 管线**:4 条序列链(桌面成功对话 6 事件、Buddy 应用 5 事件、模板使用、playbook)+ web 元素点击 + 主题 API,全部硬编码指纹(IDE 5.5.6/win32/20 核/24G 等 22 字段);但调用点全部在**自动化任务系统** `internal/panel/autotask.go`(活跃保活/成长任务),chat 请求链路(`client.go:1018-1080` ChatStreamContext)零行为上报 | `desktop.go:39-330`、`autotask.go:840/853/876/916/967/1015/1030/1093`、`client.go:1018-1080` |
| DeepSeek 思维链注入 + reasoning_content 回填 | **存在**:injectThinking(thinking.type=enabled + 缺档补默认,disabled 照抄官方删 effort);backfillReasoningContent(assistant 消息补 string,reasoning 镜像,空串补 `" "` 占位,门控 thinkingEnabled‖hasTrace 对齐官方) | `thinking.go:156-186/70-144/191-204` |
| effort 降级 | **存在**:六档 rank(off→max),支持档 ≤ 请求档取最高、全高于取最低,snake/camel 双字段,模型声明默认档优先于硬编码 high | `payload.go:160-223`、`thinking.go:32` |
| 提示词体系 custom/append/passthrough + 拦截自动降级 | **存在**:custom=Rewrite 替换全部 system/developer;append=开头连续块后插入(逐字不动既有消息);passthrough=透传;ContentBlocked 首遇自动切 Degraded 中性提示词重试一次(降级闸) | `prompt.go:25/51-93/111-153`、`handler.go:679-685/845-856` |
| 指纹脱敏黑名单 | **存在**:7 特征预检(零分配快速路径)+ header 键值整段剥离 + 裸键名缩写 + cc_* kv 循环清理 + 5 组模板句改写(含反探测 `11128→11-128`);净化范围 content/reasoning_content/reasoning/tool_calls.arguments | `sanitize.go:15-79/82-116/179-220` |

**方案未提及但实际存在的改写点**(chat 单 pass 管线内,`payload.go:30-92` + `client.go:785-799`):max_completion_tokens→max_tokens 翻译(:100-125)、GPT 系 max_tokens 下限 16(:137-157)、stream_options 补 include_usage(:48-50)、tool_choice 对象→字符串归一(:330-373)、tools pattern `\_` 归一(:390-406)、developer→system 角色(:236-255)、image_url 字符串→对象(:266-292)、tool 配对三步 merge→repack→cleanup(:64-72,`tool_pairing.go` 347 行)、global 域兜底 system 注入(:298-322)、prompt_cache_key 保留注入。**header 层 8 个注入点**(`headers.go:198-247`):公共指纹头、设备风控头 device_token(每号>config>文件三级)、会话头族四层(X-Conversation-ID/Request-ID/Message-ID/B3)、归属伪造(injectAttribution)、global 账号头覆写、clientIP 透传开关、X-No-* 缺省约定、禁带 X-Refresh-Token 红线。

**passthrough 开关的真实语义**(`payload.go:13-15`):`sanitize=false` 时**仅跳过 sanitizeMessages**,但强制 stream、tool_choice 归一、tool 配对、role 归一等仍会发生——**不是**方案 3.2 v1.2 说的"跳过全部行为改写,仅透传+流式重建",更达不到"与直连 sidecar 逐字节一致"。T204 的 rewriteMode DoD 需按此重新定义。

### 3.5 会话粘性(方案 3.5)

| 方案推断 | 源码事实 | 证据 |
|---|---|---|
| conversation_id 绑定账号,TTL 30min 滚动续期,不可用自动解绑重选 | **存在且超预期**:快路径 RLock + 慢路径写锁 re-check(TOCTOU 防护);命中校验按 `AvailableForModel`(6004 模型豁免,"换得动"关键);双段分配(优先全空闲账号 FNV-1a 哈希,其次全池);成功后 Bind 到最终成功号、失败 Unbind;GC 5min | `session.go:147-201`、`session.go:182-222`、`state.go:377-406` |
| 派生规则 `sha256(model+"|"+system[:200]+"|"+firstUserMsg[:200])[:16]` | **不符**:实际 `sha256(systemText+"\x00"+firstUserContentSignature)` 前 16 hex + `"d-"` 前缀——**无 model 参与、无 200 字符截断**、分隔符 `\x00`、首条 user 用多模态兼容签名(图片 part 以 `[type:摘要]` 入键)、带 user_id 抑制闸(带 user 标识不派生)、prompt_cache_key 作为第 5 优先级显式键 | `session.go:390-434`、`session.go:346-349/363-378` |
| 存储为本地 JSON(StateStore 抽象) | **部分不符**:内存 map + redisstore 异步镜像(fire-and-forget,Noop 可纯内存,重启恢复绑定);方案已删 Redis,移植按 3.2 走本地 StateStore 即可,但注意源码有"重启粘性不丢"语义需决定是否保留 | `session.go:9/111-132/215-222` |
| (方案未提及) | 轮级聚合键 TurnKey/TurnRequestID(最后一条 user 消息序号+签名,后台用量聚合用);会话头族与粘性同源(ids.go) | `ids.go:81-124/216-229` |

### 3.6 状态持久化(3.4 契约第二点"proper-lockfile + 损坏重建")

- 实际:5s 周期 flusher + dirty 标志 + `.tmp` 写入后 `os.Rename` 原子替换 + Redis 快照镜像(快照比本地新才采用);落盘失败节流日志(首败/每 12 次提醒/恢复各一条)(`persist.go:15-19/231-271/43`)。
- **proper-lockfile 无对应物**(Go 单进程单写者);**"损坏时从 usage 记录重建"未实现**——损坏时仅日志告警,启动 load 失败即空池。方案的 proper-lockfile + 损坏重建属新增增强,维持 3.4 设计但 T302 须明确这是超集而非移植。

## 4. 差异比例评估(与方案推断相比)

| 域 | 方案覆盖度 | 主要差异来源 |
|---|---|---|
| 选号算法 | 骨架 ~80% / 机制全集 ~30% | realm 分池、积分保底、模型豁免、负缓存、探索、降权、虚拟实例共 7 组机制未在方案出现 |
| Classify | ~35%(语义 5/14 可对上) | 14 类 11 层 vs 方案 5 类;顺序即语义 |
| 状态机 | ~30-40% | 单链模型 vs 四维正交;全部退避参数不符(402→04:00 非 00:00、404→60s 非 5min、熔断 30min×2→6h 非 1s→30min、无 BROKEN、无转换日志) |
| payload 管线 | ~50% | 方案 7 项全部存在,但实际改写点为列举量 2.5 倍(管线 16 步+header 8 点);passthrough 语义与 v1.2 定义冲突 |
| 会话粘性 | ~65% | 骨架一致;派生公式、存储介质、user_id 闸、双段分配不符 |
| **综合(按 T204~T207 工作量加权)** | **≈50%** | 远超 G0-T2 的 20% 重估线 → T204~T207 必须修订后开工 |

## 5. 契约影响(3.4 / 3.5 / 3.2 / 3.8 需修订条目)

**3.4 账号池与状态持久化**(建议全文重写该节状态机段,替换文本):

> 熔断状态机(对齐源码实测,四维正交模型,`transition.go` 为蓝本):账号可选择性 = disabled(终态,12153 连续 3 次或 11140 触发,人工 revive)/ paused(暂停态)/ 账号级冷却(until:CoolSoft 限流、CoolHard 余额)与模型级冷却(modelCooldowns)正交 / 熔断器(fails,与冷却正交,仅 5xx 喂入)/ 连败降权。参数:429 → 优先对齐上游重置墙钟(6004 走模型级豁免),无墙钟按 softStreak 有界退避封顶 2h;402/14018 → CoolHard 至下一个本地 04:00;404 → 固定 60s;5xx → 熔断计数,3 次触发 30min×2^n 封顶 6h,NoteSuccess 全清;ErrClient 连败 5 次降权出池 10min。每次迁移写状态转换日志(方案新增,源码无,须新建)。Classify 按 14 类 × 11 层判定顺序移植(附录源码行号),新增 ErrWafBlock/ErrModelBlocked/ErrAccountFault/ErrBadParams/ErrPromptTooLong/ErrImageInvalid 六类到 `src/utils/errors.ts` 映射。

**3.5 会话粘性**(派生规则段替换):

> 客户端未提供会话键时派生规则(对齐源码):`"d-" + sha256(systemText + "\x00" + firstUserContentSignature).hex[:16]`;无 model 参与、无截断;首条 user 消息用多模态兼容签名(文本 part 拼接、非文本 part 入 `[type:sha256[:8]]` 摘要);请求携带 metadata.user_id 或顶层 user_id 时不派生(回落加权轮换);`prompt_cache_key` 作为显式键第 5 优先级。补充:命中校验必须按模型维度(6004 豁免),双段分配(优先空闲号),成功后重绑最终成功号。

**3.2 rewriteMode 定义**(必须修正,否则 T204 验收不可达):

> 源码的 sanitize 开关仅控制 `sanitizeMessages` 一层;强制 stream、tool 归一、role 归一、tool 配对等在任何模式下都会执行(协议兼容层,不做上游即 400)。修订:`'full'`=全部改写;`'passthrough'`=跳过内容类改写(提示词/脱敏/思维链注入),**保留协议兼容层**;DoD"与直连 sidecar 逐字节一致"改为"与 sanitize=false 的 Go 原版逐字节一致"(Go 原版同样强制 stream:true,与"直连"本来就不同)。

**3.8 协议矩阵**:tools 行结论"上游支持,但需 6 项 tools 相关改写(tool_choice/pattern/配对三步等)才可用";视觉行维持 ⚠️(image_url 归一化存在,`payload.go:266-292`,上游支持多模态 content,实测结论仍以 T204 fixture 为准)。

## 6. 架构裁决(按 1.3 阈值逐条判定)

| 1.3 阈值 | 判定 | 依据 |
|---|---|---|
| ① 不可离线复现的行为事件链 >3 条 | **不触发(边界情况)** | 事件链确有 4 条序列 + 2 个独立上报(`desktop.go:133/232/307/322/266/206`),但全部硬编码于源码、纯 HTTP POST,载荷可逐字节移植=可离线复现;且均不在 chat 同步管线(属自动化任务系统,T401/T402 范围)。保留意见:事件链"点亮活跃度"的效果只能实机验证,移植后有效性无离线断言手段 |
| ② 改写点 >10 处且互相耦合 | **触发** | chat 单 pass 管线 16 个改写步骤(`payload.go:30-92`)+ ensureConsoleSystem + header 层 8 个注入点 + prompt 3 模式 + SSE 2 个重建器 + thinking 2 函数 + sanitize 5 层,合计 >25 处;显式顺序依赖 ≥6 处,含跨模块耦合(prompt.Append 依赖 normalizeRoles 未执行的中间态,`prompt.go:107-110`;injectThinking 注入档位须过 normalizeReasoningEffort,`payload.go:73-75`;backfillReasoningContent 读 injectThinking 写入的 thinking.type,`thinking.go:79-85`;sanitize 必须洗 reasoning 镜像字段,`sanitize.go:203-212`) |
| ③ Classify/状态机无法逐行对照 | **不触发** | 源码完整、结构清晰、中文注释密度极高;Classify 11 层(`client.go:489-596`)与 applyErrorPolicy 12 分支(`handler.go:1274-1362`)逐行可对照;约 2,800 行专项测试(payload 467/sse 934/thinking 305/sanitize 393/tool_pairing 424/prompt 224)可直接转 snapshot fixture |

**裁决:推荐联邦(3.11 Sidecar 路径)。** 阈值②字面成立:改写点数量为阈值 2.5 倍、耦合为顺序敏感型且跨模块,移植后逐字节保真的验证面(每步顺序 × 每种请求形态 × 双域 CN/global)呈组合爆炸,是 1.3 该条针对的典型形态。

**如实记录的缓解因素**(供 DECISION 签字时权衡,不改变推荐):
1. 各改写步均为确定性纯变换(JSON in→out),无共享可变状态;"耦合"主要是顺序敏感而非状态纠缠;
2. 约 2,800 行 Go 专项测试可机械转为 T107 snapshot fixture,方案 A 的验证成本比常规移植低;
3. 折中路径存在:方案 A 变体 = 移植协议兼容层(强制 stream/tool 归一/配对,确定性最高、收益最大)+ 放弃内容类改写(默认 rewriteMode=passthrough,3.2 已预留)——若负责人选此路,须按第 10 章变更流程重排并接受 R1 风险上浮。

**联邦路径注意项**(执行 3.11 时):sidecar 需选用本报告 §1 的 fork 版(≥1.12.0-panel,上游 Sliverkiss 版已删库且缺 global 双域/模型级冷却等后期修复);sidecar 自带面板/签到/成长任务/TTL 粘性,T205/T206/T207/T401/T402 全部委托;用量采集口径按 3.9(costUsd=null + native.points,源码 `usage.go` 的 credit 字段即积分)。

## 7. T204~T207 任务卡修订建议

按 G0-T2 DoD(差异 >20% 必须修订)与裁决结果:

| 任务 | 联邦裁决下的处置(3.11) |
|---|---|
| T204(上游 Client 与协议改写,5 人天) | **替换为 T204'** 透传 Provider + Sidecar 管理(3.11-1/2):子进程拉起、健康检查、崩溃重启;`chatCompletion` 透传 pipe;`rewriteMode` 总开关保留但仅控制透传前的 header 清洗层;DoD"reasoning 回填/提示词三模式"删除,新增"sidecar 健康状态面板可见"。预估 5 → 2 人天 |
| T205(账号池调度,4 人天) | **替换为 T205'**:账号管理委托 sidecar 面板 API(`listAccounts/addAccount/pause/resume` 映射),池健康聚合读取 sidecar /status;本地不做选号。预估 4 → 0.5 人天 |
| T206(熔断状态机,3 人天) | **取消独立任务**,并入 T205'(状态机完全由 sidecar 内部承接,网关只读快照);释放 3 人天 |
| T207(会话粘性,1.5 人天) | **取消独立任务**(粘性由 sidecar 内置 session 路由承担,TTL 30min 源码既有);网关侧仅保证 conversation_id 原样透传;释放 1.5 人天 |
| 关联:T308(Anthropic 桥,1 人天) | 按 3.11 随 T204 系替换:桥接 TS 层后仍打 sidecar 的 OpenAI 端点,桥本身可保留(core/anthropic-bridge 复用) |
| 关联:T401/T402(定时任务) | 联邦下不移植任务体系(sidecar 原生五类任务 + 成长任务),面板跳转 sidecar 原生面板;T403 任务中心页降级为"sidecar 任务状态只读展示" |
| 工作量 | T204~T207 ≈13.5 → T204'+T205' ≈2.5 人天(3.11 预估 ≈4 人天口径内,含 sidecar 管理与用量采集) |

若 DECISION 最终签字为方案 A(接受缓解因素),则 T204~T207 保留但必须:① 3.4/3.5 契约按 §5 修订后重写 DoD(当前 DoD 的"404 五路径/402 次日/派生公式"会直接验收失败);② T204 预估 5 → 8 人天(16 步管线 + 8 头点 + 双域);③ T205 预估 4 → 6 人天(7 组方案外机制);④ T206 预估 3 → 4 人天(四维正交 + 12 分支策略);⑤ 先行任务:把 Go 测试转 snapshot fixture 提前至 T107(Go 原版 fixture 采集脚本对 WorkBuddy 可执行,直接移植测试用例)。

---

### 附:证据文件索引(绝对路径)

- 选号:`F:/AI/Qdor/review/workbuddy2api-panel/internal/pool/pick.go`
- 冷却/熔断/负缓存:`internal/pool/cooldown.go`;迁移矩阵:`internal/pool/transition.go`;参数常量:`internal/pool/entry.go:499-543`;持久化:`internal/pool/persist.go`
- Classify:`internal/upstream/client.go:27-80/460-600`;错误策略:`internal/server/handler.go:1235-1362`;轮转退避:`internal/server/backoff.go`
- payload 管线:`internal/upstream/payload.go`;SSE:`internal/upstream/sse.go`;思维链:`internal/upstream/thinking.go`;脱敏:`internal/upstream/sanitize.go`;tool 配对:`internal/upstream/tool_pairing.go`;headers:`internal/upstream/headers.go`;行为事件链:`internal/upstream/desktop.go` + `internal/panel/autotask.go`
- 提示词:`internal/prompt/prompt.go`;粘性:`internal/session/session.go` + `internal/session/ids.go`
