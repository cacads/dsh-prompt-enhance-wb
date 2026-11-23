/**
 * Retry arithmetic, kept out of the request path so it can be tested.
 *
 * A plugin that calls `llm.stream` directly sits below the harness's retry
 * layer: the host retries at the agent-loop error watermark, which a plugin
 * never reaches. What the plugin *can* do is ask the provider's resolved policy
 * (`llm.providerRetryPolicy`) and apply the same backoff formula the harness
 * uses, so behaviour matches rather than inventing a second dialect.
 *
 * The formula is copied from the harness's resolved policy semantics:
 * exponential from `initialDelayMs`, capped at `maxDelayMs`, multiplied by a
 * jitter band `1 - j + 2j·random`.
 * @module dsh-prompt-enhance-wb/retry
 */

/** Fallback policy when the provider has none of its own. */
export const DEFAULT_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  initialDelayMs: 800,
  maxDelayMs: 8000,
  jitterRatio: 0.1,
  // The harness's own default retryable codes (`dsh-llm/src/retry-policy.ts`).
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
})

/** Safety cap for `mode: 'always'`, which otherwise never stops retrying. */
export const ALWAYS_SAFETY_CAP = 3

/**
 * Upper bound on retries for one model, whatever the provider asks for.
 *
 * The harness default is five; inside a button click that would mean minutes of
 * spinner time. Three attempts is the point past which the next model in the
 * chain is the better bet.
 */
export const NORMAL_RETRY_CAP = 3

/** Clamp a number into a range without trusting its type. */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Narrow an untrusted policy into the fields used here.
 * @param {object|null|undefined} policy - value from `llm.providerRetryPolicy`.
 * @returns {object} a usable policy.
 */
export function normalizePolicy(policy) {
  if (policy === null || typeof policy !== 'object') return { ...DEFAULT_POLICY }
  const mode = policy.mode === 'always' || policy.mode === 'normal' ? policy.mode : 'normal'
  const codes = Array.isArray(policy.retryableCodes)
    ? policy.retryableCodes.filter(code => typeof code === 'string')
    : DEFAULT_POLICY.retryableCodes.slice()
  return {
    mode,
    maxRetries: Math.trunc(clampNumber(policy.maxRetries, 0, 8, DEFAULT_POLICY.maxRetries)),
    initialDelayMs: Math.trunc(clampNumber(policy.initialDelayMs, 0, 60000, DEFAULT_POLICY.initialDelayMs)),
    maxDelayMs: Math.trunc(clampNumber(policy.maxDelayMs, 0, 120000, DEFAULT_POLICY.maxDelayMs)),
    jitterRatio: clampNumber(policy.jitterRatio, 0, 1, DEFAULT_POLICY.jitterRatio),
    retryableCodes: codes,
  }
}

/**
 * How many retries a policy allows for one model.
 * @param {object} policy - normalized policy.
 * @returns {number} retry count.
 */
export function retryCapOf(policy) {
  if (policy.mode === 'always') return ALWAYS_SAFETY_CAP
  return Math.min(Math.max(0, policy.maxRetries), NORMAL_RETRY_CAP)
}

/**
 * Delay before retry number `attempt` (1-based), jittered.
 * @param {object} policy - normalized policy.
 * @param {number} attempt - 1 for the first retry.
 * @param {() => number} [random] - injectable RNG for tests.
 * @returns {number} delay in milliseconds.
 */
export function computeBackoffDelayMs(policy, attempt, random = Math.random) {
  const p = normalizePolicy(policy)
  const step = Math.min(Math.max(1, Math.trunc(attempt)), 16)
  const exponential = Math.min(p.initialDelayMs * 2 ** (step - 1), p.maxDelayMs)
  const band = 1 - p.jitterRatio + 2 * p.jitterRatio * random()
  return Math.max(0, Math.min(Math.round(exponential * band), p.maxDelayMs))
}

/**
 * Whether a failure is worth retrying under this policy.
 * `STREAM_THROW` (the provider threw before any chunk) is retried even under a
 * policy that does not list it: a synchronous throw is a transport failure by
 * construction, and treating it as fatal would make one bad socket look like a
 * broken model.
 * @param {object} policy - normalized policy.
 * @param {{code?: string}|null|undefined} failure - provider failure.
 * @returns {boolean} whether to retry.
 */
export function isRetryableFailure(policy, failure) {
  const p = normalizePolicy(policy)
  if (p.mode === 'always') return true
  const code = typeof failure?.code === 'string' ? failure.code : ''
  if (code === '') return false
  if (code === 'STREAM_THROW') return true
  return p.retryableCodes.includes(code)
}

/**
 * Resolve the policy for one provider, degrading to the default.
 * @param {(provider: string) => unknown} reader - `llm.providerRetryPolicy`.
 * @param {string} provider - provider id.
 * @returns {object} normalized policy.
 */
export function policyFor(reader, provider) {
  if (typeof reader !== 'function' || provider === '') return { ...DEFAULT_POLICY }
  try {
    return normalizePolicy(reader.call(undefined, provider))
  } catch {
    return { ...DEFAULT_POLICY }
  }
}

/**
 * Sleep, cancellable through the shared abort signal.
 * @param {number} ms - delay.
 * @param {AbortSignal} [signal] - cancels the wait.
 * @returns {Promise<void>} settles on timeout or abort.
 */
export function sleep(ms, signal) {
  return new Promise(resolve => {
    if (ms <= 0) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}
