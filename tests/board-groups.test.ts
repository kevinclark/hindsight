/**
 * The board files one row per event a parent groups (src/rules/parents.ts): the devices that dropped off CAN together, and the
 * alerts about them, are one issue on the board, not one each. Invented event TEST and invented devices; no real match or verdict.
 */
import { describe, expect, it } from 'vitest'
import { boardCounts, buildBoard, groupWords, isGate, isRed, RED_CAP, type Board, type BoardIssue } from '../src/board/model.ts'
import { handoff, queueSheet } from '../src/board/sheets.ts'
import { boardLines, fieldChanges, greyTake } from '../src/board/writes.ts'
import { ownerText, rowTitle, statusLine, tags } from '../src/board/words.ts'
import { redsDueBefore, stillOf } from '../src/now/now.ts'
import { openDeferrals, queueChecklist } from '../src/foresight/checklists.ts'
import type { BoardEvent, HistoryEvent } from '../src/triage/history.ts'
import type { SummaryFinding } from '../src/session/summary.ts'
import { BASE, ROBOT, SCHEDULE, input, match, profile, session } from './helpers/board-scene.ts'

const PARENT = 'can/devices-dropped-together'
const DROP = 'can/device-dropout'
const ALERT = 'alerts/error'
const T = 100.5
const WHEN = '0:59 into the match (teleop; robot time 100.5 s)'
const dev = (n: number) => `Device ${n}`
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()

function finding(rule: string, about: string, severity: 'error' | 'warning', explainedBy: SummaryFinding['explainedBy'] | null, time = T): SummaryFinding {
  return {
    key: `${rule} · ${about}`, rule, about, severity, title: `test finding ${rule} · ${about}`, time, matchTime: null, when: WHEN,
    evidence: {}, likely: [], ruledOut: {}, ...(explainedBy ? { explainedBy } : {}),
  } as unknown as SummaryFinding
}

/**
 * Match n with a cluster of the shape a CAN cut makes: `drops` devices that dropped together (red, explained by the parent), `direct` alerts the
 * parent explains (amber), and `through` alerts explained by one of the dropped devices (amber, a link). Plus `others`: keys that
 * fire on their own.
 */
function clusterMatch(n: number, c: { drops: number; direct?: number; through?: number; others?: string[]; t?: number; names?: string[] }) {
  const t = c.t ?? T
  const m = match(n, { fires: (c.others ?? []).map((key) => ({ key, severity: 'error' as const })), quiet: [DROP, ALERT] })
  const byParent = { rule: PARENT, about: null, time: t, why: 'it dropped off CAN with the others: one event, not separate faults' }
  const name = (i: number) => c.names?.[i] ?? dev(i + 1)
  const drops = Array.from({ length: c.drops }, (_, i) => finding(DROP, name(i), 'error', byParent, t + i * 0.01))
  const direct = Array.from({ length: c.direct ?? 0 }, (_, i) => finding(ALERT, `Alert ${i + 1}`, 'warning', byParent, t))
  const through = Array.from({ length: c.through ?? 0 }, (_, i) => finding(ALERT, `${name(i)} alert`, 'warning', { rule: DROP, about: name(i), time: t + i * 0.01, why: 'test reason' }, t + 1))
  m.rules[DROP] = { status: 'fired', findings: drops }
  if (direct.length || through.length) m.rules[ALERT] = { status: 'fired', findings: [...direct, ...through] }
  return m
}

/** A plain match where the drop and alert rules could be checked and stayed quiet, and `fires` fire on their own. */
const plain = (n: number, fires: { key: string; severity?: 'error' | 'warning' }[] = []) => {
  const m = match(n, { fires: fires.map((f) => ({ severity: 'error' as const, ...f })), quiet: [DROP, ALERT] })
  for (const f of fires) {
    const x = m.rules[f.key.split(' · ')[0]].findings.find((y) => y.key === f.key)!
    Object.assign(x, { about: f.key.split(' · ')[1] ?? null })
  }
  return m
}

let seq = 0
const bl = (key: string, op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})

const groups = (b: Board) => b.rows.filter((i) => i.group)
const one = (b: Board) => { const g = groups(b); expect(g).toHaveLength(1); return g[0] }

describe('1: the members of a group', () => {
  // Q2 is clean; Q3 holds the cluster: 6 devices drop, the parent explains 3 alerts, and 2 alerts are about two of the devices.
  const s = session([plain(2), clusterMatch(3, { drops: 6, direct: 3, through: 2, others: ['power/brownout'] })])
  const b = buildBoard(input(s, [], SCHEDULE))

  it('are the issues the parent explains, directly or through a member: one row of 11', () => {
    const g = one(b)
    expect(g.group!.members).toHaveLength(11)
    expect(g.group!.devices).toBe(6)
    expect(g.group!.others).toBe(5)
    expect(b.rows.filter((i) => !i.group).map((i) => i.key)).toEqual(['power/brownout'])
  })
  it("heads the row with the parent's own name for the devices (as Match review does), the match and the time", () => {
    const g = one(b)
    expect(g.group!.head).toBe('6 CAN devices dropped within 0.05 s')
    expect(rowTitle(g)).toBe('6 CAN devices dropped within 0.05 s · Q3 0:59 teleop')
    expect(g.group!.also).toBe('and 5 robot-code alerts about them')
  })
  it("gives the parent's next step and meaning, and the worst member's priority", () => {
    const g = one(b)
    expect(g.nextStep).toMatch(/^Look at what these devices share/)
    expect(g.group!.meaning).toMatch(/^Several devices dropped off CAN at the same moment/)
    expect(g.priority).toBe('red')
    expect(g.mechanism).toBe('CAN')
  })
  it('keeps every member as its own issue, reachable by its key (marks and history stay per device)', () => {
    expect(b.issues.filter((i) => i.rule === DROP)).toHaveLength(6)
    expect(b.issues.some((i) => i.group)).toBe(false)
  })
  it('one explained issue alone is not a group', () => {
    const solo = buildBoard(input(session([plain(2), clusterMatch(3, { drops: 1 })]), [], SCHEDULE))
    expect(groups(solo)).toEqual([])
    expect(solo.rows.map((i) => i.key)).toEqual([`${DROP} · ${dev(1)}`])
  })
  it('two clusters in one session are two groups', () => {
    const two = buildBoard(input(session([clusterMatch(2, { drops: 3 }), clusterMatch(3, { drops: 3, t: 200 })]), [], SCHEDULE))
    // Both clusters name the same devices: each device's latest sighting is Q3's, so Q2's cluster has no members left.
    expect(groups(two)).toHaveLength(1)
    const apart = buildBoard(input(session([clusterMatch(2, { drops: 3 }), (() => { const m = clusterMatch(3, { drops: 3, t: 200 }); for (const f of m.rules[DROP].findings) Object.assign(f, { about: `Other ${f.about}`, key: `${DROP} · Other ${f.about}` }); return m })()]), [], SCHEDULE))
    expect(groups(apart).map((g) => rowTitle(g))).toEqual(['3 CAN devices dropped within 0.02 s · Q2 0:59 teleop', '3 CAN devices dropped within 0.02 s · Q3 0:59 teleop'])
  })
})

describe('2: counts read the group as one issue', () => {
  // A large cut: 20 devices, 10 alerts the parent explains, 6 alerts about the devices; plus 3 reds and an amber of their own.
  const s = session([plain(2, [{ key: 'power/brownout' }, { key: 'comms/loss' }, { key: 'loop/overrun' }]), clusterMatch(3, { drops: 20, direct: 10, through: 6 }), plain(4, [{ key: 'vision/stale · Front camera', severity: 'warning' }])])

  it('with no marks: 4 reds, not 23, and one row for the 36', () => {
    const b = buildBoard(input(s, [], SCHEDULE))
    expect(b.issues).toHaveLength(40)
    expect(b.rows).toHaveLength(5)
    expect(b.strip.reds).toBe(4)
    expect(b.strip.gate).toBe(4)
    expect(b.strip.noOwner).toBe(5)
    expect(boardCounts(b)).toMatchObject({ open: 5, reds: 4, gate: 4, noOwner: 5 })
  })
  it('the red cap counts the group once: all four reds are above the line', () => {
    const b = buildBoard(input(s, [], SCHEDULE))
    expect(b.visible.filter(isRed)).toHaveLength(4)
    expect(b.below.filter(isRed)).toHaveLength(0)
    expect(RED_CAP).toBeGreaterThanOrEqual(4)
  })
  it('with marks: owners on the other reds leave only the group without an owner', () => {
    const history: HistoryEvent[] = ['power/brownout', 'comms/loss', 'loop/overrun', 'vision/stale · Front camera'].map((k) => bl(k, 'owner', 'pit', iso(70)))
    const b = buildBoard(input(s, history, SCHEDULE))
    expect(b.strip.noOwner).toBe(1)
    expect(boardCounts(b).noOwner).toBe(1)
  })
  it('says where it counts that one red is a group', () => {
    const b = buildBoard(input(s, [], SCHEDULE))
    expect(boardCounts(b).groupWords).toBe('one of them 20 CAN devices dropped within 0.19 s')
    const plainBoard = buildBoard(input(session([plain(2, [{ key: 'power/brownout' }])]), [], SCHEDULE))
    expect(boardCounts(plainBoard).groupWords).toBe('')
  })
})

describe('3: every count site reads grouped rows', () => {
  const s = session([plain(2, [{ key: 'power/brownout' }]), clusterMatch(3, { drops: 5, direct: 2, through: 1 })])
  const b = buildBoard(input(s, [], SCHEDULE))

  it("Now's practice-day line: open and red from the same count", () => {
    expect(stillOf(b, 'Test Regional')).toEqual({ event: 'Test Regional', open: 2, red: 2, groupWords: 'one of them 5 CAN devices dropped within 0.04 s' })
  })
  it("Now's practice-day line leaves a grey red out of red (Now counted it before)", () => {
    const g = buildBoard(input(session([plain(2, [{ key: 'power/brownout' }]), plain(3), plain(4), clusterMatch(5, { drops: 3 })]), [], SCHEDULE))
    expect(g.rows.find((i) => i.key === 'power/brownout')?.grey).toBe(true)
    expect(stillOf(g, 'Test Regional')).toMatchObject({ open: 2, red: 1 })
  })
  it("Now's reds due before a match count the group once", () => {
    expect(redsDueBefore(b, b.tl.nextPos + 0.5)).toBe(2)
    expect(groupWords(b.rows.filter(isRed))).toBe('one of them 5 CAN devices dropped within 0.04 s')
  })
  it('the queue sheet gates on the group once', () => {
    const q = queueSheet(b)
    expect(q.gate).toBe(2)
    expect(q.redsOpen).toBe(2)
    expect(q.lines.map((l) => l.issue.group ? 'group' : l.issue.key)).toEqual(['power/brownout', 'group'])
  })
  it('the handoff lists the group once', () => {
    expect(handoff(b).redsDue).toHaveLength(2)
  })
  it("Foresight's deferral list shows a deferred group once, and its members' live reds count as deferred", () => {
    const g = one(b)
    const lines = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(70)), g, [{ op: 'workaround', value: 'Drive gently' }, { op: 'defer', value: 'end-of-event', until: { kind: 'end-of-event' } }], { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) })
    const b2 = buildBoard(input(s, lines, SCHEDULE))
    const open = openDeferrals(b2, profile)
    expect(open).toHaveLength(1)
    expect(open[0].title).toMatch(/^5 CAN devices dropped/)
    expect(open[0].members).toHaveLength(8)
    const red = (about: string) => ({ level: 'red', finding: { key: `${DROP} · ${about}`, rule: DROP, about } })
    const c = queueChecklist({ verdict: { items: [red(dev(1))], notChecked: [], crashed: [], blind: [] } as never, why: '', profile, deferrals: open, deferralNote: null })
    expect(c.rows.flatMap((r) => r.fix)).toEqual([])
    expect(c.rows.flatMap((r) => r.deferrals).filter((d) => d.seenNow)).toHaveLength(1)
  })
  it("a deferred group's live red in another system makes that system Go with deferral, not Go", () => {
    const names = ['Flywheel left', 'Flywheel right', 'Gyro']
    const s2 = session([plain(2), clusterMatch(3, { drops: 3, names })])
    const g = one(buildBoard(input(s2, [], SCHEDULE)))
    const lines = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(70)), g, [{ op: 'workaround', value: 'Drive gently' }, { op: 'defer', value: 'end-of-event', until: { kind: 'end-of-event' } }], { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) })
    const open = openDeferrals(buildBoard(input(s2, lines, SCHEDULE)), profile)
    const red = { level: 'red', finding: { key: `${DROP} · Flywheel left`, rule: DROP, about: 'Flywheel left' } }
    const c = queueChecklist({ verdict: { verdict: 'GO', items: [red], notChecked: [], crashed: [], blind: [] } as never, why: '', profile, deferrals: open, deferralNote: null })
    const mech = c.rows.find((r) => r.system === 'Mechanisms')!
    expect(mech.fix).toEqual([])
    expect(mech.word).toBe('Go with deferral')
    expect(mech.deferrals.map((d) => d.seenNow)).toEqual([true])
  })
  it('a group deferred in part keeps its deferred members on the queue sheet and in Foresight', () => {
    const lines = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(70)), one(b).group!.open[0], [{ op: 'workaround', value: 'Drive gently' }, { op: 'defer', value: 'end-of-event', until: { kind: 'end-of-event' } }], { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) })
    const b2 = buildBoard(input(s, lines, SCHEDULE))
    const g = one(b2)
    expect(g.status).toBe('open')
    expect(g.group!.mixed.status).toBe(true)
    expect(statusLine(g)).toBe('Mixed: 7 Open, 1 Deferred')
    expect(isGate(g, b2.tl)).toBe(true)
    expect(queueSheet(b2).deferrals).toBe(1)
    expect(openDeferrals(b2, profile).map((d) => d.key)).toEqual([`${DROP} · ${dev(1)}`])
  })
  it("the handoff shows the members' cause marks under the group row", () => {
    const g = one(b)
    const marks = [bl(g.group!.open[0].key, 'cause', 'confirmed', iso(70), { cause: 'bus', text: 'loose plug' })]
    const h = handoff(buildBoard(input(s, marks, SCHEDULE)))
    expect(h.causeLines.get(g.key)?.map((l) => [l.kind, l.text])).toEqual([['confirmed', 'loose plug']])
  })
  it("the handoff shows a cause the logs ruled out for every member once under the group row", () => {
    const s2 = session([plain(2), clusterMatch(3, { drops: 3 })])
    for (const f of s2.matches[1].rules[DROP].findings) Object.assign(f, { ruledOut: { 'battery-sag': 'test reason' } })
    const b2 = buildBoard(input(s2, [], SCHEDULE))
    expect(handoff(b2).causeLines.get(one(b2).key)).toHaveLength(1)
  })
  it("the handoff lists a member's note once when the member is itself a deferral due and its group is in the gate", () => {
    const g = one(b)
    const m = g.group!.open[0]
    const at = { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) }
    const h1 = [...boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(70)), m, [{ op: 'workaround', value: 'Drive gently' }, { op: 'defer', value: 'next-match', until: { kind: 'next-match' } }, { op: 'note', value: 'test note' }], at)]
    const b2 = buildBoard(input(s, h1, SCHEDULE))
    const h = handoff(b2)
    expect(h.redsDue.some((i) => i.group)).toBe(true)
    expect(h.deferralsDue.map((i) => i.key)).toEqual([m.key])
    expect(h.tried.map((t) => t.text)).toEqual(['test note'])
  })
  it("a deferred group reads as seen on its own system's row too while a red it covers is live elsewhere", () => {
    const names = ['Flywheel left', 'Flywheel right', 'Gyro']
    const s2 = session([plain(2), clusterMatch(3, { drops: 3, names })])
    const g = one(buildBoard(input(s2, [], SCHEDULE)))
    const lines = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(70)), g, [{ op: 'workaround', value: 'Drive gently' }, { op: 'defer', value: 'end-of-event', until: { kind: 'end-of-event' } }], { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) })
    const open = openDeferrals(buildBoard(input(s2, lines, SCHEDULE)), profile)
    const red = { level: 'red', finding: { key: `${DROP} · Flywheel left`, rule: DROP, about: 'Flywheel left' } }
    const c = queueChecklist({ verdict: { verdict: 'GO', items: [red], notChecked: [], crashed: [], blind: [] } as never, why: '', profile, deferrals: open, deferralNote: null })
    expect(c.rows.filter((r) => r.deferrals.length).map((r) => [r.system, r.deferrals[0].seenNow])).toEqual(expect.arrayContaining([['Mechanisms', true], [open[0].system, true]]))
  })
  it('a cluster in a pit run is a group too, named by the pit run', () => {
    const pit = clusterMatch(99, { drops: 3 })
    Object.assign(pit, { onField: false, matchLabel: '', fileName: 'pit1.wpilog', playedAt: BASE + 70 * 60e3 })
    const b2 = buildBoard(input(session([plain(2), plain(3)], [pit]), [], SCHEDULE))
    expect(rowTitle(one(b2))).toBe('3 CAN devices dropped within 0.02 s · Pit run 0:59 teleop')
  })
  it('a member that closed is in the closed list while the group stays open', () => {
    const s2 = session([plain(2), clusterMatch(3, { drops: 4, direct: 1 }), plain(4)])
    const fixed = [bl(`${DROP} · ${dev(1)}`, 'status', 'check', iso(65), { match: 'TEST Qualification 3', played: iso(60) })]
    const b2 = buildBoard(input(s2, fixed, SCHEDULE))
    expect(one(b2).group!.open).toHaveLength(4)
    expect(b2.closed.map((i) => i.key)).toEqual([`${DROP} · ${dev(1)}`])
  })
  it('a group whose members are all closed is one line in the closed list', () => {
    const fixed = one(b).group!.members.map((m) => bl(m.key, 'status', 'check', iso(65), { match: 'TEST Qualification 3', played: iso(60) }))
    const b2 = buildBoard(input(session([...s.matches, plain(4)]), fixed, SCHEDULE))
    expect(groups(b2)).toEqual([])
    expect(b2.closed.filter((i) => i.group)).toHaveLength(1)
    expect(b2.closed.filter((i) => !i.group)).toEqual([])
  })
})

describe('5: a change on the group fans out to its open members', () => {
  const s = session([plain(2), clusterMatch(3, { drops: 4, direct: 1 })])
  const b = buildBoard(input(s, [], SCHEDULE))
  const g = one(b)
  const who = { device: 'dev-a', role: 'pit' as const }
  const at = { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) }

  it('one line per open member per change, each with its own seq', () => {
    const lines = boardLines([], who, new Date(iso(70)), g, [{ op: 'owner', value: 'pit' }, { op: 'priority', value: 'medium' }], at)
    expect(lines).toHaveLength(10)
    expect(new Set(lines.map((l) => l.seq)).size).toBe(10)
    expect(new Set(lines.map((l) => l.key))).toEqual(new Set(g.group!.open.map((m) => m.key)))
    expect(lines.every((l) => l.robot === ROBOT)).toBe(true)
  })
  it('after it, every member has the owner, and the group does too', () => {
    const lines = boardLines([], who, new Date(iso(70)), g, [{ op: 'owner', value: 'pit' }], at)
    const b2 = buildBoard(input(s, lines, SCHEDULE))
    expect(one(b2).owner).toBe('pit')
    expect(one(b2).group!.mixed.owner).toBe(false)
    expect(b2.strip.noOwner).toBe(0)
  })
  it('a queue tick on the group ticks every open member, and the group counts as checked', () => {
    const lines = boardLines([], who, new Date(iso(70)), g, [{ op: 'checked', value: 'Q4' }], at)
    expect(lines).toHaveLength(5)
    const b2 = buildBoard({ ...input(s, lines, SCHEDULE), now: new Date(iso(75)) })
    const q = queueSheet(b2)
    expect(q.lines.find((l) => l.issue.group)?.checked).not.toBeNull()
  })
  it("a Save writes a field the members disagree on only when that control was used", () => {
    // Red devices and amber alerts: mixed on priority from the start.
    expect(g.group!.mixed.priority).toBe(true)
    const form = { priority: g.priority, status: g.asked, owner: 'pit' }
    expect(fieldChanges(g, form, { owner: true }).map((c) => c.op)).toEqual(['owner'])
    expect(fieldChanges(g, form, { owner: true, priority: true }).map((c) => [c.op, c.value])).toEqual([['priority', 'high'], ['owner', 'pit']])
    // A plain issue writes what differs, touched or not.
    const plainIssue = b.issues.find((i) => !i.group)!
    expect(fieldChanges(plainIssue, { priority: plainIssue.priority, status: plainIssue.asked, owner: '' }, { priority: true, status: true, owner: true })).toEqual([])
  })
  it("mixed owners can be cleared, and a mixed status set, by using the control", () => {
    const h = [bl(`${DROP} · ${dev(1)}`, 'owner', 'pit', iso(70)), bl(`${DROP} · ${dev(2)}`, 'status', 'check', iso(70))]
    const g2 = one(buildBoard(input(s, h, SCHEDULE)))
    const form = { priority: g2.priority, status: 'open' as const, owner: '' }
    expect(fieldChanges(g2, form, {})).toEqual([])
    expect(fieldChanges(g2, form, { status: true, owner: true }).map((c) => [c.op, c.value])).toEqual([['status', 'open'], ['owner', '']])
  })
  it('a closed member is not written to', () => {
    const fixed = [bl(`${DROP} · ${dev(1)}`, 'status', 'check', iso(65), { match: 'TEST Qualification 3', played: iso(60) })]
    const b2 = buildBoard(input(session([...s.matches, plain(4)]), fixed, SCHEDULE))
    const g2 = one(b2)
    expect(g2.group!.members.map((m) => m.key)).toContain(`${DROP} · ${dev(1)}`)
    expect(g2.group!.members.find((m) => m.key === `${DROP} · ${dev(1)}`)!.open).toBe(false)
    const lines = boardLines(fixed, who, new Date(iso(100)), g2, [{ op: 'owner', value: 'pit' }], at)
    expect(lines).toHaveLength(4)
    expect(lines.map((l) => l.key)).not.toContain(`${DROP} · ${dev(1)}`)
  })
  it("a still-holds tick on the group ticks each open member", () => {
    const lines = boardLines([], who, new Date(iso(70)), g, [{ op: 'checked', value: 'holds' }], at)
    expect(lines.map((l) => [l.op, l.value])).toEqual(Array(5).fill(['checked', 'holds']))
  })
  it('notes and cause marks are per member: a group refuses them', () => {
    expect(() => boardLines([], who, new Date(iso(70)), g, [{ op: 'note', value: 'x' }], at)).toThrow(/per member/)
    expect(() => boardLines([], who, new Date(iso(70)), g, [{ op: 'cause', value: 'confirmed', cause: 'bus', text: '' }], at)).toThrow(/per member/)
  })
  it("the grey row's take leaves its note out on a group", () => {
    const lines = boardLines([], who, new Date(iso(70)), g, greyTake('pit').filter((c) => !g.group || c.op !== 'note'), at)
    expect(lines.every((l) => l.op !== 'note')).toBe(true)
  })
})

describe('6: mixed member state', () => {
  const s = session([plain(2), clusterMatch(3, { drops: 3 })])
  it('owners that differ read "mixed"; a member with no owner keeps the group in "no owner"', () => {
    const history = [bl(`${DROP} · ${dev(1)}`, 'owner', 'pit', iso(70)), bl(`${DROP} · ${dev(2)}`, 'owner', 'drive', iso(70))]
    const b = buildBoard(input(s, history, SCHEDULE))
    const g = one(b)
    expect(g.group!.mixed.owner).toBe(true)
    expect(ownerText(g)).toBe('mixed owners')
    expect(b.strip.noOwner).toBe(1)
  })
  it('statuses that differ read "mixed"; a member still open keeps the group in the gate', () => {
    const history = [bl(`${DROP} · ${dev(1)}`, 'status', 'fixing', iso(70))]
    const b = buildBoard(input(s, history, SCHEDULE))
    const g = one(b)
    expect(g.group!.mixed.status).toBe(true)
    expect(statusLine(g)).toBe('Mixed: 2 Open, 1 Fixing')
    expect(isGate(g, b.tl)).toBe(true)
  })
  it('priorities that differ read "mixed", and the row takes the worst', () => {
    const g = one(buildBoard(input(s, [bl(`${DROP} · ${dev(1)}`, 'priority', 'low', iso(70))], SCHEDULE)))
    expect(g.group!.mixed.priority).toBe(true)
    expect(g.priority).toBe('red')
  })
  it('red if any open member is red', () => {
    const history = [bl(`${DROP} · ${dev(1)}`, 'priority', 'low', iso(70)), bl(`${DROP} · ${dev(2)}`, 'priority', 'low', iso(70))]
    const g = one(buildBoard(input(s, history, SCHEDULE)))
    expect(g.priority).toBe('red')
  })
})

describe('7 and 8: which sighting decides', () => {
  it('a sighting marked "not a real problem" does not decide the group while the issue has a real one', () => {
    const m = clusterMatch(3, { drops: 4 })
    Object.assign(m.rules[DROP].findings[0], { wrongMark: { reason: 'test reason', when: iso(70) } })
    const b = buildBoard(input(session([plain(2, [{ key: `${DROP} · ${dev(1)}` }]), m]), [], SCHEDULE))
    expect(one(b).group!.members.map((x) => x.key)).not.toContain(`${DROP} · ${dev(1)}`)
    expect(b.rows.filter((i) => i.key === `${DROP} · ${dev(1)}`)).toHaveLength(1)
  })
  it('a member that fires on its own in a later match leaves the group (its latest sighting decides)', () => {
    const s = session([clusterMatch(2, { drops: 4 }), plain(3, [{ key: `${DROP} · ${dev(1)}` }])])
    const b = buildBoard(input(s, [], SCHEDULE))
    const g = one(b)
    expect(g.group!.members.map((m: BoardIssue) => m.key)).not.toContain(`${DROP} · ${dev(1)}`)
    expect(b.rows.filter((i) => i.key === `${DROP} · ${dev(1)}`)).toHaveLength(1)
    // Each issue is on the board once.
    const shown = b.rows.flatMap((i) => (i.group ? i.group.members.map((m) => m.key) : [i.key]))
    expect(new Set(shown).size).toBe(shown.length)
  })
  it('a group fixed as a group whose cut comes back stays one group, tagged as come back (Kevin, 2026-11-11)', () => {
    const s1 = session([plain(2), clusterMatch(3, { drops: 4, direct: 1 })])
    const g = one(buildBoard(input(s1, [], SCHEDULE)))
    const fix = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(65)), g, [{ op: 'status', value: 'check' }], { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) })
    const b = buildBoard(input(session([...s1.matches, clusterMatch(4, { drops: 4, direct: 1, t: 300 })]), fix, SCHEDULE))
    const back = one(b)
    expect(back.group!.members).toHaveLength(5)
    expect(back.cameBack).toBe(true)
    expect(tags(back)).toContain('Came back after a fix')
    expect(rowTitle(back)).toMatch(/· Q4 /)
    expect(b.rows).toHaveLength(1)
  })
  it('a came-back group keeps its key and its members through a status change, on the group or on one member', () => {
    const s1 = session([plain(2), clusterMatch(3, { drops: 4 })])
    const g = one(buildBoard(input(s1, [], SCHEDULE)))
    const at = { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) }
    const fix = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(65)), g, [{ op: 'status', value: 'check' }], at)
    const s2 = session([...s1.matches, clusterMatch(4, { drops: 4, t: 300 })])
    const back = one(buildBoard(input(s2, fix, SCHEDULE)))
    const at4 = { event: 'TEST', match: 'TEST Qualification 4', played: iso(80) }
    const fixing = boardLines(fix, { device: 'dev-a', role: 'pit' }, new Date(iso(85)), back, [{ op: 'status', value: 'fixing' }], at4)
    const after = one(buildBoard(input(s2, [...fix, ...fixing], SCHEDULE)))
    expect(after.key).toBe(back.key)
    expect(after.group!.members).toHaveLength(4)
    const oneMember = boardLines(fix, { device: 'dev-a', role: 'pit' }, new Date(iso(85)), back.group!.open[0], [{ op: 'status', value: 'fixing' }], at4)
    const b3 = buildBoard(input(s2, [...fix, ...oneMember], SCHEDULE))
    expect(one(b3).group!.members).toHaveLength(4)
    expect(statusLine(one(b3))).toBe('Mixed: 3 Open, 1 Fixing')
    expect(b3.rows).toHaveLength(1)
  })
  it('one cut is one row when only some of it came back after a fix, saying how many (Kevin, 2026-11-11)', () => {
    const fixed = [1, 2].map((n) => bl(`${DROP} · ${dev(n)}`, 'status', 'check', iso(30), { match: 'TEST Qualification 2', played: iso(40) }))
    const b = buildBoard(input(session([plain(2), clusterMatch(3, { drops: 4 })]), fixed, SCHEDULE))
    const g = one(b)
    expect(g.group!.members).toHaveLength(4)
    expect(g.group!.cameBack).toBe(2)
    expect(tags(g)).toContain('2 of 4 issues came back after a fix')
    expect(b.rows).toHaveLength(1)
  })
  it('a lone device whose fix did not hold is in its cut\'s row, and its own row says it came back', () => {
    const fixed = [bl(`${DROP} · ${dev(1)}`, 'status', 'check', iso(30), { match: 'TEST Qualification 2', played: iso(40) })]
    const b = buildBoard(input(session([plain(2), clusterMatch(3, { drops: 4 })]), fixed, SCHEDULE))
    const g = one(b)
    expect(tags(g)).toContain('1 of 4 issues came back after a fix')
    expect(tags(g.group!.members.find((m) => m.key === `${DROP} · ${dev(1)}`)!)).toContain('Came back after a fix')
    expect(b.rows).toHaveLength(1)
  })
  it('a group fixed as a group whose cut comes back bigger is one row: "4 of 6 came back after a fix"', () => {
    const s1 = session([plain(2), clusterMatch(3, { drops: 4 })])
    const fix = boardLines([], { device: 'dev-a', role: 'pit' }, new Date(iso(65)), one(buildBoard(input(s1, [], SCHEDULE))), [{ op: 'status', value: 'check' }], { event: 'TEST', match: 'TEST Qualification 3', played: iso(60) })
    const b = buildBoard(input(session([...s1.matches, clusterMatch(4, { drops: 6, t: 300 })]), fix, SCHEDULE))
    expect(b.rows).toHaveLength(1)
    expect(rowTitle(one(b))).toMatch(/^6 CAN devices dropped/)
    expect(tags(one(b))).toContain('4 of 6 issues came back after a fix')
  })
})
