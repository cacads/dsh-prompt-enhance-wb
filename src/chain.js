/**
 * Model-chain resolution.
 *
 * The chain answers one question: which provider/model pairs may run this
 * rewrite, in what order. Three layers, each one degrading to the next instead
 * of failing the whole enhancement:
 *
 * 1. configured models (`models[]` in the settings file),
 * 2. the session's own route, so an enhancement costs the model the user is
 *    already talking to,
 * 3. the harness default selection.
 *
 * Duplicates are dropped: trying the same model twice only spends budget.
 * @module dsh-prompt-enhance-wb/chain
 */

import { normalizeModel } from './config.js'

/** Never try more routes than this, however the config was written. */
export const MAX_CHAIN = 6

/**
 * Build the ordered, de-duplicated attempt list.
 * @param {Array<{provider: string, model: string}>} configured - `config.models`.
 * @param {{provider: string, model: string}|undefined} sessionRoute - session route.
 * @param {{provider: string, model: string}|undefined} defaultRoute - harness default.
 * @returns {{list: Array<{provider: string, model: string}>, source: 'config'|'session'|'default'|'none'}}
 *   the chain and which layer produced its head.
 */
export function buildChain(configured, sessionRoute, defaultRoute) {
  const candidates = []
  for (const entry of Array.isArray(configured) ? configured : []) {
    const model = normalizeModel(entry)
    if (model !== null) candidates.push(model)
  }
  const seeded = candidates.length > 0
  if (!seeded) {
    const session = normalizeModel(sessionRoute)
    if (session !== null) candidates.push(session)
    else {
      const fallback = normalizeModel(defaultRoute)
      if (fallback !== null) candidates.push(fallback)
    }
  }
  const seen = new Set()
  const list = []
  for (const entry of candidates) {
    const key = `${entry.provider}/${entry.model}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push(entry)
    if (list.length >= MAX_CHAIN) break
  }
  const resolvedSource = list.length === 0
    ? 'none'
    : seeded
      ? 'config'
      : list[0].provider === sessionRoute?.provider && list[0].model === sessionRoute?.model ? 'session' : 'default'
  return { list, source: resolvedSource }
}
