/**
 * Persistence for the saved configuration.
 *
 * The file lives under `DSH_HOME`, not in the package directory: a plugin
 * reinstall wipes that directory, and a setting that silently resets is worse
 * than one that was never offered. Writes are atomic (temp file + rename) so a
 * crash mid-save cannot leave a half-written config behind, and a size cap stops
 * an edited file from being used as a write amplifier.
 * @module dsh-prompt-enhance-wb/store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Refuse to load or save anything larger than this. */
export const CONFIG_SIZE_LIMIT = 256 * 1024

/**
 * Read the saved config, tolerating every failure.
 *
 * A missing, unreadable, oversized or malformed file yields `{}`: the plugin
 * then runs on defaults rather than refusing to start because a user edited the
 * JSON by hand.
 * @param {string} file - absolute path.
 * @returns {object} the parsed config, or `{}`.
 */
export function readConfigFile(file) {
  try {
    const text = readFileSync(file, 'utf8')
    if (text.length > CONFIG_SIZE_LIMIT) return {}
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * Write the config atomically.
 * @param {string} file - absolute path.
 * @param {object} config - config to persist.
 * @returns {{ok: true} | {ok: false, code: string, message: string}} the outcome.
 */
export function writeConfigFile(file, config) {
  const text = JSON.stringify(config, null, 2)
  if (text.length > CONFIG_SIZE_LIMIT) {
    return { ok: false, code: 'config-too-large', message: `config exceeds ${CONFIG_SIZE_LIMIT} bytes` }
  }
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* the temp file may never have existed */ }
    return { ok: false, code: 'config-write-failed', message: error instanceof Error ? error.message : String(error) }
  }
}
