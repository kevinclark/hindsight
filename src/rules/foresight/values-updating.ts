/**
 * Are every device's readings still coming in?
 *
 * Checks (Foresight, the live pit check, only): each device's "updating" signal from the robot profile (one that
 * changes every few loops even at rest: a motor's stator current, the gyro's yaw rate), over the last 5 s of the
 * disabled stretch. Fires for a connected device whose signal did not change at all while at least one other did, and
 * once for the robot when none changed (its other signals still arriving, or the page would say "no data").
 * Measured on the CalGames 2026 logs (Q13, Q21, P0), robot disabled before and after the match: those 16 signals
 * changed 41–49 times a second and never sat still longer than 0.16 s, so 5 s still is 30 times the longest seen.
 * Position and velocity can't tell: some still motors' (the swerve drives, flywheels, indexer) sat unchanged for the
 * whole disabled stretch before the match (228–345 s), and the swerve turn positions sat still from 2 s up to
 * 184 s. Nor can the CANcoders (a still one's position sat unchanged up to 110 s) or the flywheel motors (every
 * signal of theirs is unchanged at rest). Those are listed as not checked. The 5 s itself is assumed (any value from ~1 s up
 * fits the measurement).
 * Why: a reading that stops changing while the device still says it is connected (a status signal the code stopped
 * refreshing, a device that stopped sending) leaves the robot acting on old values.
 */
import { rule, round } from '../rule.ts'
import type { Problem } from '../rule.ts'

const STILL_SECONDS = 5

export default rule({
  id: 'foresight/values-updating',
  title: 'Device readings stopped updating',
  severity: 'warning',
  who: ['software', 'pit'],
  meaning: 'A device says it is connected, but its readings have not changed at all for several seconds while the others keep changing. The robot code may be acting on old values from it.',
  causes: [
    { id: 'refresh', cause: 'The robot code stopped refreshing that device\'s signals (a status signal left out of refreshAll, or an update rate set to 0)', look: 'the device\'s IO class in the robot code: is this signal in BaseStatusSignal.refreshAll and given an update frequency?' },
    { id: 'device', cause: 'The device stopped sending while the bus still answers (a faulted or rebooting controller)', look: 'Phoenix Tuner X: the device\'s faults and its signal plot; its LEDs' },
    { id: 'wiring', cause: 'A loose CAN connection to that device', look: 'the CAN wires and connectors either side of the device: wiggle-test them' },
  ],
  nextStep: 'Open the device in Phoenix Tuner X and watch its readings; if they move there but not here, check the robot code refreshes that signal.',
  incident: 'The team\'s 2026 pit checklist: "All device values updating"',

  check(match) {
    const stretch = match.beforeEnable.at(-1)
    if (!stretch) return // a match log: this is a pit check
    if (stretch.end - stretch.start < STILL_SECONDS) return match.couldNotCheck(`less than ${STILL_SECONDS} s to measure over yet`)
    const recent = [{ start: stretch.end - STILL_SECONDS, end: stretch.end + 1e-6 }]
    const p = match.profile
    const devices = [...p.motorGroups.flatMap((g) => g.motors), ...p.otherDevices]
    const unchecked = devices.filter((d) => !d.updating).map((d) => d.name)
    if (unchecked.length === devices.length) return match.couldNotCheck('the robot profile names no reading that changes at rest for any device')
    if (unchecked.length) match.checkedOnlyPart(`no reading that changes at rest for ${unchecked.join(', ')}`)
    const still: { name: string; key: string; value: number }[] = []
    let moving = 0
    for (const d of devices) {
      if (!d.updating) continue
      // Not announced, or announced with no value yet (the reader has no entry either way).
      if (!match.has(d.updating)) { match.checkedOnlyPart(`${d.name}: the robot does not send ${d.updating}`); continue }
      if (d.connected && match.has(d.connected) && match.signal(d.connected).at(stretch.end) < 0.5) continue // can/device-dropout says it
      const s = match.signal(d.updating, `${d.name} reading`)
      const held = s.at(recent[0].start)
      if (s.samples(recent).some((v) => v !== held && !(Number.isNaN(v) && Number.isNaN(held)))) moving++
      else still.push({ name: d.name, key: d.updating, value: held })
    }
    if (still.length === 0) return
    // Every reading frozen while the robot still sends (its clock and battery keep coming, or the page would say
    // "no data"): the devices' side stopped, the very fault this line is for.
    if (moving === 0) {
      return {
        about: 'all devices',
        message: `No device reading changed in the last ${STILL_SECONDS} s (${still.length} watched): the robot may have stopped reading its devices`,
        at: stretch.end,
        evidence: { 'readings watched': still.map((d) => d.name).join(', '), 'CalGames 2026, at rest': 'changed 41–49 times a second; never still longer than 0.16 s' },
      }
    }
    return still.map((d): Problem => ({
      about: d.name,
      message: `${d.name}: its readings have not changed for ${STILL_SECONDS} s while ${moving} other device reading${moving === 1 ? '' : 's'} did`,
      at: stretch.end,
      measured: [{ label: 'seconds unchanged', value: STILL_SECONDS, unit: 's', threshold: STILL_SECONDS }],
      evidence: {
        signal: d.key,
        'value, unchanged': Number.isFinite(d.value) ? round(d.value, 3) : 'no value yet',
        'CalGames 2026, at rest': 'changed 41–49 times a second; never still longer than 0.16 s',
      },
      plot: { signals: [d.key], from: stretch.end - 2 * STILL_SECONDS, to: stretch.end },
    }))
  },
})
