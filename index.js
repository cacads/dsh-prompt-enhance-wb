/**
 * The Host half: the HTTP surface behind the composer button.
 *
 * Four routes, all under one prefix:
 *
 * - `enhance`  — rewrite one draft (POST)
 * - `progress` — what the current call is doing (GET, `?key=<session>:<seq>`)
 * - `cancel`   — abort that call (POST)
 * - `config`   — read or patch the saved settings (GET / POST)
 *
 * The rewrite reuses the session's own model route when `models` is empty, so an
 * enhancement costs the model the user is already talking to and needs no API
 * key of its own. Models are tried in order with the provider's own retry policy
 * applied, and the whole call is bounded by one budget.
 * @module dsh-prompt-enhance-wb/index
 */

import { normalizeConfig, mergeConfig, DEFAULTS, configFileOf } from './src/config.js'
import { buildChain } from './src/chain.js'
import { collectReply } from './src/collect.js'
import { policyFor, computeBackoffDelayMs, isRetryableFailure, retryCapOf, sleep } from './src/retry.js'
import { checkFidelity, describeLosses } from './src/fidelity.js'
import { composeSystemPrompt, buildMessages } from './src/prompts.js'
import { readConfigFile, writeConfigFile } from './src/store.js'
import { createRegistry } from './src/inflight.js'
import { join } from 'node:path'

/** Route prefix shared by every handler. */
export const ROUTE_PREFIX = '/dsh-prompt-enhance-wb'

/** Exact paths the plugin registers. */
export const ROUTES = Object.freeze({
  enhance: `${ROUTE_PREFIX}/enhance`,
  progress: `${ROUTE_PREFIX}/progress`,
  cancel: `${ROUTE_PREFIX}/cancel`,
  config: `${ROUTE_PREFIX}/config`,
})

export const name = 'dsh-prompt-enhance-wb'
export const inject = ['llm']

/** Largest request body accepted, over and above the draft allowance. */
const BODY_SLACK_BYTES = 64 * 1024

/**
 * Read a bounded JSON body.
 * @param {object} req - incoming request.
 * @param {number} cap - byte ceiling.
 * @returns {Promise<object>} the parsed body, or `{}` when empty.
 */
async function readJson(req, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * Write a JSON response.
 * @param {object} res - outgoing response.
 * @param {number} status - HTTP status.
 * @param {object} body - serializable body.
 * @returns {void}
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Same-origin fence for the plugin's own routes.
 *
 * These routes are registered outside the harness's authenticated surface, so a
 * cross-site page must not be able to drive them. A request with no origin
 * header at all (same-origin `fetch`, a local script) is allowed; a browser
 * request must come from this host and be same-origin.
 * @param {object} req - incoming request.
 * @returns {boolean} whether the request is trusted.
 */
function isTrustedRequest(req) {
  const headers = req.headers ?? {}
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === String(headers.host ?? '')
  } catch {
    return false
  }
}

/**
 * Strip the wrappers a model sometimes adds around an otherwise correct answer.
 * @param {string} text - raw model output.
 * @returns {string} the bare prompt body.
 */
function normalizeOutput(text) {
  let out = text.trim()
  // A single fenced block that spans the whole answer is packaging, not content.
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(out)
  if (fence !== null) out = fence[1].trim()
  // Balanced straight or curly quotes around the whole answer.
  const quoted = /^(["'“«])([\s\S]*)(["'”»])$/u.exec(out)
  if (quoted !== null && quoted[2].trim() !== '') out = quoted[2].trim()
  return out
}

/** Narrow an untrusted provider/model pair into a usable route. */
function routeOf(candidate) {
  if (candidate === null || candidate === undefined) return undefined
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * Fetch a service without letting a cordis-level throw escape.
 * @param {object} ctx - registrant context.
 * @param {string} serviceName - service name.
 * @returns {unknown} the service, or undefined.
 */
function serviceOf(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * The session's own route: the provider/model of its last request header.
 *
 * `requestHeader` is a method in every release checked; the property shape is
 * accepted too so a change in either direction degrades to the other branch.
 * @param {object} ctx - registrant context.
 * @param {string} sessionId - the session behind the composer.
 * @returns {{provider: string, model: string}|undefined} the route.
 */
function sessionRouteOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') return undefined
    const session = sessions.get(sessionId)
    if (session === null || session === undefined) return undefined
    const header = session.requestHeader
    const epoch = typeof header === 'function' ? header.call(session) : header
    return routeOf(epoch?.config)
  } catch {
    return undefined
  }
}

/**
 * The harness-wide default selection, published by `agentDefaultModel`.
 * @param {object} ctx - registrant context.
 * @returns {{provider: string, model: string}|undefined} the route.
 */
function defaultRouteOf(ctx) {
  const face = serviceOf(ctx, 'agentDefaultModel')
  if (face === null || face === undefined || typeof face.currentSelection !== 'function') return undefined
  try {
    return routeOf(face.currentSelection())
  } catch {
    return undefined
  }
}

/**
 * Whether this profile can serve the plugin's routes at all.
 *
 * A profile without a web server (pure CLI, some Electron launches) still mounts
 * the plugin, and the button would render while every click failed invisibly.
 * Saying so once at load is the whole fix.
 * @param {object} ctx - registrant context.
 * @returns {void}
 */
function warnWithoutWebServer(ctx) {
  if (serviceOf(ctx, 'webServer') !== undefined) return
  const logger = serviceOf(ctx, 'logger') ?? console
  const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : console.warn
  warn('[dsh-prompt-enhance-wb] no webServer service in this profile; the composer button will have no endpoint to call.')
}

/**
 * Resolve `DSH_HOME` the way the harness does.
 * @returns {string} absolute home path.
 */
function dshHomeOf() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(home, '.dsh')
}

/**
 * Mount the plugin.
 * @param {object} ctx - registrant context.
 * @param {object} [rowConfig] - config from the bundle patch row.
 * @returns {void}
 */
export function apply(ctx, rowConfig = {}) {
  const file = configFileOf(dshHomeOf())
  // Saved settings win over the row: the row is a seed that a reinstall can
  // rewrite, while the file is what the user last chose on the settings page.
  let current = mergeConfig(normalizeConfig(rowConfig), readConfigFile(file))
  const registry = createRegistry()

  warnWithoutWebServer(ctx)

  /**
   * Guard every handler: method, origin, and a JSON body under the cap.
   * @param {object} req - request.
   * @param {object} res - response.
   * @param {string} method - expected method.
   * @param {(body: object) => void} run - handler body.
   * @returns {void}
   */
  function handle(req, res, method, run) {
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, error: { code: 'method', message: `only ${method} is allowed` } })
      return
    }
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request rejected' } })
      return
    }
    const cap = current.maxInputChars * 8 + BODY_SLACK_BYTES
    readJson(req, cap)
      .then(body => run(body ?? {}))
      .catch(error => {
        if (res.writableEnded) return
        const code = error instanceof SyntaxError ? 'body' : 'handler'
        writeJson(res, code === 'body' ? 400 : 500, {
          ok: false,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        })
      })
  }

  /**
   * One rewrite, from route resolution to the final gates.
   * @param {object} body - request body.
   * @param {object} res - response to write.
   * @returns {Promise<void>} settles after the response is written.
   */
  async function enhance(body, res) {
    const text = typeof body.text === 'string' ? body.text : ''
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const seq = Number.isSafeInteger(body.seq) ? body.seq : 0
    if (text.trim() === '') {
      writeJson(res, 422, { ok: false, error: { code: 'empty', message: 'draft is empty' } })
      return
    }
    if (text.length > current.maxInputChars) {
      writeJson(res, 422, {
        ok: false,
        error: { code: 'too-long', message: `draft exceeds ${current.maxInputChars} characters`, count: text.length, max: current.maxInputChars },
      })
      return
    }
    const chain = buildChain(current.models, sessionRouteOf(ctx, sessionId), defaultRouteOf(ctx))
    if (chain.list.length === 0) {
      writeJson(res, 409, { ok: false, error: { code: 'unconfigured', message: 'no model route is configured' } })
      return
    }
    const key = `${sessionId}:${seq}`
    const record = registry.begin(key)
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      record.timedOut = true
      try { record.controller.abort() } catch { /* already aborted */ }
    }, current.timeoutMs)
    const onClose = () => {
      if (!res.writableEnded) {
        record.cancelled = true
        try { record.controller.abort() } catch { /* already aborted */ }
      }
    }
    res.on('close', onClose)

    const memory = Array.isArray(body.memory?.rounds) ? body.memory.rounds : []
    const memoryOn = body.memory !== undefined && memory.length > 0 && current.memory
    const continueMode = body.continue === true
    const system = composeSystemPrompt({
      maxChars: current.maxOutputChars,
      continueMode,
      memory: memoryOn,
    })
    const messages = buildMessages({
      text,
      rounds: memoryOn ? memory : [],
      idPrefix: `${name}-${sessionId || 'session'}-${seq}`,
    })

    const llm = serviceOf(ctx, 'llm')
    const policyReader = llm !== null && llm !== undefined && typeof llm.providerRetryPolicy === 'function'
      ? provider => llm.providerRetryPolicy(provider)
      : undefined

    let lastFailure = null
    try {
      for (let index = 0; index < chain.list.length; index += 1) {
        if (record.cancelled || record.timedOut) break
        const entry = chain.list[index]
        const label = `${entry.provider}/${entry.model}`
        registry.progress(record, { stage: 'llm', step: index + 1, total: chain.list.length, model: label })
        const policy = policyFor(policyReader, entry.provider)
        const cap = retryCapOf(policy)
        for (let attempt = 0; ; attempt += 1) {
          if (record.cancelled || record.timedOut) break
          let outcome
          try {
            const stream = llm.stream({
              provider: entry.provider,
              model: entry.model,
              system,
              messages,
              signal: record.controller.signal,
              ...(current.temperature >= 0 ? { temperature: current.temperature } : {}),
              ...(sessionId !== '' ? { sessionId } : {}),
            })
            outcome = await collectReply(stream, { outputLimit: current.maxOutputChars })
          } catch (error) {
            // A synchronous throw is a transport failure, not a bad prompt: the
            // retry layer below decides whether this model gets another try.
            outcome = { kind: 'error', text: '', failure: { code: 'STREAM_THROW', message: error instanceof Error ? error.message : String(error) } }
          }
          if (record.cancelled || record.timedOut) break
          if (outcome.kind === 'ok' || (outcome.kind === 'maxtokens' && outcome.text.trim() !== '')) {
            registry.progress(record, { stage: 'gate' })
            return finishSuccess(entry, index, outcome, text, res, startedAt, record)
          }
          if (outcome.kind === 'toolong') {
            writeJson(res, 422, {
              ok: false,
              error: { code: 'too-long-result', message: `the rewrite exceeded ${current.maxOutputChars} characters`, max: current.maxOutputChars },
            })
            return
          }
          if (outcome.kind === 'aborted') {
            writeJson(res, record.timedOut ? 504 : 499, {
              ok: false,
              error: { code: record.timedOut ? 'timeout' : 'cancelled', message: record.timedOut ? 'the enhancement timed out' : 'the enhancement was cancelled' },
            })
            return
          }
          lastFailure = outcome.failure ?? { code: 'LLM_FAILED', message: 'the model returned nothing usable' }
          if (isRetryableFailure(policy, lastFailure) && attempt < cap) {
            const delayMs = computeBackoffDelayMs(policy, attempt + 1)
            registry.progress(record, { retry: `${label}#${attempt + 1}` })
            await sleep(delayMs, record.controller.signal)
            continue
          }
          break
        }
      }
      if (record.cancelled || record.timedOut) {
        writeJson(res, record.timedOut ? 504 : 499, {
          ok: false,
          error: { code: record.timedOut ? 'timeout' : 'cancelled', message: record.timedOut ? 'the enhancement timed out' : 'the enhancement was cancelled' },
        })
        return
      }
      writeJson(res, 502, {
        ok: false,
        error: {
          code: 'llm',
          message: lastFailure?.message ?? 'every model in the chain failed',
          ...(lastFailure?.code !== undefined ? { detail: `last failure: ${lastFailure.code}` } : {}),
        },
      })
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
      registry.finish(key)
    }
  }

  /**
   * Run the gates and write the success envelope.
   * @param {{provider: string, model: string}} entry - model that produced the rewrite.
   * @param {number} index - its position in the chain.
   * @param {{kind: string, text: string}} outcome - collected result.
   * @param {string} draft - original draft.
   * @param {object} res - response.
   * @param {number} startedAt - epoch ms the call began.
   * @param {object} record - in-flight record.
   * @returns {void}
   */
  function finishSuccess(entry, index, outcome, draft, res, startedAt, record) {
    const value = normalizeOutput(outcome.text)
    if (value === '') {
      writeJson(res, 502, { ok: false, error: { code: 'empty-result', message: 'the model returned nothing' } })
      return
    }
    const losses = checkFidelity(draft, value)
    const lossy = Object.keys(losses).length > 0
    if (lossy && current.rejectOnFidelityLoss) {
      writeJson(res, 422, {
        ok: false,
        error: { code: 'fidelity', message: 'hard facts were lost in the rewrite', detail: describeLosses(losses), losses },
      })
      return
    }
    const warnings = []
    if (lossy) warnings.push({ code: 'fidelity', detail: describeLosses(losses), losses })
    if (value.length < draft.length * current.minRatio) {
      warnings.push({ code: 'shorter', detail: 'the rewrite is markedly shorter than the draft' })
    }
    if (outcome.kind === 'maxtokens') {
      warnings.push({ code: 'truncated', detail: 'the rewrite hit the model output limit' })
      registry.progress(record, { degraded: 'truncated' })
    }
    registry.progress(record, { stage: 'done' })
    writeJson(res, 200, {
      ok: true,
      value,
      original: draft,
      ...(warnings.length > 0 ? { warnings } : {}),
      truncated: outcome.kind === 'maxtokens',
      route: { provider: entry.provider, model: entry.model },
      chainSource: index === 0 ? 'primary' : 'fallback',
      elapsedMs: Math.max(0, Date.now() - startedAt),
    })
  }

  /**
   * Read or patch the saved settings.
   * @param {object} req - request.
   * @param {object} res - response.
   * @returns {void}
   */
  function configRoute(req, res) {
    if (req.method === 'GET') {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request rejected' } })
        return
      }
      writeJson(res, 200, { ok: true, config: current, file })
      return
    }
    handle(req, res, 'POST', body => {
      if (body !== null && typeof body === 'object' && body.config !== null && typeof body.config === 'object') {
        const next = mergeConfig(current, body.config)
        const written = writeConfigFile(file, next)
        if (!written.ok) {
          writeJson(res, 500, { ok: false, error: { code: written.code, message: written.message } })
          return
        }
        current = next
        writeJson(res, 200, { ok: true, config: current })
        return
      }
      writeJson(res, 200, { ok: true, config: current })
    })
  }

  ctx.inject(['webServer'], routeCtx => {
    const disposers = []
    const server = routeCtx.get('webServer')
    disposers.push(routeCtx.effect(() => server.register({
      kind: 'exact',
      path: ROUTES.enhance,
      handler: (req, res) => handle(req, res, 'POST', body => enhance(body, res)),
    }), 'dsh-prompt-enhance-wb: enhance route'))
    disposers.push(routeCtx.effect(() => server.register({
      kind: 'exact',
      path: ROUTES.progress,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: { code: 'method', message: 'only GET is allowed' } })
          return
        }
        const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? ''
        const view = registry.view(key)
        if (view === null) {
          writeJson(res, 404, { ok: false, error: { code: 'no-record', message: 'no enhancement is in flight for this key' } })
          return
        }
        writeJson(res, 200, view)
      },
    }), 'dsh-prompt-enhance-wb: progress route'))
    disposers.push(routeCtx.effect(() => server.register({
      kind: 'exact',
      path: ROUTES.cancel,
      handler: (req, res) => handle(req, res, 'POST', body => {
        const key = typeof body.key === 'string' ? body.key : ''
        writeJson(res, 200, { ok: true, cancelled: registry.cancel(key) })
      }),
    }), 'dsh-prompt-enhance-wb: cancel route'))
    disposers.push(routeCtx.effect(() => server.register({
      kind: 'exact',
      path: ROUTES.config,
      handler: (req, res) => configRoute(req, res),
    }), 'dsh-prompt-enhance-wb: config route'))
    return () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* route already gone */ }
      }
    }
  })
}

export { DEFAULTS }
