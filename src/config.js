/**
 * Configuration: defaults, normalization, and the one file it is saved to.
 *
 * Two sources are merged, in this order, so a saved setting always wins over
 * the bundle patch that seeded it: the plugin row in `cordis.patch.yml` (which
 * an install would otherwise reset) and the JSON file under `DSH_HOME` written
 * by the settings page. Keeping the file outside the package directory is
 * deliberate — reinstalling a plugin wipes that directory (AGENTS §2.3).
 * @module dsh-prompt-enhance-wb/config
 */

import { dirname, join } from 'node:path'

/** Where a saved configuration lives, relative to `DSH_HOME`. */
export const CONFIG_DIRNAME = '.dsh-prompt-enhance-wb'
export const CONFIG_FILENAME = 'config.json'

/** Every tunable, with the value used when nothing else says otherwise. */
export const DEFAULTS = Object.freeze({
  /** Refuse drafts longer than this many characters. */
  maxInputChars: 8000,
  /** Upper length bound in the instruction, and the hard cap on the answer. */
  maxOutputChars: 4000,
  /** Whole-call budget across every model attempt. */
  timeoutMs: 90000,
  /** Sampling temperature; a negative value leaves the provider default. */
  temperature: 0.3,
  /** A rewrite shorter than this fraction of the draft is flagged. */
  minRatio: 0.6,
  /** Block, rather than annotate, a rewrite that dropped hard facts. */
  rejectOnFidelityLoss: false,
  /** Carry earlier confirmed rewrites into the next call. */
  memory: false,
  /** Preferred models, tried in order; empty = session route, then default. */
  models: Object.freeze([]),
})

/** Clamp an integer into a range, falling back when it is not a number. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Clamp a float into a range, falling back when it is not a number. */
function clampFloat(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Normalize one model entry.
 * @param {unknown} candidate - `{provider, model}` from config.
 * @returns {{provider: string, model: string}|null} the entry, or null if unusable.
 */
export function normalizeModel(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * Normalize a config patch over the defaults.
 *
 * Unknown keys are dropped rather than carried: a config file is user-editable
 * and a stale key must not resurrect a behaviour this version no longer has.
 * @param {object} patch - untrusted config.
 * @returns {object} a complete config.
 */
export function normalizeConfig(patch = {}) {
  const source = patch !== null && typeof patch === 'object' ? patch : {}
  const raw = Array.isArray(source.models) ? source.models : []
  const models = raw.map(normalizeModel).filter(entry => entry !== null).slice(0, 6)
  // The pre-1.1 surface had a single provider/model pair; honour it so an
  // upgraded profile keeps using the route it was configured with.
  if (models.length === 0) {
    const legacy = normalizeModel({ provider: source.provider, model: source.model })
    if (legacy !== null) models.push(legacy)
  }
  return {
    maxInputChars: clampInt(source.maxInputChars, 200, 100000, DEFAULTS.maxInputChars),
    maxOutputChars: clampInt(source.maxOutputChars, 200, 50000, DEFAULTS.maxOutputChars),
    timeoutMs: clampInt(source.timeoutMs, 5000, 600000, DEFAULTS.timeoutMs),
    temperature: clampFloat(source.temperature, -1, 2, DEFAULTS.temperature),
    minRatio: clampFloat(source.minRatio, 0, 1, DEFAULTS.minRatio),
    rejectOnFidelityLoss: source.rejectOnFidelityLoss === true,
    memory: source.memory === true,
    models,
  }
}

/**
 * Merge a patch over a base config, then normalize.
 * @param {object} base - current config.
 * @param {object} patch - changes.
 * @returns {object} merged config.
 */
export function mergeConfig(base, patch) {
  return normalizeConfig({ ...(base !== null && typeof base === 'object' ? base : {}), ...(patch !== null && typeof patch === 'object' ? patch : {}) })
}

/**
 * Absolute path of the saved config.
 * @param {string} dshHome - `DSH_HOME`.
 * @returns {string} path to `config.json`.
 */
export function configFileOf(dshHome) {
  return join(dshHome, CONFIG_DIRNAME, CONFIG_FILENAME)
}

/**
 * Absolute directory holding the saved config.
 * @param {string} dshHome - `DSH_HOME`.
 * @returns {string} directory path.
 */
export function configDirOf(dshHome) {
  return dirname(configFileOf(dshHome))
}
