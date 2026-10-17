/**
 * 推理档位表测试 —— 零网络、零额度、零依赖。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────
 * 档位从「两个硬编码 Set」改成「一张按模型的表」后，出错的代价是**线上 400**：
 *  - 给不支持 Off 的模型列 Off → 用户选了就等于选了个假开关
 *  - 发字面量 "off" → DeepSeek 三个模型实测全部 400/11133
 *  - 给强制档位模型（glm-5.1）省略字段 → 400/11150
 *  - 返回空 efforts → 宿主 `dsh-llm/lib/index.js:2131` 直接抛 INVALID_MODEL_REASONING
 * 这些都不是「看起来不对」，而是**用户一点就报错**，所以必须被测试守住。
 *
 * ── 数据依据（2026-10-17 实测，见 efforts-result.json）─────────────
 *   ① 声明：acc-product-config-v3.json 的 reasoning.supportedEfforts
 *   ② 接受：直连 copilot.tencent.com 逐档实发
 *   ③ Off 有效性：硬题 + max_tokens=4096 实测 completion_thinking_tokens
 *
 * ⚠️ 运行方式同其它测试：必须在**已安装副本**里跑
 *   cd <profile>/node_modules/dsh-codebuddy && node --test "test/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.error('\n[efforts] 无法加载 ../lib/index.js：' + error.message)
  console.error('[efforts] 请在「已安装副本」中运行：cd <profile>/node_modules/dsh-codebuddy && node --test "test/*.test.mjs"\n')
  throw error
}

const {
  MODEL_EFFORTS, DEFAULT_EFFORT_SPEC, effortsForModel, wireReasoningEffort, FALLBACK_MODELS
} = mod.__test__

/** 档位 id → 线上应发的值（不含 off，off 单独断言）。 */
const ids = (modelId) => effortsForModel(modelId).map((e) => e.id)

// ── 表结构自检 ────────────────────────────────────────────────────

test('efforts: 表结构自检 —— 每条都有合法 off 布尔值与 tiers 数组', () => {
  const problems = []
  const VALID_TIERS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

  for (const [model, spec] of Object.entries(MODEL_EFFORTS)) {
    if (typeof spec.off !== 'boolean') problems.push(`${model}: off 不是布尔值（${spec.off}）`)
    if (!Array.isArray(spec.tiers)) { problems.push(`${model}: tiers 不是数组`); continue }
    if (new Set(spec.tiers).size !== spec.tiers.length) problems.push(`${model}: tiers 有重复`)
    for (const tier of spec.tiers) {
      if (!VALID_TIERS.has(tier)) problems.push(`${model}: 非法档位 ${tier}`)
    }
    // 强制型必须有至少一个可发档位，否则 off 降级时无从降起
    if (spec.forceEffort === true && spec.tiers.length === 0) {
      problems.push(`${model}: forceEffort 但 tiers 为空（收到 off 时无档可降）`)
    }
  }
  assert.deepEqual(problems, [], '档位表结构有问题：\n' + problems.map((p) => '  · ' + p).join('\n'))
})

test('efforts: 表里的模型 id 都在 FALLBACK_MODELS 里（防止表与清单漂移）', () => {
  const known = new Set(FALLBACK_MODELS.map((m) => m.id))
  const orphans = Object.keys(MODEL_EFFORTS).filter((id) => !known.has(id))
  assert.deepEqual(
    orphans, [],
    `档位表里有 FALLBACK_MODELS 没有的模型：${orphans.join('、')}\n` +
    '（要么是模型改名了，要么是清单漏收录 —— 两者都会让该模型永远走兜底档位）'
  )
})

// ── 三种模型类型的关键断言 ────────────────────────────────────────

test('efforts: DeepSeek 系必须给 Off（实测 omit → think=0，真能关思考）', () => {
  for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
    assert.ok(ids(model).includes('off'), `${model} 应提供 Off（实测不传字段 think=0）`)
  }
})

test('efforts: 假 Off 的模型绝不能给 Off（声明能关、实测关不掉）', () => {
  // kimi-k2.8-preview / kimi-k3-2 声明 canDisableThinking=true，
  // 但硬题实测 omit 仍思考 1986~4093 tok —— 给了就是假开关
  for (const model of ['kimi-k2.8-preview', 'kimi-k3-2']) {
    assert.ok(!ids(model).includes('off'), `${model} 不应提供 Off（实测 omit 仍在思考，是假开关）`)
  }
  // 声明 canDisableThinking=false 的一律不给
  for (const model of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'hy3', 'hy4-preview', 'step-5-preview']) {
    assert.ok(!ids(model).includes('off'), `${model} 不应提供 Off（canDisableThinking=false）`)
  }
})

test('efforts: deepseek-v4.1-flash 必须暴露 low/medium 之外的完整档位（本次更新的核心诉求）', () => {
  const list = ids('deepseek-v4.1-flash')
  assert.deepEqual(list, ['off', 'low', 'high', 'max'],
    'deepseek-v4.1-flash 的档位应严格等于 off+low+high+max（声明 ∩ 实测）')
})

test('efforts: 顶档按官方声明取 —— 不是所有模型都给 max/xhigh', () => {
  // 官方声明 supportedEfforts 里没有 max/xhigh 的，绝不能给
  assert.ok(!ids('hy4-preview').includes('max'), 'hy4-preview 只声明了 high，不能给 max（假档）')
  assert.ok(!ids('hy4-preview').includes('xhigh'), 'hy4-preview 不能给 xhigh')
  assert.deepEqual(ids('hy4-preview').filter((t) => t !== 'off'), ['high'])

  assert.equal(ids('deepseek-v4-pro').at(-1), 'xhigh', 'v4-pro 声明顶档是 xhigh')
  assert.equal(ids('deepseek-v4.1-flash').at(-1), 'max', 'v4.1-flash 声明顶档是 max')
  assert.equal(ids('glm-5.3').at(-1), 'max', 'glm-5.3 声明顶档是 max')
})

test('efforts: space-bunny 五档全给（官方声明最全的模型）', () => {
  assert.deepEqual(ids('space-bunny').filter((t) => t !== 'off'),
    ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('efforts: step-5-preview 含 medium（少数声明 medium 的模型）', () => {
  const list = ids('step-5-preview').filter((t) => t !== 'off')
  assert.ok(list.includes('medium'), 'step-5-preview 声明了 medium，必须暴露')
  assert.ok(!list.includes('max'), 'step-5-preview 没声明 max，不能给')
})

// ── 档位顺序与宿主契约 ────────────────────────────────────────────

test('efforts: 顺序始终强度递增（off → low → medium → high → xhigh → max）', () => {
  const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const model of Object.keys(MODEL_EFFORTS)) {
    const list = ids(model)
    const ranked = list.map((t) => ORDER.indexOf(t))
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i] > ranked[i - 1],
        `${model} 档位顺序错了：${list.join(',')}（应单调递增）`)
    }
  }
})

test('efforts: 任何模型都至少返回一档（宿主对空 efforts 直接抛 INVALID_MODEL_REASONING）', () => {
  for (const model of [...Object.keys(MODEL_EFFORTS), 'never-heard-of-this-model']) {
    assert.ok(effortsForModel(model).length > 0, `${model} 返回了空档位列表`)
  }
  // tiers:[] 的单值模型也必须兜底出至少一档
  assert.ok(ids('kimi-k2.7').length > 0, 'kimi-k2.7（无声明档位）应兜底出至少一档')
})

test('efforts: 每个档位都有非空显示名（选择器直接显示它）', () => {
  for (const model of Object.keys(MODEL_EFFORTS)) {
    for (const effort of effortsForModel(model)) {
      assert.ok(typeof effort.name === 'string' && effort.name.length > 0,
        `${model} 的档位 ${effort.id} 没有显示名`)
    }
  }
})

// ── 线上取值（最要命的部分：发错就是 400）─────────────────────────

test('wire: Off 永远不发字面量 "off"（DeepSeek 实测 400/11133）', () => {
  for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.2']) {
    const wire = wireReasoningEffort('off', model)
    assert.equal(wire, undefined,
      `${model} 选 Off 时不能发任何 reasoning_effort（发 "off" 会 400/11133），实际发了 ${wire}`)
  }
})

test('wire: 声明过的档位原样发出（不再把所有档压缩到顶档）', () => {
  assert.equal(wireReasoningEffort('low', 'deepseek-v4.1-flash'), 'low',
    'low 必须原样发 low —— 旧实现会错发成顶档')
  assert.equal(wireReasoningEffort('high', 'deepseek-v4.1-flash'), 'high')
  assert.equal(wireReasoningEffort('max', 'deepseek-v4.1-flash'), 'max')
  assert.equal(wireReasoningEffort('xhigh', 'deepseek-v4-pro'), 'xhigh')
  assert.equal(wireReasoningEffort('medium', 'step-5-preview'), 'medium')
})

test('wire: 强制档位模型（glm-5.1）选 Off 时必须降级成最低档而非省略字段', () => {
  const wire = wireReasoningEffort('off', 'glm-5.1')
  assert.ok(wire !== undefined,
    'glm-5.1 省略字段会 400/11150（实测），选 Off 必须降级成具体档位')
  assert.equal(wire, 'low', 'glm-5.1 的最低可用档是 low')
})

test('wire: 未声明的档位不原样打到网关（防 11133/11150）', () => {
  // hy4-preview 只声明 high；请求 max 不能发 max
  assert.equal(wireReasoningEffort('max', 'hy4-preview'), 'high')
  // 未知模型走兜底 high+max，请求 low 应落到已声明档位
  assert.equal(wireReasoningEffort('low', 'unknown-model-xyz'), 'high')
})

test('wire: 无档位参数时不产生字段', () => {
  for (const value of [undefined, null, '']) {
    assert.equal(wireReasoningEffort(value, 'deepseek-v4.1-flash'), undefined)
  }
})

test('wire: 兜底规格与旧行为一致（未知模型 = high + max，不比现状激进）', () => {
  assert.deepEqual(DEFAULT_EFFORT_SPEC, { off: false, tiers: ['high', 'max'] })
  assert.deepEqual(ids('totally-unknown-model'), ['high', 'max'])
})
