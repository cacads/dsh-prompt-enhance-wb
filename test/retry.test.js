import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_POLICY,
  normalizePolicy,
  retryCapOf,
  computeBackoffDelayMs,
  isRetryableFailure,
  policyFor,
  NORMAL_RETRY_CAP,
} from '../src/retry.js'

test('backoff grows exponentially and stays under the cap', () => {
  const policy = normalizePolicy({ ...DEFAULT_POLICY, initialDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0 })
  assert.equal(computeBackoffDelayMs(policy, 1, () => 0), 500)
  assert.equal(computeBackoffDelayMs(policy, 2, () => 0), 1000)
  assert.equal(computeBackoffDelayMs(policy, 3, () => 0), 2000)
  assert.equal(computeBackoffDelayMs(policy, 4, () => 0), 4000)
  assert.equal(computeBackoffDelayMs(policy, 9, () => 0), 4000)
})

test('jitter stays inside the declared band', () => {
  const policy = normalizePolicy({ ...DEFAULT_POLICY, initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2 })
  const low = computeBackoffDelayMs(policy, 1, () => 0)
  const high = computeBackoffDelayMs(policy, 1, () => 1)
  assert.equal(low, 800)
  assert.equal(high, 1200)
})

test('a hostile policy is narrowed instead of trusted', () => {
  const policy = normalizePolicy({ mode: 'weird', maxRetries: 10 ** 6, initialDelayMs: -1, jitterRatio: 5 })
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 8)
  assert.equal(policy.initialDelayMs, 0)
  assert.equal(policy.jitterRatio, 1)
})

test('the retry cap bounds a generous policy', () => {
  assert.equal(retryCapOf(normalizePolicy({ mode: 'normal', maxRetries: 99 })), NORMAL_RETRY_CAP)
  assert.equal(retryCapOf(normalizePolicy({ mode: 'always' })), 3)
  assert.equal(retryCapOf(normalizePolicy({ mode: 'normal', maxRetries: 1 })), 1)
})

test('retryability follows the provider policy, with transport errors always retried', () => {
  const policy = normalizePolicy({ mode: 'normal', retryableCodes: ['RATE_LIMIT'] })
  assert.equal(isRetryableFailure(policy, { code: 'RATE_LIMIT' }), true)
  assert.equal(isRetryableFailure(policy, { code: 'AUTH' }), false)
  assert.equal(isRetryableFailure(policy, { code: 'STREAM_THROW' }), true)
  assert.equal(isRetryableFailure(policy, null), false)
  const always = normalizePolicy({ mode: 'always', retryableCodes: [] })
  assert.equal(isRetryableFailure(always, { code: 'AUTH' }), true)
})

test('a provider without a policy or a throwing reader falls back to the default', () => {
  assert.deepEqual(policyFor(undefined, 'x'), { ...DEFAULT_POLICY })
  assert.deepEqual(policyFor(() => { throw new Error('unregistered') }, 'x'), { ...DEFAULT_POLICY })
})

test('the default policy retries the harness default codes', () => {
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.equal(isRetryableFailure(DEFAULT_POLICY, { code }), true, code)
  }
})
