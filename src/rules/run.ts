/**
 * The runner: builds the things each rule checks (motors, devices, cameras, ...) from the robot profile, calls each
 * rule's `check`, and turns what it returns into findings. Rules don't call this; read it only if you are curious.
 */
import type { Match } from '../match/match.ts'
import type { Finding, Plot, PlotLine } from './types.ts'
import type { Answer, Link, Problem, Rule, Severity } from './rule.ts'
import { MatchView, MissingSignal, words, type CameraView, type DeviceView, type GroupView, type MechanismView, type MotorView } from './view.ts'

export interface SkippedRule { rule: string; reason: string }

export interface Report {
  findings: Finding[]
  /** Rules (or parts of rules) that couldn't run, and why. */
  skipped: SkippedRule[]
  /** Rules that threw: a bug in the rule, shown so it isn't silent. */
  crashed: SkippedRule[]
  /**
   * Findings the consolidators made to name a group of findings (src/rules/parents.ts). Kept out of `findings`, so
   * they add nothing to any count; the findings they group point at them with `explainedBy`. Left out when none.
   */
  parents?: Finding[]
}

/** What reduces a match's findings after the rules have run: links (src/rules/links.ts) nest one under another. */
export interface Consolidators {
  links?: Link[]
}

/** The most passes the consolidators get before they count as crashed (each pass only adds, so they settle sooner). */
export const MAX_PASSES = 10

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
/** Things only a fitting robot profile can name: rules over them don't run on a log the profile doesn't fit. */
const ROBOT_ITEMS = ['motor', 'motorGroup', 'device', 'camera', 'mechanism']

export function runRules(match: Match, rules: Rule[], consolidators: Consolidators = {}): Report {
  const view = new MatchView(match)
  const findings: Finding[] = []
  const skipped: SkippedRule[] = []
  const crashed: SkippedRule[] = []
  const misfit = match.profileChoice.misfit ? match.profileChoice.fit : null
  for (const rule of rules) {
    if (misfit && (rule.needsProfile ?? ROBOT_ITEMS.includes(rule.forEach ?? 'match'))) {
      skipped.push({ rule: rule.id, reason: `the robot profile doesn't fit this log (${misfit.present} of ${misfit.total} of its signals are in it)` })
      continue
    }
    try {
      const result = runOne(rule, view)
      findings.push(...result.findings)
      if (result.notChecked.length) {
        // "Not checked" only when every item was skipped and nothing was found; otherwise "partly checked".
        const all = result.itemsSkipped === result.items && result.findings.length === 0
        skipped.push({ rule: rule.id, reason: `${all ? '' : 'partly checked; '}${result.notChecked.join('; ')}` })
      }
    } catch (error) {
      crashed.push({ rule: rule.id, reason: String(error) })
    }
  }
  if (skipped.length) {
    findings.push({
      rule: 'meta/not-checked', severity: 'info', time: null, matchTime: null, when: null, about: null, key: 'meta/not-checked',
      title: `${skipped.length} rule${skipped.length === 1 ? '' : 's'} not checked or partly checked${skipped.every((x) => x.reason.includes('missing')) ? ': signals missing' : ''}`,
      meaning: 'These rules could not look at this log, so their silence says nothing about this match.',
      causes: [
        { id: 'not-logged', cause: 'The robot code does not log the signal', look: 'the evidence below names each missing key; search the robot code for it' },
        { id: 'profile', cause: 'The robot profile names a key this robot logs under another name', look: 'open the log in AdvantageScope and compare key names with the profile file in src/profiles/' },
      ],
      nextStep: 'For each rule you care about, log the missing signal or fix its key in the robot profile.',
      evidence: Object.fromEntries(skipped.map((s) => [s.rule, s.reason])),
    })
  }
  // Worst first: severity, then the rule's place in the list (things that cost the match first), then time.
  const place = (f: Finding) => { const i = rules.findIndex((r) => r.id === f.rule); return i < 0 ? rules.length : i }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || place(a) - place(b) || (a.time ?? Infinity) - (b.time ?? Infinity))
  const parents = consolidate(findings, consolidators, crashed)
  return { findings, skipped, crashed, ...(parents.length ? { parents } : {}) }
}

/**
 * The reduce stage: the consolidators run over the findings in a fixed order, pass after pass, until a pass changes
 * nothing. They only add (an `explainedBy`), never remove, merge or reorder, so they always settle; still changing after
 * `maxPasses` is reported as crashed, never a silent stop. Returns the parents they made.
 */
export function consolidate(findings: Finding[], consolidators: Consolidators, crashed: SkippedRule[] = [], maxPasses = MAX_PASSES): Finding[] {
  const parents: Finding[] = []
  for (let pass = 1; pass <= maxPasses; pass++) {
    const changed = nestPass(findings, consolidators.links ?? [], crashed)
    if (!changed) return parents
  }
  crashed.push({ rule: 'consolidators', reason: `still changing after ${maxPasses} pass${maxPasses === 1 ? '' : 'es'}` })
  return parents
}

/**
 * One pass over the links (src/rules/links.ts): a finding that another finding explains gets `explainedBy`. Each
 * finding gets at most one, and keeps it: the first link that matches, in links.ts order, and the first cause finding
 * in report order. A link that throws is listed with the crashed rules, like a rule. True if it explained any finding.
 */
function nestPass(findings: Finding[], links: Link[], crashed: SkippedRule[]): boolean {
  let changed = false
  for (const symptom of findings) {
    if (symptom.explainedBy) continue
    for (const l of links.filter((x) => x.explains === symptom.rule)) {
      let cause: Finding | undefined
      try {
        cause = findings.find((c) => c !== symptom && c.rule === l.cause && l.when(c, symptom))
      } catch (error) {
        const name = `link ${l.cause} → ${l.explains}`
        if (!crashed.some((c) => c.rule === name)) crashed.push({ rule: name, reason: String(error) })
      }
      if (!cause) continue
      symptom.explainedBy = { rule: cause.rule, about: cause.about, time: cause.time, why: l.why }
      changed = true
      break
    }
  }
  return changed
}

/** Run one rule over each of its things. A thing whose signals are missing is noted, not fatal. */
function runOne(rule: Rule, view: MatchView): { findings: Finding[]; notChecked: string[]; items: number; itemsSkipped: number } {
  const findings: Finding[] = []
  const notChecked: string[] = []
  // A pit check has nothing to judge in a match log (no disabled stretch): it stays quiet.
  if (rule.foresightOnly && view.beforeEnable.length === 0) return { findings, notChecked, items: 0, itemsSkipped: 0 }
  let items: ReturnType<typeof itemsFor>
  try {
    items = itemsFor(rule, view)
  } catch (error) {
    // e.g. no Alerts in the log at all: the rule couldn't look.
    if (!(error instanceof MissingSignal)) throw error
    return { findings, notChecked: [`missing ${error.key}`], items: 1, itemsSkipped: 1 }
  }
  // No alerts raised is a clean result; no motors or cameras in the profile means the rule couldn't look.
  if (items.length === 0 && rule.forEach !== 'alert') {
    return { findings, notChecked: [`the robot profile lists no ${rule.forEach}s`], items: 1, itemsSkipped: 1 }
  }
  let itemsSkipped = 0
  for (const item of items) {
    view.notes = []
    view.sampled.clear()
    try {
      const answer: Answer = item.check()
      const problems = answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]
      // A signal logged slowly can hide a short dip or spike: say so on each finding, and as "partly checked".
      const slow = view.slowSignals()
      findings.push(...problems.map((p) => withSampling(toFinding(rule, p, item.name, view), slow)))
      if (problems.length === 0) for (const s of slow) view.checkedOnlyPart(s.note)
      notChecked.push(...view.notes.map((n) => (item.name ? `${item.name}: ${n.reason}` : n.reason)))
      if (view.notes.some((n) => n.whole) && problems.length === 0) itemsSkipped++
    } catch (error) {
      if (!(error instanceof MissingSignal)) throw error
      itemsSkipped++
      notChecked.push(item.name ? `${item.name}: missing ${error.key}` : `missing ${error.key}`)
    }
  }
  return { findings, notChecked, items: items.length, itemsSkipped }
}

/** The things a rule checks, each with its name and a call to the rule's check. */
function itemsFor(rule: Rule, view: MatchView): { name: string | null; check: () => Answer }[] {
  const p = view.profile
  const motor = (m: (typeof p.motorGroups)[0]['motors'][0], group: string): MotorView => ({
    name: m.name, group,
    supply: () => view.signal(need(m.supplyCurrent, `${m.name} supply current`), `${m.name} supply`),
    stator: () => view.signal(need(m.statorCurrent, `${m.name} stator current`), `${m.name} stator`),
    velocity: () => view.signal(need(m.velocity, `${m.name} velocity`), m.name),
    connected: () => view.signal(need(m.connected, `${m.name} Connected flag`), `${m.name} connected`),
    temperature: () => view.signal(need(m.temperature, `${m.name} temperature`), `${m.name} temperature`),
  })
  switch (rule.forEach) {
    case undefined:
    case 'match':
      return [{ name: null, check: () => rule.check(view) }]
    case 'motor':
      return p.motorGroups.flatMap((g) => g.motors.map((m) => ({ name: m.name, check: () => rule.check(motor(m, g.name), view) })))
    case 'motorGroup':
      return p.motorGroups.map((g) => {
        const group: GroupView = { name: g.name, motors: g.motors.map((m) => motor(m, g.name)), limits: g.limits, sameLoop: !!g.sameLoop }
        return { name: g.name, check: () => rule.check(group, view) }
      })
    case 'device': {
      const devices: DeviceView[] = [
        ...p.motorGroups.flatMap((g) => g.motors.filter((m) => m.connected).map((m) => motor(m, g.name))),
        ...p.otherDevices.map((d) => ({ name: d.name, connected: () => view.signal(d.connected, `${d.name} connected`) })),
      ]
      return devices.map((d) => ({ name: d.name, check: () => rule.check(d, view) }))
    }
    case 'camera':
      return p.cameras.map((c) => {
        const camera: CameraView = {
          name: c.name,
          acceptedPose: () => view.pose(c.acceptedPose),
          acceptedPoseKey: c.acceptedPose,
          resultKey: c.result ?? null,
          tagsSeen: () => view.photonTargets(need(c.result, `${c.name} PhotonVision result`), `${c.name} tags seen`),
          stale: () => view.signal(c.stale, `${c.name} stale`),
          connected: () => view.signal(c.connected, `${c.name} connected`),
        }
        return { name: c.name, check: () => rule.check(camera, view) }
      })
    case 'mechanism':
      return p.zeroing.map((z) => ({
        name: z.mechanism,
        check: () => {
          const mechanism: MechanismView = {
            name: z.mechanism,
            position: () => view.signal(z.position, `${z.mechanism} position (°)`).times(z.positionToDegrees),
            zeroDoneAt: view.text('console').firstMatch(z.doneMessage),
            zeroDirection: z.zeroDirection,
            moveDegrees: z.moveDegrees,
          }
          return rule.check(mechanism, view)
        },
      }))
    case 'alert':
      return view.alerts().map((a) => ({ name: a.name, check: () => rule.check(a, view) }))
  }
}

function need(key: string | undefined, what: string): string {
  if (!key) throw new MissingSignal(`${what} (not in the robot profile)`)
  return key
}

function toFinding(rule: Rule, p: Problem, itemName: string | null, view: MatchView): Finding {
  const about = p.about ?? itemName
  const time = p.at ?? null
  // A cause id the rule doesn't have is a typo in the rule: stop, so it shows as crashed instead of silently ranking nothing.
  const unknown = [...(p.likely ?? []), ...Object.keys(p.ruledOut ?? {})].filter((id) => !rule.causes.some((c) => c.id === id))
  if (unknown.length) throw new Error(`${rule.id}: no cause with id ${unknown.map((id) => `"${id}"`).join(', ')}`)
  // This log's likely causes first (in the order the rule gave them), then the rest in the rule's order.
  const likely = p.likely ?? []
  const rank = (id: string) => (likely.includes(id) ? likely.indexOf(id) : likely.length + rule.causes.findIndex((c) => c.id === id))
  const causes = [...rule.causes]
    .sort((a, b) => Number(!!p.ruledOut?.[a.id]) - Number(!!p.ruledOut?.[b.id]) || rank(a.id) - rank(b.id))
    .map((c) => ({ ...c, ...(likely.includes(c.id) ? { likely: true } : {}), ...(p.ruledOut?.[c.id] ? { ruledOut: p.ruledOut[c.id] } : {}) }))
  return {
    rule: rule.id,
    severity: p.severity ?? rule.severity,
    title: p.message,
    time,
    matchTime: time === null ? null : view.matchSeconds(time),
    when: time === null ? null : view.when(time),
    meaning: rule.meaning,
    causes,
    nextStep: p.nextStep ?? rule.nextStep,
    about,
    key: about ? `${rule.id} · ${about}` : rule.id,
    evidence: definedOnly(p.evidence),
    measured: p.measured,
    plot: toPlot(p, view),
  }
}

function withSampling(f: Finding, slow: { label: string; note: string }[]): Finding {
  if (slow.length === 0) return f
  return { ...f, evidence: { ...f.evidence, 'logged slowly (short dips or spikes can be missed)': slow.map((s) => s.note).join('; ') } }
}

function toPlot(p: Problem, view: MatchView): Plot | undefined {
  if (!p.plot || p.plot.signals.length === 0) return undefined
  const from = p.plot.from ?? (p.at ?? NaN) - 5
  const to = p.plot.to ?? (p.at ?? NaN) + 5
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined
  const lines: PlotLine[] = []
  for (const s of p.plot.signals) {
    if (typeof s !== 'string') lines.push({ label: s.label, data: s.series })
    else if (view.has(s)) lines.push({ label: words(s), data: view.signal(s).series })
  }
  return { from, to, lines, unit: p.plot.unit ?? '', threshold: p.plot.line, markers: p.plot.marks?.map((t) => ({ t, label: '' })) }
}

/** The evidence without the entries a rule left undefined. */
function definedOnly(evidence: Problem['evidence']): Record<string, number | string> {
  return Object.fromEntries(Object.entries(evidence ?? {}).filter((e): e is [string, number | string] => e[1] !== undefined))
}
