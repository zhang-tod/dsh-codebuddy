/**
 * dsh-codebuddy 回归测试 —— 零网络、零额度。
 *
 * 运行方式（必须在**已安装副本**里跑，因为 lib/index.js 要解析 @deepseek-ai/dsh-llm）：
 *   node --test test/
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
  console.error('[test]   copy lib/ test/ -> <profile>/node_modules/dsh-codebuddy/ 然后 node --test test/\n')
  throw error
}
const {
  CodeBuddyAdapter, sseFrames, framePayload, classifyHttpFailure,
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
