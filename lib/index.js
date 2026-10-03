/**
 * dsh-codebuddy — CodeBuddy 开放平台适配器（host 半）
 *
 * 目标：把腾讯 CodeBuddy（copilot.tencent.com）接入 DSH，**完全替代原有的 4+1 个二进制补丁**。
 *
 * ── 与补丁版的关系（2026-10-01 实测结论）──────────────────────────
 *   ✅ 采纳：developer 角色必须避开（网关 400）      → 本适配器只发 system
 *   ✅ 采纳：多轮必须回传 reasoning_content          → 从 reasoning 块提取
 *   ❌ 不采纳：UA 伪造（实测网关不校验 UA，四种 UA 全 200）
 *   ❌ 不需要：input/cost 空值守卫（DSH 0.2.0 上游已修）
 *   ✅ 但遵守契约：仍发送 attributionHeaders()（DSH 要求，与网关无关）
 *
 * ── 契约依据（逐条对齐 dsh-llm/lib/types/types.d.ts）─────────────
 *   StreamChunk       L417-447  block-start/block-end 成对；tool-call-delta 带 id
 *   ContentBlockType  L114-124  'tool-call'（连字符，非 toolCall）
 *   FinishReasonMap   L131-151  stop / tool-calls / max-tokens
 *   TokenUsage        L160-174  inputTokens/outputTokens（计数互斥）
 *   ToolSchema        L455-466  parameters（非 inputSchema）
 *
 * @module dsh-codebuddy
 */

import { createHash } from 'node:crypto'

import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  normalizeApiKey,
  requiredImageOffload,
  requestImageHandleText,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  ReasoningEffortId,
  isQuotaExceededError,
  isContextWindowExceededError
} from '@deepseek-ai/dsh-llm'

export const name = 'llm-codebuddy'
export const inject = ['llm']

const DEFAULT_BASE_URL = 'https://copilot.tencent.com/v2'

/**
 * 内置模型（探测失败时的兜底）。2026-10-01 实测校准。
 *
 * ⚠️ 必须与 cordis.patch.yml 的 models **逐条一致**（id / contextWindow / inputModalities）。
 * 两者是同一份清单的两个副本：配置项存在时以 YAML 为准，配置缺失时用本表兜底。
 * 改一边务必改另一边（PLUGINS.md 有校验清单）。
 *
 * contextWindow 取值依据见 cordis.patch.yml 顶部注释：官方 defaultLength，不是 1M。
 * inputModalities 省略 = 仅文本（宿主据此把图片投影成占位文字，不会静默丢失）。
 */
const FALLBACK_MODELS = [
  // 官方产物配置里查不到的 5 个 → 无证据，保守 131072 / 仅文本
  { id: 'auto', name: 'Auto 自动路由', contextWindow: 131072, maxTokens: 8192 },
  { id: 'hy3-preview', name: 'Hy3 Preview', contextWindow: 131072, maxTokens: 8192 },
  { id: 'hy3-preview-agent', name: 'Hy3 Preview Agent', contextWindow: 131072, maxTokens: 8192 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 131072, maxTokens: 8192 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 131072, maxTokens: 8192 },
  // 官方 defaultLength 可查的模型
  { id: 'hy4-preview', name: 'Hy4 Preview (混元4)', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'hy3', name: 'Hy3 (混元3)', contextWindow: 192000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 300000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'glm-5.3-flashx', name: 'GLM 5.3 FlashX', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'glm-5.1', name: 'GLM 5.1', contextWindow: 200000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  // 视觉旗舰：官方 descriptionZh「原生多模态模型」
  { id: 'glm-5v-turbo', name: 'GLM 5V Turbo (视觉)', contextWindow: 200000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  // ⚠️ 唯一不声明 image 的官方多模态模型：实测 4 张纯色图只对 2 张（blue→Orange、yellow→Pink）
  { id: 'minimax-m3-pay', name: 'MiniMax M3 Pay', contextWindow: 300000, maxTokens: 8192 },
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'kimi-k2.7', name: 'Kimi K2.7', contextWindow: 256000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 256000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 256000, maxTokens: 8192, inputModalities: ['text', 'image'] },
  { id: 'step-5-preview', name: 'Step-5 Preview (阶跃)', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] }
]

/**
 * 探测候选（「获取模型」逐个试；命中判定见 probeModel）。
 * 清单来源：2026-10-01 对 copilot.tencent.com 网关的实测扫描（21 个模型 + 内置 auto = 22 条，全部命中）。
 * 注：腾讯桌面端 UI 里可见的 `kimi-k2.7-code` 在 API 网关上返回 11102（不存在），已剔除。
 *
 * ⚠️ 由 FALLBACK_MODELS 派生（勿再手抄一份）：模型清单原先散落三处
 * （cordis.patch.yml / FALLBACK_MODELS / 本数组），改一处漏两处。
 * 现在只保留「配置清单」这一个真相源，这里退化为一行投影。
 */
const PROBE_CANDIDATES = FALLBACK_MODELS.map((m) => m.id)

/**
 * 探测候选 id 列表：**优先配置清单**，空配置才退回内置兜底表。
 * 必须走配置 —— 否则用户在 cordis.patch.yml 里删掉的模型会被探测重新加回目录。
 */
function candidateIds(cfg) {
  const source = Array.isArray(cfg?.models) && cfg.models.length ? cfg.models : FALLBACK_MODELS
  return source.map((m) => m?.id).filter((id) => typeof id === 'string' && id.length > 0)
}

/** 单次模型探测超时（ms）。超时算「无法判定」→ 进重试阶段，不会被误判为不存在。 */
const PROBE_TIMEOUT_MS = 8000/**
 * 猜测候选（**深度探测**）：腾讯上新模型时优先「按家族版本号递增」命名，网关上又没有清单接口
 * （已实测 50 条路径 GET/POST 全 404），所以只能按命名规律盲探。
 *
 * ⚠️ 成本：每一条都是**真实计费请求**（22 条已知 + 本表 38 条 = 60 次，含第③阶段重试最坏 120 次）。
 * 因此本表**默认不参与**探测，仅当用户显式勾选「深度探测」才启用（见 discoverAll 的 deep 参数）。
 * 命中即自动出现在「获取模型」结果里，**无需升级插件**。
 */
const PROBE_EXTRA = [
  // 混元 hy 家族
  'hy5', 'hy5-preview', 'hy5-preview-agent', 'hy4', 'hy4-1-preview', 'hy3-preview-vision',
  'hunyuan-t1', 'hunyuan-turbos',
  // DeepSeek
  'deepseek-v5', 'deepseek-v5-pro', 'deepseek-v5-flash',
  'deepseek-v4.2', 'deepseek-v4.1', 'deepseek-v4.1-pro',
  // GLM
  'glm-6', 'glm-6-flash', 'glm-5.4', 'glm-5.4-flash', 'glm-5.4-flashx', 'glm-5v', 'glm-5v-flash',
  // MiniMax
  'minimax-m4', 'minimax-m3.1', 'minimax-m3-pro',
  // Kimi / 月之暗面
  'kimi-k4', 'kimi-k3.1', 'kimi-k3-preview', 'kimi-k2.9', 'kimi-k2.8', 'moonshot-v1-128k',
  // 阶跃 Step
  'step-6', 'step-5', 'step-5-flash', 'step-5-preview-flash',
  // 其他常见国产家族
  // 注：gpt-5 / claude-sonnet-4.5 / gemini-2.5-pro 已删除 —— 该网关只代理国产模型，
  //     这三条 2026-10-01 实测均不存在，白烧 3 次计费请求。
  //     其余海外家族一律不要再加回来（qwen/doubao/ernie 尚属国产，保留）。
  'qwen3-max', 'qwen3-coder', 'doubao-1.5-pro', 'ernie-5'
]

// ─────────────────────────────────────────────────────────────
// 探测成本控制（C3）
// ─────────────────────────────────────────────────────────────

/**
 * 会话内探测缓存 TTL（ms），键 = baseURL + 密钥指纹。
 * 30 分钟：足以覆盖「连续点几次获取模型」，又不会把上新模型藏一整天。
 * 命中缓存 → 0 网络请求。
 */
const DISCOVER_CACHE_TTL_MS = 30 * 60 * 1000

/** 连续多少个 429 就熔断整批（尊重限流，而不是盲重试把额度烧光）。 */
const DISCOVER_429_BREAKER = 3

/** 429 无 Retry-After 时的默认退避（ms）。 */
const DISCOVER_429_BACKOFF_MS = 2000

/** Retry-After 上限（ms）：防止网关回一个超大值把 UI 卡死。 */
const DISCOVER_429_MAX_WAIT_MS = 15000

/**
 * 一整轮探测的总时限（ms）。
 * 单次探测有 8s 超时，但一条被 clamp 到 15s 的退避乘上多批，累积起来仍可能好几分钟 ——
 * 用户会以为卡死，而且关掉页面也停不下来（服务端还在烧计费请求）。这里是硬预算。
 */
const DISCOVER_DEADLINE_MS = 60 * 1000

// ─────────────────────────────────────────────────────────────
// 多模态（C1）
// ─────────────────────────────────────────────────────────────

/**
 * 声明为视觉时，请求图的投影几何。
 * 与 dsh-llm-pi-ai 的默认值对齐（4M 像素 / 1MiB），两个适配器走同一套尺寸策略，
 * 切路由时不会出现「同一个附件两个尺寸」。
 */
const IMAGE_MAX_PIXELS = 2097152
const IMAGE_MAX_BYTES = 1048576

/**
 * 请求级 base64 图片总预算（20MiB，与 pi-ai 默认一致）。
 * 历史里每张图都会重新编码进每一次请求，不设上限的话长会话必然撑爆网关请求体积。
 * 超限时抛 IMAGE_OFFLOAD_REQUIRED，交给 dsh-compaction-image-offload 卸载最旧的几张。
 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** 未知模型 ID → 友好显示名（例：hy5-preview → "Hy5 Preview (混元)"）。 */
const NAME_TOKENS = {
  deepseek: 'DeepSeek', glm: 'GLM', hy: 'Hy', kimi: 'Kimi', minimax: 'MiniMax',
  moonshot: 'Moonshot', hunyuan: 'Hunyuan', qwen: 'Qwen', doubao: 'Doubao',
  ernie: 'Ernie', gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', step: 'Step',
  auto: 'Auto', v: 'V', flash: 'Flash', flashx: 'FlashX', turbo: 'Turbo',
  preview: 'Preview', agent: 'Agent', code: 'Code', pro: 'Pro', max: 'Max',
  mini: 'Mini', plus: 'Plus', pay: 'Pay', vision: 'Vision', coder: 'Coder'
}
const NAME_VENDOR = [
  [/^hy\d|^hunyuan/u, '混元'], [/^glm/u, '智谱'], [/^minimax/u, 'MiniMax'],
  [/^kimi|^moonshot/u, 'Kimi'], [/^step/u, '阶跃'], [/^deepseek/u, 'DeepSeek'],
  [/^qwen|^tongyi/u, '通义'], [/^doubao/u, '豆包'], [/^ernie/u, '文心']
]
function friendlyName(id) {
  const pretty = String(id).split('-').map((part) =>
    NAME_TOKENS[part] ?? (/^\d/u.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
  ).join(' ')
  const vendor = NAME_VENDOR.find(([re]) => re.test(id))
  return vendor ? `${pretty} (${vendor[1]})` : pretty
}

/** 设置页路由（**必须带前导斜杠**：webServer 用 URL.pathname 匹配）。 */
const SETTINGS_ROUTE = '/_dsh/dsh-codebuddy/settings'

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

/**
 * 模型声明的输入模态。
 *
 * 默认 ['text']，**必须显式给出而不是留 undefined**：宿主只在
 * `inputModalities !== undefined && !includes('image')` 时才把图片投影成文本占位
 * （dsh-llm/lib/index.js:2311）。留 undefined 等于放弃这次投影，图片会在适配器里被
 * flatten 成 "[图片]" 静默丢失。
 *
 * 反向约束同样重要：声明 image 就必须真的能发 image_url（见 mapMessage），
 * 否则宿主保留图片块、网关解不了，请求会在消息落库**之后**才失败，会话卡在无法成功的重试里。
 * 两者代价不对称，所以默认保守，只有 glm-5v-turbo 显式升级。
 *
 * @param {object|undefined} model - 配置里的模型条目
 * @returns {{inputModalities: string[]}} 可展开进 LlmModelInfo / LlmResolvedModelInfo
 */
function resolveModalities(model) {
  const declared = model?.inputModalities
  const mods = Array.isArray(declared) && declared.length ? declared : ['text']
  return { inputModalities: [...mods] }
}

/**
 * 该模型是否声明了视觉输入。
 * @param {object|undefined} model - 配置里的模型条目
 * @returns {boolean}
 */
function modelAcceptsImages(model) {
  return resolveModalities(model).inputModalities.includes('image')
}

/**
 * 请求图的目标几何：等比缩到像素预算内，并给出编码字节目标。
 * 与 dsh-llm-pi-ai 的 requestImageTarget 同构，两个适配器尺寸策略一致。
 * @param {object} ref - 持久化图片引用（含 width/height）
 * @returns {{width: number, height: number, maxBytes: number}} ImageRequestTarget
 */
function requestImageTarget(ref) {
  // 与 dsh-attachment 的 requestImageDimensions 同算法（向内取整，小图不放大）
  const maxPixels = IMAGE_MAX_PIXELS
  const scale = Math.min(1, Math.sqrt(maxPixels / (ref.width * ref.height)))
  if (scale === 1) return { width: ref.width, height: ref.height, maxBytes: IMAGE_MAX_BYTES }
  if (ref.width >= ref.height) {
    let w = Math.max(1, Math.floor(ref.width * scale))
    let h = Math.max(1, Math.round((w * ref.height) / ref.width))
    while (w * h > maxPixels && w > 1) {
      w -= 1
      h = Math.max(1, Math.round((w * ref.height) / ref.width))
    }
    return { width: w, height: h, maxBytes: IMAGE_MAX_BYTES }
  }
  let h = Math.max(1, Math.floor(ref.height * scale))
  let w = Math.max(1, Math.round((h * ref.width) / ref.height))
  while (w * h > maxPixels && h > 1) {
    h -= 1
    w = Math.max(1, Math.round((h * ref.width) / ref.height))
  }
  return { width: w, height: h, maxBytes: IMAGE_MAX_BYTES }
}

/** 按出现顺序收集未卸载的图片引用（按 attachmentId 去重）。 */
function collectImageRefs(messages, refs) {
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block?.type !== 'image') continue
      if (block.offloaded === true) continue
      refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  return refs
}

/**
 * 把历史里的图片引用解析成可发送的请求版本。
 *
 * 关键：图片在 DSH 里是**持久化引用**（ImageBlock 只带 attachmentId，不带字节），
 * 必须先经 attachments.readImageRequest() 派生出一个确定性的请求版本，
 * 拿到真实字节才能编码成 base64 发出去。
 * 没有附件服务就无法发图 —— 这正是「声明 image 却不发图」会踩的坑，所以宁可直接抛错。
 *
 * @returns {Promise<Map<string, object>>} attachmentId → 请求版本（data/mediaType/bytes）
 */
async function prepareRequestImages(messages, ctx, signal) {
  const attachments = ctx.get('attachments')
  const refs = collectImageRefs(messages, new Map())
  if (!refs.size) return new Map()
  if (typeof attachments?.readImageRequest !== 'function') {
    throw new LlmError('dsh-codebuddy: 图片输入需要附件服务（attachments.readImageRequest）', 'UNSUPPORTED_CONTENT')
  }
  const ordered = [...refs.values()]
  const prepared = []
  for (const ref of ordered) {
    prepared.push(await attachments.readImageRequest(ref, requestImageTarget(ref), signal))
  }
  const versions = new Map()
  ordered.forEach((ref, index) => versions.set(ref.attachmentId, prepared[index]))
  return versions
}

/**
 * 为一张图片解析「执行世界里的只读路径」，写进模型可见的说明文字。
 * 与 pi-ai 一致：图片旁边永远有一行文字说明它是什么、多大、在哪，
 * 这样即使模型没看懂图，也还有可读的线索（也能用文件工具再读一次）。
 */
function imageAccessText(ctx, ref) {
  try {
    const attachments = ctx.get('attachments')
    const fs = ctx.get('fs')
    if (!attachments?.imageHostPath || !fs?.processPathFromHostPath) return undefined
    return resolveImageAttachmentAccess(attachments, (hostPath) => fs.processPathFromHostPath(hostPath), ref)
  } catch {
    return undefined
  }
}

/**
 * 不传 `reasoning_effort` 时**真的不思考**的模型 → 只有这些模型提供 Off 档。
 *
 * 判据（2026-10-01 网关实测，每条重复 3 次，强触发思维的题）：
 *   不传字段 → reasoning_content 长度稳定为 0，正文照常输出。
 * 其余模型（混元 hy 系、glm-5.3 系、kimi-k2.7、kimi-k3、step-5 等）官方
 * `reasoning.canDisableThinking = false` / `onlyReasoning = true`，
 * 不传字段也会输出思维链 → 对它们提供 Off 就是**假开关**，宁可不给。
 */
const EFFORT_OFF_MODELS = new Set([
  'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash',
  'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  'minimax-m3', 'minimax-m3-pay',
  'kimi-k2.6', 'kimi-k2.5'
])

/**
 * Max 档的线上取值。
 * 官方 `reasoning.supportedEfforts` 里最高档叫 `xhigh` 的模型发 `xhigh`，其余发 `max`。
 * 两者网关都接受（实测），但发官方声明的那个才算「按契约要档位」而不是碰运气。
 */
const EFFORT_MAX_XHIGH_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.2'])

/**
 * 某模型可选的推理档位。
 *
 * 与旧实现的区别（这是 C2 的核心）：旧代码对**所有**模型都列 off/high/max，
 * 而 `OFF` 在 DeepSeek 上会让网关回 HTTP 400 code 11150
 * （"the reasoning effort value is not supported by the current model"），
 * 在高/中/低档上发 `max` 也不是官方声明的取值。
 *
 * 现在按模型给档：只有「不传字段就真的不思考」的模型才拿到 Off。
 * @param {string} modelId
 * @returns {Array<{id: string, name: string}>}
 */
function effortsForModel(modelId) {
  const efforts = []
  if (EFFORT_OFF_MODELS.has(modelId)) efforts.push({ id: ReasoningEffortId('off'), name: 'Off' })
  efforts.push({ id: ReasoningEffortId('high'), name: 'High' })
  efforts.push({ id: ReasoningEffortId(EFFORT_MAX_XHIGH_MODELS.has(modelId) ? 'xhigh' : 'max'), name: 'Max' })
  return efforts
}

/**
 * 把选中的档位翻译成线上字段。返回 undefined 表示**一个字段都不发**。
 *
 * - Off  → 不发 `reasoning_effort`（该模型的 omit 即关闭思考，实测 reasoning_content 恒为 0）
 *          注意**不能**发字面量 "off"：DeepSeek 系列会 400/11150。
 * - High → `reasoning_effort: 'high'`
 * - Max  → `reasoning_effort: 'xhigh' | 'max'`（按官方 supportedEfforts）
 *
 * @param {string|undefined} effort - 宿主传来的档位 id
 * @param {string} modelId
 * @returns {string|undefined} 要写进请求体的值
 */
function wireReasoningEffort(effort, modelId) {
  if (!effort) return undefined
  if (effort === 'off') return undefined
  if (effort === 'high') return 'high'
  // 'max' / 'xhigh' 都归到该模型官方声明的顶档
  return EFFORT_MAX_XHIGH_MODELS.has(modelId) ? 'xhigh' : 'max'
}

const apiRoot = (baseURL) => String(baseURL || DEFAULT_BASE_URL).replace(/\/+$/u, '')

/** 统一出网头：DSH 契约要求每个 provider 请求带 attributionHeaders()。 */
function wireHeaders(key) {
  return {
    ...attributionHeaders(),
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
  }
}

/** 解析 API key（凭据库 → 环境变量 → 形如 sk-/ck- 的字面量）。 */
async function resolveKey(ctx, ref) {
  if (!ref) throw new LlmError('dsh-codebuddy: 未配置 API 密钥', 'INVALID_CREDENTIAL')
  const viaCredentials = await ctx.get('credentials')?.resolve?.(ref)
  const raw = viaCredentials?.value ?? process.env[ref] ?? (/^(sk-|ck-)/.test(ref) ? ref : undefined)
  if (!raw) {
    throw new LlmError(
      `dsh-codebuddy: 无法解析凭据 "${ref}"；请在设置页填写 API 密钥，或设置同名环境变量`,
      'INVALID_CREDENTIAL'
    )
  }
  const checked = normalizeApiKey(raw)
  if (!checked.ok) throw new LlmError(`dsh-codebuddy: 凭据无效（${checked.reason}）`, 'INVALID_CREDENTIAL')
  return checked.value
}

/** HTTP 状态 → LlmError code。 */
function statusToCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

/**
 * 网关的「上下文超限」业务码。
 * 实测：prompt 超长时返回 **HTTP 400** + code 11115
 * （`prompt is too long: 1074539 tokens > 1048576 maximum`）。
 * 光看 HTTP 状态码会把它归到 INVALID_REQUEST，于是 dsh-compaction-basic 的硬门槛
 * `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()` 永远不成立，
 * 压缩永不触发 → 会话卡在一条无法成功的请求上反复重试。
 */
const GATEWAY_PROMPT_TOO_LONG_CODE = 11115

/**
 * 网关的「额度已用尽」业务码。
 * 实测：额度耗尽时返回 **HTTP 429** + `{"error":{"data":{"code":14018,"msg":"额度已用尽…"}}}`
 * （注意业务码**嵌在 error.data 里**，不在顶层 —— 只读顶层会整个漏掉）。
 *
 * 为什么必须单独识别：429 经 statusToCode 映射为 RATE_LIMIT，而 RATE_LIMIT 在
 * cordis.patch.yml 的 retryableCodes 里 = **可重试**。但额度用尽是永久失败，
 * 重试只会白等 5 次退避（约 30 秒）再报错，且错误码语义错误（用户看到「限流」而非「欠费」）。
 */
const GATEWAY_QUOTA_EXHAUSTED_CODE = 14018

/**
 * 归一网关失败：**业务码优先于 HTTP 状态码**。
 *
 * 网关错误体有两种形态，都要覆盖：
 *   顶层 `{code,msg}`（如 11102 无效模型、11115 超长）
 *   嵌套 `{error:{data:{code,msg}}}`（如 14018 额度用尽）
 *
 * @param {number} status - HTTP 状态
 * @param {string} raw - 响应体原文
 * @returns {{code: string, message?: string}} code 为归一后的 LlmError code
 */
function classifyHttpFailure(status, raw) {
  const base = statusToCode(status)
  if (!raw) return { code: base }
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  const node = parsed?.error?.data ?? parsed?.error ?? parsed
  const code = typeof node?.code === 'number' ? node.code
    : (typeof parsed?.code === 'number' ? parsed.code : undefined)
  // 文案逐层兜底，最后退回原文：纯文本响应体或只给一层嵌套时，
  // msg 一旦变成空串，下面所有正则就全失效（超限会被误判成 INVALID_REQUEST → 压缩永不触发）。
  const msg = String(
    node?.msg
    ?? node?.message
    ?? parsed?.msg
    ?? parsed?.error?.message
    ?? (typeof parsed === 'string' ? parsed : raw)
  ).slice(0, 300)
  // 额度用尽：永久失败 → 必须归 QUOTA（不在 retryableCodes 内），不能落到 RATE_LIMIT
  if (code === GATEWAY_QUOTA_EXHAUSTED_CODE
    || isQuotaExceededError(msg)
    || /额度已用尽|额度不足|余额不足/u.test(msg)) {
    return { code: 'QUOTA', message: msg || undefined }
  }
  if (status !== 400) return { code: base }
  // 真实超限：业务码命中，或消息形态命中（防网关只回文案不给 code）
  const tooLong = code === GATEWAY_PROMPT_TOO_LONG_CODE
    || isContextWindowExceededError(msg)
    || /prompt is too long/iu.test(msg)
  if (tooLong) return { code: 'CONTEXT_WINDOW_EXCEEDED', message: msg || undefined }
  return { code: base }
}

/**
 * 探测单个模型是否存在（发 1 条 max_tokens:1 的流式请求）。
 *
 * 只回 true/false/null 不够用：调用方还要区分「限流」「超时」「网络错误」，
 * 才能实现 429 熔断与成本统计，所以这里连原因一起回。
 * @returns {Promise<{verdict: boolean|null, reason: string, retryAfterMs?: number}>}
 *   verdict: true=存在 / false=不存在(11102) / null=无法判定
 *   reason:  ok | absent | rate | timeout | error
 */
async function probeModel(baseURL, key, modelId, signal) {
  // 单次探测超时：防止一条悬挂请求拖死整批（超时 → null → 进第③阶段重试）
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, PROBE_TIMEOUT_MS)
  const relay = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', relay, { once: true })
  }
  let resp
  try {
    resp = await fetch(`${apiRoot(baseURL)}/chat/completions`, {
      method: 'POST',
      headers: wireHeaders(key),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: true
      }),
      signal: ctrl.signal
    })
  } catch {
    // 用户主动取消不是「无法判定」，交给调用方按 aborted 处理
    if (signal?.aborted) return { verdict: null, reason: 'aborted' }
    return { verdict: null, reason: timedOut ? 'timeout' : 'error' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', relay)
  }

  if (resp.ok) {
    try { await resp.body?.cancel?.() } catch { /* ignore */ }
    return { verdict: true, reason: 'ok' }
  }

  // 429 必须读响应体再分类：它同时表示「限流」与「额度用尽」，语义完全相反 ——
  // 前者稍后重试有效，后者重试一万次也没用。不分清就会给用户
  // 「触发限流，建议稍后重试」，而他实际需要的是去充值。
  if (resp.status === 429) {
    const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
    const text = await resp.text().catch(() => '')
    try { await resp.body?.cancel?.() } catch { /* ignore */ }
    const exhausted = /14018/u.test(text)
      || isQuotaExceededError(text)
      || /额度已用尽|额度不足|余额不足/u.test(text)
    return exhausted
      ? { verdict: null, reason: 'quota', message: text.slice(0, 200) }
      : { verdict: null, reason: 'rate', retryAfterMs }
  }

  try {
    const parsed = JSON.parse(await resp.text())
    // 业务码可能嵌在 {error:{data:{code}}} 里（14018 就是），取码要穿透两层
    const node = parsed?.error?.data ?? parsed?.error ?? parsed
    const code = typeof node?.code === 'number' ? node.code : parsed?.code
    // 只有网关明确回 11102 才算「不存在」；其余一律「无法判定」
    return code === 11102 ? { verdict: false, reason: 'absent' } : { verdict: null, reason: 'error' }
  } catch {
    return { verdict: null, reason: 'error' }
  }
}

/**
 * 解析 Retry-After（秒数或 HTTP 日期）→ ms。
 * @returns {number|undefined} 合法正数才返回；缺失/非法一律 undefined（调用方退化到默认退避）
 */
function parseRetryAfter(raw) {
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.min(seconds * 1000, DISCOVER_429_MAX_WAIT_MS) : undefined
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  const delta = at - Date.now()
  return delta > 0 ? Math.min(delta, DISCOVER_429_MAX_WAIT_MS) : undefined
}

/**
 * 批量探测。
 *
 * 阶段：① 已知清单（PROBE_CANDIDATES，默认唯一参战方）
 *      ② 猜测候选（PROBE_EXTRA，**仅 deep=true**）
 *      ③ 对「无法判定」的 ID 重试一轮。
 * 关键：只有网关明确回 11102 才算「不存在」；429/5xx/网络抖动一律算「无法判定」，
 * 进入第③阶段重试。否则限流会静默吞掉真实模型 → 表现为「只获取到一部分」。
 *
 * 成本：每条候选都是**真实计费请求**。默认只探配置清单（22 次；含第③阶段重试最坏 44 次），
 * 深度探测才追加 PROBE_EXTRA。连续 DISCOVER_429_BREAKER 个 429 直接熔断整批并如实上报，
 * 而不是把剩下的候选全部打完（那是拿额度换「无法判定」）。
 *
 * @param {{deep?: boolean, signal?: AbortSignal}} [opts]
 * @returns {Promise<{ids: string[], stats: object}>} stats 回传 UI，让成本可见
 */
async function discoverAll(baseURL, key, opts = {}) {
  const { deep = false, signal, deadlineMs = DISCOVER_DEADLINE_MS } = opts
  // 内部 controller：把「外部取消」与「总时限到点」两条中断源合并，
  // 到点时连在飞的探测请求一起中断（否则要等它自己 8s 超时才发现超预算）。
  const ctrl = new AbortController()
  const relay = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', relay, { once: true })
  }
  const expiresAt = Date.now() + deadlineMs
  const remainingMs = () => expiresAt - Date.now()
  let deadlineHit = false
  const timer = setTimeout(() => { deadlineHit = true; ctrl.abort() }, deadlineMs)

  const found = []
  const seen = new Set()
  const unknown = []
  const absentIds = []
  const STEP = 6
  let probed = 0
  let absent = 0
  let rate = 0
  let timedOut = 0
  let errored = 0
  let rateBatches = 0
  let tripped = false
  let quota = 0
  let quotaStopped = false

  /** 探一批；返回 false 表示熔断/超时，调用方应立即收工。 */
  async function probeBatch(list, size) {
    for (let i = 0; i < list.length; i += size) {
      if (ctrl.signal.aborted) return false
      const batch = list.slice(i, i + size)
      const results = await Promise.all(batch.map((m) => probeModel(baseURL, key, m, ctrl.signal)))
      let waitMs = 0
      let batchRate = 0
      results.forEach((r, idx) => {
        const id = batch[idx]
        probed += 1
        if (r.reason === 'rate') {
          rate += 1
          batchRate += 1
          waitMs = Math.max(waitMs, r.retryAfterMs ?? 0)
        } else if (r.reason === 'quota') quota += 1
        else if (r.reason === 'timeout') timedOut += 1
        else if (r.reason === 'absent') { absent += 1; absentIds.push(id) }
        else if (r.reason === 'error') errored += 1
        if (r.verdict === true && !seen.has(id)) { seen.add(id); found.push(id) }
        else if (r.verdict === null && r.reason !== 'aborted' && r.reason !== 'rate'
          && r.reason !== 'quota' && !seen.has(id)) unknown.push(id)
      })

      // 额度用尽 → 整账号已无额度，继续探毫无意义（只会把剩余请求也撞成 429）
      if (quota > 0) { quotaStopped = true; return false }

      // 熔断判据（⚠️ 必须按「批」而不是「逐个」计数）：
      // 同一批是**并发**发出的，批内后到的 200 不代表限流已解除。
      // 因此：一批里出现 >= BREAKER 个 429，或连续 BREAKER 批都撞到 429 → 立刻收工。
      if (batchRate >= DISCOVER_429_BREAKER) { tripped = true; return false }
      if (batchRate > 0) {
        rateBatches += 1
        if (rateBatches >= DISCOVER_429_BREAKER) { tripped = true; return false }
      } else {
        rateBatches = 0
      }

      // 本批出现过限流 → 尊重 Retry-After 再继续，别把限流打成连环。
      // 退避不得超过剩余预算（否则一条 15s 的 Retry-After 就把总时限吃穿了）。
      if (batchRate > 0) {
        const wait = Math.min(waitMs > 0 ? waitMs : DISCOVER_429_BACKOFF_MS, Math.max(0, remainingMs()))
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    return true
  }

  // 候选来源：优先**配置清单**（用户在 cordis.patch.yml 里增删模型的意图必须被尊重），
  // 空配置才退回内置兜底表。若一律用兜底表，用户从配置里删掉的模型会被探测重新加回目录。
  const candidates = Array.isArray(opts.candidates) && opts.candidates.length
    ? opts.candidates
    : PROBE_CANDIDATES
  // 深度探测的猜测清单要去掉与候选重复的 id，避免同一个模型被探两次（双倍计费）
  const lists = deep
    ? [candidates, PROBE_EXTRA.filter((id) => !candidates.includes(id))]
    : [candidates]
  for (const list of lists) {
    if (!await probeBatch(list, STEP)) break
  }

  // 第③阶段：把「没探明白」的重试一轮（并发降到 3，避免再次撞限流）。
  // 额度用尽 / 已到总时限 / 预算不够再跑一批 → 都不重试。
  if (!tripped && !quotaStopped && !ctrl.signal.aborted && unknown.length && remainingMs() > 1000) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(800, Math.max(0, remainingMs()))))
    await probeBatch(unknown, 3)
  }

  clearTimeout(timer)
  signal?.removeEventListener?.('abort', relay)

  return {
    ids: found,
    stats: {
      probed,
      hit: found.length,
      absent,
      absentIds,
      rate,
      quota,
      timeout: timedOut,
      error: errored,
      deep,
      // aborted 只表示**外部取消**（用户点了取消）；总时限到点是单独的 deadlineHit
      aborted: Boolean(signal?.aborted),
      throttleStopped: tripped,
      quotaStopped,
      deadlineHit
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────

/**
 * 从响应体产出 data 帧。
 * 支持 LF 与 CRLF；流结束后 flush 残余缓冲区。
 */
async function* sseFrames(resp) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 归一 CRLF，避免 \r\n\r\n 永不切帧
      buffer = buffer.replace(/\r\n/g, '\n')
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) yield part
    }
    if (buffer.trim()) yield buffer
  } finally {
    // 主动断流：中途抛错（截断守卫 / 带内错误 / 空响应）时若不 cancel，
    // 未消费的响应体与连接会留到服务端空闲超时才回收；重试最多 5 次 → 同时挂住多条 socket。
    try { await reader.cancel?.() } catch { /* ignore */ }
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

/** 解析一帧里的 data 负载（多行 data: 按 SSE 规范拼接）。 */
function framePayload(frame) {
  const datas = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) datas.push(line.slice(5).trimStart())
  }
  if (!datas.length) return null
  return datas.join('\n')
}

// ─────────────────────────────────────────────────────────────
// 适配器
// ─────────────────────────────────────────────────────────────

class CodeBuddyAdapter extends LlmAdapter {
  constructor(options) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return { id: provider, name: 'CodeBuddy (unofficial)' }
  }

  providerRetryPolicy() {
    return this.options.retryPolicy()
  }

  /**
   * 目录条目（供 GUI 模型选择器）。
   * 只含 LlmModelInfo 允许的字段。
   *
   * ⚠️ 这个方法是 GUI 模型选择器的**唯一来源**（dsh-llm/lib/index.js:1700-1702：
   * catalog 是 advisory，选择器只认 listModels()）。所以 inputModalities 必须在这里出现，
   * 否则选择器不知道哪些模型能看图。
   */
  listModels() {
    return Promise.resolve(this.options.models().map((m) => ({
      provider: this.options.provider,
      id: m.id,
      name: m.name ?? m.id,
      ...resolveModalities(m)
    })))
  }

  /**
   * 模型元数据。
   * 契约：context.contextWindow（正整数），defaultMaxTokens 可选。
   *
   * ⚠️ inputModalities 缺省（undefined）会让宿主**跳过图片投影**
   * （dsh-llm/lib/index.js:2311 要求该字段已定义且不含 image 才投影），
   * 图片块于是直接落到适配器的 flatten()，变成字符串 "[图片]" **静默丢失**。
   * 所以这里必须显式声明 ['text']，让宿主走正规的文本投影，
   * 生成带 sha256 标识的占位；声明了 image 的模型则保留图片并真的发出去。
   */
  resolveModel(provider, model) {
    const found = this.options.models().find((m) => m.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name ?? model,
      context: { contextWindow: found?.contextWindow ?? 131072 },
      defaultMaxTokens: found?.maxTokens ?? 8192,
      ...resolveModalities(found),
      // 档位按模型给：不支持 Off 的模型不列 Off（否则宿主会把它当合法档位发给网关 → 400/11150）
      reasoning: { efforts: effortsForModel(model) }
    })
  }

  /** 流式调用。 */
  async * stream(options) {
    const cfg = this.options.current()
    const key = await resolveKey(this.options.ctx, cfg.apiKeyEnv)
    const model = cfg.models.find((m) => m.id === options.model)

    // 图片只在模型声明了 image 时才解析；文本模型这里直接返回空表，
    // 因为宿主已按 inputModalities 把图片投影成占位文字了。
    let requestImages = new Map()
    if (modelAcceptsImages(model)) {
      requestImages = await prepareRequestImages(options.messages ?? [], this.options.ctx, options.signal)
      // 超量兜底：历史里每张图都会重编码进每一次请求，不设上限迟早撑爆网关请求体积。
      // 抛 IMAGE_OFFLOAD_REQUIRED 让上层卸载最旧的几张，而不是让请求无解地失败。
      // 用**请求版本**的真实字节数计量（与 pi-ai 一致），不用源图字节。
      if (requestImages.size) {
        const offloadCount = requiredImageOffload(
          options.messages ?? [],
          { representation: 'base64', maxBytes: MAX_REQUEST_IMAGE_BYTES },
          (block) => requestImages.get(block.attachment.attachmentId)?.bytes ?? 0
        )
        if (offloadCount > 0) {
          throw new LlmError(
            `dsh-codebuddy: 请求图片超过 ${MAX_REQUEST_IMAGE_BYTES} 字节上限，需再卸载 ${offloadCount} 张最旧的图片`,
            IMAGE_OFFLOAD_REQUIRED_CODE,
            { offloadImages: offloadCount }
          )
        }
      }
    }

    const body = this.buildBody(options, requestImages, this.options.ctx)

    let resp
    try {
      resp = await fetch(`${apiRoot(cfg.baseURL)}/chat/completions`, {
        method: 'POST',
        headers: wireHeaders(key),
        body: JSON.stringify(body),
        signal: options.signal
      })
    } catch (error) {
      throw new LlmError(`dsh-codebuddy: 请求失败（${error?.message ?? error}）`, 'TRANSPORT', { cause: error })
    }

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '')
      // 真实超限是 HTTP 400 + code 11115 → 必须归一成 CONTEXT_WINDOW_EXCEEDED，
      // 否则压缩器（硬门槛只认这个 code）永远不会介入。
      const classified = classifyHttpFailure(resp.status, raw)
      throw new LlmError(
        `dsh-codebuddy: 网关返回 ${resp.status}${raw ? ` — ${raw.slice(0, 300)}` : ''}`,
        classified.code,
        {
          status: resp.status,
          ...(resp.headers.get('x-request-id') ? { requestId: resp.headers.get('x-request-id') } : {})
        }
      )
    }

    yield* this.parseStream(resp, options)
  }

  /**
   * 组装请求体。
   * @param {object} options - GenerateOptions
   * @param {Map<string, object>} [requestImages] - attachmentId → 请求版本（仅有图时非空）
   * @param {object} [ctx] - 用于解析图片只读路径（可选）
   */
  buildBody(options, requestImages = new Map(), ctx) {
    const messages = []

    // DSH 的系统提示词字段是 `system`（非 systemPrompt）
    if (options.system) messages.push({ role: 'system', content: options.system })

    for (const msg of options.messages ?? []) {
      const mapped = this.mapMessage(msg, requestImages, ctx)
      if (mapped) messages.push(mapped)
    }

    const body = {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }

    if (options.maxTokens || options.defaultMaxTokens) {
      body.max_tokens = options.maxTokens ?? options.defaultMaxTokens
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop?.length) body.stop = options.stop

    // 工具 schema 字段是 `parameters`（非 inputSchema）
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} }
        }
      }))
    }

    // 推理档位：由 wireReasoningEffort 翻译成线上取值。
    // Off = 不传字段（DeepSeek 收到字面量 "off" 会 400/11150，所以不能用 "off"）。
    const wireEffort = wireReasoningEffort(options.reasoningEffort, options.model)
    if (wireEffort) body.reasoning_effort = wireEffort

    return body
  }

  /**
   * 单条消息映射。
   *
   * 关键（对齐 ContentBlockType 词表）：
   *   - assistant 的块类型是 'tool-call'（连字符）
   *   - 推理是内容块 {type:'reasoning'}，不是顶层字段
   *   - developer 角色降级为 system（网关不认 developer；框架通常已剥离，此为兜底）
   *
   * @param {object} msg - RequestMessage
   * @param {Map<string, object>} [requestImages] - attachmentId → 请求版本
   * @param {object} [ctx] - 用于解析图片只读路径
   */
  mapMessage(msg, requestImages = new Map(), ctx) {
    const role = msg.role

    if (role === 'system') return { role: 'system', content: this.flatten(msg.content) }
    if (role === 'developer') return { role: 'system', content: this.flatten(msg.content) }
    // user 可能是多模态：含图片时保留结构化数组，其余一律走纯文本
    if (role === 'user') return { role: 'user', content: this.userContent(msg.content, requestImages, ctx) }

    if (role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      const reasoning = blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text).join('')
      const calls = blocks.filter((b) => b?.type === 'tool-call')

      const out = {
        role: 'assistant',
        content: text || (calls.length ? null : '')
      }
      // 多轮必须回传推理内容（原补丁 5 的等价物）
      if (reasoning) out.reasoning_content = reasoning
      if (calls.length) {
        out.tool_calls = calls.map((c) => ({
          id: String(c.id),
          type: 'function',
          function: {
            name: c.name,
            // 契约：arguments 已是 JSON 字符串
            arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})
          }
        }))
      }
      return out
    }

    if (role === 'tool' || role === 'toolResult') {
      return {
        role: 'tool',
        tool_call_id: String(msg.toolCallId ?? msg.id ?? ''),
        content: this.flatten(msg.content)
      }
    }

    return null
  }

  /**
   * user 内容映射：有图发结构化块，无图仍发纯字符串。
   *
   * 图片块的真实线上形态（2026-10-01 对网关实测确认）：
   *   { type:'image_url', image_url:{ url:'data:<mime>;base64,<...>' } }
   * 必须用 **对象** 形态 —— 直接给字符串网关会回
   *   11101 "cannot unmarshal string into Go value of type v2.ImageContent"。
   *
   * 每张图前面会插一行 requestImageHandleText：说明它是什么、请求版本多大、只读副本在哪。
   * 这既是模型的可读线索，也让「图没看懂」时还有退路（能用文件工具再读一次）。
   */
  userContent(content, requestImages, ctx) {
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) return this.flatten(content)
    if (!requestImages.size) return this.flatten(content)

    const blocks = []
    for (const block of content) {
      if (block?.type === 'text') {
        if (block.text) blocks.push({ type: 'text', text: block.text })
        continue
      }
      if (block?.type !== 'image') continue
      // 已卸载的图片：宿主本应投影成占位文字；兜底不发字节
      if (block.offloaded === true) continue
      const version = requestImages.get(block.attachment.attachmentId)
      if (!version) continue
      blocks.push({
        type: 'text',
        text: requestImageHandleText(block.attachment, version, imageAccessText(ctx, block.attachment))
      })
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` }
      })
    }
    // 全被过滤掉时退回文本，避免发出空 content
    return blocks.length ? blocks : this.flatten(content)
  }

  /** 内容降级为纯文本。 */
  flatten(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[图片]' : b?.type === 'file' ? '[文件]' : ''))
      .filter(Boolean)
      .join('\n')
  }

  /**
   * 解析 SSE → StreamChunk。
   *
   * 契约要点：
   *   - 每个块 start/end 成对，各自独立 index
   *   - text 与 reasoning **不得共用 index**（否则思维链混进正文）
   *   - tool-call-delta 必须带 id
   *   - block-end 必须带装配好的 block
   *   - finish 用 reason:（非 finish:）
   */
  async * parseStream(resp, options) {
    // index 分配：text / reasoning / 每个 tool-call 各占一个
    let nextIndex = 0
    let textIndex = -1
    let reasoningIndex = -1
    let textContent = ''
    let reasoningText = ''
    const toolSlots = new Map() // 网关的 tool_calls[].index → { index, id, name, args }
    const blocks = [] // 已完成块（供 block-end 回传）

    let usage = null
    let finishKind = 'stop'
    // 流是否正常收尾：收到 [DONE] 或任一 finish_reason 才算。未收尾 = 被截断。
    let sawTerminal = false

    for await (const frame of sseFrames(resp)) {
      const payload = framePayload(frame)
      if (payload === '[DONE]') { sawTerminal = true; continue }
      if (!payload) continue

      let json
      try { json = JSON.parse(payload) } catch { continue }

      // 网关带内错误（HTTP 200 + 错误帧）
      if (json.error || (typeof json.code === 'number' && json.code !== 0 && !json.choices)) {
        // 错误体可能有三种形态：{error:{data:{code,msg}}} / {error:{...}} / 顶层 {code,msg}
        const errNode = typeof json.error === 'object' && json.error !== null ? (json.error.data ?? json.error) : undefined
        const code = typeof errNode?.code === 'number' ? errNode.code : json.code
        const msg = errNode?.msg
          ?? (typeof json.error === 'string' ? json.error : undefined)
          ?? json.error?.message
          ?? json.msg
          ?? `网关错误 code=${json.code}`
        // 与 HTTP 路径共用同一个分类器，保证两条通路的错误码同源。
        // 兜底不再是 SERVER —— 带内错误帧携带的是业务码，落 SERVER 会被当成可重试
        // （白等 5 次退避），与 HTTP 400 路径给出 INVALID_REQUEST 的语义不一致。
        const kind = classifyHttpFailure(400, payload).code
        throw new LlmError(`dsh-codebuddy: ${msg}`, kind)
      }

      if (json.usage && (Number.isFinite(json.usage.prompt_tokens)
        || Number.isFinite(json.usage.completion_tokens)
        || Number.isFinite(json.usage.total_tokens))) {
        usage = json.usage
      }

      const choice = json.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) {
        sawTerminal = true
        finishKind = choice.finish_reason === 'length' ? 'max-tokens'
          : choice.finish_reason === 'tool_calls' ? 'tool-calls'
            : 'stop'
      }

      const delta = choice.delta
      if (!delta) continue

      // 推理增量 → 独立块
      if (delta.reasoning_content) {
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoningText += delta.reasoning_content
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
      }

      // 正文增量 → 独立块
      if (delta.content) {
        if (textIndex < 0) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textContent += delta.content
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }

      // 工具调用增量
      for (const call of delta.tool_calls ?? []) {
        const slotKey = call.index ?? 0
        let slot = toolSlots.get(slotKey)
        if (!slot) {
          slot = {
            index: nextIndex++,
            id: String(call.id ?? `call_${slotKey}`),
            name: call.function?.name ?? '',
            args: '',
            started: false
          }
          toolSlots.set(slotKey, slot)
        }
        if (call.id) slot.id = String(call.id)
        if (call.function?.name) slot.name = call.function.name
        const chunkArgs = call.function?.arguments ?? ''
        if (!slot.started) {
          slot.started = true
          yield {
            type: 'block-start',
            index: slot.index,
            blockType: 'tool-call'
          }
          yield {
            type: 'tool-call-delta',
            index: slot.index,
            id: slot.id,
            name: slot.name,
            argumentsDelta: chunkArgs
          }
        } else if (chunkArgs) {
          yield {
            type: 'tool-call-delta',
            index: slot.index,
            id: slot.id,
            argumentsDelta: chunkArgs
          }
        }
        slot.args += chunkArgs
      }
    }

    // 收尾：按 index 顺序闭合各块。
    // 流完整性守卫：既没有 [DONE] 也没有 finish_reason → 连接被截断
    // （代理 idle 断流 / 网关重启 / TCP RST）。此时正文可能是半句话、
    // tool-call 参数可能是半截 JSON，按正常结束提交会污染会话与工具调用，
    // 因此归一成可重试的 TRANSPORT，交给 retryPolicy 重试。
    if (!sawTerminal) {
      throw new LlmError('dsh-codebuddy: 响应流被截断（未收到 [DONE] 或 finish_reason）', 'TRANSPORT')
    }

    // ⚠️ block-end 的 block 必须是【已累积的完整内容】——
    //    BlockAssembler 见到 block 会直接返回它，不再拼接 delta。
    const closers = []
    if (reasoningIndex >= 0) {
      closers.push({ index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } })
    }
    if (textIndex >= 0) {
      closers.push({ index: textIndex, block: { type: 'text', text: textContent } })
    }
    for (const slot of toolSlots.values()) {
      closers.push({
        index: slot.index,
        block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args }
      })
    }
    closers.sort((a, b) => a.index - b.index)
    for (const c of closers) yield { type: 'block-end', index: c.index, block: c.block }

    // 空响应守卫：一个块都没产出且非工具调用 → 让 patch 的 EMPTY_RESPONSE 重试生效
    if (closers.length === 0 && finishKind === 'stop') {
      throw new LlmError('dsh-codebuddy: 网关返回空响应（无任何内容块）', 'EMPTY_RESPONSE')
    }

    // usage（计数互斥：cached 从 prompt 总数里扣除）
    // 只在至少有一个真实数值计数时才上报：网关可能回空对象 {}，
    // 那会把真实用量覆盖成 0 —— 统计显示 0 比不显示更糟。
    if (usage && (Number.isFinite(usage.prompt_tokens)
      || Number.isFinite(usage.completion_tokens)
      || Number.isFinite(usage.total_tokens))) {
      const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
      const out = usage.completion_tokens ?? 0
      // 优先采信网关给的 total；缺 prompt 时用 total-completion 反推，避免把「缺字段」当成 0
      const total = Number.isFinite(usage.total_tokens) ? usage.total_tokens : undefined
      const prompt = Number.isFinite(usage.prompt_tokens)
        ? usage.prompt_tokens
        : (total !== undefined ? Math.max(0, total - out) : 0)
      const uncached = Math.max(0, prompt - cached)
      const payloadUsage = {
        inputTokens: uncached,
        outputTokens: out,
        totalTokens: total ?? (prompt + out)
      }
      if (cached > 0) payloadUsage.cacheReadTokens = cached
      yield { type: 'usage', usage: payloadUsage }
    }

    yield { type: 'finish', reason: { kind: finishKind } }
  }
}

// ─────────────────────────────────────────────────────────────
// 设置页后端
// ─────────────────────────────────────────────────────────────

const okEnvelope = (value) => ({ ok: true, value })
const failEnvelope = (code, message) => ({ ok: false, error: { code, message } })

/**
 * 会话内探测缓存：键 = baseURL + 密钥指纹。
 * 重复点「获取模型」→ 0 请求（成本可见、可预期）。
 * 进程重启即失效，不落盘（密钥指纹不该留在磁盘上）。
 */
const discoverCache = new Map()

/** 密钥指纹：只用于做缓存键，不泄露密钥本身（sha256 前 16 位）。 */
function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
}

/** 探测缓存键：baseURL + 密钥指纹（+ 深度标记）。 */
function discoverCacheKey(baseURL, key, deep) {
  return `${baseURL}|${keyFingerprint(key)}${deep ? '|deep' : ''}`
}

/**
 * 本次会话「探测命中」的模型（id → 元数据）。
 *
 * 为什么必须单独存：GUI 模型选择器**只认 adapter.listModels()**
 * （dsh-llm/lib/index.js:1700-1702：catalog 是 advisory，选择器不查发现结果）。
 * 只把探测结果回给设置页 = 用户看得到却选不到，网关上新增的模型永远用不上；
 * 反之已下线的模型仍留在静态清单里，选中就 400。
 * 因此每次探测成功后登记命中项，由 listModels() 合并进目录。
 *
 * 生命周期与 discoverCache 相同（进程重启即失效）。跨会话持久化需要给本条目
 * 加 Config schema 走 DSH settings 命名空间，属后续改动。
 */
const discoveredModels = new Map()

/** 登记一次探测命中的模型，供 listModels() 合并。 */
function rememberDiscovered(ids, known) {
  for (const id of ids) {
    const hit = known?.get?.(id)
    discoveredModels.set(id, {
      id,
      name: hit?.name ?? friendlyName(id),
      contextWindow: hit?.contextWindow ?? 131072,
      maxTokens: hit?.maxTokens ?? 8192,
      ...(Array.isArray(hit?.inputModalities) && hit.inputModalities.length
        ? { inputModalities: [...hit.inputModalities] }
        : {})
    })
  }
}

/**
 * 本次会话「确认不存在」的模型 id（网关明确回 11102）。
 *
 * 只加不减是不够的：模型下线后探测会正确地不返回它，但静态清单里仍留着，
 * 用户选中就 400。因此一次**干净完成**的探测会整体替换本集合，由 mergeModels 剔除。
 * 只认干净结果：半途取消或撞限流熔断的部分结果不能当权威，否则会误删可用模型。
 */
let absentModels = new Set()

/**
 * 当前目录结论所属的作用域（`baseURL|密钥指纹`）。
 *
 * discoveredModels / absentModels 只有 id 维、全局共享，若不跟踪作用域：
 * 换端点或换密钥后，旧端点的「命中」会被并进新端点的目录（选中即 400），
 * 旧端点的「下线」会误删新端点的模型。作用域一变就整体清空重来。
 */
let discoveryScope = null

/** 清空目录结论并记下新作用域。 */
function resetDiscoveryScope(scope) {
  discoveryScope = scope
  discoveredModels.clear()
  rememberAbsent([])
}

/** 用一次干净探测的「确认不存在」结果整体替换集合（不是累加）。 */
function rememberAbsent(ids) {
  absentModels = new Set(Array.isArray(ids) ? ids : [])
}

/**
 * 合并「配置清单」与「本次会话探测命中」的模型，并剔除已确认下线的。
 * 配置清单在前（顺序稳定、用户可控），探测新增的追加在后；同 id 以配置清单为准。
 */
function mergeModels(configured) {
  const base = Array.isArray(configured) ? configured : []
  const seen = new Set()
  const out = []
  for (const m of base) {
    if (!m?.id || seen.has(m.id) || absentModels.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  for (const m of discoveredModels.values()) {
    if (seen.has(m.id) || absentModels.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    // 体积上限：设置页只提交几百字节的 JSON，超过就是异常输入（防内存放大）
    if (total > 64 * 1024) throw new LlmError('dsh-codebuddy: 请求体过大（上限 64KB）', 'INVALID_REQUEST')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function settingsBackend(ctx, getConfig) {
  /** 保存密钥到凭据库（不写明文到配置文件）。 */
  async function storeKey(ref, value) {
    const credentials = ctx.get('credentials')
    // 宿主凭据服务只有 set / unset / resolve / describe 等方法，没有 write（旧代码里的
    // `credentials?.write` 是死分支，永远不会命中）。
    if (credentials?.set) return void await credentials.set(ref, value)
    process.env[ref] = value // 退化：仅本次会话有效（UI 会明确标注）
  }

  async function hasKey(ref) {
    try { if ((await ctx.get('credentials')?.resolve?.(ref))?.value) return true } catch { /* ignore */ }
    return Boolean(process.env[ref])
  }

  async function handle(req, res) {
    try {
      if (!req.method || req.method === 'GET') {
        const cfg = getConfig()
        return sendJson(res, 200, okEnvelope({
          provider: cfg.provider,
          baseURL: cfg.baseURL,
          models: cfg.models,
          hasKey: await hasKey(cfg.apiKeyEnv)
        }))
      }

      // ── 写操作同源围栏（三道独立检查）──
      // 本路由挂在 webServer 上，而 webServer **没有鉴权层**：精确路由直接进 handler
      // （实测无凭据 GET 本路由 200，而 GET / 是 401）。因此浏览器侧只能靠同源校验：
      //   ① Content-Type 必须是 application/json —— 它不是 CORS「简单请求」类型，
      //      跨站调用被迫走预检，而本路由从不回 Access-Control-Allow-Origin → 被浏览器拦下；
      //   ② 带 Origin 时，其 host 必须与 Host 一致 —— 覆盖 DNS rebinding 等绕过预检的场景；
      //   ③ Sec-Fetch-Site 必须同源 —— 这一条才拦得住沙箱 iframe 发出的 `Origin: null`。
      // 比较用「同源」而非「localhost」，否则经 dsh-pocket（局域网/隧道）打开的设置页会被误杀。
      // ① Host 必须是回环名 —— 这一道专门挡 DNS rebinding：
      //    攻击页把自己的域名解析到 127.0.0.1 时，Origin 与 Host **都是该域名**，
      //    只比较「Origin.host === Host」是拦不住的，必须限定 Host 本身。
      const hostHeader = String(req.headers.host ?? '')
      const hostName = hostHeader.startsWith('[')
        ? hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase()
        : hostHeader.split(':')[0].toLowerCase()
      if (!new Set(['localhost', '127.0.0.1', '[::1]', '::1']).has(hostName)) {
        return sendJson(res, 403, failEnvelope('bad-host', `拒绝非回环来源的写入（host: ${hostHeader}）`))
      }
      const ctype = String(req.headers['content-type'] ?? '')
      if (!ctype.toLowerCase().includes('application/json')) {
        return sendJson(res, 415, failEnvelope('unsupported-media-type', '设置接口只接受 application/json'))
      }
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.trim() !== '') {
        if (origin.trim().toLowerCase() === 'null') {
          return sendJson(res, 403, failEnvelope('null-origin', '拒绝来自沙箱/不透明来源的写入（Origin: null）'))
        }
        let originHost
        try { originHost = new URL(origin).host } catch { originHost = undefined }
        if (originHost !== undefined && originHost !== req.headers.host) {
          return sendJson(res, 403, failEnvelope('cross-origin', `拒绝跨站写入（origin ${originHost} ≠ host ${req.headers.host}）`))
        }
      }
      const site = req.headers['sec-fetch-site']
      if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
        return sendJson(res, 403, failEnvelope('cross-site', `拒绝跨站写入（sec-fetch-site: ${site}）`))
      }

      // 请求生命周期派生的取消信号：用户关页面/点取消 → 立刻停止后续计费探测。
      // （此前 discover 拿不到任何 signal，「取消」只在客户端停了进度条，服务端照打 22 次。）
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      const reqSignal = ac.signal

      const body = await readJsonBody(req)
      const cfg = getConfig()

      if (body.action === 'set-key') {
        const value = String(body.apiKey ?? '').trim()
        if (!value) return sendJson(res, 400, failEnvelope('empty', '密钥为空'))
        await storeKey(cfg.apiKeyEnv, value)
        // 换了密钥 → 缓存里的探测结果不再可信
        discoverCache.clear()
        return sendJson(res, 200, okEnvelope({ saved: true }))
      }

      // 删除密钥：此前无删除路径，填错了只能去改凭据文件
      if (body.action === 'clear-key') {
        let attempted = false
        try {
          const credentials = ctx.get('credentials')
          if (credentials?.unset) { await credentials.unset(cfg.apiKeyEnv); attempted = true }
        } catch { /* 凭据库不可用则退化到环境变量 */ }
        if (process.env[cfg.apiKeyEnv]) { delete process.env[cfg.apiKeyEnv]; attempted = true }
        resetDiscoveryScope(null)
        discoverCache.clear()
        // ⚠️ 必须复验：CODEBUDDY_API_KEY 可能来自 ~/.dsh/.env 这类**只读来源**，
        //    unset 在这种情形下要么 reject、要么删了也会被只读来源「复活」。
        //    不复验就会回「✅ 已删除」而实际值还在 —— 重启后密钥复活、界面与实际相反。
        const stillThere = await hasKey(cfg.apiKeyEnv)
        if (stillThere) {
          return sendJson(res, 200, okEnvelope({
            cleared: false,
            message: '⚠️ 未能删除：该密钥由只读来源（如 ~/.dsh/.env）提供，'
              + '请在对应文件中移除后重启 DSH；设置页只能清除凭据库里的值'
          }))
        }
        return sendJson(res, 200, okEnvelope({
          cleared: attempted,
          message: attempted ? '✅ 密钥已删除' : '未找到已保存的密钥'
        }))
      }

      if (body.action === 'test') {
        // 草稿密钥的边界与 discover 一致：只接受字面量，绝不把任意串当环境变量名解析
        const draftTest = String(body.apiKey ?? '').trim()
        if (draftTest && !/^(sk-|ck-)/u.test(draftTest)) {
          return sendJson(res, 400, failEnvelope('bad-draft-key',
            '草稿密钥必须是 sk-/ck- 开头的字面量；环境变量名请先保存到凭据库'))
        }
        let key
        try { key = await resolveKey(ctx, draftTest || cfg.apiKeyEnv) } catch (error) {
          return sendJson(res, 200, okEnvelope({
            ok: false,
            message: '❌ ' + (draftTest ? '草稿密钥无效或无法解析' : (error?.message ?? error))
          }))
        }
        try {
          // 超时守卫：设置页点「测试连接」不能因为一条悬挂请求永远转圈
          const resp = await fetch(`${apiRoot(cfg.baseURL)}/chat/completions`, {
            method: 'POST',
            headers: wireHeaders(key),
            body: JSON.stringify({
              model: cfg.models?.[0]?.id ?? 'auto',
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: true
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
          })
          if (resp.ok) {
            try { await resp.body?.cancel?.() } catch { /* ignore */ }
            return sendJson(res, 200, okEnvelope({ ok: true, message: '✅ 连接成功，密钥有效' }))
          }
          const text = await resp.text().catch(() => '')
          // 用与对话路径同一个分类器，把已知语义翻成人话；
          // 直接把网关 JSON 甩给用户既难读、也让「欠费」看起来像「限流」。
          const cls = classifyHttpFailure(resp.status, text)
          const HINT = {
            QUOTA: '⛔ 额度已用尽 —— 请到 codebuddy.cn 充值或购买加量包；密钥本身是有效的。',
            AUTH: '❌ 密钥无效或已过期，请在下方重新填写。',
            RATE_LIMIT: '⚠️ 触发限流 —— 稍后重试即可。',
            CONTEXT_WINDOW_EXCEEDED: '⚠️ 上下文超出上限。',
            SERVER: '⚠️ 网关侧异常（5xx）—— 稍后重试。'
          }
          return sendJson(res, 200, okEnvelope({
            ok: false,
            message: (HINT[cls.code] ?? `❌ 网关返回 ${resp.status}`)
              + (cls.message ? `　（网关原文：${String(cls.message).slice(0, 120)}）` : '')
          }))
        } catch (error) {
          return sendJson(res, 200, okEnvelope({ ok: false, message: '❌ 网络错误：' + (error?.message ?? error) }))
        }
      }

      if (body.action === 'discover') {
        // ── 草稿输入的边界（安全关键，勿放宽）──
        // apiKey 只接受**字面量密钥**（sk-/ck- 开头）。绝不接受任意字符串：
        //   resolveKey 会把 ref 当环境变量名解析（process.env[ref]），
        //   若直接采信 body.apiKey，`{"apiKey":"DEEPSEEK_API_KEY","baseURL":"https://evil.tld"}`
        //   就能把 .env 里任意一条凭据以 Bearer 发到攻击者主机（凭据外发 + SSRF）。
        const draftKey = String(body.apiKey ?? '').trim()
        if (draftKey && !/^(sk-|ck-)/u.test(draftKey)) {
          return sendJson(res, 400, failEnvelope('bad-draft-key',
            '草稿密钥必须是 sk-/ck- 开头的字面量；环境变量名请先在设置页保存到凭据库'))
        }
        // baseURL 只允许 https，且主机必须与当前生效端点一致（防把密钥改道外发）。
        let baseURL = cfg.baseURL
        const draftURL = String(body.baseURL ?? '').trim()
        if (draftURL && draftURL !== cfg.baseURL) {
          let u
          let configured
          try { u = new URL(draftURL); configured = new URL(cfg.baseURL) } catch {
            return sendJson(res, 400, failEnvelope('bad-url', '接口地址必须是合法的 URL'))
          }
          if (u.protocol !== 'https:') {
            return sendJson(res, 400, failEnvelope('insecure-url', '接口地址必须是 https（明文会把密钥裸发）'))
          }
          if (u.host !== configured.host) {
            return sendJson(res, 400, failEnvelope('foreign-host',
              '草稿地址的主机必须与已配置端点一致（' + configured.host + '）'))
          }
          baseURL = draftURL
        }

        let key
        try {
          // ⚠️ 两条分支都必须 await：resolveKey 是 async，漏掉 await 会得到 Promise，
          //    进而发出 "Bearer [object Promise]" 并把缓存键塌陷成同一个槽。
          key = await resolveKey(ctx, draftKey || cfg.apiKeyEnv)
        } catch (error) {
          // 草稿路径的 ref 就是密钥原文 —— 禁止回显
          return sendJson(res, 400, failEnvelope('no-key',
            draftKey ? '草稿密钥无效或无法解析' : (error?.message ?? String(error))))
        }

        // 端点或密钥变了 → 上一轮的目录结论不再适用（否则旧端点的模型会被并进新端点）
        const scope = discoverCacheKey(baseURL, key, false)
        if (scope !== discoveryScope) resetDiscoveryScope(scope)

        const deep = body.deep === true
        const known = new Map([...FALLBACK_MODELS, ...(cfg.models ?? [])].map((m) => [m.id, m]))

        // 缓存命中 → 0 请求。deep 探测单独缓存，避免「浅探测结果」冒充「深探测结果」。
        const keyOf = discoverCacheKey(baseURL, key, deep)
        const cachedEntry = discoverCache.get(keyOf)
        if (cachedEntry && Date.now() - cachedEntry.at <= DISCOVER_CACHE_TTL_MS) {
          // 缓存命中也照常应用命中项（同一作用域内依然权威）；
          // 但**不**重新写 absent —— 旧快照的「下线」结论可能已被更新的探测推翻，
          // 覆盖回去会把刚被证明可用的模型重新藏起来。
          rememberDiscovered(cachedEntry.ids, known)
          return sendJson(res, 200, okEnvelope({
            models: cachedEntry.ids.map((id) => known.get(id) ?? {
              id, name: friendlyName(id), contextWindow: 131072, maxTokens: 8192
            }),
            stats: { ...cachedEntry.stats, cached: true, ageMs: Date.now() - cachedEntry.at },
            cacheTtlMs: DISCOVER_CACHE_TTL_MS,
            baseURL
          }))
        }

        const { ids, stats } = await discoverAll(baseURL, key, {
          deep, signal: reqSignal, candidates: candidateIds(cfg)
        })
        // 不写缓存的情形：被取消 / 撞限流熔断 / 额度用尽 / 到总时限 / **一条有效判定都没有**
        // （全超时或全 401）。最后一条很关键：否则一次网络抖动会把「0 个模型」固化 30 分钟。
        const clean = !stats.aborted && !stats.throttleStopped && !stats.quotaStopped
          && !stats.deadlineHit && (stats.hit + stats.absent > 0)
        if (clean) {
          discoverCache.set(keyOf, { at: Date.now(), ids, absentIds: stats.absentIds, stats })
        }
        // 命中项登记进目录 → GUI 选择器立刻可选（这是「探测结果真正生效」的关键一步）
        rememberDiscovered(ids, known)
        // 只有干净探测才敢剔除「确认下线」的，避免把限流/超时误判成下线而误删可用模型
        if (clean) rememberAbsent(stats.absentIds)
        return sendJson(res, 200, okEnvelope({
          models: ids.map((id) => known.get(id) ?? {
            id, name: friendlyName(id), contextWindow: 131072, maxTokens: 8192
          }),
          stats: { ...stats, cached: false },
          cacheTtlMs: DISCOVER_CACHE_TTL_MS,
          note: deep
            ? `深度探测：已发送 ${stats.probed} 次计费请求（含猜测候选）`
            : `常规探测：已发送 ${stats.probed} 次计费请求（仅已知清单；勾选「深度探测」可尝试猜测新模型）`
        }))
      }

      if (body.action === 'discover-cache-clear') {
        const removed = discoverCache.size
        discoverCache.clear()
        return sendJson(res, 200, okEnvelope({ cleared: removed }))
      }

      // 端点只能改配置：本插件没有 Config schema，落库无处可写。
      // 曾经这里回 200 + "已保存"，而客户端据此弹「✅ 端点已保存」—— 点了其实什么都没发生。
      // 现在如实拒绝，UI 也已把地址框改为只读展示。
      if (body.action === 'set-base-url') {
        return sendJson(res, 400, failEnvelope('readonly',
          '端点不支持在设置页修改：请编辑 cordis.patch.yml 的 baseURL，或设置环境变量 CODEBUDDY_BASE_URL 后重启 DSH'))
      }

      return sendJson(res, 400, failEnvelope('unknown-action', `未知操作：${body.action}`))
    } catch (error) {
      return sendJson(res, 500, failEnvelope('internal', error?.message ?? String(error)))
    }
  }

  return { handle }
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const provider = config.provider ?? 'codebuddy-native'
  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'llm-codebuddy'

  /**
   * 生效配置。
   *
   * C4「可配置」就落在这里：models 一旦在 cordis.patch.yml 里给出就以它为准，
   * 想给某个模型换 contextWindow / 加一个 inputModalities，改 YAML 即可，**不用改代码**。
   * FALLBACK_MODELS 只在配置缺失时兜底（含单测直接 apply 的场景）。
   */
  const readConfig = () => ({
    baseURL: process.env.CODEBUDDY_BASE_URL || config.baseURL || DEFAULT_BASE_URL,
    apiKeyEnv: config.apiKeyEnv ?? 'CODEBUDDY_API_KEY',
    models: Array.isArray(config.models) && config.models.length ? config.models : FALLBACK_MODELS
  })

  const adapter = new CodeBuddyAdapter({
    ctx,
    provider,
    current: readConfig,
    models: () => mergeModels(readConfig().models),
    retryPolicy: () => resolveRetryPolicy(config.retryPolicy)
  })

  // 路由名冲突保护：pi-ai 可能已注册同名 provider
  let registration
  try {
    registration = ctx.llm.registerAdapter([provider], adapter)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-codebuddy: 路由 "${provider}" 注册失败（可能已被 llm-pi-ai 占用）：${error?.message ?? error}`)
    return
  }

  try {
    ctx.llm.registerConfigurableProviders([{
      provider,
      displayName: 'CodeBuddy (unofficial)',
      settingsNs,
      settingsPath: []
    }])
  } catch (error) {
    ctx.logger?.warn?.(`dsh-codebuddy: provider 目录注册失败：${error?.message ?? error}`)
  }

  try {
    const known = new Map(FALLBACK_MODELS.map((m) => [m.id, m]))
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const cfg = readConfig()
      const key = request?.apiKey ?? await resolveKey(ctx, cfg.apiKeyEnv)
      // 宿主把用户正在编辑的端点放在 request.baseURL（types.d.ts:263）。这条通路走的是
      // 已鉴权的 connection，故允许草稿端点；但仍限定 https，避免明文把密钥裸发。
      const draft = String(request?.baseURL ?? '').trim()
      const baseURL = draft && /^https:\/\//iu.test(draft) ? draft : cfg.baseURL
      // 端点/密钥变了 → 上一轮目录结论不再适用
      const keyOf = discoverCacheKey(baseURL, key, false)
      if (keyOf !== discoveryScope) resetDiscoveryScope(keyOf)
      const cachedEntry = discoverCache.get(keyOf)
      const cached = Boolean(cachedEntry) && Date.now() - cachedEntry.at <= DISCOVER_CACHE_TTL_MS
      const fresh = cached ? null : await discoverAll(baseURL, key, { signal, candidates: candidateIds(cfg) })
      const ids = fresh ? fresh.ids : cachedEntry.ids
      const absentIds = fresh ? (fresh.stats.absentIds ?? []) : []
      // 干净 = 未取消 + 未熔断 + 未欠费 + 未超时预算 + 至少一条有效判定
      const clean = fresh
        ? (!fresh.stats.aborted && !fresh.stats.throttleStopped && !fresh.stats.quotaStopped
          && !fresh.stats.deadlineHit && (fresh.stats.hit + fresh.stats.absent > 0))
        : false
      if (fresh && clean) discoverCache.set(keyOf, { at: Date.now(), ids, absentIds, stats: fresh.stats })
      // 宿主页发现命中的模型同样登记进目录 → 选择器立刻可选
      rememberDiscovered(ids, known)
      // 只有本轮「新鲜且干净」的结果才敢改写「下线」集合。
      // 缓存命中时 absentIds 是旧快照的快照，拿它整体替换会把刚被证明可用的模型重新藏起来。
      if (clean) rememberAbsent(absentIds)
      return ids.map((id) => {
        const hit = known.get(id)
        return {
          id,
          name: hit?.name ?? friendlyName(id),
          contextWindow: hit?.contextWindow ?? 131072,
          maxTokens: hit?.maxTokens ?? 8192,
          // 发现结果也要带模态：否则从这里采纳的条目不知道哪些模型能看图
          ...(hit?.inputModalities ? { inputModalities: [...hit.inputModalities] } : {})
        }
      })
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-codebuddy: 模型发现注册失败：${error?.message ?? error}`)
  }

  ctx.on('loader/volatile-update', () => {
    try { registration?.replace([provider]) } catch (error) { ctx.logger?.warn?.(error) }
  })

  // 设置页同源路由
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const backend = settingsBackend(ctx, () => ({ provider, ...readConfig() }))
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => { void backend.handle(req, res) }
      })
      return () => dispose?.()
    }, 'dsh-codebuddy: settings route')
  })
}

/**
 * 测试出口 —— 仅供仓内单测（test/*.test.mjs）使用，**不对外承诺稳定**。
 *
 * 这些函数要么是纯函数、要么只依赖极薄的 stub（fetch / resp.body.getReader），
 * 因此可以零网络、零额度地验证 SSE 解析、块生命周期、usage 互斥计数、
 * 工具调用拼接、错误分类与目录合并。
 */
export const __test__ = {
  CodeBuddyAdapter,
  sseFrames,
  framePayload,
  classifyHttpFailure,
  statusToCode,
  apiRoot,
  friendlyName,
  probeModel,
  discoverAll,
  mergeModels,
  rememberDiscovered,
  rememberAbsent,
  resetDiscoveryScope,
  discoveredModels,
  FALLBACK_MODELS,
  PROBE_CANDIDATES,
  GATEWAY_PROMPT_TOO_LONG_CODE,
  GATEWAY_QUOTA_EXHAUSTED_CODE
}
