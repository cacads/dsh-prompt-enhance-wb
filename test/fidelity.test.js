import test from 'node:test'
import assert from 'node:assert/strict'

import { checkFidelity, extractFacts, describeLosses } from '../src/fidelity.js'

const DRAFT = '把 C:\\work\\app.js 里的 MAX_RETRY 从 3 改成 5，参考 https://example.com/a?b=1 和 `npm run build`'

test('a faithful rewrite loses nothing', () => {
  const losses = checkFidelity(DRAFT, `修改 C:\\work\\app.js：把 MAX_RETRY 由 3 调整到 5。\n参考 https://example.com/a?b=1\n执行 \`npm run build\` 验证。`)
  assert.deepEqual(losses, {})
})

test('a dropped path, number and code span are all reported', () => {
  const losses = checkFidelity(DRAFT, '参考 https://example.com/a?b=1 修改一下重试次数并构建')
  assert.ok(Array.isArray(losses.path), 'path loss')
  assert.ok(losses.path.some(token => token.includes('app.js')))
  assert.ok(Array.isArray(losses.number), 'number loss')
  assert.ok(losses.number.includes('3'))
  assert.ok(Array.isArray(losses.code), 'code loss')
})

test('one dropped URL is reported once, not three times', () => {
  const draft = '看 https://example.com/a?b=1 这个链接'
  const losses = checkFidelity(draft, '看这个链接就好')
  assert.ok(Array.isArray(losses.url))
  assert.equal(losses.path, undefined)
  assert.equal(losses.identifier, undefined)
})

test('re-wrapping a code span is not a loss', () => {
  const losses = checkFidelity('跑 `npm test`', '请执行 npm test 并汇报结果')
  assert.equal(losses.code, undefined)
})

test('identifiers keep their structure, prose words do not become facts', () => {
  const facts = extractFacts('调用 buildAll 然后看 README 里的 user_id')
  assert.ok(facts.get('identifier')?.has('buildAll'))
  assert.ok(facts.get('identifier')?.has('user_id'))
  assert.equal(facts.get('identifier')?.has('README'), false)
})

test('losses summarize into one line per kind', () => {
  const summary = describeLosses({ path: ['a.js', 'b.js', 'c.js', 'd.js'], number: ['3'] })
  assert.ok(summary.includes('path: a.js, b.js, c.js +1'))
  assert.ok(summary.includes('number: 3'))
})
