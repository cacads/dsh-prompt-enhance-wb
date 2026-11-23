import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readConfigFile, writeConfigFile, CONFIG_SIZE_LIMIT } from '../src/store.js'

/** A throwaway directory per test. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-penh-'))
  const file = join(dir, 'nested', 'config.json')
  mkdirSync(join(dir, 'nested'), { recursive: true })
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a missing file reads as empty instead of throwing', () => {
  const { file, cleanup } = scratch()
  try {
    assert.deepEqual(readConfigFile(file), {})
  } finally {
    cleanup()
  }
})

test('a malformed file reads as empty', () => {
  const { dir, file, cleanup } = scratch()
  try {
    writeFileSync(file, '{not json', 'utf8')
    assert.deepEqual(readConfigFile(file), {})
    writeFileSync(file, '[1,2,3]', 'utf8')
    assert.deepEqual(readConfigFile(file), {})
  } finally {
    cleanup()
    void dir
  }
})

test('an oversized file is refused rather than loaded', () => {
  const { dir, file, cleanup } = scratch()
  try {
    writeFileSync(file, JSON.stringify({ pad: 'x'.repeat(CONFIG_SIZE_LIMIT + 10) }), 'utf8')
    assert.deepEqual(readConfigFile(file), {})
  } finally {
    cleanup()
    void dir
  }
})

test('a save creates the directory and round-trips', () => {
  const { file, cleanup } = scratch()
  try {
    const written = writeConfigFile(file, { memory: true, models: [] })
    assert.deepEqual(written, { ok: true })
    assert.deepEqual(readConfigFile(file), { memory: true, models: [] })
    assert.equal(readFileSync(file, 'utf8').includes('\n  "memory"'), true)
  } finally {
    cleanup()
  }
})

test('an oversized config is refused without leaving a temp file', () => {
  const { dir, file, cleanup } = scratch()
  try {
    const result = writeConfigFile(file, { pad: 'x'.repeat(CONFIG_SIZE_LIMIT + 10) })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'config-too-large')
    assert.throws(() => readFileSync(`${file}.tmp`, 'utf8'))
  } finally {
    cleanup()
    void dir
  }
})
