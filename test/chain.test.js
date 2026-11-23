import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChain, MAX_CHAIN } from '../src/chain.js'

const session = { provider: 'deepseek-account', model: 'deepseek-flash' }
const harnessDefault = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

test('configured models are tried first', () => {
  const chain = buildChain([{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }], session, harnessDefault)
  assert.equal(chain.source, 'config')
  assert.deepEqual(chain.list, [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])
})

test('an empty config follows the session route', () => {
  const chain = buildChain([], session, harnessDefault)
  assert.equal(chain.source, 'session')
  assert.deepEqual(chain.list, [session])
})

test('without a session route the harness default is used', () => {
  const chain = buildChain([], undefined, harnessDefault)
  assert.equal(chain.source, 'default')
  assert.deepEqual(chain.list, [harnessDefault])
})

test('nothing configured and no route yields an empty chain', () => {
  const chain = buildChain([], undefined, undefined)
  assert.equal(chain.source, 'none')
  assert.deepEqual(chain.list, [])
})

test('duplicates are dropped so budget is not spent twice', () => {
  const chain = buildChain([session, session, { provider: 'a', model: 'm' }], undefined, undefined)
  assert.equal(chain.list.length, 2)
})

test('invalid entries do not poison the chain', () => {
  const chain = buildChain([{ provider: '', model: 'x' }, null, { provider: 'a', model: 'm' }], undefined, undefined)
  assert.deepEqual(chain.list, [{ provider: 'a', model: 'm' }])
})

test('the chain length is capped', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ provider: `p${index}`, model: `m${index}` }))
  const chain = buildChain(many, undefined, undefined)
  assert.equal(chain.list.length, MAX_CHAIN)
})
