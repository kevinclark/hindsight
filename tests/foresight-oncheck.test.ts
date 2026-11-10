// Foresight grades the on-check rules (mech/pair-decoupled) over the enabled runs since code start, while the robot
// runs, on made-up logs for the 2026 offseason robot's kicker. Replayed the way live.ts reads a robot: records arrive in
// time order, prune() and a check every second. The real cases are in foresight-oncheck-real.test.ts.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { RecordStore } from '../src/foresight/records.ts'
import type { ForesightResult } from '../src/foresight/engine.ts'
import { replayLive } from '../src/foresight/replay.ts'
import { allItems } from '../src/foresight/verdict.ts'
import { markOnRun } from '../src/foresight/onchecks.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { foresightKeys } from '../src/foresight/keys.ts'
import { profileKeys } from '../src/profiles/choose.ts'

const START = 10
const LEADER = '/Indexer/KickerLeaderVelocityRotationsPerSec'
const FOLLOWER = '/Indexer/KickerFollowerVelocityRotationsPerSec'
const LEADER_AMPS = '/Indexer/KickerLeaderStatorCurrentAmp'
const FOLLOWER_AMPS = '/Indexer/KickerFollowerStatorCurrentAmp'

/** A signal every 20 ms from START to `to`. */
function every20ms(name: string, to: number, value: (t: number) => number): FixtureEntry {
  const records: [number, number][] = []
  for (let i = 0; START + i * 0.02 <= to; i++) records.push([START + i * 0.02, value(START + i * 0.02)])
  return { name, type: 'double', records }
}

/**
 * The robot on from START to `to`, enabled over `enables`; the kicker runs at 12 rot/s in each of `bursts`, its leader
 * 12.5 % fast (and carrying 18 % of the current) in `apart`.
 */
function pitRun(o: { to: number; enables: [number, number | null][]; bursts: [number, number][]; apart?: [number, number] }): FixtureEntry[] {
  const named = new Set<string>()
  const entries = kicker(o)
  for (const e of entries) named.add(e.name)
  // Every other signal Foresight reads that the profile names, steady, so the profile fits as it does on the robot.
  const rest = foresightKeys(offseason2026).filter((k) => profileKeys(offseason2026).includes(k) && !named.has(k))
  return [...entries, ...rest.map((name) => ({ name, type: 'double', records: [[START, 0]] as [number, number][] }))]
}

function kicker(o: Parameters<typeof pitRun>[0]): FixtureEntry[] {
  const inside = (t: number, iv: [number, number] | undefined) => !!iv && t >= iv[0] && t < iv[1]
  const kicker = (t: number) => (o.bursts.some((b) => inside(t, b)) ? 12 : 0)
  const apart = (t: number) => inside(t, o.apart) && kicker(t) > 0
  const enabled: [number, boolean][] = [[START, false]]
  for (const [on, off] of o.enables) { enabled.push([on, true]); if (off !== null) enabled.push([off, false]) }
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: enabled },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: [[START, true]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[START, false]] },
    every20ms('/Timestamp', o.to, (t) => Math.round(t * 1e6)),
    every20ms('/SystemStats/BatteryVoltage', o.to, () => 12.7),
    // Every device and camera the profile names is connected, so the profile fits.
    ...[...offseason2026.motorGroups.flatMap((g) => g.motors.map((m) => m.connected!)), ...offseason2026.otherDevices.map((d) => d.connected), ...offseason2026.cameras.map((c) => c.connected)]
      .map((name) => ({ name, type: 'boolean', records: [[START, true]] as [number, boolean][] })),
    every20ms(LEADER, o.to, (t) => (apart(t) ? 1.125 : 1) * kicker(t)),
    every20ms(FOLLOWER, o.to, kicker),
    // Stator current changes every loop, even at rest: a fast "updating" key, kept 30 s only unless latched.
    every20ms(LEADER_AMPS, o.to, (t) => (apart(t) ? 1 : kicker(t) ? 5 : 0.1 + 0.05 * Math.round(t * 50 % 2))),
    every20ms(FOLLOWER_AMPS, o.to, (t) => (apart(t) ? 4.5 : kicker(t) ? 5 : 0.1 + 0.05 * Math.round(t * 50 % 2))),
  ]
}

/** Replayed as live.ts reads a robot (src/foresight/replay.ts), every signal; the result at each whole second. */
function replay(entries: FixtureEntry[], to: number): Map<number, ForesightResult> {
  const steps = [...replayLive(openWpilog(writeWpilog(entries)), offseason2026, undefined, { keys: null })]
  return new Map(steps.filter((s) => s.now <= to + 0.01).map((s) => [Math.round(s.now), s.result]))
}

const pairItem = (r: ForesightResult | undefined) => (r?.onchecks ? allItems(r.onchecks.verdict).find((i) => i.finding.rule === 'mech/pair-decoupled') : undefined)

describe('Foresight grades the on-check run while the robot is enabled', () => {
  const run = pitRun({ to: 140, enables: [[20, null]], bursts: [[30, 33], [45, 48]], apart: [30.5, 31.7] })
  const results = replay(run, 140)

  it('shows the pair amber during the first kicker burst, the robot still enabled, and never reads GO', () => {
    expect(pairItem(results.get(31))).toBeUndefined() // 0.5 s apart so far: not yet
    const during = results.get(32)
    expect(during?.state).toBe('enabled')
    expect(pairItem(during)?.level).toBe('amber')
    expect(pairItem(during)?.finding.title).toMatch(/Kicker leader and Kicker follower ran more than 4 % apart for 1\.2 s/)
    for (const r of results.values()) {
      expect(r.state).not.toBe('checked') // enabled throughout: only the on checks
      expect(r.onchecks?.verdict.verdict).not.toBe('GO')
    }
  })

  it('still names the motor that ran free 100 s later, from stator currents kept past their 30 s', () => {
    const late = results.get(140)
    expect(late?.state).toBe('enabled')
    expect(pairItem(late)?.finding.evidence['ran free']).toBe('Kicker leader')
    expect(pairItem(late)?.finding.evidence['Kicker leader: share of the pair\'s current in it (%)']).toBe(18)
    expect(pairItem(late)?.finding.evidence['cleared later in the log']).toBe('yes')
  })

  it('a healthy run: the on checks read NOT CHECKED (never GO) while enabled, with nothing flagged', () => {
    const healthy = replay(pitRun({ to: 60, enables: [[20, null]], bursts: [[30, 33]] }), 60)
    const r = healthy.get(60)
    expect(r?.state).toBe('enabled')
    expect(r?.onchecks?.verdict.verdict).toBe('NOT CHECKED')
    expect(r?.onchecks?.verdict.items.filter((i) => i.level !== 'grey')).toEqual([])
  })

  it('once disabled and checked, the pair finding joins the verdict as amber', () => {
    const after = replay(pitRun({ to: 120, enables: [[20, 50]], bursts: [[30, 33]], apart: [30.5, 31.7] }), 120)
    const r = after.get(120)
    expect(r?.state).toBe('checked')
    if (r?.state !== 'checked') return
    const item = allItems(r.verdict).find((i) => i.finding.rule === 'mech/pair-decoupled')
    expect(item?.level).toBe('amber')
  })

  it('before any enable the on checks find nothing and the pair rule is listed as not checked', () => {
    const r = replay(pitRun({ to: 60, enables: [], bursts: [] }), 60).get(60)
    expect(r?.onchecks.verdict.items).toEqual([])
    expect(r?.onchecks.report.skipped.find((s) => s.rule === 'mech/pair-decoupled')?.reason).toBe('the robot was never enabled')
    expect(r?.state === 'checked' && r.report.skipped.find((s) => s.rule === 'mech/pair-decoupled')?.reason).toBe('the robot was never enabled')
  })
})

describe('the On checks lines (checklist section 8)', () => {
  const line = (r: ForesightResult | undefined) => markOnRun(r?.onchecks ?? null).find((l) => l.rules?.includes('mech/pair-decoupled'))
  it('mark the pair line amber during the run, saying it came back together later', () => {
    const results = replay(pitRun({ to: 60, enables: [[20, null]], bursts: [[30, 33], [45, 48]], apart: [30.5, 31.7] }), 60)
    expect(line(results.get(32))?.state).toBe('amber')
    expect(line(results.get(60))?.state).toBe('amber')
    expect(line(results.get(60))?.detail).toMatch(/together again for 4\.3 s after/)
    expect(markOnRun(results.get(60)!.onchecks).filter((l) => l.byEye).map((l) => l.state)).toEqual(['by eye', 'by eye', 'by eye', 'by eye', 'by eye'])
  })
  it('say not checked before the robot is enabled, and OK after a run that stayed together', () => {
    expect(line(replay(pitRun({ to: 40, enables: [], bursts: [] }), 40).get(40))).toMatchObject({ state: 'not checked', detail: 'the robot was never enabled' })
    expect(line(replay(pitRun({ to: 40, enables: [[20, null]], bursts: [[30, 33]] }), 40).get(40))?.state).toBe('ok')
  })
})

describe('RecordStore keeps a fast key\'s records inside its kept stretches', () => {
  it('prune and windowLog keep them past the key\'s seconds, and drop the rest', () => {
    const store = new RecordStore()
    const p = new Uint8Array(8)
    for (let t = 0; t <= 100; t += 1) store.add('/fast', 'double', t, p)
    store.recent.set('/fast', 30)
    store.keepDuring.set('/fast', [{ start: 20, end: 22 }])
    store.prune()
    expect(store.entries.get('/fast')!.t).toEqual([20, 21, 22, ...Array.from({ length: 31 }, (_, i) => 70 + i)])
    const window = openWpilog(store.windowLog(0, 100))
    const raw = [...window.entries.values()].find((e) => e.name === '/fast')
    expect(raw).toBeDefined()
  })
})
