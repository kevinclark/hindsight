// Foresight's two checklists (ADR 9): the queue's systems with deferrals, and the practice-start list. Invented robot,
// event TEST, "test workaround". The team-log replay at the end is skipped when ~/.hindsight/team-logs.json is absent.
import { describe, expect, it } from 'vitest'
import {
  boardFor, deferralSession, isCarried, openDeferrals, sessionEventName, PRACTICE_FIRST, practiceChecklist, queueChecklist, SYSTEMS, systemOf, tickAt, tickKey, ticksFor, TICK_MINUTES, uncoveredItems, type OpenDeferral,
} from '../src/foresight/checklists.ts'
import { markOnchecks, ONCHECKS } from '../src/foresight/onchecks.ts'
import { eventFromLibrary, eventFromSchedule } from '../src/session/today-event.ts'
import { todayMode } from '../src/session/mode.ts'
import { scopeOf } from '../src/board/model.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import type { Report } from '../src/rules/index.ts'
import type { Proof } from '../src/foresight/proven.ts'
import { goWithWord } from '../src/board/words.ts'
import { queueSheet } from '../src/board/sheets.ts'
import { buildBoard } from '../src/board/model.ts'
import { atLatest, boardLines } from '../src/board/writes.ts'
import { lastPassingSha, parseHistory, serializeHistory, type BoardEvent, type HistoryEvent, type OpaqueEvent, type PitCheckEvent } from '../src/triage/history.ts'
import { foresightCard, verdictTone, type ForesightReportInput } from '../src/report/foresight-model.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { ROBOT, input, match, profile as sceneProfile, session } from './helpers/board-scene.ts'

const profile = { ...sceneProfile, motorGroups: [...(sceneProfile as RobotProfile).motorGroups, { name: 'Drive', motors: [{ name: 'Drive front left' }] }] } as unknown as RobotProfile

const finding = (rule: string, about: string | null, severity: 'error' | 'warning' | 'info' = 'warning') => ({
  rule, severity, title: `test finding ${rule}${about ? ` (${about})` : ''}`, time: null, matchTime: null, when: null, about, key: about ? `${rule} · ${about}` : rule,
  evidence: {}, meaning: '', causes: [], nextStep: `test step for ${rule}`,
})
const real: Proof = { logs: 9, fires: 1, ourFires: 1, base: 'test', date: '2099-03-05' }
const PROVEN = { 'can/bus-dropout': real, 'power/rest-voltage': real, 'vision/stale': real, 'can/device-dropout': real, 'build/dirty': real, 'foresight/zero-sanity': real }
const report = (findings: ReturnType<typeof finding>[], skipped: Report['skipped'] = []): Report => ({ findings, skipped, crashed: [] } as unknown as Report)
const verdict = (findings: ReturnType<typeof finding>[], skipped: Report['skipped'] = []) => verdictFor(report(findings, skipped), PROVEN)

const RED_POWER = finding('power/rest-voltage', null)
const RED_CAMERA = finding('vision/stale', 'Front camera')
const RED_CODE = finding('build/dirty', null)
const defer = (f: ReturnType<typeof finding>, system: OpenDeferral['system'], workaround = 'test workaround'): OpenDeferral => ({ key: f.key, system, title: `${system} · ${f.rule}`, workaround, until: 'the end of the event' })
// The drivetrain always needs its on-blocks tick (Kevin, 2026-10-24): these tests have it, the ones about it do not.
const BLOCKS = new Map([['Drivetrain' as const, tickAt('pit', new Date().toISOString(), Date.now())]])
const checklist = (v: ReturnType<typeof verdict> | null, deferrals: OpenDeferral[] | null = [], note: string | null = null) => queueChecklist({ verdict: v, why: 'test not connected', profile, deferrals, deferralNote: note, ticks: BLOCKS })
const row = (c: ReturnType<typeof checklist>, system: string) => c.rows.find((r) => r.system === system)!

describe('a finding goes to a system by the board\'s own grouping', () => {
  it('a profile\'s camera, drive group, other group and device; else the rule family; else the rule', () => {
    expect([
      systemOf('vision/stale', 'Front camera', profile), systemOf('mech/stall', 'Drive front left', profile), systemOf('mech/stall', 'Flywheel left', profile),
      systemOf('can/device-dropout', 'Gyro', profile), systemOf('power/brownout', null, profile), systemOf('can/bus-dropout', null, profile),
      systemOf('comms/emergency-stop', null, profile), systemOf('build/dirty', null, profile), systemOf('battery/identity', null, profile),
      systemOf('foresight/controllers', null, profile), systemOf('foresight/zero-sanity', 'Arm', profile), systemOf('vision/time-sync', null, profile),
      systemOf('snapshot/swerve-ratio', null, profile), systemOf('mech/stall', null, undefined),
    ]).toEqual(['Vision', 'Drivetrain', 'Mechanisms', 'CAN', 'Power', 'CAN', 'Comms', 'Code', 'Power', 'Comms', 'Mechanisms', 'Vision', 'Drivetrain', 'Mechanisms'])
  })
})

describe('the queue checklist', () => {
  it('nothing found: seven systems, all Go, the word is GO', () => {
    const c = checklist(verdict([]))
    expect(c.rows.map((r) => r.system).sort()).toEqual([...SYSTEMS].sort())
    expect(c.rows).toHaveLength(7)
    expect(c.rows.every((r) => r.word === 'Go' && r.text === 'Go')).toBe(true)
    expect([c.word, c.kind]).toEqual(['GO', 'GO'])
  })

  it('a red with no deferral: that system is No-go and first, and the word is NO-GO', () => {
    const c = checklist(verdict([RED_POWER]))
    expect(c.rows[0]).toMatchObject({ system: 'Power', word: 'No-go' })
    expect(c.rows[0].text).toBe('No-go: test finding power/rest-voltage')
    expect(c.rows.slice(1).every((r) => r.word === 'Go')).toBe(true)
    expect([c.word, c.kind]).toEqual(['NO-GO', 'NO-GO'])
    expect(c.reason).toMatch(/1 system to fix .*Power/)
  })

  it('a red the board has deferred reads Go with deferral, named with its workaround, never hidden', () => {
    const c = checklist(verdict([RED_POWER]), [defer(RED_POWER, 'Power', 'test workaround')])
    const power = row(c, 'Power')
    expect(power.word).toBe('Go with deferral')
    expect(power.text).toBe('Go with deferral: Power · power/rest-voltage · workaround: test workaround')
    expect(power.deferrals).toEqual([expect.objectContaining({ seenNow: true, workaround: 'test workaround' })])
    expect([c.word, c.kind]).toEqual(['GO WITH 1 DEFERRAL', 'GO WITH DEFERRALS'])
  })

  it('a deferral Foresight did not see live is listed too, and counted', () => {
    const c = checklist(verdict([]), [defer(RED_CAMERA, 'Vision', 'test workaround')])
    expect(row(c, 'Vision')).toMatchObject({ word: 'Go with deferral', deferrals: [expect.objectContaining({ seenNow: false })] })
    expect(c.deferrals).toHaveLength(1)
    expect(c.word).toBe('GO WITH 1 DEFERRAL')
  })

  it('0, 1 and 3 deferrals word GO, GO WITH 1 DEFERRAL, GO WITH 3 DEFERRALS; a go with deferrals is never plain GO', () => {
    const d = [defer(RED_POWER, 'Power'), defer(RED_CAMERA, 'Vision'), defer(RED_CODE, 'Code')]
    expect([0, 1, 3].map((n) => checklist(verdict([]), d.slice(0, n)).word)).toEqual(['GO', 'GO WITH 1 DEFERRAL', 'GO WITH 3 DEFERRALS'])
    expect(checklist(verdict([]), d).word).not.toMatch(/^GO$/)
    expect(checklist(verdict([]), d).word).toBe(goWithWord(3))
  })

  it('a No-go beats a deferral; a deferral elsewhere still reads Go with deferral', () => {
    const c = checklist(verdict([RED_POWER, RED_CODE]), [defer(RED_CODE, 'Code')])
    expect([row(c, 'Power').word, row(c, 'Code').word, c.word]).toEqual(['No-go', 'Go with deferral', 'NO-GO'])
    expect(c.rows.map((r) => r.word).slice(0, 2)).toEqual(['No-go', 'Go with deferral'])
  })

  it('most critical first: No-go, then not checked, then deferral, then Go; the system order breaks ties', () => {
    const blind = [{ rule: 'foresight/zero-sanity', reason: 'missing a signal' }]  // proven here, so unjudged
    const c = checklist(verdict([RED_CODE], blind), [defer(RED_CAMERA, 'Vision')])
    expect(c.rows.map((r) => [r.system, r.word]).slice(0, 4)).toEqual([['Code', 'No-go'], ['Mechanisms', 'Not checked'], ['Vision', 'Go with deferral'], ['Power', 'Go']])
  })

  it('a proven check that could not run is Not checked and the word is NOT CHECKED, even with a deferral open', () => {
    const c = checklist(verdict([], [{ rule: 'vision/stale', reason: 'missing a camera signal' }]), [defer(RED_POWER, 'Power')])
    expect(row(c, 'Vision').word).toBe('Not checked')
    expect([c.word, c.kind]).toEqual(['NOT CHECKED', 'NOT CHECKED'])
    // No current check at all: every system is Not checked and the reason is the screen's own.
    const none = checklist(null, null, 'test note')
    expect(none.rows.every((r) => r.word === 'Not checked')).toBe(true)
    expect([none.word, none.reason, none.deferralNote]).toEqual(['NOT CHECKED', 'test not connected', 'test note'])
  })

  it('ambers are listed under their system and never move the word', () => {
    const c = checklist(verdict([finding('foresight/log-usb-stick', null)]))
    expect(row(c, 'Code')).toMatchObject({ word: 'Go' })
    expect(row(c, 'Code').look).toHaveLength(1)
    expect(c.word).toBe('GO')
  })
})

describe('the deferrals come from the board', () => {
  const D = 'power/rest-voltage'
  const scene = session([2, 3].map((n) => match(n, { fires: [{ key: D }] })))
  const bl = (key: string, op: BoardEvent['op'], value: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
    type: 'board', v: 1, key, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: 1, when: '2099-03-05T20:00:00Z', ...o,
  })
  const deferred = [bl(D, 'workaround', 'test workaround'), bl(D, 'defer', 'end-of-event', { seq: 2, until: { kind: 'end-of-event' } })]

  it('an open deferral for this robot, with its workaround and point; none when the robot is another', () => {
    const open = openDeferrals(boardFor(scene, deferred, profile, new Date('2099-03-05T21:00:00Z')), profile)
    expect(open).toEqual([{ key: D, system: 'Power', title: expect.stringMatching(/^Power · /), workaround: 'test workaround', until: 'the end of the event' }])
    const other = { ...profile, name: 'Other robot' } as RobotProfile
    expect(openDeferrals(boardFor(scene, deferred, other, new Date('2099-03-05T21:00:00Z')), other)).toEqual([])
  })

  it('a deferral that is not set, or was cleared, is not open', () => {
    expect(openDeferrals(boardFor(scene, [], profile, new Date()), profile)).toEqual([])
    const cleared = [...deferred, bl(D, 'defer', '', { seq: 3, when: '2099-03-05T20:05:00Z' })]
    expect(openDeferrals(boardFor(scene, cleared, profile, new Date()), profile)).toEqual([])
  })

  it('today\'s event session when there is one, else the latest event session for the robot, else none', () => {
    const older = { ...session([match(2)]), id: 'event:old' }
    const newer = { ...session([match(9)]), id: 'event:new' }
    const practice = { ...session([match(1)]), id: 'practice:2099-03-05', kind: 'practice' as const }
    expect(deferralSession([older, newer, practice], 'event:old', ROBOT)?.id).toBe('event:old')
    expect(deferralSession([older, newer, practice], 'practice:2099-03-05', ROBOT)?.id).toBe('event:new')
    expect(deferralSession([practice], 'practice:2099-03-05', ROBOT)).toBeNull()
    expect(deferralSession([older, newer], 'practice:2099-03-05', 'Another robot @ main')).toBeNull()
  })
})

describe('ticks confirm a system, with a role and a time', () => {
  const NOW = Date.parse('2099-03-05T21:30:00Z')
  const s = session([2, 3].map((n) => match(n)))
  const tickLines = (history: HistoryEvent[], on: boolean, forMatch: string, system = SYSTEMS[0], role: 'pit' | 'drive' = 'pit') =>
    boardLines(history, { device: 'dev-a', role }, new Date('2099-03-05T21:00:00Z'), { key: tickKey(system), robot: ROBOT }, [{ op: on ? 'checked' : 'unchecked', value: forMatch }], atLatest(s))

  it('a tick for this match counts, with its role; another match\'s does not; un-ticking takes it back', () => {
    const ticked = tickLines([], true, 'after Q3')
    expect(ticksFor(ticked, ROBOT, s, 'after Q3', NOW).get('Power')).toMatchObject({ role: 'pit', old: false })
    expect(ticksFor(ticked, ROBOT, s, 'after Q4', NOW).size).toBe(0)
    const back = [...ticked, ...tickLines(ticked, false, 'after Q3')]
    expect(ticksFor(back, ROBOT, s, 'after Q3', NOW).size).toBe(0)
  })

  it('a tick is Done for 90 minutes, then it reads old', () => {
    const ticked = tickLines([], true, 'after Q3')
    expect(TICK_MINUTES).toBe(90)
    expect(ticksFor(ticked, ROBOT, s, 'after Q3', Date.parse('2099-03-05T22:30:00Z')).get('Power')?.old).toBe(false)
    expect(ticksFor(ticked, ROBOT, s, 'after Q3', Date.parse('2099-03-05T22:31:00Z')).get('Power')?.old).toBe(true)
    expect(tickAt('pit', 'not a time', NOW).old).toBe(true)
  })

  it('reads the board\'s own scope', () => {
    expect(scopeOf(s)).toEqual({ event: 'TEST', from: expect.any(Number), to: expect.any(Number) })
  })

  it('a tick from another event, or with no event loaded, is not read; the board never shows it as an issue', () => {
    const ticked = tickLines([], true, 'after Q3').map((e) => ({ ...e, event: 'OTHER' }) as HistoryEvent)
    expect(ticksFor(ticked, ROBOT, s, 'after Q3', NOW).size).toBe(0)
    expect(ticksFor(tickLines([], true, 'after Q3'), ROBOT, null, 'after Q3', NOW).size).toBe(0)
    expect(buildBoard(input(s, tickLines([], true, 'after Q3'))).issues).toEqual([])
  })
})

describe('the practice-start checklist', () => {
  const ok = report([])
  const lines = (r: Report, snapshotUsed = true) => markOnchecks({ verdict: verdictFor(r, PROVEN), report: r, snapshotUsed })

  it('battery, CAN, cameras, zeros first, then the rest of the live checks in the team\'s order', () => {
    const c = practiceChecklist(lines(ok))
    expect(c.items.slice(0, 6).map((i) => [i.group, i.line.line])).toEqual([
      ['Battery', 'Fresh battery installed'], ['CAN', 'All device values updating'], ['CAN', "All CAN devices licensed and ID'd"], ['CAN', 'CTRE devices healthy'],
      ['Cameras', 'All cameras on and detecting AprilTags'], ['Zeros', 'Mechanisms zeroed'],
    ])
    expect(c.items.slice(6).every((i) => i.group === 'The rest')).toBe(true)
    expect(c.items.map((i) => i.line.line)).not.toContain('Correct auto selected in Elastic')
    expect(c.byEye.map((l) => l.line)).toContain('Correct auto selected in Elastic')
  })

  it('every live line done: it ends "Ready to drive", with no Go anywhere', () => {
    const c = practiceChecklist(lines(ok))
    expect(c.ready).toBe(true)
    expect(c.end).toBe('Ready to drive')
    expect(JSON.stringify(c.items.map((i) => i.line.detail))).not.toMatch(/\bGO\b/)
  })

  it('what is left is counted and named in order: "n left: …"; a camera step, a red and an unchecked line all count', () => {
    const c = practiceChecklist(lines(report([finding('power/rest-voltage', null), finding('foresight/camera-sees-tag', 'Front camera', 'info')], [{ rule: 'foresight/zero-sanity', reason: 'missing a signal' }])))
    expect(c.end).toBe('3 left: Fresh battery installed, All cameras on and detecting AprilTags, Mechanisms zeroed')
    expect(c.ready).toBe(false)
    // Without a robot snapshot the snapshot lines are never done: Ready to drive waits for one.
    // The four lines waiting on the robot snapshot are one action.
    const waiting = practiceChecklist(lines(ok, false))
    expect(waiting.left).toHaveLength(4)
    expect(waiting.end).toBe('1 left: drop the snapshot')
    expect(waiting.actions).toEqual(['drop the snapshot'])
  })
})

describe('the pit-check record', () => {
  // In the key order this build writes a typed pit check (the old-build test below needs the bytes to match).
  const line = '{"dirty":false,"robot":"Test robot @ main","when":"2099-03-05T17:00:00Z","type":"pit-check","verdict":"GO WITH DEFERRALS","sha":"abc1234"}'
  const go = '{"dirty":false,"robot":"Test robot @ main","when":"2099-03-05T16:00:00Z","type":"pit-check","verdict":"GO","sha":"def5678"}'

  it('GO WITH DEFERRALS is read as a pit check and writes back unchanged', () => {
    const { events, skipped } = parseHistory(`${go}\n${line}\n`)
    expect(skipped).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['pit-check', 'pit-check'])
    expect((events[1] as PitCheckEvent).verdict).toBe('GO WITH DEFERRALS')
    expect(serializeHistory(events)).toBe(`${go}\n${line}\n`)
  })

  it('counts as passing: lastPassingSha takes the latest GO or GO WITH DEFERRALS, never NO-GO', () => {
    const events = parseHistory(`${go}\n${line}\n`).events
    expect(lastPassingSha(events)).toBe('abc1234')
    expect(lastPassingSha(parseHistory(`${go}\n${line.replace('GO WITH DEFERRALS', 'NO-GO').replace('T17:00', 'T18:00')}\n`).events)).toBe('def5678')
  })

  it('an old build, which types only GO, NO-GO and NOT CHECKED, keeps the line opaque and writes it back byte for byte', () => {
    const oldBuildHolds: OpaqueEvent = { type: 'opaque', raw: line, when: '2099-03-05T17:00:00Z' }
    const text = `${go}\n${line}\n`
    const old = [...parseHistory(go).events, oldBuildHolds]
    expect(serializeHistory(old)).toBe(text)
    // And an old build's lastPassingSha does not see it (an opaque line has no verdict), so it falls back to the earlier GO.
    expect(lastPassingSha(old)).toBe('def5678')
  })
})

describe('the words are shared with the queue sheet, and the tone is never green for a go with work open', () => {
  it('the queue sheet\'s verdict starts with the same GO WITH words Foresight shows', () => {
    const D = 'power/rest-voltage'
    const s = session([match(2, { fires: [{ key: D }] }), match(3, { fires: [{ key: D }] })])
    const h: BoardEvent[] = [
      { type: 'board', v: 1, key: D, robot: ROBOT, op: 'workaround', value: 'test workaround', event: 'TEST', by: { device: 'd', role: 'pit' }, seq: 1, when: '2099-03-05T20:00:00Z' },
      { type: 'board', v: 1, key: D, robot: ROBOT, op: 'defer', value: 'end-of-event', until: { kind: 'end-of-event' }, event: 'TEST', by: { device: 'd', role: 'pit' }, seq: 2, when: '2099-03-05T20:00:00Z' },
    ]
    const sheet = queueSheet(buildBoard(input(s, h)))
    expect(sheet.verdict.text).toBe(`${goWithWord(1)} · 0 REDS OPEN`)
    expect(sheet.verdict.text).toBe('GO WITH 1 DEFERRAL · 0 REDS OPEN')
  })
  it('tones', () => {
    expect(['GO', 'GO WITH 2 DEFERRALS', 'NO-GO', 'NOT CHECKED', 'Ready to drive', '3 left'].map(verdictTone)).toEqual(['ok', 'warning', 'error', 'muted', 'ok', 'warning'])
  })
})


describe('the fix pass', () => {
  const D = 'power/rest-voltage'
  const scene = session([2, 3].map((n) => match(n, { fires: [{ key: D }] })))
  const bl = (key: string, op: BoardEvent['op'], value: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
    type: 'board', v: 1, key, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: 1, when: '2099-03-05T20:00:00Z', ...o,
  })
  const until = (kind: 'end-of-event' | 'next-event') => [bl(D, 'workaround', 'test workaround'), bl(D, 'defer', kind, { seq: 2, until: { kind } })]

  it('1: an earlier event\'s board keeps only what was deferred to the next event, and says where from', () => {
    const board = (k: 'end-of-event' | 'next-event') => boardFor(scene, until(k), profile, new Date('2099-03-05T21:00:00Z'))
    expect(openDeferrals(board('end-of-event'), profile)).toHaveLength(1)
    expect(openDeferrals(board('end-of-event'), profile, 'Test Regional')).toEqual([])
    expect(openDeferrals(board('next-event'), profile, 'Test Regional')).toEqual([expect.objectContaining({ key: D, carriedFrom: 'Test Regional', until: 'the next event' })])
  })

  it('2: a system left unjudged makes the word NOT CHECKED, even when the engine\'s word is not, and a deferral never lifts it', () => {
    const v = { ...verdict([]), verdict: 'GO' as const, blind: [{ rule: 'vision/stale', reason: 'missing a signal' }] }
    const c = checklist(v, [defer(RED_POWER, 'Power')])
    expect(row(c, 'Vision').word).toBe('Not checked')
    expect([c.word, c.reason]).toEqual(['NOT CHECKED', 'could not check Vision'])
  })

  it('3: practice never says Ready to drive over a red or amber no checklist line covers', () => {
    const v = verdictFor(report([finding('can/bus-dropout', null)]), PROVEN)
    expect(uncoveredItems(v).map((i) => i.finding.rule)).toEqual(['can/bus-dropout'])
    const c = practiceChecklist(markOnchecks({ verdict: v, report: report([finding('can/bus-dropout', null)]), snapshotUsed: true }), uncoveredItems(v))
    expect(c.ready).toBe(false)
    expect(c.end).toMatch(/^1 left: .* \(no checklist line\)$/)
    expect(c.items.at(-1)).toMatchObject({ group: 'Not on the checklist', done: false })
  })

  it('4: a deferred red is DEFERRED with its workaround on the card, never FIX', () => {
    const v = verdict([RED_POWER])
    const base = { verdict: 'GO WITH 1 DEFERRAL', why: 'x', state: 'connected', message: '', url: null, readAt: new Date('2099-03-05T21:00:00Z'), robot: null, items: v.items, onchecks: [], battery: null, controllers: [], build: null, notChecked: [] } as ForesightReportInput
    const card = foresightCard({ ...base, deferred: { [RED_POWER.key]: 'test workaround' } })
    expect(card.items).toEqual([expect.objectContaining({ word: 'DEFERRED', tone: 'warning', number: 'workaround: test workaround' })])
    expect(foresightCard(base).items[0].word).toBe('FIX')
  })

  it('7: every practice line the list puts first is a line of the team\'s checklist', () => {
    const names = new Set(ONCHECKS.map((l) => l.line))
    for (const g of PRACTICE_FIRST) for (const l of g.lines) expect(names.has(l)).toBe(true)
  })

  it('13: a row says how many of its checks ran; Vision says tag not seen yet until the camera step clears', () => {
    const v = verdict([finding('foresight/camera-sees-tag', 'Front camera', 'info')], [{ rule: 'vision/time-sync', reason: 'missing a signal' }])
    const c = checklist(v)
    const vision = row(c, 'Vision')
    expect(vision.note).toBe('tag not seen yet')
    expect(vision.ran.n).toBe(vision.ran.of - 1)
    expect(row(c, 'Power').note).toBeNull()
    expect(checklist(verdict([])).rows.every((r) => r.ran.n === r.ran.of)).toBe(true)
    expect(checklist(null).rows.every((r) => r.ran.n === 0)).toBe(true)
  })

  it('11: lines this robot\'s code can never report go to the by-hand fold, not "n left"', () => {
    const r = report([], [{ rule: 'foresight/log-usb-stick', reason: "the robot doesn't send /X/OnUsb: check by hand" }])
    const c = practiceChecklist(markOnchecks({ verdict: verdictFor(r, PROVEN), report: r, snapshotUsed: true }))
    expect(c.items.map((i) => i.line.line)).not.toContain('Log stick in')
    expect(c.byEye.map((l) => l.line)).toContain('Log stick in')
    expect(c.ready).toBe(true)
  })

  it('6: today is an event day from The Blue Alliance\'s dates or a library log dated today, and the mode line says which', () => {
    const now = new Date(2099, 2, 5, 10).getTime()
    const events = [{ key: '2099test', name: 'Test Regional', start_date: '2099-03-04', end_date: '2099-03-06' }, { key: '2099late', name: 'Late Event', start_date: '2099-04-01', end_date: '2099-04-03' }]
    const tba = eventFromSchedule(events, now)!
    expect(tba).toMatchObject({ id: 'event-days:2099test', signal: 'tba' })
    expect(eventFromSchedule(events, new Date(2099, 2, 7).getTime())).toBeNull()
    const lib = eventFromLibrary([{ onField: false, playedAt: now }, { onField: true, playedAt: now, event: 'TEST' }], now)!
    expect(lib.signal).toBe('library')
    expect(eventFromLibrary([{ onField: true, playedAt: now - 3 * 86400e3 }], now)).toBeNull()
    expect(todayMode([], now, {}, tba)).toMatchObject({ mode: 'event', byHand: false, line: "Event · Test Regional 2099 (from The Blue Alliance's schedule)" })
    expect(todayMode([], now, {}, lib).line).toMatch(/from a log in the library dated today/)
    expect(todayMode([], now, {}, null)).toMatchObject({ mode: 'practice' })
    // A hand choice is kept under the event's id, so it holds on the event's other days; and it says so.
    const store = { [`mode:${tba.id}`]: 'practice' }
    expect(todayMode([], now, store, tba)).toMatchObject({ mode: 'practice', byHand: true })
    expect(todayMode([], now + 86400e3, store, tba).mode).toBe('practice')
  })
})

describe('the fix pass, round 2', () => {
  const D = 'power/rest-voltage'
  const scene = session([2, 3].map((n) => match(n, { fires: [{ key: D }] })))
  const day1 = scene.matches[0].playedAt!
  const h = (kind: 'end-of-event' | 'next-event'): BoardEvent[] => [
    { type: 'board', v: 1, key: D, robot: ROBOT, op: 'workaround', value: 'test workaround', event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: 1, when: new Date(day1 + 3600e3).toISOString() },
    { type: 'board', v: 1, key: D, robot: ROBOT, op: 'defer', value: kind, until: { kind }, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: 2, when: new Date(day1 + 3600e3).toISOString() },
  ]
  const events = [{ key: '2099test', name: 'Test Regional', start_date: '2099-03-04', end_date: '2099-03-06' }]

  it('1: day two of an event, no log of today loaded: the end-of-event deferral is still shown and ticks are filed', () => {
    const now = day1 + 86400e3
    const tba = eventFromSchedule(events, now)!
    const t = todayMode([scene], now, {}, tba)
    const def = deferralSession([scene], t.sessionId, ROBOT)!
    expect(def.id).not.toBe(t.sessionId)
    // Within the repo's same-event window: today's event, not carried.
    expect(isCarried(def, t.sessionId, tba, now)).toBe(false)
    const board = boardFor(def, h('end-of-event'), profile, new Date(now))
    expect(openDeferrals(board, profile, isCarried(def, t.sessionId, tba, now) ? sessionEventName(def) : undefined)).toHaveLength(1)
  })

  it('1: the same key or name makes it today\'s event at any age; an event more than 4 days old with neither is carried', () => {
    const week = day1 + 7 * 86400e3
    const sameKey = { ...scene, event: { key: '2099test', name: 'Test Regional' } } as unknown as typeof scene
    expect(isCarried(sameKey, 'practice:x', { key: '2099test', name: 'Other' }, week)).toBe(false)
    expect(isCarried(scene, 'practice:x', { name: 'test' }, week)).toBe(false) // the field's own event name, TEST
    expect(isCarried(scene, 'practice:x', { key: '2099late', name: 'Late Event' }, week)).toBe(true)
    expect(isCarried(scene, scene.id, null, week)).toBe(false)
    expect(isCarried(scene, 'practice:x', null, day1 + 86400e3)).toBe(false)
    expect(isCarried(scene, 'practice:x', null, week)).toBe(true)
    // Two named events with different keys: carried inside the window too.
    const named = { ...scene, event: { key: '2099test', name: 'Test Regional' } } as unknown as typeof scene
    expect(isCarried(named, 'practice:x', { key: '2099other', name: 'Other Regional' }, day1 + 3.5 * 86400e3)).toBe(true)
    expect(isCarried(named, 'practice:x', { key: '2099test', name: 'Test Regional' }, day1 + 3.5 * 86400e3)).toBe(false)
    // A session the field named (no TBA key of its own): TBA's key without its year against the field's name.
    expect(isCarried(scene, 'practice:x', { key: '2099other', name: 'Other Regional' }, day1 + 3.5 * 86400e3)).toBe(true)
    expect(isCarried(scene, 'practice:x', { key: '2099test', name: 'Test Regional' }, day1 + 3.5 * 86400e3)).toBe(false)
  })

  it('3: a tick dated after now reads clock ahead and is not fresh', () => {
    const t = tickAt('pit', '2099-03-05T22:00:00Z', Date.parse('2099-03-05T21:00:00Z'))
    expect(t).toMatchObject({ ahead: true, old: true })
    expect(tickAt('pit', '2099-03-05T21:00:00Z', Date.parse('2099-03-05T21:10:00Z'))).toMatchObject({ ahead: false, old: false })
  })

  it('6: one meaning of ran: a check that ran in part did not, and the rows add up to the box\'s count', () => {
    const states = [
      verdict([]),
      verdict([], [{ rule: 'vision/time-sync', reason: 'partly checked; one camera missing' }]),
      verdict([RED_POWER], [{ rule: 'snapshot/devices', reason: 'no robot snapshot' }, { rule: 'foresight/controllers', reason: 'missing a signal' }, { rule: 'vision/stale', reason: 'partly checked' }]),
    ]
    for (const v of states) {
      const c = checklist(v)
      const notRun = c.rows.reduce((n, r) => n + (r.ran.of - r.ran.n), 0)
      expect(notRun).toBe(v.notChecked.length + v.crashed.length)
      expect(c.rows.reduce((n, r) => n + r.ran.of, 0)).toBe(26)
    }
    expect(row(checklist(states[1]), 'Vision').ran.n).toBe(row(checklist(states[1]), 'Vision').ran.of - 1)
  })
})

describe('a system whose checks all failed to run is never Go (Kevin, 2026-10-24)', () => {
  // The drivetrain's three checks (gyro drift, CANcoder offsets, swerve ratio) all skipped: 0 of 3 ran.
  const skipAll = ['foresight/gyro-still-drift', 'snapshot/cancoder-offsets', 'snapshot/swerve-ratio'].map((rule) => ({ rule, reason: 'no robot snapshot' }))
  const v = () => verdict([], skipAll)
  const withTick = (when: string, now = Date.parse('2099-03-05T21:00:00Z')) => new Map([['Drivetrain' as const, tickAt('pit', when, now)]])
  const at = (c: ReturnType<typeof checklist>) => row(c, 'Drivetrain')

  it('0 of 3 with no tick: Check by hand with its step, and the word is NOT CHECKED naming the row', () => {
    const c = queueChecklist({ verdict: v(), why: '', profile, deferrals: [], deferralNote: null })
    expect(at(c)).toMatchObject({ word: 'Check by hand', ran: { n: 0, of: 3 }, step: 'On blocks: enable and confirm every wheel spins the way it should' })
    expect(at(c).text).toBe('Check by hand: On blocks: enable and confirm every wheel spins the way it should')
    expect([c.word, c.reason]).toEqual(['NOT CHECKED', 'Drivetrain: check by hand'])
  })

  it('a fresh tick turns the row Go and the word GO; an old tick, or one from a clock ahead, does not', () => {
    const fresh = queueChecklist({ verdict: v(), why: '', profile, deferrals: [], deferralNote: null, ticks: withTick('2099-03-05T20:30:00Z') })
    expect([at(fresh).word, fresh.word]).toEqual(['Go', 'GO'])
    for (const when of ['2099-03-05T18:00:00Z', '2099-03-05T22:00:00Z']) {
      const c = queueChecklist({ verdict: v(), why: '', profile, deferrals: [], deferralNote: null, ticks: withTick(when) })
      expect([at(c).word, c.word]).toEqual(['Check by hand', 'NOT CHECKED'])
    }
  })

  it('a deferral does not lift it; another system reads only "Check by hand" with no step of the team\'s', () => {
    const c = queueChecklist({ verdict: v(), why: '', profile, deferrals: [defer(RED_POWER, 'Power')], deferralNote: null })
    expect(c.word).toBe('NOT CHECKED')
    // Nothing proven here, so nothing is blind: only the person can say Power is fine.
    const power = verdictFor(report([], ['power/rest-voltage', 'battery/identity', 'battery/gauge-capacity'].map((rule) => ({ rule, reason: 'missing a signal' }))), {})
    const p = queueChecklist({ verdict: power, why: '', profile, deferrals: [], deferralNote: null })
    expect(row(p, 'Power')).toMatchObject({ word: 'Check by hand', step: null })
    expect(row(p, 'Power').text).toMatch(/^Check by hand: /)
  })

  it('the drivetrain needs its tick however many of its checks ran', () => {
    const none = queueChecklist({ verdict: verdict([]), why: '', profile, deferrals: [], deferralNote: null })
    expect(at(none)).toMatchObject({ word: 'Check by hand', ran: { n: 3, of: 3 } })
    expect(none.word).toBe('NOT CHECKED')
    const some = queueChecklist({ verdict: verdict([], skipAll.slice(0, 1)), why: '', profile, deferrals: [], deferralNote: null })
    expect(at(some).word).toBe('Check by hand')
    expect(queueChecklist({ verdict: verdict([]), why: '', profile, deferrals: [], deferralNote: null, ticks: BLOCKS }).word).toBe('GO')
  })

  it('a No-go still beats it, and a system with some checks run is not by hand', () => {
    const c = queueChecklist({ verdict: verdict([RED_POWER], skipAll), why: '', profile, deferrals: [], deferralNote: null })
    expect(row(c, 'Power').word).toBe('No-go')
    // Power with only some of its checks run is Go: only a system with none run, or the drivetrain, waits for a person.
    const some = queueChecklist({ verdict: verdictFor(report([], [{ rule: 'power/rest-voltage', reason: 'missing a signal' }]), {}), why: '', profile, deferrals: [], deferralNote: null, ticks: BLOCKS })
    expect(row(some, 'Power').word).toBe('Go')
  })
})
