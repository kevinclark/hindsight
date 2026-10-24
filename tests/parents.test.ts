// Parents (src/rules/parents.ts): a finding that names a group, made by the reduce stage (consolidate in run.ts).
// The CAN group is shaped like one 2026 match with no bus in the robot profile (25 devices, 614.037–614.284 s); the
// real log is in calgames-logs.test.ts when it is in ~/Downloads.
import { describe, expect, it } from 'vitest'
import { CONSOLIDATORS, LINKS, PARENTS, RULES, ruleById } from '../src/rules/index.ts'
import { consolidate } from '../src/rules/run.ts'
import { link, parent } from '../src/rules/rule.ts'
import type { Finding, Severity } from '../src/rules/types.ts'
import { nest, partitionStanding, withParents } from '../src/report/finding-tree.ts'
import { GROUP_DEVICES } from '../src/rules/parents.ts'

/** A finding as the runner makes it, with these likely causes tagged. */
function finding(rule: string, time: number | null, more: { about?: string; severity?: Severity; likely?: string[] } = {}): Finding {
  const r = ruleById(rule)!
  const likely = more.likely ?? []
  const about = more.about ?? null
  return {
    rule, severity: more.severity ?? r.severity, title: `${rule}${about ? ` ${about}` : ''} at ${time}`, time, matchTime: null, when: null,
    about, key: about ? `${rule} · ${about}` : rule, evidence: {}, meaning: r.meaning, causes: r.causes.map((c) => ({ ...c, ...(likely.includes(c.id) ? { likely: true } : {}) })),
    nextStep: r.nextStep,
  }
}
const dropout = (about: string, time: number, likely = ['shared-wiring']) => finding('can/device-dropout', time, { about, likely })
/** Q2's shape: 11 devices at 614.037 s, 13 at 614.096 s, the roller follower at 614.284 s. */
const q2 = () => [
  ...Array.from({ length: 11 }, (_, i) => dropout(`Device ${i}`, 614.036903)),
  ...Array.from({ length: 13 }, (_, i) => dropout(`Device ${11 + i}`, 614.095688)),
  dropout('Intake roller follower', 614.284119),
]
const GROUP = 'can/devices-dropped-together'
const explainer = (f: Finding) => f.explainedBy?.rule

describe('parents.ts', () => {
  it('groups rules that exist, needs at least 2 to make a group, and its likely causes are its own', () => {
    const ids = new Set(RULES.map((r) => r.id))
    for (const p of PARENTS) {
      expect(ids.has(p.over), p.over).toBe(true)
      expect(ids.has(p.id), `${p.id} is also a rule`).toBe(false)
      expect(p.atLeast).toBeGreaterThanOrEqual(2)
      // The same readers as its group, or under another audience the group would show without its headline.
      expect(p.who).toEqual(ruleById(p.over)!.who)
    }
  })
})

describe('CAN devices dropped together', () => {
  it('Q2 with no bus mapped: 25 dropouts become one headline with the 25 under it', () => {
    const all = q2()
    const parents = consolidate(all, CONSOLIDATORS)
    expect(parents).toHaveLength(1)
    const [group] = parents
    expect(group.title).toBe('25 CAN devices dropped within 0.25 s')
    expect([group.severity, group.time, group.key, group.about]).toEqual(['error', 614.036903, GROUP, null])
    expect(group.causes.filter((c) => c.likely).map((c) => c.id)).toEqual(['bus', 'shared-wiring'])
    expect(all.map(explainer)).toEqual(Array(25).fill(GROUP))
    const heads = nest([group, ...all], [group, ...all])
    expect(heads.map((n) => n.finding)).toEqual([group])
    expect(heads[0].children).toHaveLength(25)
  })

  it('every device low on battery: the battery is the likely cause', () => {
    const all = [dropout('A', 10, ['battery-sag']), dropout('B', 10.2, ['battery-sag']), dropout('C', 10.4, ['battery-sag'])]
    const [group] = consolidate(all, { parents: PARENTS })
    expect(group.causes.filter((c) => c.likely).map((c) => c.id)).toEqual(['battery-sag'])
  })

  it('two devices, or three spread over more than 1 s, are not a group', () => {
    expect(consolidate([dropout('A', 10), dropout('B', 10.1)], CONSOLIDATORS)).toEqual([])
    expect(consolidate([dropout('A', 10), dropout('B', 10.6), dropout('C', 11.2)], CONSOLIDATORS)).toEqual([])
  })

  it('a group is counted from its earliest drop: two events 5 s apart are two groups; a straggler stays alone', () => {
    const all = [dropout('A', 10), dropout('B', 10.5), dropout('C', 11), dropout('D', 11.4), dropout('E', 15), dropout('F', 15), dropout('G', 15.9)]
    const parents = consolidate(all, CONSOLIDATORS)
    expect(parents.map((p) => p.title)).toEqual(['3 CAN devices dropped within 1.00 s', '3 CAN devices dropped within 0.90 s'])
    expect(all.map((f) => f.explainedBy?.time ?? null)).toEqual([10, 10, 10, null, 15, 15, 15])
  })

  it('a device a link already explains is left out of the group: the brownout that dropped it wins', () => {
    const brownout = finding('power/brownout', 9.5)
    const sagged = dropout('Flywheel follower 16', 10, ['battery-sag'])
    const all = [brownout, sagged, dropout('A', 10.1), dropout('B', 10.2), dropout('C', 10.3)]
    const [group] = consolidate(all, CONSOLIDATORS)
    expect(explainer(sagged)).toBe('power/brownout')
    expect(group.title).toBe('3 CAN devices dropped within 0.20 s')
  })
})

describe('the reduce stage runs to a fixpoint', () => {
  // Not in links.ts (no real log has shown it yet): a brownout explaining a group shows why a second pass is needed.
  const brownoutExplainsGroup = link({ cause: 'power/brownout', explains: GROUP, when: () => true, why: 'test' })
  const setup = () => [finding('power/brownout', 9.5), ...q2()]

  it('a link to a parent applies in the second pass, and running again changes nothing', () => {
    const all = setup()
    const crashed: { rule: string; reason: string }[] = []
    const parents = consolidate(all, { links: [brownoutExplainsGroup, ...LINKS], parents: PARENTS }, crashed)
    expect(parents.map(explainer)).toEqual(['power/brownout'])
    const settled = JSON.stringify([all, parents])
    expect(consolidate([...all, ...parents], { links: [brownoutExplainsGroup, ...LINKS], parents: PARENTS }, crashed)).toEqual([])
    expect(JSON.stringify([all, parents])).toBe(settled)
    expect(crashed).toEqual([])
  })

  it('still changing at the pass cap is reported as crashed, not a silent stop', () => {
    const crashed: { rule: string; reason: string }[] = []
    consolidate(setup(), { links: [brownoutExplainsGroup, ...LINKS], parents: PARENTS }, crashed, 2)
    expect(crashed).toEqual([{ rule: 'consolidators', reason: 'did not settle within 2 passes' }])
  })

  it('a parent that throws is listed as crashed and changes nothing', () => {
    const broken = parent({ ...PARENTS[0], id: 'can/broken', name: () => { throw new Error('typo') } })
    const all = q2()
    const crashed: { rule: string; reason: string }[] = []
    expect(consolidate(all, { parents: [broken] }, crashed)).toEqual([])
    expect(crashed).toEqual([{ rule: 'parent can/broken', reason: 'Error: typo' }])
    expect(all.map(explainer)).toEqual(Array(25).fill(undefined))
  })
})

describe('parents in the lists', () => {
  it('a parent sits just before the first of its group in the list, and is left out when none of its group is listed', () => {
    const loss = finding('comms/loss', 500)
    const all = [loss, ...q2()]
    const [group] = consolidate(all, CONSOLIDATORS)
    expect(withParents(all, [group]).slice(0, 3)).toEqual([loss, group, all[1]])
    expect(withParents([loss], [group])).toEqual([loss])
  })

  it('a group that fires in every match folds as standing, though its parent is never in the session history', () => {
    const all = q2()
    const [group] = consolidate(all, CONSOLIDATORS)
    const tree = nest(withParents(all, [group]), [...all, group])
    const standing = new Set(all.map((f) => f.key))
    expect(partitionStanding(tree, standing, [], [group]).folded.map((n) => n.finding)).toEqual([group])
    standing.delete(all[24].key)
    expect(partitionStanding(tree, standing, [], [group]).listed.map((n) => n.finding)).toEqual([group])
  })
})

describe('alerts the robot code raised for a group', () => {
  const group = (devices: string, at = 614) => consolidate(devices.split(', ').map((d, i) => dropout(d, at + i * 0.01)), { parents: PARENTS })[0]
  const alert = (text: string, time = 614.5) => finding('alerts/passthrough', time, { about: text, severity: 'error' })

  it('Q2 with no bus: module and gyro alerts nest under the group, in the pass after it is made', () => {
    const all = q2().map((f, i) => ({ ...f, about: Q2_DEVICES[i] }))
    const alerts = [alert('Missing Module Data', 613.9), alert('Disconnected turn motor on Back Left module!'), alert('Missing Gyro Data')]
    const parents = consolidate([...all, ...alerts], CONSOLIDATORS)
    expect(parents[0].evidence[GROUP_DEVICES]).toContain('Back Left steer')
    expect(alerts.map(explainer)).toEqual([GROUP, GROUP, GROUP])
  })

  it('module means steer only when the group has a steer motor', () => {
    const module = alert('Missing Module Data')
    consolidate([group('Hood, Indexer, Kicker leader'), module], { links: LINKS })
    expect(module.explainedBy).toBeUndefined()
    consolidate([group('Front Left steer, Hood, Indexer'), module], { links: LINKS })
    expect(explainer(module)).toBe(GROUP)
  })

  it('an alert more than 2 s from the group is its own headline', () => {
    const late = alert('Missing Module Data', 616.5)
    consolidate([group('Front Left steer, Hood, Indexer'), late], { links: LINKS })
    expect(late.explainedBy).toBeUndefined()
  })
})

/** one 2026 match's 25 devices in the order they dropped. */
const Q2_DEVICES = [
  'Flywheel leader', 'Flywheel follower 16', 'Flywheel follower 17', 'Flywheel follower 18', 'Hood', 'Intake pivot',
  'Intake roller leader', 'Indexer', 'Kicker leader', 'Kicker follower', 'Intake CANcoder', 'Front Left drive',
  'Front Right drive', 'Back Left drive', 'Back Right drive', 'Front Left steer', 'Front Right steer', 'Back Left steer',
  'Back Right steer', 'Front Left CANcoder', 'Front Right CANcoder', 'Back Left CANcoder', 'Back Right CANcoder',
  'Gyro (Pigeon)', 'Intake roller follower',
]
