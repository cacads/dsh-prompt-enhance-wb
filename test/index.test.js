import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, ROUTES } from '../index.js'
import { configFileOf } from '../src/config.js'

/** A streaming reply built from chunks. */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

const delta = text => ({ type: 'text-delta', index: 0, text })
const finish = kind => ({ type: 'finish', reason: { kind } })

/** A request carrying a JSON body. */
function request(method, body, headers = { host: '127.0.0.1:1234' }, url = '/') {
  return {
    method,
    headers,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
    on() {},
    off() {},
  }
}

/** A response that records what was written. */
function response() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text
      this.writableEnded = true
    },
    on() {},
    off() {},
  }
}

/**
 * Mount the plugin against stubs and return the registered routes.
 * @param {object} options
 * @param {object} options.rowConfig - bundle row config.
 * @param {object} options.llm - llm service.
 * @param {object} [options.routes] - route hooks for sessions/default model.
 */
function mount({ rowConfig, llm, sessionRoute, defaultRoute }) {
  const routes = new Map()
  const ctx = {
    get: service => {
      if (service === 'llm') return llm
      if (service === 'webServer') return undefined
      if (service === 'sessions') {
        return {
          get: id => (sessionRoute === undefined ? undefined : {
            requestHeader: () => ({ config: sessionRoute }),
            id,
          }),
        }
      }
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => defaultRoute }
      }
      return undefined
    },
    inject(names, callback) {
      const child = {
        ...ctx,
        get: service => (service === 'webServer' ? {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        } : ctx.get(service)),
        effect: fn => fn(),
      }
      callback(child)
    },
    effect: fn => fn(),
  }
  apply(ctx, rowConfig)
  return routes
}

/** Invoke a registered route, wait for it to answer, and parse the answer. */
async function call(routes, path, req) {
  const res = response()
  await routes.get(path)(req, res)
  for (let waited = 0; waited < 200 && !res.writableEnded; waited += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (!res.writableEnded) throw new Error(`route ${path} never answered`)
  return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) }
}

/** Run one enhancement through the host with a fixed reply. */
async function enhanceWith(options) {
  const home = mkdtempSync(join(tmpdir(), 'wb-penh-idx-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = mount(options)
    const result = await call(routes, ROUTES.enhance, request('POST', {
      text: options.draft ?? '写个脚本',
      sessionId: 's1',
      seq: 1,
    }))
    return result
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('all four routes are registered under one prefix', () => {
  const routes = mount({
    rowConfig: {},
    llm: { stream: () => streamOf([]) },
  })
  assert.deepEqual([...routes.keys()].sort(), [
    ROUTES.cancel, ROUTES.config, ROUTES.enhance, ROUTES.progress,
  ].sort())
})

test('a successful rewrite returns the value and the route used', async () => {
  const calls = []
  const result = await enhanceWith({
    rowConfig: { models: [{ provider: 'p', model: 'm' }] },
    llm: {
      stream(options) {
        calls.push(options)
        return streamOf([delta('请编写一个脚本'), finish('stop')])
      },
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.value, '请编写一个脚本')
  assert.equal(result.payload.route.provider, 'p')
  assert.equal(result.payload.chainSource, 'primary')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].system.includes('Prompt Engineering Expert'), true)
})

test('the session route is used when no chain is configured', async () => {
  const calls = []
  const result = await enhanceWith({
    rowConfig: {},
    sessionRoute: { provider: 'deepseek-account', model: 'deepseek-flash' },
    llm: {
      stream(options) {
        calls.push(options)
        return streamOf([delta('改写结果'), finish('stop')])
      },
    },
  })
  assert.equal(result.status, 200)
  assert.equal(calls[0].provider, 'deepseek-account')
})

test('a retryable failure retries the same model', async () => {
  let attempts = 0
  const result = await enhanceWith({
    rowConfig: { models: [{ provider: 'p', model: 'm' }] },
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }),
      stream() {
        attempts += 1
        if (attempts === 1) return streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }])
        return streamOf([delta('第二次成功'), finish('stop')])
      },
    },
  })
  assert.equal(attempts, 2)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.value, '第二次成功')
})

test('a non-retryable failure moves to the next model', async () => {
  const calls = []
  const result = await enhanceWith({
    rowConfig: { models: [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }] },
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }),
      stream(options) {
        calls.push(options.provider)
        if (options.provider === 'p1') return streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }])
        return streamOf([delta('第二条模型的结果'), finish('stop')])
      },
    },
  })
  assert.deepEqual(calls, ['p1', 'p2'])
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.chainSource, 'fallback')
})

test('an empty draft is refused before any model call', async () => {
  let called = false
  const home = mkdtempSync(join(tmpdir(), 'wb-penh-idx-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = mount({
      rowConfig: { models: [{ provider: 'p', model: 'm' }] },
      llm: { stream() { called = true; return streamOf([]) } },
    })
    const result = await call(routes, ROUTES.enhance, request('POST', { text: '   ', sessionId: 's1', seq: 1 }))
    assert.equal(result.status, 422)
    assert.equal(result.payload.error.code, 'empty')
    assert.equal(called, false)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('a rewrite past the output cap is refused, not silently truncated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-penh-idx-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = mount({
      rowConfig: { models: [{ provider: 'p', model: 'm' }], maxOutputChars: 200 },
      llm: { stream: () => streamOf([delta('x'.repeat(400)), finish('stop')]) },
    })
    const result = await call(routes, ROUTES.enhance, request('POST', { text: '写个脚本', sessionId: 's1', seq: 1 }))
    assert.equal(result.status, 422)
    assert.equal(result.payload.error.code, 'too-long-result')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('fidelity losses warn by default and block when configured', async () => {
  const rowConfig = { models: [{ provider: 'p', model: 'm' }] }
  const draft = '改 C:\\work\\app.js 的 MAX_RETRY'
  const reply = () => streamOf([delta('把重试次数调高一些'), finish('stop')])
  const warned = await enhanceWith({ rowConfig, draft, llm: { stream: reply } })
  assert.equal(warned.status, 200)
  assert.ok(warned.payload.warnings.some(warning => warning.code === 'fidelity'))
  const blocked = await enhanceWith({
    rowConfig: { ...rowConfig, rejectOnFidelityLoss: true },
    draft,
    llm: { stream: reply },
  })
  assert.equal(blocked.status, 422)
  assert.equal(blocked.payload.error.code, 'fidelity')
})

test('a truncated finish is accepted and flagged', async () => {
  const result = await enhanceWith({
    rowConfig: { models: [{ provider: 'p', model: 'm' }] },
    llm: { stream: () => streamOf([delta('写了一半的提示词'), finish('max-tokens')]) },
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.truncated, true)
  assert.ok(result.payload.warnings.some(warning => warning.code === 'truncated'))
})

test('a long draft is refused against the configured input cap', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-penh-idx-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = mount({ rowConfig: { models: [{ provider: 'p', model: 'm' }], maxInputChars: 200 }, llm: { stream: () => streamOf([]) } })
    const result = await call(routes, ROUTES.enhance, request('POST', { text: 'x'.repeat(400), sessionId: 's1', seq: 1 }))
    assert.equal(result.status, 422)
    assert.equal(result.payload.error.code, 'too-long')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('progress reports the model being tried and cancel reports a hit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-penh-idx-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    let release = null
    const routes = mount({
      rowConfig: { models: [{ provider: 'p', model: 'm' }] },
      llm: {
        stream() {
          return (async function* () {
            yield delta('部分文本')
            await new Promise(resolve => { release = resolve })
          })()
        },
      },
    })
    const pending = call(routes, ROUTES.enhance, request('POST', { text: '写个脚本', sessionId: 's9', seq: 3 }))
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      const progress = await call(routes, ROUTES.progress, request('GET', undefined, undefined, '/?key=s9:3'))
      assert.equal(progress.status, 200)
      assert.equal(progress.payload.stage, 'llm')
      const missing = await call(routes, ROUTES.progress, request('GET', undefined, undefined, '/?key=nope:1'))
      assert.equal(missing.status, 404)
      const cancelled = await call(routes, ROUTES.cancel, request('POST', { key: 's9:3' }))
      assert.equal(cancelled.payload.cancelled, true)
    } finally {
      release?.()
    }
    const finished = await pending
    assert.equal(finished.status, 499)
    assert.equal(finished.payload.error.code, 'cancelled')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('the saved config wins over the bundled row and survives a reload', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-penh-idx-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = mount({ rowConfig: { maxOutputChars: 4000 }, llm: { stream: () => streamOf([]) } })
    const saved = await call(routes, ROUTES.config, request('POST', { config: { maxOutputChars: 1500, models: [{ provider: 'a', model: 'b' }] } }))
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.config.maxOutputChars, 1500)
    const file = configFileOf(home)
    assert.ok(readFileSync(file, 'utf8').includes('1500'))
    // A fresh mount (what a restart does) reads the file back over the row.
    const reloaded = mount({ rowConfig: { maxOutputChars: 4000 }, llm: { stream: () => streamOf([]) } })
    const current = await call(reloaded, ROUTES.config, request('GET'))
    assert.equal(current.payload.config.maxOutputChars, 1500)
    assert.deepEqual(current.payload.config.models, [{ provider: 'a', model: 'b' }])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('a cross-origin request is refused', async () => {
  const routes = mount({ rowConfig: {}, llm: { stream: () => streamOf([]) } })
  const result = await call(routes, ROUTES.cancel, request('POST', { key: 'x:1' }, {
    host: '127.0.0.1:1234',
    origin: 'https://evil.example',
  }))
  assert.equal(result.status, 403)
  assert.equal(result.payload.error.code, 'origin')
})

test('a wrong method is refused', async () => {
  const routes = mount({ rowConfig: {}, llm: { stream: () => streamOf([]) } })
  const result = await call(routes, ROUTES.enhance, request('GET'))
  assert.equal(result.status, 405)
})

