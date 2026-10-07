/**
 * dsh-codebuddy 回归测试 —— 零网络、零额度。
 *
 * 运行方式（必须在**已安装副本**里跑，因为 lib/index.js 要解析 @deepseek-ai/dsh-llm）：
 *   node --test "test/*.test.mjs"
 * ⚠️ 传目录（`node --test test/`）不行：Node 的 --test 只把文件/glob 当测试入口，
 *    裸目录名会被当成 CJS 入口模块去 require，直接 MODULE_NOT_FOUND（Node 22/24 实测一致）。
 * 开发时：把 lib/ 与 test/ 同步到 profile 的 node_modules/dsh-codebuddy 再跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.error('\n[test] 无法加载 ../lib/index.js：' + error.message)
  console.error('[test] 本插件是 DSH 插件，lib/index.js 顶层 import 了 @deepseek-ai/dsh-llm，')
  console.error('[test] 该包只在 DSH profile 里可解析。请在「已安装副本」中运行测试：')
  console.error('[test]   copy lib/ test/ -> <profile>/node_modules/dsh-codebuddy/ 然后 node --test "test/*.test.mjs"\n')
  throw error
}
const {
  CodeBuddyAdapter, sseFrames, STREAM_IDLE_TIMEOUT_MS, LlmError, framePayload, classifyHttpFailure,
  mergeModels, rememberDiscovered, rememberAbsent, resetDiscoveryScope, discoveredModels
} = mod.__test__

// ── 工具 ────────────────────────────────────────────────────────

/** 伪造一个只实现 body.getReader() 的响应（sseFrames 只用到这一个能力）。 */
function fakeResp(chunks, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () => (i >= chunks.length ? { done: true } : { done: false, value: enc.encode(chunks[i++]) }),
        releaseLock() {},
        cancel: async () => {}
      })
    }
  }
}

function makeAdapter() {
  return new CodeBuddyAdapter({
    ctx: {},
    provider: 'codebuddy-native',
    current: () => ({ baseURL: 'https://example.invalid/v2', apiKeyEnv: 'K', models: [] }),
    models: () => [],
    efforts: () => [],
    retryPolicy: () => ({})
  })
}

function frame(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n' }

async function collect(adapter, resp, options = {}) {
  const out = []
  for await (const c of adapter.parseStream(resp, options)) out.push(c)
  return out
}

// ── 1. 错误分类（本轮修的额度码）────────────────────────────────

test('classifyHttpFailure: 业务码优先于 HTTP 状态码，含嵌套 error.data', () => {
  const cases = [
    // 真实样本：额度耗尽 → 必须 QUOTA（不可重试），不是 RATE_LIMIT
    [429, '{"error":{"data":{"code":14018,"msg":"额度已用尽，请访问 …/profile/usage"}}}', 'QUOTA'],
    [400, '{"code":11102,"msg":"model [x] service info not found"}', 'INVALID_REQUEST'],
    [400, '{"code":11115,"msg":"prompt is too long: 1074539 tokens > 1048576 maximum"}', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, '{"msg":"prompt is too long: 9 tokens > 8 maximum"}', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}', 'INVALID_REQUEST'],
    // 普通限流不是额度问题 → 仍是可重试的 RATE_LIMIT
    [429, '{"code":10001,"msg":"too many requests, slow down"}', 'RATE_LIMIT'],
    [401, '{"msg":"unauthorized"}', 'AUTH'],
    [402, '{"msg":"payment required"}', 'QUOTA'],
    [500, 'oops not json', 'SERVER'],
    [400, '', 'INVALID_REQUEST'],
    // 一层嵌套 {error:{code,msg}}（不是 error.data）—— 取码/取文案必须都能穿透
    [400, '{"error":{"code":11115,"msg":"prompt is too long: 9 > 8"}}', 'CONTEXT_WINDOW_EXCEEDED'],
    [429, '{"error":{"code":14018,"msg":"额度已用尽"}}', 'QUOTA'],
    // 纯文本响应体：msg 若退化成空串，所有正则都会失效
    [400, 'prompt is too long: 1074539 tokens > 1048576 maximum', 'CONTEXT_WINDOW_EXCEEDED'],
    [429, 'You exceeded your current quota, please check your plan', 'QUOTA']
  ]
  for (const [status, body, want] of cases) {
    assert.equal(classifyHttpFailure(status, body).code, want, `HTTP ${status} ${body.slice(0, 40)}`)
  }
})

// ── 2. SSE 解析边界 ────────────────────────────────────────────

test('framePayload: 多行 data: 按 SSE 规范拼接', () => {
  assert.equal(framePayload('data: {"a":\ndata: 1}'), '{"a":\n1}')
  assert.equal(framePayload('event: x\nfoo: y'), null)
  assert.equal(framePayload('data: [DONE]'), '[DONE]')
})

test('sseFrames: CRLF 跨 chunk 切分 + 尾帧 flush', async () => {
  // 把 \r\n\r\n 的 \r 和 \n 劈到两个 chunk 里 —— 归一化必须仍能切帧
  const chunks = ['data: {"a":1}\r', '\n\r\ndata: {"b":2}\n\n', 'data: {"c":3}']
  const frames = []
  for await (const f of sseFrames(fakeResp(chunks))) frames.push(f)
  assert.equal(frames.length, 3, 'CRLF 切分与尾帧 flush 后应有 3 帧')
  assert.equal(framePayload(frames[0]), '{"a":1}')
  assert.equal(framePayload(frames[1]), '{"b":2}')
  assert.equal(framePayload(frames[2]), '{"c":3}', '尾帧无空行也要 flush')
})

// ── 2b. 流式空闲看门狗（本轮新增的 P1 修复）─────────────────────

/**
 * 伪造一个可观测的 reader。
 * @param {object} opts
 * @param {Array} [opts.chunks] - 依次返回的数据块；取尽后回落 `after`
 * @param {boolean} [opts.never] - true = read() 永不 settle（网关半路静默）
 * @param {number} [opts.delayMs] - 每次 read() 的延迟（模拟真实网络间隙）
 * @param {string} [opts.after] - chunks 取尽后的行为：'done'（默认）| 'never'
 */
function observableReader({ chunks = [], never = false, delayMs = 0, after = 'done' } = {}) {
  const enc = new TextEncoder()
  const state = { reads: 0, cancels: 0, releases: 0 }
  let i = 0
  const reader = {
    read() {
      state.reads += 1
      if (never || (i >= chunks.length && after === 'never')) return new Promise(() => {})
      const settle = () => {
        if (i >= chunks.length) return { done: true, value: undefined }
        return { done: false, value: enc.encode(chunks[i++]) }
      }
      return delayMs > 0 ? new Promise((r) => setTimeout(() => r(settle()), delayMs)) : Promise.resolve(settle())
    },
    cancel() { state.cancels += 1; return Promise.resolve() },
    releaseLock() { state.releases += 1 }
  }
  return { reader, state, resp: { body: { getReader: () => reader } } }
}

test('sseFrames: 网关半路静默 → 空闲超时抛 TRANSPORT（而不是干等 undici 的 303s 裸 TypeError）', async () => {
  // 修复前：read() 永不 settle → 一直挂到 undici bodyTimeout（实测 303s）才抛裸
  // TypeError('terminated')；它非 HarnessError，宿主归 UNKNOWN，不重试。
  const { resp, state } = observableReader({ never: true })
  const t0 = Date.now()
  let thrown
  try {
    for await (const _frame of sseFrames(resp, { idleTimeoutMs: 200 })) void _frame
  } catch (error) {
    thrown = error
  }
  const elapsed = Date.now() - t0

  assert.ok(thrown, '静默的流必须抛错，不得静默地正常结束')
  assert.equal(thrown.code, 'TRANSPORT', '必须是可重试的 TRANSPORT（在 cordis.patch.yml 的 retryableCodes 里）')
  assert.equal(thrown.name, 'LlmError', '必须是 HarnessError 子类，否则宿主会归 UNKNOWN 且不重试')
  assert.match(thrown.message, /空闲超时/)
  assert.match(thrown.message, /200ms 无数据/, '错误文案要带上实际超时值，便于排障')
  assert.ok(elapsed >= 180 && elapsed < 3000, `应在超时附近抛出（实际 ${elapsed}ms）`)

  // 不 cancel 的话，socket 会一直挂到服务端超时；重试最多 5 次 → 同时挂住多条连接
  assert.ok(state.cancels >= 1, `超时后必须 cancel 掉 reader（实际 cancel ${state.cancels} 次）`)
})

test('parseStream: 静默流端到端也是 TRANSPORT（不只是 sseFrames 单测）', async () => {
  // 走完整调用链：stream() → parseStream() → sseFrames()。这里直接测 parseStream，
  // 确认 idleTimeoutMs 能从上层注入（stream() 不传 → 用默认 60s）。
  const { resp } = observableReader({ never: true })
  await assert.rejects(
    () => collect(makeAdapter(), resp, { idleTimeoutMs: 200 }),
    (e) => e.code === 'TRANSPORT' && e.name === 'LlmError',
    '半路静默必须端到端归一成可重试的 TRANSPORT'
  )
})

test('sseFrames: 超时是「空闲」而非「总时长」—— 持续出帧的长回答不得被误杀', async () => {
  // 60 帧 × 每帧 30ms = 1800ms 总时长 >> 300ms 空闲超时。
  // 若误做成总时长超时，这里必然失败。
  const frames = Array.from({ length: 60 }, (_, k) => frame({ choices: [{ index: 0, delta: { content: String(k) }, finish_reason: '' }] }))
  frames.push(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n')
  const { resp } = observableReader({ chunks: frames, delayMs: 30 })

  const t0 = Date.now()
  const chunks = []
  for await (const c of makeAdapter().parseStream(resp, { idleTimeoutMs: 300 })) chunks.push(c)
  const elapsed = Date.now() - t0

  assert.ok(elapsed > 1000, `测试本身要跑够长才有意义（实际 ${elapsed}ms）`)
  assert.equal(chunks.at(-1).type, 'finish', '持续有数据的流必须正常收尾，不能被空闲超时打断')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 60, '60 帧正文必须一帧不丢')
})

test('sseFrames: 正常收尾后不留下悬挂的空闲超时定时器', async () => {
  // 注入的定时器按 delay 值识别；创建数与清除数必须配平，
  // 否则长会话里每次请求都会漏一个 timer（Node 进程被拖着不退出）。
  const DELAY = 137
  const created = new Set()
  const cleared = new Set()
  const origSet = globalThis.setTimeout
  const origClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = origSet(fn, ms, ...rest)
    if (ms === DELAY) created.add(id)
    return id
  }
  globalThis.clearTimeout = (id) => {
    if (created.has(id)) cleared.add(id)
    return origClear(id)
  }
  try {
    const { resp } = observableReader({ chunks: ['data: {"a":1}\n\n', 'data: [DONE]\n\n'] })
    const frames = []
    for await (const f of sseFrames(resp, { idleTimeoutMs: DELAY })) frames.push(f)
    assert.equal(frames.length, 2)
  } finally {
    globalThis.setTimeout = origSet
    globalThis.clearTimeout = origClear
  }
  assert.ok(created.size > 0, '应确实创建过空闲超时定时器（否则本测试无意义）')
  assert.equal(cleared.size, created.size,
    `每次 read() 后都必须 clearTimeout（创建 ${created.size} / 清除 ${cleared.size}）`)
})

test('sseFrames: (done) 与尾帧 flush 在超时改造后不变', async () => {
  // 收尾立即 done：只读一轮就结束，定时器不得干扰正常路径
  const { resp, state } = observableReader({ chunks: ['data: {"x":1}\n\ndata: {"y":2}'] })
  const frames = []
  for await (const f of sseFrames(resp, { idleTimeoutMs: 200 })) frames.push(f)
  assert.deepEqual(frames.map(framePayload), ['{"x":1}', '{"y":2}'])
  assert.equal(state.cancels, 1, '正常结束也应 cancel 一次回收连接（finally 原有语义保留）')
  assert.equal(state.releases, 1, 'releaseLock 原有语义保留')
})

test('STREAM_IDLE_TIMEOUT_MS: 默认 60s（早于 undici 的 300s bodyTimeout，留出重试窗口）', () => {
  assert.equal(STREAM_IDLE_TIMEOUT_MS, 60 * 1000)
  assert.ok(STREAM_IDLE_TIMEOUT_MS < 300 * 1000, '必须早于 undici 默认 bodyTimeout(300s)，否则修复无意义')
})

// ── 2c. 读取失败归一化（本轮追加）─────────────────────────────
// 与空闲超时同一条后果链：裸错误不是 HarnessError → 宿主归 UNKNOWN → 不重试。
// 依据：dsh-llm/lib/types/adapter-failure.js:105-107 `error instanceof HarnessError ? error.code : 'UNKNOWN'`

/** 造一个 read() 直接 reject 的 resp。 */
function rejectingResp(error) {
  const state = { cancels: 0, releases: 0 }
  const reader = {
    read: () => Promise.reject(error),
    cancel: async () => { state.cancels += 1 },
    releaseLock: () => { state.releases += 1 }
  }
  return { resp: { body: { getReader: () => reader } }, state }
}

/** 收集 sseFrames 抛出的错误（异步生成器不能直接 assert.rejects 迭代）。 */
async function catchFrom(gen) {
  try {
    for await (const _item of gen) void _item
    return undefined
  } catch (error) {
    return error
  }
}

test('sseFrames: read() 抛裸 TypeError（undici bodyTimeout / TCP RST）→ 归一成 TRANSPORT', async () => {
  const raw = new TypeError('terminated')
  raw.cause = { code: 'UND_ERR_BODY_TIMEOUT' }
  const { resp } = rejectingResp(raw)

  const thrown = await catchFrom(sseFrames(resp, { idleTimeoutMs: 60_000 }))
  assert.ok(thrown, '读取失败必须抛错')
  assert.equal(thrown.name, 'LlmError', '必须归一成 LlmError，否则宿主归 UNKNOWN 且不重试')
  assert.equal(thrown.code, 'TRANSPORT', 'TRANSPORT 在 cordis.patch.yml 的 retryableCodes 里 → 会被重试')
  assert.match(thrown.message, /读取失败/)
  assert.match(thrown.message, /terminated/, '原始 message 要带出来，便于排障')
})

test('sseFrames: read() 抛 AbortError → 同样归一成 TRANSPORT（取消语义由宿主保证）', async () => {
  // 取消场景不靠这里的 code 区分：宿主 adapterFailureChunk 先判 signal?.aborted，
  // 命中即走 kind:'aborted'（dsh-llm/lib/types/index.js:942），
  // 所以包装成 TRANSPORT **不会**让用户主动取消的操作被误重试。
  const abortErr = new Error('The operation was aborted')
  abortErr.name = 'AbortError'
  const { resp } = rejectingResp(abortErr)

  const thrown = await catchFrom(sseFrames(resp, { idleTimeoutMs: 60_000 }))
  assert.equal(thrown.name, 'LlmError')
  assert.equal(thrown.code, 'TRANSPORT')
  assert.match(thrown.message, /读取失败/)
})

test('sseFrames: 已是 LlmError 的读取失败原样抛出，不被二次包装成「读取失败」', async () => {
  // 例如带内错误帧（QUOTA / CONTEXT_WINDOW_EXCEEDED）已由分类器给出精确码，
  // 若在这里被包成 TRANSPORT，就会把「不可重试的永久失败」变成「可重试」→ 白等 5 次退避。
  // 必须用**真的** LlmError：生产代码判的是 `instanceof LlmError`，鸭子类型过不了这一关。
  const inner = new LlmError('dsh-codebuddy: 网关错误 code=14018', 'QUOTA')
  const { resp } = rejectingResp(inner)

  const thrown = await catchFrom(sseFrames(resp, { idleTimeoutMs: 60_000 }))
  assert.equal(thrown, inner, '必须原样抛出同一个错误对象')
  assert.equal(thrown.code, 'QUOTA', '精确码不得被改写成 TRANSPORT')
  assert.doesNotMatch(thrown.message, /读取失败/, '不得被包装')
})

test('sseFrames: 读取失败的原始错误通过 cause 保留（不丢 UND_ERR_BODY_TIMEOUT 线索）', async () => {
  const raw = new TypeError('terminated')
  raw.cause = { code: 'UND_ERR_BODY_TIMEOUT' }
  const { resp } = rejectingResp(raw)

  const thrown = await catchFrom(sseFrames(resp, { idleTimeoutMs: 60_000 }))
  assert.equal(thrown.cause, raw, 'cause 必须是原始错误本身')
  assert.equal(thrown.cause.cause.code, 'UND_ERR_BODY_TIMEOUT', '原始错误链要能一路查到 undici 的码')
})

test('sseFrames: 超时分支不受读取失败包装影响 —— 消息仍报「空闲超时」', async () => {
  // 超时抛的本身已是 LlmError，走 `instanceof LlmError → 原样抛` 或根本不进 catch，
  // 两种情形都不得变成「读取失败」。
  const { resp } = observableReader({ never: true })
  const thrown = await catchFrom(sseFrames(resp, { idleTimeoutMs: 150 }))
  assert.equal(thrown.code, 'TRANSPORT')
  assert.match(thrown.message, /空闲超时/, '超时必须是「空闲超时」')
  assert.doesNotMatch(thrown.message, /读取失败/, '超时不得被读成读取失败')
  assert.match(thrown.message, /150ms 无数据/)
})

// ── 3. 请求体组装 ──────────────────────────────────────────────

test('buildBody: system 在首位 / tools 用 parameters / off 不发 reasoning_effort', () => {
  const a = makeAdapter()
  const body = a.buildBody({
    model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', description: 'd', parameters: { type: 'object', properties: {} } }],
    reasoningEffort: 'off', maxTokens: 16
  })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'SYS')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 16)
  assert.ok(body.tools[0].function.parameters, '工具 schema 字段必须是 parameters')
  assert.equal(body.tools[0].function.inputSchema, undefined)
  assert.equal(body.reasoning_effort, undefined, 'off 不应发出该字段')
})

// ── 4. 消息映射 ────────────────────────────────────────────────

test('mapMessage: assistant 带 text+reasoning+tool-call / developer 降级 / tool 角色', () => {
  const a = makeAdapter()
  const asst = a.mapMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: '答案' },
      { type: 'reasoning', text: '推理' },
      { type: 'tool-call', id: 'c1', name: 'f', arguments: '{"x":1}' }
    ]
  })
  assert.equal(asst.role, 'assistant')
  assert.equal(asst.content, '答案')
  assert.equal(asst.reasoning_content, '推理', '多轮必须回传推理')
  assert.equal(typeof asst.tool_calls[0].function.arguments, 'string', 'arguments 必须是字符串')
  assert.equal(asst.tool_calls[0].function.arguments, '{"x":1}', '字符串不得二次编码')

  // 对象形式要序列化
  const asst2 = a.mapMessage({ role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'f', arguments: { x: 1 } }] })
  assert.equal(asst2.content, null, '无正文且有工具调用 → content 为 null')
  assert.equal(asst2.tool_calls[0].function.arguments, '{"x":1}')

  assert.equal(a.mapMessage({ role: 'developer', content: 'D' }).role, 'system')
  const tool = a.mapMessage({ role: 'tool', toolCallId: 'c1', content: 'ok' })
  assert.equal(tool.role, 'tool')
  assert.equal(tool.tool_call_id, 'c1')
  assert.equal(a.mapMessage({ role: 'nope' }), null)
})

// ── 5. 流式块生命周期 + usage 互斥 + 工具调用拼接 ──────────────

test('parseStream: 块成对 / reasoning 与 text 不共 index / tool-call 拼接正确', async () => {
  const resp = fakeResp([
    frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { reasoning_content: '想' }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { content: '你' }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'c1', index: 0, function: { name: 'f', arguments: '' } }] }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x"' } }] }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    frame({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } }),
    'data: [DONE]\n\n'
  ])
  const chunks = await collect(makeAdapter(), resp)

  const starts = chunks.filter((c) => c.type === 'block-start')
  const ends = chunks.filter((c) => c.type === 'block-end')
  assert.equal(starts.length, ends.length, 'block-start / block-end 必须成对')
  assert.deepEqual(starts.map((c) => c.blockType), ['reasoning', 'text', 'tool-call'])

  const idx = starts.map((c) => c.index)
  assert.equal(new Set(idx).size, idx.length, 'index 必须互不重复')

  // block-end 必须携带已累积的完整内容（BlockAssembler 见到 block 直接用，不再拼 delta）
  const byIdx = Object.fromEntries(ends.map((c) => [c.index, c.block]))
  const reasoningEnd = ends.find((c) => c.block.type === 'reasoning')
  const textEnd = ends.find((c) => c.block.type === 'text')
  const toolEnd = ends.find((c) => c.block.type === 'tool-call')
  assert.equal(reasoningEnd.block.text, '想')
  assert.equal(textEnd.block.text, '你好')
  assert.equal(toolEnd.block.id, 'c1')
  assert.equal(toolEnd.block.name, 'f')
  assert.equal(toolEnd.block.arguments, '{"x":1}', '工具参数分片必须完整拼接')
  assert.doesNotThrow(() => JSON.parse(toolEnd.block.arguments))

  // usage：计数互斥（cached 从 input 扣除）
  const usage = chunks.find((c) => c.type === 'usage').usage
  assert.equal(usage.inputTokens, 20, 'inputTokens 必须扣除 cache')
  assert.equal(usage.cacheReadTokens, 80)
  assert.equal(usage.totalTokens, 105)

  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('parseStream: length → max-tokens 映射', async () => {
  const resp = fakeResp([
    frame({ choices: [{ index: 0, delta: { content: '半句' }, finish_reason: '' }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
    'data: [DONE]\n\n'
  ])
  const chunks = await collect(makeAdapter(), resp)
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
})

test('parseStream: 无 finish_reason 也无 [DONE] → 抛 TRANSPORT（截断守卫）', async () => {
  const resp = fakeResp([
    frame({ choices: [{ index: 0, delta: { content: '半句话就断了' }, finish_reason: '' }] })
    // 故意不补 finish_reason / [DONE]
  ])
  await assert.rejects(
    () => collect(makeAdapter(), resp),
    (e) => e.code === 'TRANSPORT',
    '被截断的流必须归一成可重试的 TRANSPORT，而不是当成正常结束'
  )
})

test('parseStream: 带内错误帧按业务码分类（含嵌套 error.data 的额度码）', async () => {
  const quota = fakeResp([frame({ error: { data: { code: 14018, msg: '额度已用尽' } } })])
  await assert.rejects(() => collect(makeAdapter(), quota), (e) => e.code === 'QUOTA')

  const tooLong = fakeResp([frame({ code: 11115, msg: 'prompt is too long: 9 > 8' })])
  await assert.rejects(() => collect(makeAdapter(), tooLong), (e) => e.code === 'CONTEXT_WINDOW_EXCEEDED')
})

test('parseStream: 空响应 → EMPTY_RESPONSE（可重试）', async () => {
  const resp = fakeResp([frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
  await assert.rejects(() => collect(makeAdapter(), resp), (e) => e.code === 'EMPTY_RESPONSE')
})

// ── 6. 目录合并（本轮修的头号 bug）─────────────────────────────

test('mergeModels: 探测命中的模型必须进入 listModels 的目录', () => {
  discoveredModels.clear()
  const configured = [{ id: 'auto', name: 'Auto', contextWindow: 1000, maxTokens: 10 }]

  assert.equal(mergeModels(configured).length, 1, '未探测时应只有配置清单')

  rememberDiscovered(['brand-new-model'], new Map())
  const merged = mergeModels(configured)
  assert.equal(merged.length, 2, '探测命中的新模型必须被合并进来')
  assert.ok(merged.some((m) => m.id === 'brand-new-model'))
  assert.equal(merged[0].id, 'auto', '配置清单在前，顺序稳定')

  // 同 id 以配置清单为准，不得重复
  rememberDiscovered(['auto'], new Map())
  const dedup = mergeModels(configured)
  assert.equal(dedup.filter((m) => m.id === 'auto').length, 1, '同 id 不得重复')
  assert.equal(dedup.find((m) => m.id === 'auto').contextWindow, 1000)
  discoveredModels.clear()
})

test('rememberDiscovered: 用 known 元数据覆盖友好名与窗口', () => {
  discoveredModels.clear()
  rememberDiscovered(['glm-x'], new Map([['glm-x', { id: 'glm-x', name: 'GLM X', contextWindow: 300000, maxTokens: 8192, inputModalities: ['text', 'image'] }]]))
  const m = mergeModels([])[0]
  assert.equal(m.name, 'GLM X')
  assert.equal(m.contextWindow, 300000)
  assert.deepEqual(m.inputModalities, ['text', 'image'])
  discoveredModels.clear()
})

test('mergeModels: 探测确认下线的模型必须被剔除（只加不减是不够的）', () => {
  discoveredModels.clear()
  rememberAbsent([])
  const configured = [
    { id: 'alive', name: 'Alive', contextWindow: 1000, maxTokens: 10 },
    { id: 'dead', name: 'Dead', contextWindow: 1000, maxTokens: 10 }
  ]

  assert.equal(mergeModels(configured).length, 2, '未探测时应原样返回')

  // 网关明确回 11102 → 该模型已下线，必须从目录里消失，否则选中就 400
  rememberAbsent(['dead'])
  const filtered = mergeModels(configured)
  assert.deepEqual(filtered.map((m) => m.id), ['alive'])

  // 集合是「整体替换」而非累加：一次新探测只回 alive 在线，dead 不在其中 → 不应被永久隐藏
  rememberAbsent(['other'])
  const again = mergeModels(configured)
  assert.deepEqual(again.map((m) => m.id), ['alive', 'dead'], '不得把上一轮的结论累积下来')

  rememberAbsent([])
  discoveredModels.clear()
})

test('mergeModels: 探测命中与确认下线同时生效', () => {
  discoveredModels.clear()
  rememberDiscovered(['brand-new'], new Map())
  rememberAbsent(['old-removed'])
  const out = mergeModels([
    { id: 'old-removed', name: 'X', contextWindow: 1, maxTokens: 1 },
    { id: 'keep', name: 'K', contextWindow: 1, maxTokens: 1 }
  ])
  assert.deepEqual(out.map((m) => m.id), ['keep', 'brand-new'], '既加新的也减旧的')
  rememberAbsent([])
  discoveredModels.clear()
})

test('parseStream: usage 空对象不得覆盖真实用量', async () => {
  const resp = fakeResp([
    frame({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: '' }] }),
    frame({ usage: { prompt_tokens: 100, completion_tokens: 5 } }),
    frame({ usage: {} }), // 网关有时回空对象 —— 不得抹掉上一帧的真实计数
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n'
  ])
  const chunks = await collect(makeAdapter(), resp)
  const usages = chunks.filter((c) => c.type === 'usage')
  assert.equal(usages.length, 1, '空 usage 对象不得产生额外 usage 块')
  assert.equal(usages[0].usage.inputTokens, 100)
  assert.equal(usages[0].usage.outputTokens, 5)
  assert.equal(usages[0].usage.totalTokens, 105)
})

test('parseStream: 只给 total_tokens 时不能上报全 0', async () => {
  const resp = fakeResp([
    frame({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }),
    frame({ usage: { total_tokens: 1234 } }),
    'data: [DONE]\n\n'
  ])
  const chunks = await collect(makeAdapter(), resp)
  const usage = chunks.find((c) => c.type === 'usage').usage
  assert.equal(usage.totalTokens, 1234, '必须采信网关给的 total')
  assert.equal(usage.inputTokens, 1234, '缺 prompt_tokens 时用 total - completion 反推')
})

test('resetDiscoveryScope: 换端点/密钥必须清空目录结论', () => {
  discoveredModels.clear()
  rememberAbsent([])
  rememberDiscovered(['from-old-endpoint'], new Map())
  rememberAbsent(['gone-on-old-endpoint'])

  resetDiscoveryScope('https://new.example/v2|fingerprint')
  const out = mergeModels([{ id: 'gone-on-old-endpoint', name: 'X', contextWindow: 1, maxTokens: 1 }])
  assert.deepEqual(out.map((m) => m.id), ['gone-on-old-endpoint'],
    '换作用域后：旧端点的「下线」结论必须失效，旧端点的命中项也不得残留')
  discoveredModels.clear()
  rememberAbsent([])
})

// ── 7. 探测：本地 mock 网关（零额度）───────────────────────────

test('probeModel / discoverAll: 区分 存在 / 11102 / 限流 / 额度用尽', async () => {
  const { probeModel, discoverAll, PROBE_CANDIDATES } = mod.__test__
  const realId = PROBE_CANDIDATES[0] // 只让候选清单里的第一个「存在」，其余回 11102
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const model = JSON.parse(body || '{}').model
      if (model === realId) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      } else if (model === 'no-quota') {
        // 额度用尽：429 但语义是永久失败，必须与限流区分开
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end('{"error":{"data":{"code":14018,"msg":"额度已用尽，请购买加量包"}}}')
      } else if (model === 'limit-me') {
        // 真限流：429 且不含额度码
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' })
        res.end('{"code":10001,"msg":"too many requests, slow down"}')
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"code":11102,"msg":"model not found"}')
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/v2'
  try {
    const ok = await probeModel(base, 'k', realId)
    assert.equal(ok.verdict, true, '200 → 存在')
    assert.equal(ok.reason, 'ok')

    const absent = await probeModel(base, 'k', 'definitely-absent')
    assert.equal(absent.verdict, false, '11102 → 不存在')
    assert.equal(absent.reason, 'absent')

    // 限额必须回 null（无法判定），否则「限流」会被误判成「模型不存在」
    const limited = await probeModel(base, 'k', 'limit-me')
    assert.equal(limited.verdict, null, '429(限流) → 无法判定')
    assert.equal(limited.reason, 'rate', '真限流')
    assert.ok(limited.retryAfterMs > 0, 'Retry-After 应被解析')

    // 额度用尽与限流同为 429，但必须是**不同**的 reason ——
    // 否则 UI 会对欠费用户说「稍后重试」，而他要做的是去充值
    const noQuota = await probeModel(base, 'k', 'no-quota')
    assert.equal(noQuota.reason, 'quota', '429(14018) → 额度用尽，不得混同限流')

    const { ids, stats } = await discoverAll(base, 'k', { deep: false })
    assert.deepEqual(ids, [realId], '只应发现真实存在的那个，不得把 11102 / 429 当存在')
    assert.ok(stats && typeof stats.probed === 'number', '必须回传成本统计')
    assert.ok(PROBE_CANDIDATES.length >= 20)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('discoverAll: 撞到额度用尽必须立刻停，不把剩余候选打完', async () => {
  const { discoverAll } = mod.__test__
  let hits = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      hits += 1
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end('{"error":{"data":{"code":14018,"msg":"额度已用尽"}}}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/v2'
  try {
    const { stats } = await discoverAll(base, 'k', { deep: false })
    assert.equal(stats.quotaStopped, true, '必须标记为额度中止')
    assert.ok(stats.quota > 0)
    assert.ok(hits <= 6, `额度用尽后不得继续打完候选（实际发了 ${hits} 次）`)
    assert.equal(stats.aborted, false)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('discoverAll: 网关不响应时必须在总时限内返回（不能挂几分钟）', async () => {
  const { discoverAll } = mod.__test__
  // 故意永不响应：没有总时限时，这里要等每条探测各自 8s 超时，多批累积好几分钟
  const server = createServer(() => { /* 不回 */ })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/v2'
  try {
    const t0 = Date.now()
    const { stats } = await discoverAll(base, 'k', { deep: false, deadlineMs: 400 })
    const elapsed = Date.now() - t0
    assert.equal(stats.deadlineHit, true, '必须标记为「到总时限」')
    assert.ok(elapsed < 3000, `应在时限附近返回（实际 ${elapsed}ms）`)
    // 到时限 ≠ 用户取消：两者必须可区分，否则 UI 会说错话
    assert.equal(stats.aborted, false)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('discoverAll: 候选由调用方给定（配置清单优先），不硬编码兜底表', async () => {
  const { discoverAll, PROBE_CANDIDATES } = mod.__test__
  const probed = []
  const server = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      probed.push(JSON.parse(b || '{}').model)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end('{"code":11102,"msg":"model not found"}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/v2'
  try {
    await discoverAll(base, 'k', { deep: false, candidates: ['only-this-one'] })
    assert.deepEqual(probed, ['only-this-one'],
      '必须只探调用方给的候选 —— 否则用户从配置里删掉的模型会被重新加回目录')
    assert.ok(PROBE_CANDIDATES.length >= 20, '内置兜底表仍在（空配置时用）')
  } finally {
    await new Promise((r) => server.close(r))
  }
})
