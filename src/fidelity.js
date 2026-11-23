/**
 * Fidelity checking: the reserved seam for the mechanical gate.
 *
 * The enhancement prompt already instructs the model to keep every hard fact
 * verbatim. That instruction is not proof, so this module extracts the facts
 * that must survive and reports which of them did not. The result travels with
 * the enhancement so the client can warn, and config decides whether a
 * violation blocks the rewrite or only annotates it.
 *
 * Kept separate from the call path on purpose: turning the report into a hard
 * rejection later is a config change, not a rewrite of the enhancer.
 * @module dsh-prompt-enhance-wb/fidelity
 */

/**
 * Characters that end a path. CJK punctuation is in here on purpose: a path
 * followed by "：" in Chinese prose is still the same path, and letting the
 * colon join the token made a faithful rewrite look like a loss.
 */
const PATH_STOP = '\\s"\'`<>|*?：:，,。；;！!？?、（）()【】\\[\\]{}'

/**
 * One class of hard fact and the extractor that finds it in a text.
 * Order matters only for reporting; the patterns are independent.
 */
const EXTRACTORS = [
  {
    kind: 'url',
    // Scheme URLs and bare www hosts. Trailing punctuation is not part of it.
    pattern: /https?:\/\/[^\s<>"'`）)】\]]+|(?<![\w.])www\.[^\s<>"'`）)】\]]+/gu,
  },
  {
    kind: 'path',
    // POSIX absolute, Windows drive, UNC, and home-relative paths.
    pattern: new RegExp(
      `(?:[A-Za-z]:\\\\[^${PATH_STOP}]+|//[^${PATH_STOP}]+|/(?:[\\w.-]+/)*[\\w.-]+|~/[^${PATH_STOP}]+)`,
      'gu',
    ),
  },
  {
    kind: 'reference',
    // @file, @folder and @session mentions as the composer writes them.
    pattern: /@[\w./\\-]+/gu,
  },
  {
    kind: 'code',
    // Inline code spans; the delimiters are dropped when compared.
    pattern: /`[^`\n]+`/gu,
  },
  {
    kind: 'number',
    // Numbers with optional units/versions. A leading digit is required so
    // bare unit words are not collected.
    pattern: /\b\d[\d.,]*(?:\.\d+)?(?:%|\b(?:ms|s|kb|mb|gb|px|em|rem|vh|vw|d|h|min)\b)?/giu,
  },
  {
    kind: 'identifier',
    // snake_case, camelCase, SCREAMING_CASE, dotted, and hyphenated names that
    // carry a digit or a separator — plain words stay out to avoid noise.
    pattern: /\b(?:[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Za-z][\w-]*\.[A-Za-z][\w.-]*)\b/gu,
  },
]

/**
 * Whether a collected token is worth enforcing.
 *
 * Numbers and identifiers are the noisiest extractors: a rewrite legitimately
 * drops a filler number or renames a sentence-initial word, and treating that
 * as a violation makes the check unusable. They are kept only when they carry
 * real structure (a unit, a separator, a digit inside a longer token).
 * @param kind - extractor kind.
 * @param token - the matched text.
 * @returns whether a loss of this token counts.
 */
function isSignificant(kind, token) {
  const trimmed = token.trim()
  if (trimmed === '') return false
  if (kind === 'number') return trimmed.length > 1 || /\d/u.test(trimmed)
  // Identifiers only reach here through a structural pattern (snake_case,
  // camelCase, SCREAMING_CASE, dotted or hyphenated), so length is the only
  // extra guard needed; requiring a separator dropped every camelCase name.
  if (kind === 'identifier') return trimmed.length > 2
  return true
}

/**
 * Normalize a token for comparison so cosmetic wrapping does not count as loss.
 * @param token - raw matched text.
 * @returns the comparable form.
 */
function normalizeToken(token) {
  return token.replace(/[`"'“”‘’]/gu, '').replace(/[.,;:!?、。；：！？]+$/u, '').trim()
}

/**
 * Extract the hard facts from one text.
 * @param text - draft or rewrite.
 * @returns map of kind → set of normalized tokens.
 */
export function extractFacts(text) {
  const found = new Map()
  for (const { kind, pattern } of EXTRACTORS) {
    const set = new Set()
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const token = normalizeToken(match[0])
      if (isSignificant(kind, token)) set.add(token)
      // A zero-length match would spin forever; the patterns cannot produce one,
      // but the guard keeps a future pattern from hanging the request.
      if (match[0] === '') pattern.lastIndex += 1
    }
    if (set.size > 0) found.set(kind, set)
  }
  return found
}

/**
 * Report which hard facts from the draft are missing from the rewrite.
 *
 * A URL is also matched by the path and identifier extractors (its `//host/path`
 * tail and its dotted host), so a dropped URL would be reported three times.
 * A token found by a higher-priority extractor is therefore not re-reported by a
 * lower one; a genuine loss is still caught by whichever extractor saw it first.
 *
 * Code spans are compared without their backticks, so re-wrapping a span is not
 * a loss; a genuinely dropped command still is.
 * @param draft - the original composer text.
 * @param rewritten - the model's output.
 * @returns the losses per kind, empty when everything survived.
 */
export function checkFidelity(draft, rewritten) {
  const before = extractFacts(draft)
  const after = extractFacts(rewritten)
  const losses = {}
  const alreadyReported = new Set()
  for (const { kind } of EXTRACTORS) {
    const tokens = before.get(kind)
    if (tokens === undefined) continue
    const present = after.get(kind) ?? new Set()
    const missing = []
    for (const token of tokens) {
      // A code span that lost its backticks is still the same instruction; only
      // a genuinely dropped command counts as a loss.
      if (kind === 'code' && rewritten.includes(token)) continue
      if (present.has(token)) continue
      // A lost URL shows up again as its `//host/path` tail and its dotted host.
      // Skip a token that overlaps one already reported, in either direction, so
      // one lost fact is reported once.
      const overlap = [...alreadyReported].some(seen => seen.includes(token) || token.includes(seen))
      if (overlap) continue
      missing.push(token)
    }
    if (missing.length > 0) {
      losses[kind] = missing
      for (const token of missing) alreadyReported.add(token)
    }
  }
  return losses
}

/**
 * Summarize a fidelity report in one line for the client.
 * @param losses - result of {@link checkFidelity}.
 * @returns a short human-readable summary, or '' when nothing was lost.
 */
export function describeLosses(losses) {
  const parts = []
  for (const [kind, tokens] of Object.entries(losses)) {
    const shown = tokens.slice(0, 3).join(', ')
    const more = tokens.length > 3 ? ` +${tokens.length - 3}` : ''
    parts.push(`${kind}: ${shown}${more}`)
  }
  return parts.join('; ')
}
