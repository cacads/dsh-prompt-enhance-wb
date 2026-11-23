/**
 * The Host half: one POST route that turns a composer draft into an enhanced
 * prompt through the harness LLM service.
 *
 * The call reuses the session's own route when the browser supplies a session
 * id, so an enhancement costs the same model the user is already talking to and
 * needs no API key of its own. WorkBuddy does the equivalent with a dedicated
 * cheap "lite" model; here that is the session route unless config overrides it.
 * @module dsh-prompt-enhance-wb/index
 */

import { systemPromptFor, frameUserPrompt } from './src/prompts.js'
import { checkFidelity, describeLosses } from './src/fidelity.js'

/** Prefix the browser half posts to. */
export const ENDPOINT = '/dsh-prompt-enhance-wb/enhance'

/** Defaults; every value is overridable from the plugin row's `config`. */
const DEFAULTS = {
  maxInputChars: 8000,
  maxOutputChars: 4000,
  timeoutMs: 60000,
  /** A rewrite shorter than this fraction of the draft is treated as a loss. */
  minRatio: 0.6,
  /** Block (rather than only annotate) when hard facts go missing. */
  rejectOnFidelityLoss: false,
  /** Pin a provider/model; blank means use the session route, then the default. */
  provider: '',
  model: '',
}

export const name = 'dsh-prompt-enhance-wb'
export const inject = ['llm']

/**
 * Read a bounded JSON body.
 * @param req - incoming request.
 * @param cap - byte ceiling.
 * @returns the parsed body.
 */
async function readJson(req, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * Write a JSON response.
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param body - serializable body.
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
 * Collect a streamed completion into plain text.
 * @param stream - the chunk iterator from `ctx.llm.stream`.
 * @returns the accumulated text.
 */
async function collectText(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/**
 * Strip the wrappers a model sometimes adds around an otherwise correct answer.
 * @param text - raw model output.
 * @returns the bare prompt body.
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
 * @param ctx - registrant context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
function serviceOf(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * The session's own route: the provider/model of its last request header.
 *
 * `requestHeader` is a method in every release checked; the property shape is
 * accepted too so a change in either direction degrades to the other branch.
 * @param ctx - registrant context.
 * @param sessionId - the session behind the composer.
 * @returns the route, or undefined.
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
 * @param ctx - registrant context.
 * @returns the route, or undefined.
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
 * Resolve the model route for one call: config override, then the session's
 * route, then the harness default. Every layer degrades to the next instead of
 * failing the enhancement.
 * @param ctx - registrant context.
 * @param config - merged plugin config.
 * @param sessionId - optional session whose route to reuse.
 * @returns provider and model, or undefined when nothing is configured.
 */
function resolveRoute(ctx, config, sessionId) {
  return routeOf({ provider: config.provider, model: config.model })
    ?? sessionRouteOf(ctx, sessionId)
    ?? defaultRouteOf(ctx)
}

/**
 * Mount the plugin.
 * @param ctx - registrant context.
 * @param config - row config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config }

  // The browser talks to this plugin over one HTTP route, so a profile without
  // a webserver (pure CLI, and some Electron launches) has nowhere to mount it.
  // Say so once at load: otherwise the button renders, every click fails, and
  // the cause is invisible. `inject` below still registers the route normally
  // when the service is present; it does not fire at all when it is not.
  if (serviceOf(ctx, 'webServer') === undefined) {
    const logger = serviceOf(ctx, 'logger') ?? console
    const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : console.warn
    warn('[dsh-prompt-enhance-wb] no webServer service in this profile; the composer button will have no endpoint to call.')
  }

  ctx.inject(['webServer'], routeCtx => {
    const dispose = routeCtx.effect(() => {
      return routeCtx.get('webServer').register({
        kind: 'exact',
        path: ENDPOINT,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method', message: 'only POST is allowed' } })
            return
          }
          let body
          try {
            body = await readJson(req, merged.maxInputChars * 6 + 4096)
          } catch {
            writeJson(res, 400, { ok: false, error: { code: 'body', message: 'invalid JSON body' } })
            return
          }
          const text = typeof body?.text === 'string' ? body.text : ''
          if (text.trim() === '') {
            writeJson(res, 422, { ok: false, error: { code: 'empty', message: 'draft is empty' } })
            return
          }
          if (text.length > merged.maxInputChars) {
            writeJson(res, 422, {
              ok: false,
              error: { code: 'too-long', message: `draft exceeds ${merged.maxInputChars} characters`, count: text.length, max: merged.maxInputChars },
            })
            return
          }
          const route = resolveRoute(ctx, merged, body?.sessionId)
          if (route === undefined) {
            writeJson(res, 409, { ok: false, error: { code: 'unconfigured', message: 'no model route is configured' } })
            return
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), merged.timeoutMs)
          // Cancel the model call when the browser walks away mid-flight.
          const onClose = () => {
            if (!res.writableEnded) controller.abort()
          }
          res.on('close', onClose)
          try {
            const stream = ctx.get('llm').stream({
              provider: route.provider,
              model: route.model,
              system: systemPromptFor(merged.maxOutputChars),
              messages: [{ role: 'user', content: [{ type: 'text', text: frameUserPrompt(text) }] }],
              signal: controller.signal,
              ...(typeof body?.sessionId === 'string' && body.sessionId !== '' ? { sessionId: body.sessionId } : {}),
            })
            const raw = await collectText(stream)
            const value = normalizeOutput(raw)
            if (value === '') {
              writeJson(res, 502, { ok: false, error: { code: 'empty-result', message: 'the model returned nothing' } })
              return
            }
            // Fidelity is reported, not enforced, unless config says otherwise:
            // the model sees the requirement in the prompt either way.
            const losses = checkFidelity(text, value)
            const lossy = Object.keys(losses).length > 0
            if (lossy && merged.rejectOnFidelityLoss) {
              writeJson(res, 422, {
                ok: false,
                error: { code: 'fidelity', message: 'hard facts were lost in the rewrite', detail: describeLosses(losses), losses },
              })
              return
            }
            // One warning slot, so both gates are combined instead of letting
            // the later spread silently overwrite the earlier one.
            const warnings = []
            if (lossy) warnings.push({ code: 'fidelity', detail: describeLosses(losses), losses })
            if (value.length < text.length * merged.minRatio) {
              warnings.push({ code: 'shorter', detail: 'the rewrite is markedly shorter than the draft' })
            }
            writeJson(res, 200, {
              ok: true,
              value,
              original: text,
              ...(warnings.length > 0 ? { warnings } : {}),
              route: { provider: route.provider, model: route.model },
            })
          } catch (error) {
            const aborted = controller.signal.aborted
            writeJson(res, aborted ? 504 : 502, {
              ok: false,
              error: { code: aborted ? 'timeout' : 'llm', message: error instanceof Error ? error.message : String(error) },
            })
          } finally {
            clearTimeout(timer)
            res.off('close', onClose)
          }
        },
      })
    }, 'dsh-prompt-enhance-wb: enhance route')
    return dispose
  })
}
