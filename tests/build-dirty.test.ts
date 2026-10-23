// build/dirty reads AdvantageKit's GitDirty text. Older AdvantageKit versions spell it "Uncomitted changes" (one m),
// so the rule must accept both spellings. Made-up logs: event TEST, an invented commit.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const WALL = 1762637000 // epoch seconds

/** A 2025-robot log, enabled from 20 to 80 s, built from commit 1a2b3c4 with the given GitDirty text. */
function log(gitDirty: string): FixtureEntry[] {
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[5, false], [20, true], [80, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[5, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[5, true]] },
    { name: '/DriverStation/EventName', type: 'string', records: [[5, 'TEST']] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[5, (WALL + 5) * 1e6], [90, (WALL + 90) * 1e6]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[5, 12.5], [90, 12.4]] },
    { name: '/RealMetadata/GitSHA', type: 'string', records: [[5, '1a2b3c4d5e6f']] },
    { name: '/RealMetadata/GitDirty', type: 'string', records: [[5, gitDirty]] },
  ]
}

const findings = (entries: FixtureEntry[]) =>
  analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(entries) }], offseason2025).analyses[0].report.findings.filter((f) => f.rule === 'build/dirty')

describe('build/dirty: both spellings of AdvantageKit\'s GitDirty', () => {
  it.each(['Uncommitted changes', 'Uncomitted changes'])('fires on "%s"', (text) => {
    const [f] = findings(log(text))
    expect(f.title).toBe('Robot ran uncommitted changes on top of 1a2b3c4')
    expect(f.evidence.GitDirty).toBe(text)
  })

  it('stays quiet on "All changes committed"', () => {
    expect(findings(log('All changes committed'))).toEqual([])
  })
})
