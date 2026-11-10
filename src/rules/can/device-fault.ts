/**
 * Did a CTRE device raise one of its own health faults while the robot was enabled? EXPERIMENTAL (ADR 14).
 *
 * Checks: each .hoot attached to this match and lined up with the robot log (src/hoot/attach.ts): each device's health
 * faults (src/hoot/owlet.ts HEALTH_FAULTS: power, temperature, hardware) turning on inside the robot log's enabled time.
 * One finding per device and fault (its `about` names both): the first time, with how often and how long.
 * Why: a Talon FX that raises Bridge Brownout has turned its output off; no robot log we hold records per-motor faults, so
 * only the .hoot shows it. Experimental because no robot-log signal has confirmed one yet: one case in 22 .hoot files.
 */
import { plural, round, rule, type Problem } from '../rule.ts'
import { CTRE_FAULTS, CTRE_TALONFX_API } from '../sources.ts'
import { inside, Signal, type MatchView } from '../view.ts'
import { profileNames } from '../../hoot/view.ts'
import type { HootAttachment } from '../../hoot/attach.ts'
import type { HootDevice } from '../../hoot/types.ts'

/** Why a match has nothing for this rule to read. Names the file, so "what would check it" can say which. */
export const NO_HOOT = "only a Phoenix .hoot has the devices' own faults: load this match's .hoot"

/** What CTRE's API reference says each fault means (CoreTalonFX, read 2026-11-09). Faults not listed are shown by name. */
const MEANS: Record<string, string> = {
  BridgeBrownout: 'Bridge was disabled most likely due to supply voltage dropping too low',
  Undervoltage: 'Device supply voltage dropped to near brownout levels',
  BootDuringEnable: 'Device boot while detecting the enable signal',
  UnstableSupplyV: 'Supply Voltage is unstable',
  OverSupplyV: 'Supply Voltage has exceeded the maximum voltage rating of device',
  DeviceTemp: 'Device temperature exceeded limit',
  ProcTemp: 'Processor temperature exceeded limit',
  Hardware: 'Hardware fault occurred',
}

/** "BridgeBrownout" → "bridge brownout"; "5VTooLow" → "5V too low". */
export const faultWords = (name: string) =>
  name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().replace(/\bv\b|(?<=\d)v\b/g, 'V')

export default rule({
  id: 'can/device-fault',
  title: 'Device raised a fault',
  severity: 'warning',
  judges: 'fault',
  who: ['pit'],
  experimental: 'from the .hoot: not yet confirmed against robot logs',
  needsEnabled: true,
  meaning: 'A motor controller or sensor reported one of its own health faults while the robot was enabled. A bridge brownout means the motor controller turned its output off for a moment.',
  causes: [
    { id: 'battery-sag', cause: 'The battery sagged low at the device under load', look: 'Power tab: battery voltage at that moment; the Devices tab: that device\'s supply voltage' },
    { id: 'device-power', cause: 'The device\'s own power path: connector, wire, breaker or PDH channel', look: 'wiggle the power connector and wire at that device; compare its supply voltage with its neighbours\' in the Devices tab' },
    { id: 'device', cause: 'The device itself (heat, firmware, damage)', look: 'Phoenix Tuner X: its sticky faults and firmware version' },
  ],
  nextStep: 'Open the Devices tab at that moment: compare this device\'s supply voltage with the others\', then check its power connector and wire.',
  incident: 'A Talon FX raised Bridge Brownout mid-run in a 2026 practice log; the robot log has no per-motor faults, so only the .hoot showed it (2026-11-09)',
  sources: [
    { ...CTRE_TALONFX_API, says: 'Each fault\'s meaning, e.g. Fault_BridgeBrownout: "Bridge was disabled most likely due to supply voltage dropping too low".' },
    { ...CTRE_FAULTS, says: 'A fault reports the device\'s current status and clears once the problem is gone; a sticky fault stays until cleared.' },
  ],
  thresholds: [
    { name: 'faults reported', value: 'any health fault turning on while enabled', basis: 'judgment', how: 'The device\'s own flag, as CTRE defines it; limit faults (normal operation) are not read.' },
  ],

  check(match) {
    const files = match.hootFiles()
    if (files.length === 0) return match.couldNotCheck(NO_HOOT)
    const withDevices = files.filter((f) => f.reading.devices.length > 0)
    if (withDevices.length === 0) return match.couldNotCheck(`the .hoot files read hold no CTRE device (${files.map((f) => f.reading.file).join(', ')})`)
    const lined = withDevices.filter((f) => f.alignment.offset !== null)
    for (const f of withDevices) {
      if (f.alignment.offset === null) {
        const why = `${f.reading.file}: not lined up with this log (${f.alignment.why})`
        if (lined.length === 0) return match.couldNotCheck(why)
        match.checkedOnlyPart(why)
      }
    }
    const names = profileNames(match.profile, lined.map((f) => f.reading))
    const problems = lined.flatMap((f) => fileProblems(f, names, match))
    match.readFrom.set('device faults', `the Phoenix .hoot (${lined.map((x) => x.reading.file).join(', ')})`)
    return problems.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  },
})

/** Each device's faults in one lined-up file, as findings on the robot log's clock. */
function fileProblems(f: HootAttachment, names: Map<string, string>, match: MatchView): Problem[] {
  const offset = f.alignment.offset!
  return f.reading.devices.flatMap((d) => deviceProblems(d, names.get(d.name), offset, f.reading.file, match))
}

function deviceProblems(d: HootDevice, name: string | undefined, offset: number, file: string, match: MatchView): Problem[] {
  const label = name ? `${name} (${d.name})` : d.name
  const byFault = new Map<string, { on: number; off: number | null }[]>()
  for (const x of d.faults) {
    const at = x.on + offset
    if (!inside(match.enabled, at)) continue
    byFault.set(x.name, [...(byFault.get(x.name) ?? []), { on: at, off: x.off === null ? null : x.off + offset }])
  }
  return [...byFault].map(([fault, times]): Problem => {
    const longest = Math.max(...times.map((t) => (t.off === null ? NaN : t.off - t.on)).filter(Number.isFinite), 0)
    return {
      message: `${label} raised ${faultWords(fault)}${times.length > 1 ? ` ${plural(times.length, 'time')}` : ''} while enabled`,
      at: times[0].on,
      about: `${label}: ${faultWords(fault)}`,
      evidence: {
        fault: fault,
        'what CTRE says it means': MEANS[fault],
        'times while enabled': times.length,
        'longest (s)': longest > 0 ? round(longest, 2) : undefined,
        'next disable (s after)': nextDisable(times[0].on, match),
      },
      plot: d.volts ? {
        signals: ['batteryVoltage', new Signal(`${label} supply voltage (lowest per ¼ s)`, `${file}:${d.name}/SupplyVoltage`, shifted(d, offset), match.raw.logEnd)],
        unit: 'V', marks: times.map((t) => t.on),
      } : undefined,
    }
  })
}

/** Seconds from `t` to the end of the enabled stretch it is in: a fault at the moment of a disable reads differently. */
function nextDisable(t: number, match: MatchView): number | undefined {
  const span = match.enabled.find((w) => t >= w.start && t <= w.end)
  return span ? round(span.end - t, 2) : undefined
}

/** The device's supply-voltage bins on the robot log's clock, as a series a plot can draw. */
function shifted(d: HootDevice, offset: number) {
  return { name: `${d.name} supply voltage`, t: Float64Array.from(d.t, (t) => t + offset), v: Float64Array.from(d.volts!) }
}
