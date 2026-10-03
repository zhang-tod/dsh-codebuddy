# dsh-codebuddy

> ⚠️ **非官方第三方插件**。本项目与腾讯控股有限公司及其关联公司**无任何隶属、合作、赞助或背书关系**。
> 「CodeBuddy」「腾讯」等名称与标识为其各自所有者的商标，此处仅作**指示性描述**（nominative use），用于说明本插件连接的是哪一个服务。
> 本项目**不含**任何腾讯的代码、资源或凭据，也不绕过任何鉴权。

把 [腾讯 CodeBuddy 开放平台](https://copilot.tencent.com) 的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
**零源码补丁**：不改 DSH 的任何文件，不碰 `node_modules`，纯插件。

---

## 这是什么 / 不是什么

| ✅ 是 | ❌ 不是 |
|---|---|
| 一个标准 DSH 插件（`package.json` + `cordis.patch.yml` + host 入口 + 设置页） | 不是 DSH 官方的 provider |
| 用**你自己的** CodeBuddy API Key 直连官方 OpenAI 兼容网关 | 不提供、不转售、不共享任何 API Key |
| 带图形设置页：填 Key → 测试 → 获取模型 → 选模型 | 不是命令行工具，不需要改配置文件即可用 |
| 探测式模型发现（网关没有模型清单接口） | 不代理、不中转、不经第三方服务器 |

---

## 前置条件

| 项 | 要求 |
|---|---|
| DSH | 已在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 上验证（依赖 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 契约） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| 账号 | 一个[腾讯 CodeBuddy 开放平台](https://www.codebuddy.cn)账号与 API 密钥（`sk-` 或 `ck-` 开头） |

> 本插件**不需要** DSH 的账号体系，也不需要任何其它凭据。

---

## 安装

### ⚠️ 先看这条：**不要用 `link:`**

本插件的 `lib/index.js` 在**顶层静态 import** `@deepseek-ai/dsh-llm`。该包由 DSH 自身提供，只在 profile 的 `node_modules` 树里可解析。

- `link:` 安装 → 插件以**软链**形式存在 → 解析不到 `@deepseek-ai/dsh-llm` → **加载期直接抛 `ERR_MODULE_NOT_FOUND`**，表现为「装上了但设置里什么都没有」
- `file:` 安装 → pnpm 把插件**实体复制**进 profile 的 `node_modules` → 能往上层解析到 DSH 的包 → ✅ 正常工作

**所以：用 `file:` 绝对路径，或干脆手动复制目录。**

### 方式 A：`file:` 依赖（推荐）

1. 把本仓库放到一个**固定位置**，例如 `E:\WorkBuddy\dsh-codebuddy`
2. 在 DSH profile 的 `package.json` 里：
   - 加依赖：`"dsh-codebuddy": "file:E:/WorkBuddy/dsh-codebuddy"`（Windows 用正斜杠）
   - 加进 `dsh.profile.bundles` 列表
3. 让 profile 安装依赖（DSH 桌面版的「设置 → 插件」页面添加本地路径，或按你的 profile 类型走对应安装流程）
4. **重启 DSH**（必须，插件在启动时注册）

### 方式 B：手动复制

把本仓库的 `lib/`、`cordis.patch.yml`、`package.json` 复制到：

```
<DSH profile 目录>/node_modules/dsh-codebuddy/
```

然后重启 DSH。

### 方式 C：npm / GitHub（若已发布）

```bash
dsh plugin --profile <你的profile> add dsh-codebuddy
# 或
dsh plugin --profile <你的profile> add github:<owner>/dsh-codebuddy
```

> 注意：这两种方式同样依赖「插件能解析到 profile 里的 `@deepseek-ai/dsh-llm`」，若安装后报 `Cannot find module '@deepseek-ai/dsh-llm'`，请改用方式 A 或 B。

---

## 配置

重启后进入 **设置 → CodeBuddy**：

| 步骤 | 操作 |
|---|---|
| 1 | 在「API 密钥」填入你的 Key（`sk-` / `ck-` 开头），点 **保存密钥**（存进 DSH 凭据库，不写进配置文件） |
| 2 | 点 **测试连接** —— 应显示「✅ 连接成功，密钥有效」 |
| 3 | 点 **获取模型** —— 逐个探测网关，把可用模型列出来（见下方成本说明） |
| 4 | 到 **设置 → 模型**，provider 选 `CodeBuddy (unofficial)`，选中你要的模型 |

**接口地址是只读的。** 它由 `cordis.patch.yml` 的 `baseURL` 决定；要改就改配置或设环境变量 `CODEBUDDY_BASE_URL`，然后重启 DSH。设置页**故意不提供**修改入口（以前有个「保存地址」按钮，点了会显示「已保存」但其实什么都没发生，已移除）。

### 一次「获取模型」要发多少次请求？

每条候选都是一次**真实计费**的补全请求。

| 模式 | 请求数 | 说明 |
|---|---|---|
| 默认（浅探测） | 22 次（最坏 44） | 只探已知清单；「最坏」是「无法判定」的重试轮 |
| 勾选「深度探测」 | 60 次（最坏 120） | 追加 38 条按命名规律猜的**未来版本号** |

内置保护：

- **会话内缓存**（30 分钟，键 = 端点 + 密钥指纹）→ 重复点击 0 请求
- **限流熔断**：一批里出现 ≥3 个 429，或连续 3 批都撞 429 → 立刻停
- **额度熔断**：撞到 `code 14018`（额度用尽）→ **第一批就停**，不再浪费请求
- **总时限 60 秒**：到点中断在飞的请求（含退避），不会挂几分钟
- **可取消**：探测中按钮变「取消」，点它会**真的**把中断传到服务端

---

## 内置模型清单

探测失败时的兜底清单（22 条，2026-10-01 实测校准）。`contextWindow` 取官方 `defaultLength`，网关硬上限实测为 1048576 tokens。

| ID | 名称 | 上下文 | 最大输出 | 输入 |
|---|---|---|---|---|
| `auto` | Auto 自动路由 | 131072 | 8192 | 文本 |
| `hy4-preview` | Hy4 Preview (混元4) | 300000 | 8192 | 文本 / 图片 |
| `hy3` | Hy3 (混元3) | 192000 | 8192 | 文本 / 图片 |
| `hy3-preview` | Hy3 Preview | 131072 | 8192 | 文本 |
| `hy3-preview-agent` | Hy3 Preview Agent | 131072 | 8192 | 文本 |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 300000 | 8192 | 文本 / 图片 |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 300000 | 32768 | 文本 / 图片 |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 300000 | 8192 | 文本 / 图片 |
| `glm-5.3` | GLM 5.3 | 300000 | 8192 | 文本 / 图片 |
| `glm-5.3-flash` | GLM 5.3 Flash | 300000 | 8192 | 文本 / 图片 |
| `glm-5.3-flashx` | GLM 5.3 FlashX | 300000 | 8192 | 文本 / 图片 |
| `glm-5.2` | GLM 5.2 | 300000 | 8192 | 文本 / 图片 |
| `glm-5.1` | GLM 5.1 | 200000 | 8192 | 文本 / 图片 |
| `glm-5v-turbo` | GLM 5V Turbo (视觉) | 200000 | 8192 | 文本 / 图片 |
| `minimax-m3` | MiniMax M3 | 131072 | 8192 | 文本 |
| `minimax-m3-pay` | MiniMax M3 Pay | 300000 | 8192 | 文本 |
| `kimi-k3` | Kimi K3 | 131072 | 8192 | 文本 |
| `kimi-k2.8-preview` | Kimi K2.8 Preview | 300000 | 8192 | 文本 / 图片 |
| `kimi-k2.7` | Kimi K2.7 | 256000 | 8192 | 文本 / 图片 |
| `kimi-k2.6` | Kimi K2.6 | 256000 | 8192 | 文本 / 图片 |
| `kimi-k2.5` | Kimi K2.5 | 256000 | 8192 | 文本 / 图片 |
| `step-5-preview` | Step-5 Preview (阶跃) | 300000 | 8192 | 文本 / 图片 |

> 模型清单会随官方变化。**清单是兜底的，「获取模型」探测的结果才是准的**（探测到的模型会在本次会话内直接进入模型选择器）。

---

## 数据与隐私

请在使用前读完本节。

| 项 | 说明 |
|---|---|
| **API Key 去向** | 仅作为 `Authorization: Bearer` 头发往 `https://copilot.tencent.com/v2`。**不经过作者、不经过本插件的任何服务器**（本插件没有服务器） |
| **对话内容** | 你的提示词、代码、系统提示词、工具调用参数会**全部上传**到上述腾讯网关，按其隐私政策处理，可能跨境 |
| **遥测** | **无**。本插件不含任何统计、上报、埋点、回传 |
| **请求身份** | 每个请求会带 DSH 框架的标准 User-Agent（`deepseek-harness/<版本>`）。这是 DSH 的框架契约要求，非本插件添加 |
| **Key 存储** | 存进 DSH 凭据库（`~/.dsh/.credentials.yaml`），**不写明文到配置文件**。若凭据库不可用会退化为进程环境变量（仅当次会话有效） |
| **删除 Key** | 设置页有「删除密钥」。若你的 Key 由**只读来源**（如 `~/.dsh/.env`）提供，插件会**如实告诉你删不掉**，而不是假装成功 |
| **提 Issue 时** | 请勿粘贴 API Key、完整请求日志，或任何含凭据的截图 |

---

## 故障排查

| 现象 | 含义 | 怎么办 |
|---|---|---|
| **HTTP 400 · `code 11102`** | 模型不存在 | 点「获取模型」重新探测，从列表里选 |
| **HTTP 400 · `code 11115`** `prompt is too long` | 上下文超限 | 插件会归为 `CONTEXT_WINDOW_EXCEEDED`，DSH 会自动压缩后重试；持续失败就精简会话 |
| **HTTP 429 · `code 14018`** `额度已用尽` | **账号额度用尽**（永久失败，不是限流） | 到 [codebuddy.cn](https://www.codebuddy.cn/profile/usage) 充值或购买加量包。重试无用 |
| **HTTP 429（无 14018）** | 真限流 | 稍后重试；插件会尊重 `Retry-After` 并熔断 |
| **HTTP 401 / 403** | 密钥无效或过期 | 重新填写 Key |
| **`无法解析凭据 "CODEBUDDY_API_KEY"`** | 还没填 Key | 在设置页填并保存 |
| **`网关返回空响应`** | 网关回了 200 但没有任何内容块 | 插件会按 `EMPTY_RESPONSE` 自动重试 |
| **`响应流被截断`** | 连接中途断了（代理/网关重启） | 插件按 `TRANSPORT` 重试，不会把半截内容当完整回答 |
| **装完设置里没有 CodeBuddy** | 大概率用了 `link:` 安装 | 改用 `file:` 或手动复制（见「安装」） |
| **模型选择器里看不到新模型** | 探测结果**只在本次会话内生效** | 重启后重新点一次「获取模型」 |
| **`Cannot find module '@deepseek-ai/dsh-llm'`** | 插件不在 profile 的 `node_modules` 树内 | 用 `file:` 或手动复制安装 |

---

## 已知限制

1. **模型发现结果不跨会话持久化。** 探测到的新模型会在本次会话内立刻进入模型选择器，但**重启 DSH 后回到内置清单**，需要重新点一次「获取模型」。
   （跨会话持久化需要给插件条目加 `Config` schema 并依赖 `@deepseek-ai/schemastery`，会牵动 profile 的 lockfile，暂未做。）
2. **接口地址不能从设置页改。** 端点由配置 / 环境变量决定。
3. **深度探测的猜测清单会过时。** 38 条按命名规律猜的版本号（如 `hy5`、`deepseek-v5`）随官方更新而失效，且**默认不启用**。
4. **模型元数据（上下文窗口 / 最大输出）是静态声明的。** 官方调整后需要更新 `cordis.patch.yml`；探测不会自动修正已收录模型的元数据。
5. **一次「获取模型」会产生真实计费请求**（见上方成本表）。

---

## 卸载与回滚

1. 从 profile 的 `package.json` 移除 `dsh-codebuddy` 依赖与 `dsh.profile.bundles` 条目
2. 删除 `<profile>/node_modules/dsh-codebuddy/`
3. 重启 DSH —— 设置里的 CodeBuddy 分区应消失
4. 如需清理凭据：设置页点「删除密钥」，或手动移除凭据库里的 `CODEBUDDY_API_KEY`
5. 回滚到「二进制补丁」老方案：恢复你原来的 `selfheal` 脚本与 profile 里的旧 provider 段

---

## 开发

```bash
npm test        # 零网络、零额度的回归测试（node --test）
```

测试覆盖：SSE 解析边界（CRLF 跨分片、多行 `data:`、尾帧）、块生命周期与 index 分配、工具调用参数拼接、`usage` 计数互斥、错误分类（11102 / 11115 / 14018 / 401 / 5xx）、流截断守卫、目录合并（增/减/作用域）、探测的熔断与总时限、以及一个**本地 mock 网关**端到端。

> 测试必须在**已安装副本**里跑 —— `lib/index.js` 要解析 `@deepseek-ai/dsh-llm`，该包只在 DSH profile 里存在。开发时把 `lib/` 与 `test/` 同步到 `<profile>/node_modules/dsh-codebuddy/` 再跑。

---

## 许可

[MIT](LICENSE)。上游 `@deepseek-ai/dsh-llm` 系列同为 MIT，见 `LICENSE` 末尾的第三方声明。

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 插件框架与 `LlmAdapter` 契约
- `@deepseek-ai/dsh-llm-deepseek` —— 适配器实现的参考
