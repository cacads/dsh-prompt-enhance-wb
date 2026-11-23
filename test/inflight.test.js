import test from 'node:test'
import assert from 'node:assert/strict'

import { createRegistry, DEFAULT_TTL_MS } from '../src/inflight.js'

/** A registry with a hand-driven clock. */
function registryAt(tick) {
  const clock = { value: tick }
  const registry = createRegistry({ now: () => clock.value })
  return { registry, clock }
}

test('a fresh record reports the queue stage and elapsed time', () => {
  const { registry, clock } = registryAt(1000)
  registry.begin('s:1')
  clock.value = 1500
  const view = registry.view('s:1')
  assert.equal(view.stage, 'queue')
  assert.equal(view.elapsedMs, 500)
  assert.deepEqual(view.degraded, [])
})

test('progress records the model being tried and the attempt index', () => {
  const { registry } = registryAt(0)
  const record = registry.begin('s:1')
  registry.progress(record, { stage: 'llm', step: 2, total: 3, model: 'a/b' })
  registry.progress(record, { retry: 'a/b#1' })
  registry.progress(record, { degraded: 'truncated' })
  const view = registry.view('s:1')
  assert.equal(view.stage, 'llm')
  assert.equal(view.step, 2)
  assert.equal(view.total, 3)
  assert.equal(view.model, 'a/b')
  assert.deepEqual(view.retries, ['a/b#1'])
  assert.deepEqual(view.degraded, ['truncated'])
})

test('an unknown stage is ignored instead of corrupting the record', () => {
  const { registry } = registryAt(0)
  const record = registry.begin('s:1')
  registry.progress(record, { stage: 'nonsense' })
  assert.equal(registry.view('s:1').stage, 'queue')
})

test('cancel aborts the call exactly once and is idempotent afterwards', () => {
  const { registry } = registryAt(0)
  const record = registry.begin('s:1')
  let aborted = 0
  record.controller.signal.addEventListener('abort', () => { aborted += 1 })
  assert.equal(registry.cancel('s:1'), true)
  assert.equal(aborted, 1)
  assert.equal(registry.view('s:1').cancelled, true)
  registry.progress(record, { stage: 'done' })
  assert.equal(registry.cancel('s:1'), false)
  assert.equal(registry.cancel('missing'), false)
})

test('finishing drops the record so a later poll gets no-record', () => {
  const { registry } = registryAt(0)
  registry.begin('s:1')
  registry.finish('s:1')
  assert.equal(registry.view('s:1'), null)
  assert.equal(registry.size(), 0)
})

test('records older than the TTL are pruned on the next begin', () => {
  const { registry, clock } = registryAt(0)
  registry.begin('s:1')
  clock.value = DEFAULT_TTL_MS + 1
  registry.begin('s:2')
  assert.equal(registry.view('s:1'), null)
  assert.equal(registry.view('s:2').stage, 'queue')
})

test('progress reads do not resurrect a cancelled record', () => {
  const { registry } = registryAt(0)
  registry.begin('s:1')
  registry.cancel('s:1')
  assert.equal(registry.view('s:1').cancelled, true)
})
