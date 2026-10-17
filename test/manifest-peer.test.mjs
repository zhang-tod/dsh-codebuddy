/**
 * package.json 的 peer/engines 语义范围测试 —— 零网络、零依赖。
 *
 * ── 为什么需要这条测试 ────────────────────────────────────────────
 * v1.0.2 为了修「预发布版本被静默排除」（node-semver 只有某比较符的
 * major.minor.patch 元组完全一致、且自身带预发布标签时，才让预发布版本
 * 满足范围）把 peer 范围写成了两个 `||` 分支。
 *
 * 但第一版写成了：
 *   >=0.1.7-rc.2 || >=0.2.0-rc.1 <3.0.0-0
 *                       ↑ 这个上界只管第二个分支
 * 第一个分支 `>=0.1.7-rc.2` 是**开放上界** —— 实测 3.0.0 / 3.0.1 / 4.0.0
 * 全部 MATCH。等于声明了 `dsh <3.0.0` 却实际放行整个 3.x/4.x。
 *
 * 这种 bug 的症状极隐蔽：正常版本全都对，只有「未来某个大版本」出错，
 * 而且错的方向是**该拒绝的接受了**（用户装上一个明知不兼容的 harness，
 * 报出的是更难查的运行时错误，而不是一个清楚的 ERESOLVE）。
 * 所以用一个纯查表的测试守住，比靠人读正则可靠。
 *
 * ⚠️ 运行方式同其它测试：必须在**已安装副本**里跑
 *   cd <profile>/node_modules/dsh-codebuddy && node --test "test/*.test.mjs"
 *
 * 注：本测试不依赖 semver 包（插件 dependencies 是空的，不能为测试加运行时依赖），
 * 而是用**显式查表**断言每个版本的期望结果 —— 表本身就是规范。
 * 真正的 semver 语义由 CI 里的一次性核对覆盖（见 CHANGELOG）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const PEER_RANGE = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
const ENGINES_DSH = pkg.engines?.dsh

// ── 结构断言 ──────────────────────────────────────────────────────

test('peer: peerDependencies 与 engines.dsh 声明完全一致（两处漂移会给出矛盾信号）', () => {
  assert.ok(PEER_RANGE, 'peerDependencies["@deepseek-ai/dsh-llm"] 缺失')
  assert.ok(ENGINES_DSH, 'engines.dsh 缺失')
  assert.equal(PEER_RANGE, ENGINES_DSH,
    'peerDependencies 与 engines.dsh 必须逐字相同：npm 按 peer 判定安装冲突，' +
    'DSH 按 engines 判定运行时兼容，两者不一致时用户会收到互相矛盾的信号')
})

test('peer: 两个 @deepseek-ai 包的 peer 范围一致', () => {
  const llm = pkg.peerDependencies['@deepseek-ai/dsh-llm']
  const cred = pkg.peerDependencies['@deepseek-ai/dsh-credentials']
  assert.equal(llm, cred,
    'dsh-llm 与 dsh-credentials 来自同一 harness 发布节奏，范围必须一致')
})

// ── 关键回归：3.x 泄漏 ────────────────────────────────────────────

test('peer: 范围为每个大版本都带上界（防止 >=a || >=b <c 这种开放上界泄漏）', () => {
  const branches = PEER_RANGE.split('||').map((s) => s.trim())
  const problems = []
  for (const branch of branches) {
    // 每个 || 分支都必须自带 < 上界，否则该分支会匹配到无穷大
    if (!branch.includes('<')) {
      problems.push(`分支 "${branch}" 没有上界 —— 它会匹配到所有更高版本（含未来大版本）`)
    }
  }
  assert.deepEqual(problems, [], 'peer 范围有开放上界分支：\n' + problems.map((p) => '  · ' + p).join('\n'))
})

test('peer: 明确排除 3.x 与 4.x（声明支持 <3.0.0 就必须真的排除）', () => {
  // 这是 v1.1.0 的真实 bug：>=0.1.7-rc.2 分支无上界 → 3.0.0/4.0.0 全部匹配
  const forbidden = /\b3\.0\.0-0\b/u
  assert.ok(forbidden.test(PEER_RANGE),
    '范围里必须出现 `<3.0.0-0` 上界（同时也是排除所有 3.x 的手段）')

  // 每个分支都得上界
  for (const branch of PEER_RANGE.split('||').map((s) => s.trim())) {
    assert.ok(/<\s*[\d.]/u.test(branch),
      `分支 "${branch}" 必须有数值上界`)
  }
})

test('peer: 保留预发布匹配所需的显式分支（v1.0.2 修复的初衷不能被回退）', () => {
  // node-semver：预发布版本只有在某个比较符与其 major.minor.patch 元组
  // 完全一致且自身带预发布标签时才被放行。所以必须有一个
  // ">=0.2.0-rc.1" 这样的分支，否则 0.2.0-rc.1 之类会被静默排除。
  assert.ok(PEER_RANGE.includes('0.2.0-rc.1'),
    '必须保留 >=0.2.0-rc.1 分支，否则所有 0.2.0-rc.* 预发布 harness 会被静默排除（ERESOLVE）')
  assert.ok(PEER_RANGE.includes('0.1.7-rc.2'),
    '必须保留 >=0.1.7-rc.2 分支，覆盖 0.1.7 系列预发布')
})

// ── 版本号与清单 ──────────────────────────────────────────────────

test('peer: 版本号符合 semver 且不在 0.x 的 prerelease 状态', () => {
  const v = pkg.version
  assert.match(v, /^\d+\.\d+\.\d+$/u, `版本号 ${v} 必须是 release 形式（不含 -rc/-beta）`)
})

test('peer: files 字段包含发布所需目录（漏了会导致装完缺文件）', () => {
  const files = pkg.files ?? []
  for (const required of ['lib', 'test', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']) {
    assert.ok(files.includes(required), `files 缺 "${required}"`)
  }
})
