// Foresight's two checklists (ADR 9): the queue's systems with deferrals, and the practice-start list. Invented robot,
// event TEST, "test workaround". The team-log replay at the end is skipped when ~/.hindsight/team-logs.json is absent.
import { describe, expect, it } from 'vitest'
import {
  boardFor, deferralSession, openDeferrals, practiceChecklist, queueChecklist, SYSTEMS, systemOf, tickKey, ticksFor, type OpenDeferral,
} from '../src/foresight/checklists.ts'
import { markOnchecks } from '../src/foresight/onchecks.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import type { Report } from '../src/rules/index.ts'
import type { Proof } from '../src/foresight/proven.ts'
import { goWithWord } from '../src/board/words.ts'
import { queueSheet } from '../src/board/sheets.ts'
import { buildBoard } from '../src/board/model.ts'
import { atLatest, boardLines } from '../src/board/writes.ts'
import { lastPassingSha, parseHistory, serializeHistory, type BoardEvent, type HistoryEvent, type OpaqueEvent, type PitCheckEvent } from '../src/triage/history.ts'
import { verdictTone } from '../src/report/foresight-model.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { ROBOT, input, match, profile as sceneProfile, session } from './helpers/board-scene.ts'

const profile = { ...sceneProfile, motorGroups: [...(sceneProfile as RobotProfile).motorGroups, { name: 'Drive', motors: [{ name: 'Drive front left' }] }] } as unknown as RobotProfile

const finding = (rule: string, about: string | null, severity: 'error' | 'warning' | 'info' = 'warning') => ({
  rule, severity, title: `test finding ${rule}${about ? ` (${about})` : ''}`, time: null, matchTime: null, when: null, about, key: about ? `${rule} · ${about}` : rule,
  evidence: {}, meaning: '', causes: [], nextStep: `test step for ${rule}`,
})
const real: Proof = { logs: 9, fires: 1, ourFires: 1, base: 'test', date: '2099-03-05' }
const PROVEN = { 'power/rest-voltage': real, 'vision/stale': real, 'can/device-dropout': real, 'build/dirty': real, 'foresight/zero-sanity': real }
const report = (findings: ReturnType<typeof finding>[], skipped: Report['skipped'] = []): Report => ({ findings, skipped, crashed: [] } as unknown as Report)
const verdict = (findings: ReturnType<typeof finding>[], skipped: Report['skipped'] = []) => verdictFor(report(findings, skipped), PROVEN)

const RED_POWER = finding('power/rest-voltage', null)
const RED_CAMERA = finding('vision/stale', 'Front camera')
const RED_CODE = finding('build/dirty', null)
const defer = (f: ReturnType<typeof finding>, system: OpenDeferral['system'], workaround = 'test workaround'): OpenDeferral => ({ key: f.key, system, title: `${system} · ${f.rule}`, workaround, until: 'the end of the event' })
const checklist = (v: ReturnType<typeof verdict> | null, deferrals: OpenDeferral[] | null = [], note: string | null = null) => queueChecklist({ verdict: v, why: 'test not connected', profile, deferrals, deferralNote: note })
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
  const s = session([2, 3].map((n) => match(n)))
  const tickLines = (history: HistoryEvent[], on: boolean, forMatch: string, system = SYSTEMS[0], role: 'pit' | 'drive' = 'pit') =>
    boardLines(history, { device: 'dev-a', role }, new Date('2099-03-05T21:00:00Z'), { key: tickKey(system), robot: ROBOT }, [{ op: on ? 'checked' : 'unchecked', value: forMatch }], atLatest(s))

  it('a tick for this match counts, with its role; another match\'s does not; un-ticking takes it back', () => {
    const ticked = tickLines([], true, 'after Q3')
    expect(ticksFor(ticked, ROBOT, s, 'after Q3').get('Power')).toMatchObject({ role: 'pit' })
    expect(ticksFor(ticked, ROBOT, s, 'after Q4').size).toBe(0)
    const back = [...ticked, ...tickLines(ticked, false, 'after Q3')]
    expect(ticksFor(back, ROBOT, s, 'after Q3').size).toBe(0)
  })

  it('a tick from another event, or with no event loaded, is not read; the board never shows it as an issue', () => {
    const ticked = tickLines([], true, 'after Q3').map((e) => ({ ...e, event: 'OTHER' }) as HistoryEvent)
    expect(ticksFor(ticked, ROBOT, s, 'after Q3').size).toBe(0)
    expect(ticksFor(tickLines([], true, 'after Q3'), ROBOT, null, 'after Q3').size).toBe(0)
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
    expect(practiceChecklist(lines(ok, false)).end).toMatch(/^4 left: All CAN devices licensed and ID'd, CANcoder offsets correct and unchanged, Swerve ratio unchanged, Current limits as the code sets them$/)
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
