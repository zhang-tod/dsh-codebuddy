/**
 * 模型清单双副本一致性测试 —— 零网络、零额度、零依赖。
 *
 * ── 为什么需要这条测试 ──────────────────────────────────────────
 * 模型清单在仓库里有**两个副本**：
 *   ① cordis.patch.yml 的 `models:` 段 —— 生效源（配置存在时以它为准）
 *   ② lib/index.js 的 `FALLBACK_MODELS` —— 兜底源（配置缺失时用它）
 * lib/index.js 的注释写着「改一边务必改另一边」，但在此之前 21 条测试里
 * **没有任何一条覆盖它**，纯靠人肉守。
 *
 * 两个副本漂移的症状很隐蔽：同一个模型，装插件的人看到的上下文窗口 / 视觉能力
 * 取决于配置有没有被读进来 —— **两种行为，且全程不报错**。属于那种「出错也不会
 * 有人发现，只会有人觉得这插件怪」的问题，正适合交给 CI 守。
 *
 * ── 运行方式（必须在**已安装副本**里跑，理由同 test/index.test.mjs）──
 *   node --test "test/*.test.mjs"
 *
 * ⚠️ 传目录（`node --test test/`）不行：Node 的 --test 只把文件/glob 当测试入口，
 *    裸目录名会被当成 CJS 入口模块去 require，直接 MODULE_NOT_FOUND。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.error('\n[manifest] 无法加载 ../lib/index.js：' + error.message)
  console.error('[manifest] 本插件是 DSH 插件，lib/index.js 顶层 import 了 @deepseek-ai/dsh-llm，')
  console.error('[manifest] 该包只在 DSH profile 里可解析。请在「已安装副本」中运行测试：')
  console.error('[manifest]   copy lib/ test/ -> <profile>/node_modules/dsh-codebuddy/ 然后 node --test "test/*.test.mjs"\n')
  throw error
}
const { FALLBACK_MODELS } = mod.__test__

// ── YAML 解析（手写。为什么不用 js-yaml：见文件头「零依赖」；models 段缩进固定，
//    只有标量与流式数组两种写法，40 行正则比多一个 npm 依赖划算得多）──────────

/**
 * 解析 cordis.patch.yml 的 `models:` 段。
 *
 * 解析失败一律 **抛错**，绝不返回空数组 —— 返回 [] 会让下面所有比对「全绿」，
 * 这条测试就退化成永远绿的摆设（比没有测试更坏）。
 *
 * @param {string} text - cordis.patch.yml 原文
 * @returns {Array<{line:number,id:string,name:string|undefined,contextWindow:number|undefined,maxTokens:number|undefined,inputModalities:string[]|undefined}>}
 */
function parseModelsFromYaml(text) {
  const lines = text.split(/\r?\n/)

  // 1) 定位 `models:` 键（顶层不参与，这里只找唯一那一处 8 空格缩进的行）
  const headRe = /^\s*models:\s*(#.*)?$/
  const head = lines.findIndex((line) => headRe.test(line))
  if (head < 0) throw new Error('cordis.patch.yml 里找不到 `models:` 段（键名改了？）')

  // 2) 条目缩进由第一条 `- id:` 实测决定，不写死 10 空格 —— 改了缩进也不至于假绿
  const idRe = /^(\s*)-\s+id:\s*/
  let itemIndent = -1
  let firstItem = -1
  for (let i = head + 1; i < lines.length; i++) {
    const match = idRe.exec(lines[i])
    if (match) { itemIndent = match[1].length; firstItem = i; break }
    // 列 0 起头的非空行 = 已经走出 models 段
    if (lines[i].trim() && /^\S/.test(lines[i])) break
  }
  if (itemIndent < 0) {
    throw new Error('cordis.patch.yml 的 `models:` 段里没解析到任何 `- id:` 条目（缩进或写法变了？）')
  }

  // 3) 按缩进切条目，条目内字段用统一列偏移取值。
  //    条目行是 `<indent>- id: xxx`，字段行是 `<indent>  name: xxx`，
  //    两者切掉 `itemIndent + 2` 后都从同一起点开始，正好可以共用一条正则。
  const items = []
  let current = null
  for (let i = firstItem; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue // 空行与整行注释不计
    const indent = line.length - line.trimStart().length
    if (indent < itemIndent) break
    if (indent === itemIndent) {
      if (!trimmed.startsWith('- ')) break // 同缩进却不是列表项 → 段结构变了，停
      current = { line: i + 1, raw: {} }
      items.push(current)
    } else if (!current) {
      break
    }
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line.slice(itemIndent + 2))
    if (kv && current) current.raw[kv[1]] = kv[2].trim()
  }
  if (!items.length) throw new Error('cordis.patch.yml 的 `models:` 段解析出 0 条')

  // 4) 取值：标量去引号去行尾注释；inputModalities 只支持流式数组 [a, b]
  const scalar = (raw) => {
    let value = String(raw).trim()
    const hash = value.indexOf(' #')
    if (hash >= 0) value = value.slice(0, hash).trim()
    const quoted = value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    return quoted ? value.slice(1, -1) : value
  }
  const num = (raw, line, field) => {
    const value = Number(scalar(raw))
    if (!Number.isFinite(value)) {
      throw new Error(`cordis.patch.yml:${line} 的 ${field} 不是数字：${raw}`)
    }
    return value
  }
  const mods = (raw, line) => {
    const value = scalar(raw)
    if (!value.startsWith('[') || !value.endsWith(']')) {
      throw new Error(`cordis.patch.yml:${line} 的 inputModalities 写法不支持（期望 [text, image]）：${raw}`)
    }
    return value.slice(1, -1).split(',').map((part) => scalar(part)).filter((part) => part.length > 0)
  }

  return items.map((item) => {
    const { raw, line } = item
    const id = raw.id === undefined ? '' : scalar(raw.id)
    if (!id) throw new Error(`cordis.patch.yml:${line} 的条目没有 id`)
    return {
      line,
      id,
      name: raw.name === undefined ? undefined : scalar(raw.name),
      contextWindow: raw.contextWindow === undefined ? undefined : num(raw.contextWindow, line, 'contextWindow'),
      maxTokens: raw.maxTokens === undefined ? undefined : num(raw.maxTokens, line, 'maxTokens'),
      // 未声明 = 仅文本（宿主侧语义见 lib/index.js resolveModalities）
      inputModalities: raw.inputModalities === undefined ? undefined : mods(raw.inputModalities, line)
    }
  })
}

const YAML_MODELS = parseModelsFromYaml(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))

/** 值 → 可读文本（undefined 与空数组要区分得出来，否则报错信息帮不上忙）。 */
const show = (value) => (value === undefined ? '(未声明)' : JSON.stringify(value))

/** 逐字段比较 YAML 副本与 JS 副本，返回「模型 + 字段 + 两边取值」的可读清单。 */
function diffField(field) {
  const byId = new Map(YAML_MODELS.map((model) => [model.id, model]))
  const problems = []
  for (const jsModel of FALLBACK_MODELS) {
    const yamlModel = byId.get(jsModel.id)
    if (!yamlModel) continue // id 缺失由「id 集合」那条测试负责报，这里不重复刷屏
    const a = yamlModel[field]
    const b = jsModel[field]
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue
    problems.push(
      `${jsModel.id}: ${field} 不一致 —— cordis.patch.yml:${yamlModel.line} = ${show(a)}` +
      `，lib/index.js FALLBACK_MODELS = ${show(b)}`
    )
  }
  return problems
}

/** 断言某个字段逐模型一致，失败时逐行点名「哪个模型哪个字段」。 */
function assertFieldAligned(field, hint) {
  const problems = diffField(field)
  assert.deepStrictEqual(
    problems,
    [],
    `模型清单两个副本的 ${field} 漂移（${problems.length} 处）${hint ? '：' + hint : ''}\n` +
    problems.map((line) => '  · ' + line).join('\n') + '\n'
  )
}

// ── 测试 ────────────────────────────────────────────────────────

test('manifest: 解析器自检 —— YAML models 段解析完整，否则本文件会退化成永远绿', () => {
  const problems = []
  if (!YAML_MODELS.length) problems.push('cordis.patch.yml 的 models 段解析出 0 条')
  if (!FALLBACK_MODELS.length) problems.push('FALLBACK_MODELS 是空数组')
  for (const model of YAML_MODELS) {
    if (model.contextWindow === undefined) problems.push(`cordis.patch.yml:${model.line} (${model.id}) 缺 contextWindow`)
    if (model.maxTokens === undefined) problems.push(`cordis.patch.yml:${model.line} (${model.id}) 缺 maxTokens`)
  }
  const dupYaml = YAML_MODELS.map((m) => m.id).filter((id, i, all) => all.indexOf(id) !== i)
  const dupJs = FALLBACK_MODELS.map((m) => m.id).filter((id, i, all) => all.indexOf(id) !== i)
  if (dupYaml.length) problems.push('cordis.patch.yml 里 id 重复：' + [...new Set(dupYaml)].join('、'))
  if (dupJs.length) problems.push('FALLBACK_MODELS 里 id 重复：' + [...new Set(dupJs)].join('、'))
  assert.deepStrictEqual(problems, [], '清单本身不完整：\n' + problems.map((line) => '  · ' + line).join('\n'))
})

test('manifest: id 集合 —— cordis.patch.yml 与 FALLBACK_MODELS 完全相同', () => {
  const yamlIds = YAML_MODELS.map((model) => model.id)
  const jsIds = FALLBACK_MODELS.map((model) => model.id)
  const onlyYaml = yamlIds.filter((id) => !jsIds.includes(id))
  const onlyJs = jsIds.filter((id) => !yamlIds.includes(id))
  assert.deepStrictEqual(
    { '只在 cordis.patch.yml': onlyYaml, '只在 FALLBACK_MODELS': onlyJs },
    { '只在 cordis.patch.yml': [], '只在 FALLBACK_MODELS': [] },
    `模型 id 集合漂移：只在 YAML 有 [${onlyYaml.join('、')}]；只在 JS 有 [${onlyJs.join('、')}]` +
    '（YAML 决定用户能选到什么，JS 决定配置缺失时的兜底清单，两边必须一致）'
  )
})

test('manifest: 逐模型 contextWindow 一致（决定 DSH 何时压缩 / 判定溢出）', () => {
  assertFieldAligned('contextWindow')
})

test('manifest: 逐模型 maxTokens 一致（决定单次回答会不会被截断）', () => {
  assertFieldAligned('maxTokens')
})

test('manifest: 逐模型 inputModalities 一致（决定图片是否被投影成占位文字）', () => {
  assertFieldAligned(
    'inputModalities',
    '未声明 = 仅文本；两边写法必须逐字对齐，否则同一模型会出现两种视觉行为'
  )
})

test('manifest: 逐模型 name 一致（模型选择器里用户直接看到的显示名）', () => {
  assertFieldAligned('name')
})
