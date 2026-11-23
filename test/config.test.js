import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig, mergeConfig, DEFAULTS, configFileOf } from '../src/config.js'

test('an empty patch yields the defaults', () => {
  assert.deepEqual(normalizeConfig(), normalizeConfig(DEFAULTS))
  assert.deepEqual(normalizeConfig(DEFAULTS).models, [])
})

test('numeric bounds are clamped, not trusted', () => {
  const low = normalizeConfig({ maxInputChars: 1, maxOutputChars: -5, minRatio: 9 })
  assert.equal(low.maxInputChars, 200)
  assert.equal(low.maxOutputChars, 200)
  assert.equal(low.minRatio, 1)
  const high = normalizeConfig({ timeoutMs: 10 ** 9, temperature: 99 })
  assert.equal(high.timeoutMs, 600000)
  assert.equal(high.temperature, 2)
})

test('a non-numeric value falls back to the default', () => {
  const config = normalizeConfig({ maxInputChars: 'lots' })
  assert.equal(config.maxInputChars, DEFAULTS.maxInputChars)
})

test('the pre-1.1 provider/model pair becomes the first chain entry', () => {
  const config = normalizeConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(config.models, [{ provider: 'deepseek-account', model: 'deepseek-flash' }])
})

test('an explicit chain wins over the legacy pair', () => {
  const config = normalizeConfig({
    provider: 'legacy',
    model: 'old',
    models: [{ provider: 'a', model: 'b' }],
  })
  assert.deepEqual(config.models, [{ provider: 'a', model: 'b' }])
})

test('malformed chain entries are dropped and the list is capped', () => {
  const config = normalizeConfig({
    models: [
      { provider: '', model: 'x' },
      { provider: 'a' },
      'nope',
      { provider: 'b', model: 'c' },
      ...Array.from({ length: 9 }, (_, index) => ({ provider: `p${index}`, model: `m${index}` })),
    ],
  })
  assert.equal(config.models.length, 6)
  assert.deepEqual(config.models[0], { provider: 'b', model: 'c' })
})

test('unknown keys are dropped so a stale setting cannot resurrect', () => {
  const config = normalizeConfig({ legacyMode: 'publish', maxAge: 5 })
  assert.equal('legacyMode' in config, false)
  assert.equal('maxAge' in config, false)
})

test('merge composes patch over base and keeps validation', () => {
  const base = normalizeConfig({ maxInputChars: 5000, memory: true })
  const merged = mergeConfig(base, { maxInputChars: 9000 })
  assert.equal(merged.maxInputChars, 9000)
  assert.equal(merged.memory, true)
  const capped = mergeConfig(base, { maxInputChars: 10 ** 9 })
  assert.equal(capped.maxInputChars, 100000)
})

test('the saved config lives outside the package directory', () => {
  const file = configFileOf('C:\\Users\\x\\.dsh')
  assert.ok(file.includes('.dsh-prompt-enhance-wb'))
  assert.ok(file.endsWith('config.json'))
  assert.equal(file.includes('node_modules'), false)
})
