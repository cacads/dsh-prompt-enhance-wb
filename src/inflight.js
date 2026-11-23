/**
 * In-flight enhancement registry: one record per (session, sequence).
 *
 * The record is what makes three UI behaviours possible without streaming:
 * a progress read (which model, how long, how many retries), a cancel request
 * (find the AbortController for this exact call), and a late-result guard on the
 * host side (a cancelled call must not write its result anywhere).
 *
 * Records are pruned on read by age, so a browser that walks away mid-call
 * cannot grow this map without bound.
 * @module dsh-prompt-enhance-wb/inflight
 */

/** Stages the client can render. */
export const STAGES = Object.freeze(['queue', 'llm', 'gate', 'done'])

/** How long an unfinished record is kept before being pruned. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * Create a registry.
 * @param {object} [options]
 * @param {number} [options.ttlMs] - record lifetime.
 * @param {() => number} [options.now] - injectable clock for tests.
 * @returns {object} registry operations.
 */
export function createRegistry(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const records = new Map()

  /** Drop records nobody can still be waiting for. */
  function prune() {
    const cutoff = now() - ttlMs
    for (const [key, record] of records) {
      if (record.updatedAt < cutoff) records.delete(key)
    }
  }

  /**
   * Start a record.
   * @param {string} key - `<sessionId>:<seq>`.
   * @returns {object} the mutable record.
   */
  function begin(key) {
    prune()
    const stamp = now()
    const record = {
      key,
      stage: 'queue',
      step: 0,
      total: 0,
      model: '',
      startedAt: stamp,
      updatedAt: stamp,
      degraded: [],
      retries: [],
      cancelled: false,
      timedOut: false,
      controller: new AbortController(),
    }
    records.set(key, record)
    return record
  }

  /**
   * Advance a record.
   * @param {object} record - record from {@link begin}.
   * @param {object} patch - fields to set.
   * @returns {void}
   */
  function progress(record, patch) {
    if (record === null || record === undefined) return
    if (typeof patch.stage === 'string' && STAGES.includes(patch.stage)) record.stage = patch.stage
    if (Number.isFinite(patch.step)) record.step = patch.step
    if (Number.isFinite(patch.total)) record.total = patch.total
    if (typeof patch.model === 'string' && patch.model !== '') record.model = patch.model
    if (typeof patch.degraded === 'string' && !record.degraded.includes(patch.degraded)) record.degraded.push(patch.degraded)
    if (typeof patch.retry === 'string') record.retries.push(patch.retry)
    record.updatedAt = now()
  }

  /**
   * Public view of a record.
   * @param {string} key - record key.
   * @returns {object|null} progress payload, or null when unknown.
   */
  function view(key) {
    const record = records.get(key)
    if (record === undefined) return null
    return {
      ok: true,
      stage: record.stage,
      step: record.step,
      total: record.total,
      model: record.model,
      elapsedMs: Math.max(0, now() - record.startedAt),
      degraded: record.degraded.slice(),
      retries: record.retries.slice(),
      cancelled: record.cancelled,
      timedOut: record.timedOut,
    }
  }

  /**
   * Abort one call.
   * @param {string} key - record key.
   * @returns {boolean} whether a live record was cancelled.
   */
  function cancel(key) {
    const record = records.get(key)
    if (record === undefined) return false
    if (record.stage === 'done') return false
    record.cancelled = true
    record.updatedAt = now()
    try { record.controller.abort() } catch { /* abort is idempotent in practice */ }
    return true
  }

  /**
   * Mark a call finished and drop its record.
   * @param {string} key - record key.
   * @returns {void}
   */
  function finish(key) {
    records.delete(key)
  }

  /**
   * Current record count, for tests and diagnostics.
   * @returns {number} size.
   */
  function size() {
    return records.size
  }

  return { begin, progress, view, cancel, finish, prune, size }
}
