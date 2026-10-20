// The team's pit checklist as Foresight marks it: from the current check only, "by eye" never OK, and the verdict
// itself untouched by the list.
import { describe, expect, it } from 'vitest'
import { markOnchecks, ONCHECKS, wantedLines } from '../src/foresight/onchecks.ts'
import { WANTED_CHECKS } from '../src/rules/wanted.ts'
import { FORESIGHT_RULES } from '../src/rules/index.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import type { Report } from '../src/rules/index.ts'

const finding = (rule: string, severity: 'warning' | 'info', title = rule) => ({ rule, severity, title, time: null, matchTime: null, when: null, about: null, key: rule, evidence: {}, meaning: '', causes: [], nextStep: '' })
const proven = { 'power/rest-voltage': { logs: 9, fires: 1, ourFires: 1, base: 'x', date: 'd' } }
const state = (marked: ReturnType<typeof markOnchecks>, line: string) => marked.find((l) => l.line === line)!.state

describe('the team\'s pit checklist in Foresight', () => {
  it('with no current check, nothing is OK; by-eye lines say so', () => {
    const marked = markOnchecks(null)
    expect(marked.length).toBe(ONCHECKS.length)
    expect(marked.some((l) => l.state === 'ok')).toBe(false)
    expect(state(marked, 'Correct auto selected in Elastic')).toBe('by eye')
    expect(state(marked, 'Log stick in')).toBe('not checked')
    expect(state(marked, 'Fresh battery installed')).toBe('not checked')
  })

  it('marks lines from the verdict: red, amber, context, OK, and not checked when no covering check ran', () => {
    const report: Report = {
      findings: [finding('power/rest-voltage', 'warning', 'Battery rested at 12.45 V'), finding('build/dirty', 'warning'), finding('foresight/gyro-still-drift', 'info', 'Gyro moved 0.02°')],
      skipped: [{ rule: 'foresight/zero-sanity', reason: 'missing /Intake/Pivot/PositionRotations' }],
      crashed: [],
    }
    const verdict = verdictFor(report, proven)
    const marked = markOnchecks({ verdict, report })
    expect(state(marked, 'Fresh battery installed')).toBe('red')
    expect(state(marked, 'No undeployed changes')).toBe('amber')
    expect(state(marked, 'Gyro seems normal')).toBe('context')
    expect(state(marked, 'No alerts on Elastic')).toBe('ok')
    expect(state(marked, 'Mechanisms zeroed')).toBe('not checked')
    expect(marked.filter((l) => l.byEye).every((l) => l.state === 'by eye')).toBe(true)
    // The list is a view: the verdict is what verdictFor said, nothing more.
    expect(verdict.verdict).toBe('NO-GO')
  })

  it('an assisted check: its grey finding is a step ("Do"), and a camera check that could not run is not OK', () => {
    const step = { findings: [finding('foresight/camera-sees-tag', 'info', 'Hold an AprilTag up to Back_Right')], skipped: [], crashed: [] }
    const marked = markOnchecks({ verdict: verdictFor(step, proven), report: step })
    expect(marked.find((l) => l.line === 'All cameras on and detecting AprilTags')).toMatchObject({ state: 'to do', detail: 'Hold an AprilTag up to Back_Right' })
    expect(verdictFor(step, proven).verdict).toBe('GO')
    const blind = { findings: [], skipped: [{ rule: 'foresight/camera-sees-tag', reason: 'missing /Apriltag VisionBack_Left/Result' }], crashed: [] }
    expect(state(markOnchecks({ verdict: verdictFor(blind, proven), report: blind }), 'All cameras on and detecting AprilTags')).toBe('not checked')
    // The lines this work ticked, and the ones still waiting.
    const none = { findings: [], skipped: [], crashed: [] }
    const ok = markOnchecks({ verdict: verdictFor(none, proven), report: none })
    expect(['No motors overheating', 'All device values updating'].map((l) => state(ok, l))).toEqual(['ok', 'ok'])
    expect(state(ok, 'Log stick in')).toBe('ok')
    // The snapshot lines are never OK without a snapshot the check used, even when the report says nothing of them.
    expect(['CANcoder offsets correct and unchanged', 'Swerve ratio unchanged', 'All CAN devices licensed and ID\'d', 'Current limits as the code sets them'].map((l) => state(ok, l))).toEqual(Array(4).fill('not checked'))
    expect(ok.find((l) => l.line === 'Swerve ratio unchanged')!.detail).toMatch(/no robot snapshot/)
  })
})

describe('wanted checks in Foresight: grey context, never in the verdict', () => {
  const none: Report = { findings: [], skipped: [], crashed: [] }
  const noStick: Report = { findings: [], skipped: [{ rule: 'foresight/log-usb-stick', reason: 'the robot doesn\'t send /Hindsight/LogDrive/OnUsb' }], crashed: [] }

  it('lists every wanted check, worded as the problem; the log stick says only this pit check could see it', () => {
    const lines = wantedLines(null)
    expect(lines.map((l) => l.id)).toEqual(WANTED_CHECKS.map((w) => w.id))
    expect(lines.find((l) => l.id === 'wanted/log-usb-stick')!.detail).toMatch(/^only this pit check could see it \(a log that exists was written somewhere, so a missing stick never shows in a log\), once the robot sends/)
    expect(lines.find((l) => l.id === 'wanted/hood-zeroed-since-boot')!.detail).toMatch(/^no check can see it yet: the robot would need to send a true\/false "zeroed since boot" flag/)
    expect(wantedLines({ report: noStick }).map((l) => l.id)).toContain('wanted/log-usb-stick')
  })

  it('drops an entry while the check that covers it could run: its own line says it then', () => {
    expect(wantedLines({ report: none }).map((l) => l.id)).not.toContain('wanted/log-usb-stick')
    for (const w of WANTED_CHECKS.filter((w) => w.coveredBy)) expect(FORESIGHT_RULES.map((r) => r.id)).toContain(w.coveredBy)
  })

  it('never a check: no wanted id runs, so none can be a finding or move the verdict', () => {
    const ids = new Set(FORESIGHT_RULES.map((r) => r.id))
    expect(WANTED_CHECKS.some((w) => ids.has(w.id))).toBe(false)
    expect(verdictFor(noStick, proven).verdict).toBe('GO')
  })
})
