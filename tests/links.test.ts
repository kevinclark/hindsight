// Links between findings (src/rules/links.ts) and how the lists nest them (src/report/finding-tree.ts). The chains
// are shaped like the real ones (CalGames Q13, P0, Q21; MTTD Q41, Q61), with their times and evidence; the real logs
// themselves are checked in calgames-logs.test.ts and mttd-rules.test.ts when they are in ~/Downloads.
import { describe, expect, it } from 'vitest'
import { FORESIGHT_RULES, LINKS, RULES, ruleById, runRules } from '../src/rules/index.ts'
import { linkFindings } from '../src/rules/run.ts'
import type { Finding, Severity } from '../src/rules/types.ts'
import { BUS_DEVICES } from '../src/rules/can/bus-dropout.ts'
import { nest, severityWords } from '../src/report/finding-tree.ts'
import { reviewCard, reviewModel } from '../src/report/review-model.ts'
import { link } from '../src/rules/rule.ts'
import { analyzeFixture } from './helpers/load.ts'

/** A finding as the runner makes it: the rule's causes with these likely ones first. */
function finding(rule: string, time: number | null, more: { about?: string; severity?: Severity; likely?: string[]; evidence?: Finding['evidence'] } = {}): Finding {
  const r = ruleById(rule)!
  const likely = more.likely ?? []
  const causes = [...r.causes]
    .sort((a, b) => Number(likely.includes(b.id)) - Number(likely.includes(a.id)) || likely.indexOf(a.id) - likely.indexOf(b.id))
    .map((c) => (likely.includes(c.id) ? { ...c, likely: true } : { ...c }))
  const about = more.about ?? null
  return {
    rule, severity: more.severity ?? r.severity, title: `${rule}${about ? ` ${about}` : ''} at ${time}`, time, matchTime: null, when: null,
    about, key: about ? `${rule} · ${about}` : rule, evidence: more.evidence ?? {}, meaning: r.meaning, causes, nextStep: r.nextStep,
  }
}
const explainer = (f: Finding) => f.explainedBy && `${f.explainedBy.rule}${f.explainedBy.about ? ` · ${f.explainedBy.about}` : ''}`
const alert = (text: string, time: number | null, severity: Severity = 'error') => finding('alerts/passthrough', time, { about: text, severity })

describe('links.ts', () => {
  it('names only rules that exist, never links a rule to itself, and has no cycle', () => {
    const ids = new Set(RULES.map((r) => r.id))
    for (const l of LINKS) {
      expect(ids.has(l.cause), l.cause).toBe(true)
      expect(ids.has(l.explains), l.explains).toBe(true)
      expect(l.cause).not.toBe(l.explains)
    }
    // Depth-first from every rule: reaching a rule already on the path is a cycle.
    const next = (id: string) => LINKS.filter((l) => l.cause === id).map((l) => l.explains)
    const visit = (id: string, path: string[]): void => {
      expect(path, `cycle: ${[...path, id].join(' → ')}`).not.toContain(id)
      for (const n of next(id)) visit(n, [...path, id])
    }
    for (const id of ids) visit(id, [])
  })

  it('Q13: hood zero → tilt → early disable, and the comms loss → the DS log stopping', () => {
    const zero = finding('mech/zero-not-completed', 270.945, { about: 'Hood', evidence: { 'zero completed (robot time, s)': 293.53 } })
    const tilt = finding('collision/tilt', 281.874, { about: 'Pitch', severity: 'error' })
    const disable = finding('auto/early-disable', 282.693, { likely: ['wedged'] })
    const loss = finding('comms/loss', 417.404, { likely: ['ds-laptop'] })
    const ds = finding('comms/ds-log-truncated', 420.479)
    const all = [loss, disable, tilt, zero, ds]
    linkFindings(all, LINKS)
    expect(all.map(explainer)).toEqual([undefined, 'collision/tilt · Pitch', 'mech/zero-not-completed · Hood', undefined, 'comms/loss'])
    expect(nest(all, all).map((n) => n.finding)).toEqual([loss, zero])
  })

  it('P0: collapse → brownout → follower dropout → its alert, and brownout → margin below zero', () => {
    const brownout = finding('power/brownout', 532.770, { likely: ['weak-battery'] })
    const collapse = finding('power/battery-collapse', 542.262, { severity: 'error', likely: ['weak-battery'] })
    const dropout = finding('can/device-dropout', 535.307, { about: 'Flywheel follower 16', likely: ['battery-sag', 'device-power'] })
    const follower = alert('Flywheel Follower Disconnected', 535.307)
    const margin = finding('power/margin', 541.168, { likely: ['weak-battery', 'load'], evidence: { 'margin (V)': -0.31 } })
    const all = [brownout, collapse, dropout, follower, margin]
    linkFindings(all, LINKS)
    expect(all.map(explainer)).toEqual(['power/battery-collapse', undefined, 'power/brownout', 'can/device-dropout · Flywheel follower 16', 'power/brownout'])
    const [headline] = nest(all, all)
    expect(headline.finding).toBe(collapse)
    expect(headline.children[0].children.map((c) => c.finding)).toEqual([dropout, margin])
  })

  it('Q61: the brownout ranked by the collapse nests; a brownout whose top cause is the load does not', () => {
    const collapse = finding('power/battery-collapse', 705.729)
    const brownout = finding('power/brownout', 703.006, { likely: ['weak-battery'] })
    const load = finding('power/brownout', 703.006, { likely: ['load', 'weak-battery'] })
    linkFindings([collapse, brownout], LINKS)
    linkFindings([collapse, load], LINKS)
    expect(explainer(brownout)).toBe('power/battery-collapse')
    expect(load.explainedBy).toBeUndefined()
  })

  it('Q21: the camera dropout explains both of its alerts, but not the other camera\'s', () => {
    const stale = finding('vision/stale', 394.717, { about: 'Back_Right', likely: ['connection', 'coprocessor'] })
    const red = alert('Back_Right Camera Disconnected!', 394.717)
    const amber = alert("PhotonCamera 'Back_Right' is disconnected.", 394.717, 'warning')
    const other = alert('Back_Left Camera Disconnected!', 394.717)
    const all = [red, other, stale, amber]
    linkFindings(all, LINKS)
    expect(all.map(explainer)).toEqual(['vision/stale · Back_Right', undefined, undefined, 'vision/stale · Back_Right'])
    // A link never hides a red under an amber: the red alert stays a headline and says what explains it.
    const heads = nest(all, all)
    expect(heads.map((n) => n.finding)).toEqual([red, other, stale])
    expect(heads[0].note).toMatch(/^explained by vision\/stale Back_Right/)
    expect(heads[2].children.map((c) => c.finding)).toEqual([amber])
  })

  it('Q41: the bus drop explains the module and gyro alerts, not "Using Sync Odometry" or a camera alert at the same moment', () => {
    const bus = finding('can/bus-dropout', 745.063, { about: 'CANivore bus', likely: ['bus'], evidence: { [BUS_DEVICES]: 'Gyro (Pigeon), Front Left module, Front Right module, Back Left module, Back Right module' } })
    const module = alert('Missing Module Data', 744.218)
    const gyro = alert('Missing Gyro Data', 744.218, 'warning')
    const sync = alert('Using Sync Odometry', 744.249, 'info')
    const camera = alert("PhotonCamera 'Back_Right' is disconnected.", 744.5, 'warning')
    const later = alert('Missing Module Data again', 747.1)
    const all = [bus, module, gyro, camera, sync, later]
    linkFindings(all, LINKS)
    expect(all.map(explainer)).toEqual([undefined, 'can/bus-dropout · CANivore bus', 'can/bus-dropout · CANivore bus', undefined, undefined, undefined])
  })

  it('an alert naming another device of the same kind stays separate (follower 17 is not follower 16)', () => {
    const dropout = finding('can/device-dropout', 535.307, { about: 'Flywheel follower 16', likely: ['battery-sag'] })
    const other = alert('Flywheel Follower 17 Disconnected', 535.4)
    const same = alert('Flywheel Follower Disconnected', 535.307)
    linkFindings([dropout, other, same], LINKS)
    expect([explainer(other), explainer(same)]).toEqual([undefined, 'can/device-dropout · Flywheel follower 16'])
  })

  it('a link that throws is listed as crashed and the other links still run', () => {
    const broken = link({ cause: 'power/brownout', explains: 'power/margin', when: () => { throw new Error('typo') }, why: 'x' })
    const brownout = finding('power/brownout', 703, { likely: ['weak-battery'] })
    const collapse = finding('power/battery-collapse', 705, { severity: 'error' })
    const margin = finding('power/margin', 703.3, { evidence: { 'margin (V)': -0.06 } })
    const crashed: { rule: string; reason: string }[] = []
    linkFindings([brownout, collapse, margin], [broken, ...LINKS], crashed)
    expect(crashed).toEqual([{ rule: 'link power/brownout → power/margin', reason: 'Error: typo' }])
    expect(explainer(brownout)).toBe('power/battery-collapse')
  })

  it('stays quiet: a dropout at normal voltage, a dropout before the brownout, a margin above zero, an alert only outside the match', () => {
    const brownout = finding('power/brownout', 423.539)
    const normal = finding('can/device-dropout', 430, { about: 'Intake roller follower', likely: ['can-connector'] })
    const before = finding('can/device-dropout', 400, { about: 'Flywheel follower 16', likely: ['battery-sag'] })
    const margin = finding('power/margin', 423.539, { evidence: { 'margin (V)': 0.16 } })
    const outside = alert('Flywheel Follower Disconnected', null, 'info')
    const all = [brownout, normal, before, margin, outside]
    linkFindings(all, LINKS)
    expect(all.map(explainer)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('stays quiet: a tilt in teleop after an early disable, a disable that was not wedged, a tilt after the zero landed', () => {
    const zero = finding('mech/zero-not-completed', 270.9, { about: 'Hood', evidence: { 'zero completed (robot time, s)': 293.5 } })
    const disable = finding('auto/early-disable', 282.7, { likely: ['wedged'] })
    const teleopTilt = finding('collision/tilt', 300, { about: 'Roll' })
    const newAuto = finding('auto/early-disable', 301, { likely: ['new-auto'] })
    const all = [disable, newAuto, teleopTilt, zero]
    linkFindings(all, LINKS)
    expect(all.map(explainer)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('a zero that never completed explains a later tilt in auto, not one in teleop', () => {
    const zero = finding('mech/zero-not-completed', 83.4, { about: 'Intake pivot', evidence: { 'zero completed (robot time, s)': 'never' } })
    const inAuto = finding('collision/tilt', 90, { about: 'Pitch', severity: 'error', evidence: { phase: 'auto' } })
    const inTeleop = finding('collision/tilt', 150, { about: 'Roll', evidence: { phase: 'teleop' } })
    linkFindings([zero, inAuto, inTeleop], LINKS)
    expect([explainer(inAuto), explainer(inTeleop)]).toEqual(['mech/zero-not-completed · Intake pivot', undefined])
  })
})

describe('nesting in the lists', () => {
  const collapse = finding('power/battery-collapse', 542, { severity: 'error' }) // red when the match browned out
  const brownout = finding('power/brownout', 532, { likely: ['weak-battery'] })
  const margin = finding('power/margin', 541, { evidence: { 'margin (V)': -0.3 } })
  const all = [brownout, collapse, margin]
  linkFindings(all, LINKS)

  it('a finding whose headline is a known issue is a headline in the active list, labelled', () => {
    const active = [brownout, margin]
    const heads = nest(active, all, [collapse])
    expect(heads.map((n) => n.finding)).toEqual([brownout])
    expect(heads[0].note).toMatch(/^explained by a known issue \(power\/battery-collapse at 542\): /)
    expect(heads[0].children.map((c) => c.finding)).toEqual([margin])
  })

  it('a finding whose headline is not shown (another audience) says what explains it', () => {
    const heads = nest([margin], all)
    expect(heads[0].note).toBe('explained by power/brownout at 532: the voltage went below the brownout setting, so there was no margin left')
  })

  it('a chain with a known middle: the finding under it becomes an active headline, labelled', () => {
    const active = [collapse, margin]
    const heads = nest(active, all, [brownout])
    expect(heads.map((n) => n.finding)).toEqual([collapse, margin])
    expect(heads[0].children).toEqual([])
    expect(heads[1].note).toMatch(/^explained by a known issue \(power\/brownout at 532\): /)
  })

  it('a finding that came back after a fix stays a headline', () => {
    const heads = nest(all, all, [], [brownout])
    expect(heads.map((n) => n.finding)).toEqual([brownout, collapse])
    expect(heads[0].children.map((c) => c.finding)).toEqual([margin])
  })

  it('says how serious the nested findings are', () => {
    expect(severityWords([brownout, margin, finding('alerts/passthrough', 1)])).toBe('1 error, 1 warning, 1 info')
  })
})

describe('the pass runs for match analysis only', () => {
  const [p0] = analyzeFixture('p0-brownout').analyses

  it('match analysis links the P0 cut; the card lists the headline once and counts every error', () => {
    const linked = p0.report.findings.filter((f) => f.explainedBy).map((f) => `${f.rule} ← ${f.explainedBy!.rule}`)
    expect(linked.length).toBeGreaterThan(0)
    const model = reviewModel(p0, new Map())
    const card = reviewCard(model)
    expect(card.heading).toBe(`${model.errors.length} errors`)
    expect(card.items.length).toBe(model.headlines.filter((n) => n.finding.severity === 'error').length)
  })

  it('Foresight rules, and runRules without links, leave explainedBy off', () => {
    for (const report of [runRules(p0.match, FORESIGHT_RULES), runRules(p0.match)]) {
      expect(report.findings.filter((f) => f.explainedBy)).toEqual([])
    }
  })
})
