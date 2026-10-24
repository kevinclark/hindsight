/**
 * Did any device the robot logs a "...Connected" flag for go false while enabled, that the robot profile doesn't watch?
 *
 * Checks: every boolean input of the log named "<something>Connected" (AdvantageKit logs; the log type decides which
 * keys count, src/profiles/formats.ts) that was false while the robot was enabled, except the devices the robot profile
 * already names (can/device-dropout checks those) and the roboRIO's own readings (a dashboard's network client is not a
 * device). Three or more flags falling within 0.1 s of each other are one event, not that many devices.
 * Why: A public 2026 robot, Q108: the intake's leader motor went off 3 times, 29.2 s, 20.5 s, then for the rest
 * of the match; the team found the Anderson connector pulled apart.
 *
 * Checked on: those logs only, 26 (public ones and 8033's 2026 logs). It fired on 4 and one is a confirmed case (that
 * intake); a camera flag that dropped on 2 others is unconfirmed. Nothing says yet how often a flag drops without a
 * device fault.
 */
import { isFalse, plural, round, rule } from '../rule.ts'
import { CTRE_CAN_TROUBLESHOOTING, WPILIB_PREEMPTIVE } from '../sources.ts'
import type { Episode, MatchView } from '../view.ts'
import { secondsWatched, watched } from './bus.ts'

/** Flags falling within this many seconds of the first of them are one event. */
const TOGETHER = 0.1
/** This many flags in one event is the power, the bus or the code, not a device. */
const EVENT_SIZE = 3
/** A device off for longer than this in total makes the finding an error. */
const LONG_SECONDS = 5
/** Device lines shown before "+N more". */
const MAX_LINES = 8

interface Drop { name: string; episode: Episode }

export default rule({
  id: 'can/input-disconnected',
  title: 'Device input went disconnected',
  severity: 'warning',
  judges: 'fault',
  who: ['pit', 'software'],
  meaning: 'A device the robot code logs a Connected flag for stopped answering while the robot was enabled. If it is a motor, it stopped working until it came back.',
  causes: [
    { id: 'connector', cause: 'A loose or pulled-apart power or CAN connector on that device (Anderson, Weidmuller, Wago, a CAN splice)', look: 'tug each connector at that device and the ones next to it; look for a connector that has crept open' },
    { id: 'wiring', cause: 'Power or CAN wiring shared by several devices (a breaker, a splice, a terminal)', look: 'what else is on the same branch or PDH channel, and whether it dropped too' },
    { id: 'robot-power', cause: 'The robot lost power or the CAN bus went down (when several devices dropped at once)', look: 'the power/brownout and can/bus-dropout findings; the battery voltage at that moment' },
    { id: 'code-stopped', cause: 'The robot code stopped or restarted (when several devices dropped at once)', look: 'the loop/restart-mid-match finding and the console log at that time' },
    { id: 'device-fault', cause: 'The device itself (old firmware, damage)', look: 'its status light during a dropout; the vendor tool (Phoenix Tuner, REV Hardware Client) for firmware and faults' },
  ],
  nextStep: 'Tug-test the power and CAN connectors on the named device and the ones next to it, then check what else shares its wiring.',
  incident: 'A public 2026 robot, Q108: intake leader motor off at 282.2 s (29.2 s), 320.7 s (20.5 s), then from 342.4 s to the end; the team found the intake connector pulled apart',
  sources: [
    { ...CTRE_CAN_TROUBLESHOOTING, says: 'Flick, shake or jostle the CAN wiring to reproduce intermittent drops; bad crimps and connection points are the most common cause.' },
    { ...WPILIB_PREEMPTIVE, says: 'Tug-test the power connectors in the pit (none should pull out) and wiggle the battery connector; it is better for the robot to fail in the pits than in a match.' },
  ],
  thresholds: [
    { name: 'flags falling together that count as one event', value: 'within 0.1 s of the first', basis: 'judgment', how: 'Chosen.' },
    { name: 'flags in one event that point at power, the bus or the code', value: '3 or more', basis: 'judgment', how: 'Chosen.' },
    { name: 'a long disconnect (error)', value: 'more than 5 s in total', basis: 'judgment', how: 'Chosen. Checked on 26 logs: it fired on 4 and one is a confirmed case.' },
  ],

  check(match) {
    const named = profileKeys(match)
    const flags = match.deviceFlags().filter((f) => !named.has(f.key))
    const drops: Drop[] = []
    const firstEnable = Math.min(...watched(match).map((w) => w.start))
    for (const f of flags) {
      // `touching` keeps a drop that spans the auto→teleop gap as one drop.
      // Not a drop already under way at the first enable, or false from the log's first record: a flag false since
      // boot (an unplugged spare) never "went" anywhere. Any later drop that touches an enabled stretch counts.
      for (const episode of match.signal(f.key).episodes(isFalse, { touching: watched(match) })) {
        if (episode.start > firstEnable && episode.start > match.logStart) drops.push({ name: f.name, episode })
      }
    }
    if (drops.length === 0) return
    drops.sort((a, b) => a.episode.start - b.episode.start || a.name.localeCompare(b.name))

    const { events, singles } = groupDrops(drops)
    const devicesIn = (ds: Drop[]) => new Set(ds.map((d) => d.name)).size
    const enabledEnd = Math.max(...watched(match).map((w) => w.end))
    const toTheEnd = (d: Drop) => d.episode.end >= enabledEnd
    const secondsOff = new Map<string, number>()
    for (const d of drops) secondsOff.set(d.name, (secondsOff.get(d.name) ?? 0) + secondsWatched(match, d.episode))
    const stuck = drops.some(toTheEnd)
    const long = [...secondsOff.values()].some((s) => s > LONG_SECONDS)

    const evidence: Record<string, string | number> = {}
    const lines: [string, string][] = []
    for (const e of events) {
      const first = e.drops[0].episode.start
      const stillOff = devicesIn(e.drops.filter(toTheEnd))
      lines.push([`${devicesIn(e.drops)} devices at once`, `${devicesIn(e.drops)} devices dropped at once at ${match.when(first)}: likely robot power, the CAN bus, or the robot code stopping, not one device${stillOff ? ` (${plural(stillOff, 'device')} still off at the end)` : ''}`])
    }
    for (const [name, mine] of byDevice(singles)) {
      lines.push([name, mine.map((d) => `${match.when(d.episode.start)}, ${toTheEnd(d) ? 'to the end of the match' : `${seconds(d.episode.seconds)} s`}`).join('; ')])
    }
    for (const [label, text] of lines.slice(0, MAX_LINES)) evidence[label] = text
    if (lines.length > MAX_LINES) evidence['more'] = `+${lines.length - MAX_LINES} more`

    const first = drops[0].episode.start
    const worstSeconds = Math.max(...secondsOff.values())
    const parts = [
      singles.length ? plural(new Set(singles.map((d) => d.name)).size, 'device') : '',
      events.length ? `${events.length} ${events.length === 1 ? 'drop' : 'drops'} of several devices at once` : '',
    ].filter(Boolean)
    return {
      message: `${parts.join(' and ')} went disconnected, first ${match.whenAt(first)}${stuck ? '; some never came back' : ''}`,
      at: first,
      severity: stuck || long ? 'error' : 'warning',
      evidence,
      likely: events.length && !singles.length ? ['robot-power', 'code-stopped'] : ['connector', 'wiring'],
      ruledOut: events.length ? undefined : { 'robot-power': 'no group of devices dropped together', 'code-stopped': 'no group of devices dropped together' },
      measured: [{ label: 'longest a device was disconnected while enabled', value: round(worstSeconds), unit: 's', threshold: LONG_SECONDS }],
      plot: { signals: [...new Set(drops.slice(0, 4).map((d) => flags.find((f) => f.name === d.name)!.key))].map((key) => match.signal(key)), from: first - 5, to: Math.min(first + 30, match.logEnd) },
    }
  },
})

/** Keys the robot profile already names a Connected flag for: motors, devices, cameras, the companion's, bus members. */
function profileKeys(match: MatchView): Set<string> {
  return new Set([
    ...match.connectedDevices().map((d) => d.key),
    ...match.profile.cameras.map((c) => c.connected),
    ...(match.profile.canBuses ?? []).flatMap((b) => b.members.map((m) => m.key)),
  ])
}

/** Drops (sorted by start) split into events of EVENT_SIZE or more different devices within TOGETHER seconds, and the rest. */
function groupDrops(drops: Drop[]): { events: { drops: Drop[] }[]; singles: Drop[] } {
  const events: { drops: Drop[] }[] = []
  const singles: Drop[] = []
  for (let i = 0; i < drops.length;) {
    let j = i
    while (j < drops.length && drops[j].episode.start - drops[i].episode.start <= TOGETHER + 1e-9) j++
    const run = drops.slice(i, j)
    if (new Set(run.map((d) => d.name)).size >= EVENT_SIZE) {
      events.push({ drops: run })
      i = j
    } else {
      singles.push(drops[i])
      i++
    }
  }
  return { events, singles }
}

function byDevice(drops: Drop[]): Map<string, Drop[]> {
  const out = new Map<string, Drop[]>()
  for (const d of drops) out.set(d.name, [...(out.get(d.name) ?? []), d])
  return out
}

/** 29.2, 20.5, 0.18: one decimal from 1 s up, two below (a blip's length matters). */
function seconds(s: number): number {
  return s >= 1 ? Math.round(s * 10) / 10 : Math.round(s * 100) / 100
}
