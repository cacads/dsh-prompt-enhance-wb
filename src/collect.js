/**
 * Turning one `llm.stream` iterator into a classified result.
 *
 * Three outcomes matter more than the text: a clean finish, a rewrite that hit
 * the provider's token ceiling (still usable, but truncated), and a rewrite that
 * ran past our own character cap (a second generation, not an enhancement).
 * Telling them apart is what lets the host report `truncated` instead of
 * silently returning half a prompt.
 *
 * Chunk shapes are those of the installed harness (`text-delta`, `block-end`,
 * `finish` with `reason.kind`); a chunk shape we do not recognise is skipped
 * rather than fatal, so a harness addition degrades to the text-only path.
 * @module dsh-prompt-enhance-wb/collect
 */

/**
 * @typedef {object} Collected
 * @property {'ok'|'toolong'|'maxtokens'|'error'|'aborted'|'cancelled'} kind
 * @property {string} text - whatever arrived before the outcome
 * @property {object|null} [failure] - provider failure when `kind` is `error`
 * @property {number} [limit] - the cap that `toolong` crossed
 */

/**
 * Drain a completion stream.
 *
 * `outputLimit` is a character ceiling, not a token budget: it exists to stop a
 * runaway rewrite at the point where it can no longer be a rewrite. Zero or a
 * non-finite value disables it.
 * @param {AsyncIterable<object>} stream - the chunk iterator from `llm.stream`.
 * @param {object} [options]
 * @param {number} [options.outputLimit] - character ceiling, 0 = none.
 * @returns {Promise<Collected>} the classified result.
 */
export async function collectReply(stream, options = {}) {
  const limit = Number.isFinite(options.outputLimit) && options.outputLimit > 0 ? options.outputLimit : 0
  let text = ''
  const blocks = []
  let sawDelta = false
  let finish = null
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' || chunk.type === 'text') {
      const delta = typeof chunk.text === 'string' ? chunk.text : ''
      if (delta === '') continue
      if (limit > 0 && text.length + delta.length > limit) return { kind: 'toolong', text, limit }
      sawDelta = true
      text += delta
      continue
    }
    if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object'
      && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
      blocks.push(chunk.block.text)
      continue
    }
    if (chunk.type === 'finish') {
      finish = chunk.reason ?? chunk
      break
    }
  }
  const body = sawDelta ? text : blocks.join('')
  if (finish === null) return { kind: 'cancelled', text: body }
  const kind = typeof finish.kind === 'string' ? finish.kind : ''
  if (kind === 'stop' || kind === 'tool-calls' || kind === '') return { kind: 'ok', text: body }
  if (kind === 'max-tokens') return { kind: 'maxtokens', text: body, failure: finish.failure ?? null }
  if (kind === 'aborted' || kind === 'cancelled') return { kind: 'aborted', text: body }
  return { kind: 'error', text: body, failure: finish.failure ?? null }
}
