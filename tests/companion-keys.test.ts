// companion/keys.json lists every key the companion library (the Java side, in companion/) logs. Its own Java tests
// check the library logs exactly these keys; this one checks the list is well formed and that the keys Hindsight
// already reads are on it, so renaming a key on either side fails a test.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROFILES } from '../src/profiles/index.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { LOG_DRIVE_KEYS } from '../src/foresight/keys.ts'

interface CompanionKey { key: string; type: string; module: string }

const { keys } = JSON.parse(readFileSync(new URL('../companion/keys.json', import.meta.url), 'utf8')) as { keys: CompanionKey[] }
const listed = new Set(keys.map((k) => k.key))

describe('companion key list', () => {
  it('is well formed', () => {
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      expect(k.key).toMatch(/^\/[A-Za-z]/)
      expect(['boolean', 'int64', 'double', 'string']).toContain(k.type)
      expect(['core', 'battery']).toContain(k.module)
    }
    expect(listed.size).toBe(keys.length)
  })

  it('has the monitoring keys under /Hindsight', () => {
    const core = keys.filter((k) => k.module === 'core').map((k) => k.key)
    expect(core.every((key) => key.startsWith('/Hindsight/'))).toBe(true)
    for (const key of ['/Hindsight/CANivore/{bus}/UtilizationPercent', '/Hindsight/System/CpuPercent', '/Hindsight/LogDrive/FreeBytes']) {
      expect(core).toContain(key)
    }
  })

  it('has every battery key the 2026 profile reads', () => {
    for (const [field, candidates] of Object.entries(offseason2026.battery)) {
      expect(candidates.some((key) => listed.has(key)), field).toBe(true)
    }
  })

  it('has every battery-tracker key any profile names', () => {
    const trackerKeys = PROFILES.flatMap((p) => Object.values(p.battery).flat())
      .filter((key) => key.startsWith('/BatteryGauge/') || key.startsWith('/RealOutputs/Battery/'))
    expect(trackerKeys.length).toBeGreaterThan(0)
    for (const key of trackerKeys) expect(listed, key).toContain(key)
  })

  it('has the log-drive keys Foresight reads, with their types', () => {
    const types = Object.fromEntries(keys.map((k) => [k.key, k.type]))
    expect(Object.values(LOG_DRIVE_KEYS).map((key) => types[key])).toEqual(['boolean', 'string', 'string', 'string'])
  })
})
