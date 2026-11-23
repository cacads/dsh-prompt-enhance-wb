import test from 'node:test'
import assert from 'node:assert/strict'

import { collectReply } from '../src/collect.js'

/** Build an async iterable from a list of chunks. */
async function* chunks(list) {
  for (const chunk of list) yield chunk
}

const delta = text => ({ type: 'text-delta', index: 0, text })
const finish = kind => ({ type: 'finish', reason: { kind } })

test('a clean stream returns its text', async () => {
  const result = await collectReply(chunks([delta('hello '), delta('world'), finish('stop')]))
  assert.equal(result.kind, 'ok')
  assert.equal(result.text, 'hello world')
})

test('a max-tokens finish keeps the usable text and reports truncation', async () => {
  const result = await collectReply(chunks([delta('half a prompt'), finish('max-tokens')]))
  assert.equal(result.kind, 'maxtokens')
  assert.equal(result.text, 'half a prompt')
})

test('the local character cap wins over a well-behaved stream', async () => {
  const result = await collectReply(
    chunks([delta('x'.repeat(10)), delta('y'.repeat(10))]),
    { outputLimit: 15 },
  )
  assert.equal(result.kind, 'toolong')
  assert.equal(result.limit, 15)
})

test('a blocking provider is not buffered past the cap', async () => {
  let pulled = 0
  async function* endless() {
    for (let index = 0; index < 100; index += 1) {
      pulled += 1
      yield delta('0123456789')
    }
  }
  const result = await collectReply(endless(), { outputLimit: 25 })
  assert.equal(result.kind, 'toolong')
  assert.ok(pulled < 10, `pulled ${pulled} chunks`)
})

test('a stream without text blocks falls back to block-end text', async () => {
  const result = await collectReply(chunks([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'from the block' } },
    finish('stop'),
  ]))
  assert.equal(result.kind, 'ok')
  assert.equal(result.text, 'from the block')
})

test('an aborted stream is reported as aborted, not as empty success', async () => {
  const result = await collectReply(chunks([delta('partial'), finish('aborted')]))
  assert.equal(result.kind, 'aborted')
})

test('a stream that ends without a finish chunk is cancelled', async () => {
  const result = await collectReply(chunks([delta('partial')]))
  assert.equal(result.kind, 'cancelled')
})

test('an error finish carries the provider failure', async () => {
  const result = await collectReply(chunks([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } },
  ]))
  assert.equal(result.kind, 'error')
  assert.equal(result.failure.code, 'RATE_LIMIT')
})

test('tool-calls counts as a clean finish', async () => {
  const result = await collectReply(chunks([delta('text'), finish('tool-calls')]))
  assert.equal(result.kind, 'ok')
})

test('unknown chunk shapes are ignored rather than fatal', async () => {
  const result = await collectReply(chunks([{ type: 'usage', usage: {} }, { nope: true }, delta('ok'), finish('stop')]))
  assert.equal(result.kind, 'ok')
  assert.equal(result.text, 'ok')
})
