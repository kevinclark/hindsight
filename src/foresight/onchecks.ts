/**
 * The team's own pit checklist (2026 Pit Checklist, sections 6, 9 and 10), in its order and words, with each line
 * marked from Foresight's checks: OK, a problem (red or amber), not checked, or "check by eye" (nothing on the robot
 * can tell).
 *
 * It is a view of the verdict, never an input to it: a line is marked only from the current check's results, a
 * "by eye" line never counts toward GO, and a proven check that could not run still makes the verdict NOT CHECKED
 * whatever the lines show (verdict.ts).
 */
import type { Report } from '../rules/index.ts'
import { allItems, type Verdict } from './verdict.ts'
import { SNAPSHOT_RULES, TAKE_SNAPSHOT } from './snapshot-checks.ts'
import { WANTED_CHECKS } from '../rules/wanted.ts'

export interface OncheckLine {
  section: string
  line: string
  /** Foresight checks that cover the line. */
  rules?: string[]
  /** Nothing on the robot can tell: a person checks it. */
  byEye?: boolean
  /** What the checks cover of the line, when it is only part of it. */
  note?: string
  /**
   * Checks that need a person's help (e.g. holding a tag up to a camera): their context (grey) findings are the step to
   * do, so the line shows "Do" with the step until they clear. Never a fault, never counted toward GO.
   */
  assisted?: string[]
  /** Shown as one line with the others of this group (MERGED_LINES): the group's worst state, every part named. */
  group?: string
  /** Context only, not a row: it folds away with the lines a person checks. */
  context?: boolean
}

export const ONCHECKS: OncheckLine[] = [
  { section: 'Battery', line: 'Fresh battery installed', rules: ['power/rest-voltage', 'battery/identity', 'battery/gauge-capacity'], note: 'the team installs at 13.0 V on the PDH (13.3 V on the gauge); Foresight flags under 12.5 V at rest, measured at another moment' },
  { section: 'Controllers', line: 'Controllers plugged into the DS and working', rules: ['foresight/controllers'], note: 'plugged in on the right ports; whether they work is by eye' },
  { section: 'Controllers', line: 'Backup controller', byEye: true },
  { section: 'Software', line: 'All cameras on and detecting AprilTags', rules: ['vision/stale', 'vision/time-sync', 'foresight/camera-sees-tag'], assisted: ['foresight/camera-sees-tag'], note: 'connected, time-synced and each saw a tag' },
  { section: 'Software', line: 'Elastic open with the correct layout', byEye: true },
  { section: 'Software', line: 'Correct auto selected in Elastic', byEye: true },
  { section: 'Software', line: 'Other windows closed on the DS laptop', byEye: true },
  { section: 'Software', line: 'No alerts on Elastic', rules: ['alerts/passthrough'] },
  { section: 'Software', line: 'Mechanisms zeroed', rules: ['foresight/zero-sanity'], note: 'the intake pivot against its CANcoder; the hood has no absolute encoder' },
  { section: 'Software', line: 'CANcoder offsets correct and unchanged', rules: ['snapshot/cancoder-offsets'], group: 'snapshot', note: 'from the robot snapshot: each CANcoder runs the code\'s offset and is read by its own motor; whether the code\'s offsets are right (wheels straight) is by eye' },
  { section: 'Software', line: 'Swerve ratio unchanged', rules: ['snapshot/swerve-ratio'], group: 'snapshot', note: 'from the robot snapshot: every drive and steer motor runs the code\'s gear ratio' },
  { section: 'Software', line: 'All CAN devices licensed and ID\'d', rules: ['snapshot/devices', 'snapshot/licensed'], group: 'snapshot', note: 'from the robot snapshot: every motor, CANcoder and the gyro on its own ID, and no Pro feature used without a licence' },
  { section: 'Software', line: 'Current limits as the code sets them', rules: ['snapshot/current-limits'], group: 'snapshot', note: 'Foresight\'s line, not on the team\'s list: from the robot snapshot, every motor\'s six current-limit settings, followers included' },
  { section: 'Software', line: 'All device values updating', rules: ['can/device-dropout', 'foresight/values-updating'], group: 'devices', note: 'devices connected and their readings changing; not the CANcoders or flywheel motors (nothing of theirs changes at rest)' },
  { section: 'Software', line: 'CTRE devices healthy', rules: ['can/device-rebooted', 'foresight/sticky-faults', 'foresight/firmware-mismatch'], note: 'Foresight\'s line, not on the team\'s list: from the Hindsight companion\'s reading of each device the code watches (HindsightDevices.watch): no reboot, no sticky fault, one firmware per model' },
  { section: 'Software', line: 'Log stick in', rules: ['foresight/log-usb-stick'], note: 'the robot\'s own reading, once a second since its code started (Hindsight companion library): OK only if the stick has been in the whole time. Pulled it, even if it\'s back? Restart the robot code: the log doesn\'t carry on when a stick goes back in' },
  { section: 'Software', line: 'Gyro seems normal', rules: ['foresight/gyro-still-drift'], context: true, note: 'heading drift while still, as context: no line yet' },
  { section: 'Software', line: 'No undeployed changes', rules: ['build/dirty', 'foresight/commit-matches'] },
  { section: 'Software', line: 'No motors overheating', rules: ['foresight/motor-temperature'], group: 'devices', note: 'every motor at or under 60 °C (hotter than any ended a CalGames match)' },
]

/** Every check that asks a person to do something (its grey findings are a step, not context). */
export const ASSISTED_RULES = new Set(ONCHECKS.flatMap((l) => l.assisted ?? []))

export type LineState = 'ok' | 'red' | 'amber' | 'to do' | 'context' | 'not checked' | 'by eye'

export interface MarkedLine extends OncheckLine { state: LineState; detail: string }

const FROM_SNAPSHOT = new Set<string>(SNAPSHOT_RULES)

/**
 * Mark each line from the current check (null: nothing current, e.g. settling, closed or stale). `snapshotUsed`: the
 * check ran over a robot snapshot (engine.ts); without one, the snapshot lines are never OK, even if nothing says so.
 */
export function markOnchecks(current: { verdict: Verdict; report: Report; snapshotUsed?: boolean } | null): MarkedLine[] {
  return ONCHECKS.map((l) => {
    if (l.byEye) return { ...l, state: 'by eye', detail: 'check by eye' }
    if (!current) return { ...l, state: 'not checked', detail: 'no current check' }
    const rules = l.rules ?? []
    // Items under another count too: "No alerts on Elastic" is not OK while Elastic shows one, whatever explains it.
    const items = allItems(current.verdict).filter((i) => rules.includes(i.finding.rule))
    const worst = items.find((i) => i.level === 'red') ?? items.find((i) => i.level === 'amber')
    if (worst) return { ...l, state: worst.level as 'red' | 'amber', detail: worst.finding.title }
    const steps = items.filter((i) => i.level === 'grey' && l.assisted?.includes(i.finding.rule))
    if (steps.length) return { ...l, state: 'to do', detail: steps.map((i) => i.finding.title).join('; ') }
    const blind = new Set([...current.report.skipped.filter((s) => !s.reason.startsWith('partly')), ...current.report.crashed].map((s) => s.rule))
    const ran = rules.filter((r) => !blind.has(r) && (current.snapshotUsed || !FROM_SNAPSHOT.has(r)))
    if (ran.length === 0) {
      const why = [...current.report.skipped, ...current.report.crashed].find((s) => rules.includes(s.rule))?.reason
      return { ...l, state: 'not checked', detail: why ?? (rules.some((r) => FROM_SNAPSHOT.has(r)) ? `no robot snapshot: ${TAKE_SNAPSHOT}` : 'its checks could not read their signals') }
    }
    // A snapshot check that skipped any part (an offset or a licence fault unread) can't vouch for the line either:
    // what it did read may be the lesser half (remote sensor IDs read, every offset not).
    const skippedSnapshot = [...current.report.skipped, ...current.report.crashed].find((s) => FROM_SNAPSHOT.has(s.rule) && rules.includes(s.rule))
    if (skippedSnapshot) return { ...l, state: 'not checked', detail: `${skippedSnapshot.rule}: ${skippedSnapshot.reason}` }
    // An assisted check that skipped any part (one camera unread) can't vouch for the line.
    const skippedStep = current.report.skipped.find((s) => l.assisted?.includes(s.rule)) ?? current.report.crashed.find((s) => l.assisted?.includes(s.rule))
    if (skippedStep) return { ...l, state: 'not checked', detail: `${skippedStep.rule}: ${skippedStep.reason}` }
    const context = items.find((i) => i.level === 'grey')
    if (context && items.every((i) => i.level === 'grey') && rules.every((r) => r === context.finding.rule)) return { ...l, state: 'context', detail: context.finding.title }
    return { ...l, state: 'ok', detail: l.note ?? 'OK' }
  })
}

export interface WantedLine { id: string; question: string; detail: string }

/**
 * The wanted checks (rules/wanted.ts) as Foresight shows them: grey context, never a fault, never an input to the
 * verdict. An entry whose covering check ran in the current check is left out: that check's own line says it now.
 */
export function wantedLines(current: { report: Report } | null): WantedLine[] {
  const ran = (rule: string) => !!current && ![...current.report.skipped, ...current.report.crashed].some((s) => s.rule === rule)
  return WANTED_CHECKS.filter((w) => !(w.coveredBy && ran(w.coveredBy))).map((w) => {
    const why = w.liveOnly ? `only this pit check could see it (${w.liveOnly}), once the robot sends ${w.needs}` : `no check can see it yet: the robot would need to send ${w.needs}`
    return { id: w.id, question: w.question, detail: `${why}. What happened: ${w.incident}.` }
  })
}

/**
 * The checklist as the page and the printed report show it (round-5-checklist.md, Kevin 2026-10-20): the team's lines
 * above, with each group below shown as one line at its first member's place. A merged line shows the worst state of
 * its parts and names every part that is not OK, so a merge hides nothing and changes nothing in the verdict (this is
 * still only a view of it).
 */
export const MERGED_LINES: Record<string, { line: string; ok: string }> = {
  snapshot: { line: 'Robot snapshot matches the code', ok: 'from the robot snapshot: CANcoder offsets, swerve ratio, every CAN device licensed and on its ID, current limits as the code sets them' },
  devices: { line: 'Devices connected, motors cool', ok: 'devices connected and their readings changing (not the CANcoders or flywheel motors: nothing of theirs changes at rest); every motor at or under 60 °C' },
}

export interface ChecklistLine extends MarkedLine {
  /** Folded away with the by-eye lines: a person's, or context that can never be a fault. */
  folded: boolean
  /** The lines merged into this one (empty for a line that stands alone). */
  parts: MarkedLine[]
}

// Worst first. "Not checked" outranks OK: a line is OK only if every part is.
const RANK: Record<LineState, number> = { red: 6, amber: 5, 'to do': 4, 'not checked': 3, context: 2, 'by eye': 1, ok: 0 }

export function mergeLines(lines: MarkedLine[]): ChecklistLine[] {
  const out: ChecklistLine[] = []
  const merged = new Map<string, ChecklistLine>()
  for (const l of lines) {
    if (!l.group) { out.push({ ...l, folded: l.state === 'by eye' || !!l.context, parts: [] }); continue }
    let m = merged.get(l.group)
    if (!m) {
      m = { section: l.section, line: MERGED_LINES[l.group].line, state: 'ok', detail: '', folded: false, parts: [] }
      merged.set(l.group, m); out.push(m)
    }
    m.parts.push(l)
  }
  for (const [group, m] of merged) {
    m.state = m.parts.reduce<LineState>((w, p) => (RANK[p.state] > RANK[w] ? p.state : w), 'ok')
    const bad = [...m.parts].filter((p) => p.state !== 'ok').sort((a, b) => RANK[b.state] - RANK[a.state])
    if (!bad.length) { m.detail = MERGED_LINES[group].ok; continue }
    // Parts that say the same thing (no snapshot) are named together, once.
    const byDetail = new Map<string, string[]>()
    for (const p of bad) byDetail.set(p.detail, [...(byDetail.get(p.detail) ?? []), p.line])
    m.detail = [...byDetail].map(([d, names]) => `${names.join(', ')}: ${d}`).join('; ')
  }
  return out
}

/** The checklist lines for the page and report: marked, then merged. */
export const checklistLines = (current: Parameters<typeof markOnchecks>[0]): ChecklistLine[] => mergeLines(markOnchecks(current))
