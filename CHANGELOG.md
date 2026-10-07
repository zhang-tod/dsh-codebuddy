# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.3] - 2026-10-07

修复两个会造成用户可见故障的缺陷，并补上回归防护与 CI。

### 修复

- **流式响应中途静默会干等约 5 分钟，且最终不重试。**
  网关半路静默时（代理停止转发但不断开连接），`sseFrames` 会在 `reader.read()` 上死等，
  直到 Node 内置 `fetch`（undici）的默认 `bodyTimeout` 触发 —— **实测 303 秒** —— 抛出一个**裸 `TypeError`**
  （`cause.code = 'UND_ERR_BODY_TIMEOUT'`）。而宿主 `normalizeLlmFailure` → `harnessErrorCode` 只承认
  `HarnessError` 子类，其余一律归 `"UNKNOWN"`，`UNKNOWN` 不在 `retryableCodes` 里 → **不重试**，
  用户干等五分钟只看到一句无法理解的错误。

  现在给每次 `read()` 加 **空闲超时**（`STREAM_IDLE_TIMEOUT_MS`，默认 60 秒；`sseFrames(resp, { idleTimeoutMs })`
  可覆盖，测试用），超时即取消响应体并抛 `LlmError(..., 'TRANSPORT')` —— `TRANSPORT` 在重试策略里，会走正常重试。

  注意是**空闲**超时不是总时长超时：每收到一块数据就重置计时，长回答不受影响。

- **读取失败（TCP RST / 连接重置等）同样不重试。**
  上一条修的是「静默」；但若 `read()` 直接抛出硬错误（如 `ECONNRESET`），抛出的仍是**裸 `TypeError`**，
  同样被宿主归成 `UNKNOWN` → 不重试。现在把**非 `LlmError` 的读取失败**统一归一成
  `LlmError(..., 'TRANSPORT', { cause })`，让重试策略接管；已是 `LlmError` 的原样透出，不二次包装。

  > 用户主动取消**不会**因此被误重试：宿主 `adapterFailureChunk(error, options.signal)` 先判 `signal?.aborted`，
  命中即走 `kind: 'aborted'` 分支。

  > **这条守卫的边界（实测，勿误解）**：它按「两次收到数据之间是否静默」判定，因此**会被心跳骗过** ——
  > 网关只要持续吐任意字节（SSE 注释 `: keepalive`、半截帧），计时就不断重置。
  > 实测：完全不发字节 → 60 秒准时超时；每 200ms 发一次心跳 → 永不超时。
  > Node `fetch` 自带的 300 秒 `bodyTimeout` 同样被心跳骗过，故这不是退步，而是适用范围。
  > 另外失败等待的上界约为 **5.5 分钟**（60 秒 × 最多 5 次重试 + 退避约 30 秒）——
  > 这是把「必然失败」换成「大概率自愈」的有意取舍。

### 变更

- `package.json` 的 `files` 加入 `"test"`。此前 npm 包不含 `test/`，而 `scripts.test` 指向
  `test/index.test.mjs` —— **装完之后 `npm test` 必然报 `Could not find 'test/index.test.mjs'`**（实测退出码 1）。

### 新增

- **GitHub Actions CI**（`.github/workflows/ci.yml`）：push 到 main 与所有 PR 都跑全量测试。
  **为什么这个仓库能在 CI 里跑测试**：`lib/index.js` 顶层 import `@deepseek-ai/dsh-llm`，该包此前被认为
  「只在 DSH profile 里可解析」；实测它**已发布到 npm**（31 个版本），CI 里 `npm i -D @deepseek-ai/dsh-llm@0.2.0-rc.2`
  即可，无需安装整个 DSH。
  ⚠️ **必须钉版本号**：该包 dist-tags 的 `latest` 是 `0.0.1-rc.1`（很旧），不写版本会装错。

- **模型清单一致性测试**。`cordis.patch.yml` 的 `models:` 与 `lib/index.js` 的 `FALLBACK_MODELS`
  是同一份清单的两个副本，此前只靠注释里一句「改一边务必改另一边」，没有任何测试覆盖。
  现在逐条断言 id 集合、`contextWindow`、`maxTokens`、`inputModalities` 一致，不一致时报出**具体模型与字段**。

### 文档

- **修正 `CHANGELOG.md` 中 v1.0.1 的两处失实描述**（本次修复的起因之一）。
  原文写「全链路超时：**流式空闲看门狗**、单次探测 8s、探测总时限 60s、**测试连接 15s**」。对着代码逐条核实后：

  | 声称 | 实况 |
  |---|---|
  | 流式空闲看门狗 | ❌ **当时并不存在**（全仓无实现，历史里也没有；v1.0.3 才真正补上） |
  | 单次探测 8s | ✅ 属实（`PROBE_TIMEOUT_MS`） |
  | 探测总时限 60s | ✅ 属实（`DISCOVER_DEADLINE_MS`） |
  | 测试连接 15s | ❌ **实际是 8s**（用的是 `PROBE_TIMEOUT_MS`；`15000` 是 `DISCOVER_429_MAX_WAIT_MS`，与测试连接无关） |

- `cordis.patch.yml` 的注释曾写「→ 改为官方配置：见下方 `compat.supportsDeveloperRole: false`」，
  但**下方并不存在 compat 段**，而且 `compat.*` 是 `llm-pi-ai` 的协议漂移门禁字段，
  DSH 核心与官方 `dsh-llm-deepseek` 都不消费它 —— 已改为说明本适配器在代码里直接规避
  （只发 `system`、回传 `reasoning_content`），不存在对应配置项。

> **这一节的教训**：发版前把 CHANGELOG 里**每个动词和数字**对着代码跑一遍。
> 插件收录指南明写「描述会被当作对插件的声明并与代码核对，**夸大是让一个本来不错的插件被打回的主要原因**」——
> 同一条标准不只适用于市场条目，也适用于仓库里每一份对外文字。

## [1.0.2] - 2026-10-05

`peerDependencies` 预发布范围修正：让声明在**普通 semver 语义**下也成立。不改任何运行时代码。

### 修复

- `"@deepseek-ai/dsh-llm"` 与 `"@deepseek-ai/dsh-credentials"` 的范围
  由 `>=0.1.7-rc.2` 改为 `>=0.1.7-rc.2 || >=0.2.0-rc.1 <3.0.0-0`。

  原因：node-semver 只放行「范围里存在**同一个 major.minor.patch 元组**、且该比较符自身带预发布标签」
  的预发布版本。`>=0.1.7-rc.2` 在 `0.1.7-rc.2` 上为真，但**在 `0.2.0-rc.1` / `0.2.0-rc.2` 上为假** ——
  而 `0.2.0-rc.2` 正是当前 DSH 的运行时版本。

  需要说明的是：**DSH 自身的兼容门禁不会因此拦下本插件**。门禁
  （`evaluatePluginCompatibility`）在比较时传了 `{ includePrerelease: true }`，
  `>=0.1.7-rc.2` 在那个语义下对 `0.2.0-rc.2` 返回真，实测判定为「无不兼容 peer」。

  受影响的是**普通 semver 的消费方**（npm / pnpm 的 peer 解析、任何未加 `includePrerelease`
  的校验），对它们在 `0.2.0-rc.2` 上会判为不满足。新增的 `||` 分支把预发布标签放在匹配的
  `0.2.0` 元组上，两种语义下都成立 —— 这也是插件列表收录指南明确要求的形式。

  覆盖矩阵（普通 semver / 门禁语义，修复后一致为真）：
  `0.1.7-rc.2` ✓ / `0.1.8` ✓ / `0.2.0-rc.1` ✓ / `0.2.0-rc.2` ✓ / `0.2.0` ✓ / `0.2.9` ✓ / `0.3.0` ✓

- `engines.dsh` 同步为同一范围（该字段由工具链读取，不参与 DSH 门禁）。

## [1.0.1] - 2026-10-05

默认参数校准：只调整内置模型清单的声明值与对应文档，不改动接口、探测逻辑或请求构造。

### 变更

- **`contextWindow` 统一为 1000000**（全部 22 个模型）。此前各模型取官方产物里的
  `defaultLength`（131072 / 192000 / 200000 / 256000 / 300000 不等）。
  `contextWindow` 是宿主 DSH 的**本地声明** —— 决定它何时压缩上下文、何时判定溢出 ——
  不是请求体字段，与网关侧的 `supportedLengths` 无关；实测网关硬上限 1048576 tokens，
  1M 声明下长期运行正常。
- **`deepseek-v4.1-flash` 的 `maxTokens` 8192 → 128000**。8192 会让长回答被截断在半途，
  表现为「已达到输出 token 上限，发送继续才能继续」。其余模型维持 8192，
  `deepseek-v4-pro` 维持 32768。
- 修正 `cordis.patch.yml` 中与调整后取值自相矛盾的注释（原文称「1M 会顶穿网关硬上限，
  故取官方 defaultLength」）。

### 文档

- `README.md` / `README.en.md`：内置模型清单表重算（22 行），补记两个参数的取值理由，
  以及它们之间的约束 —— `contextWindow - reservedCompletionTokens > 0`，
  二者之和无需小于网关硬上限。

## [1.0.0] - 2026-10-03

首次公开发布。

### 新增

- **探测结果真正进入模型选择器**：`listModels()` 现在合并「配置清单 ∪ 本会话探测命中」。
  此前探测结果只回给设置页展示，GUI 模型选择器仍只认静态清单 —— 网关上新增的模型「看得到却选不到」。
- **探测确认下线的模型会被剔除**：只加不减会让已下线模型仍能被选中，一选就 HTTP 400。
  仅在一次**干净完成**的探测后整体替换该结论；限流 / 超时 / 取消的结果一律不写入，避免误删可用模型。
- **目录结论按作用域隔离**（端点 + 密钥指纹）：更换端点或密钥会自动清空，旧端点的模型不再串味。
- 设置页新增：删除密钥、清空探测缓存、深度探测开关、探测中取消、成本统计显示。
- **全链路超时**：单次探测 8s、探测总时限 60s（`PROBE_TIMEOUT_MS` / `DISCOVER_DEADLINE_MS`），
  以及设置页「测试连接」的同一个 8s 守卫。
  > ⚠️ **本条曾被写错，2026-10-07 更正**：原文声称还包含「流式空闲看门狗」与「测试连接 15s」，
  > 对着代码核实后两者都不成立（看门狗当时根本没有实现；测试连接用的是 8s 而非 15s）。
  > 看门狗已于 [1.0.3] 真正补上，见该节。
- **请求生命周期取消信号**：关闭页面即停止服务端探测（此前「取消」只停了进度条）。
- **SSE 截断守卫**：未收到 `[DONE]` 或 `finish_reason` 时归一成 `TRANSPORT` 重试，
  不再把半截正文或半截工具参数当完整结果提交。
- 带内错误帧与 HTTP 错误路径**共用同一个分类器**。
- 回归测试 21 条（零网络、零额度，含本地 mock 网关端到端）。
- `LICENSE`、`README.md`、`README.en.md`、`.gitignore`、`CHANGELOG.md`。

### 修复

- **额度用尽被误判为限流**：网关额度耗尽时返回 HTTP 429 + `code 14018`，
  此前一律归 `RATE_LIMIT`（可重试）→ 用户白等 5 次退避约 30 秒，且看到「限流」而非「欠费」。
  现在归 `QUOTA`（不可重试），探测**第一批即停**，文案改为引导充值。
- **上下文超限未分类**：网关返回 `code 11115` / `prompt is too long`，
  此前落 `INVALID_REQUEST`，导致 DSH 的溢出兜底压缩「永不触发」（消费方是硬门槛判断）。
  现在归 `CONTEXT_WINDOW_EXCEEDED`。
- `probeModel` 的 429 分支**不读响应体** → 无法区分限流与欠费（同一状态码，语义相反）。
- `11102`（模型不存在）判定只读顶层 `code` → 改为穿透 `error.data.code`。
- `usage` 忽略 `total_tokens`，且网关回空对象 `{}` 时会覆盖真实计数 → 用量被上报成 0。
- 图片未声明 `inputModalities` → 宿主跳过图片投影，图片被静默降级为字面量 `[图片]`。
- 流式响应中途失败时未 `cancel` 响应体 → 连接与缓冲被挂住直到服务端超时。
- `clear-key` 谎报成功：密钥可能来自只读来源（如 `~/.dsh/.env`），删了会被「复活」，
  此前仍回「✅ 已删除」→ 现在复验并**如实报告删不掉**。
- `set-base-url` 是空操作却弹「✅ 端点已保存」→ 改为如实拒绝，UI 的地址框改为只读。
- 探测候选硬编码兜底表 → 改为**配置清单优先**（否则用户从配置里删掉的模型会被探测重新加回）。
- 深度探测的猜测清单可能与被探候选重复 → 去重，避免同一模型双倍计费。
- 注释中的成本数字与实测不符（63/126 → 实测 60/120）。

### 安全

- **修复凭据外发原语**：`discover` 动作曾直接采信请求体中的 `apiKey` 与 `baseURL`，
  而 `resolveKey` 会把任意字符串当作**环境变量名**解析 ——
  构造一个请求即可令插件把 `.env` 中任意一条凭据以 `Authorization: Bearer` 发往任意主机。
  现在草稿密钥**只接受 `sk-` / `ck-` 字面量**，草稿地址必须为 `https` 且与已配置端点**同主机**。
- **修复漏写 `await`**：`key = draftKey ? resolveKey(...) : await resolveKey(...)`
  真值分支漏 `await` → 会发出 `Bearer [object Promise]`、把缓存键塌陷成同一槽，并产生未处理的 Promise 拒绝。
- 设置页写操作围栏加固：`Host` 必须为回环名（挡 DNS rebinding）、拒绝 `Origin: null`、
  `Sec-Fetch-Site` 校验、`Content-Type` 必须为 JSON、请求体 64 KB 上限。
- 错误文案不再回显密钥原文。

### 变更

- 模型清单纯净化为单一真相源（`PROBE_CANDIDATES` 由 `FALLBACK_MODELS` 派生，不再手抄）。
- 显示名改为 `CodeBuddy (unofficial)`，`keywords` 移除 `tencent`。
- `peerDependencies` 由 `"*"` 收窄为 `>=0.1.7-rc.2`（此前 `"*"` 会让 registry 上过期的 `latest` 也被视为满足）。
- 新增 `npm test`（`node --test`）。

### 已知限制

- 探测结果**不跨会话持久化**：重启 DSH 后回到内置清单，需重新点一次「获取模型」。
  （跨会话持久化需要 `Config` schema 与 `@deepseek-ai/schemastery` 依赖，会牵动 profile 的 lockfile。）
- 接口地址不能在设置页修改（由配置 / 环境变量决定）。
- 一次「获取模型」会产生真实计费请求（默认 22 次，最坏 44；深度探测 60 / 120）。
- 模型元数据（上下文窗口、最大输出）为静态声明，官方调整后需更新 `cordis.patch.yml`。
