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
import { plural, rule, round } from '../rule.ts'
import type { Problem } from '../rule.ts'
import type { MatchView } from '../view.ts'

const STILL_SECONDS = 5
const AT_REST_NOTE = 'changed 41–49 times a second; never still longer than 0.16 s'

export default rule({
  id: 'foresight/values-updating',
  title: 'Device readings stopped updating',
  severity: 'warning',
  foresightOnly: true,
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
    const stretch = match.pitStretch
    if (stretch.end - stretch.start < STILL_SECONDS) return match.couldNotCheck(`less than ${STILL_SECONDS} s to measure over yet`)

    const devices = [...match.profile.motorGroups.flatMap((g) => g.motors), ...match.profile.otherDevices]
    const withoutReading = devices.filter((d) => !d.updating).map((d) => d.name)
    if (withoutReading.length === devices.length) {
      return match.couldNotCheck('the robot profile names no reading that changes at rest for any device')
    }
    if (withoutReading.length > 0) match.checkedOnlyPart(`no reading that changes at rest for ${withoutReading.join(', ')}`)

    const { still, movingCount } = watchReadings(match, devices, stretch.end)
    if (still.length === 0) return

    // Every reading frozen while the robot still sends (its clock and battery keep coming, or the page would say
    // "no data"): the devices' side stopped, the very fault this line is for.
    if (movingCount === 0) {
      return {
        about: 'all devices',
        message: `No device reading changed in the last ${STILL_SECONDS} s (${still.length} watched): the robot may have stopped reading its devices`,
        at: stretch.end,
        evidence: { 'readings watched': still.map((d) => d.name).join(', '), 'CalGames 2026, at rest': AT_REST_NOTE },
      }
    }
    return still.map((d): Problem => ({
      about: d.name,
      message: `${d.name}: its readings have not changed for ${STILL_SECONDS} s while ${plural(movingCount, 'other device reading')} did`,
      at: stretch.end,
      measured: [{ label: 'seconds unchanged', value: STILL_SECONDS, unit: 's', threshold: STILL_SECONDS }],
      evidence: {
        signal: d.key,
        'value, unchanged': Number.isFinite(d.value) ? round(d.value, 3) : 'no value yet',
        'CalGames 2026, at rest': AT_REST_NOTE,
      },
      plot: { signals: [d.key], from: stretch.end - 2 * STILL_SECONDS, to: stretch.end },
    }))
  },
})

/** Which devices' readings did not change at all in the last STILL_SECONDS, and how many others did. */
function watchReadings(match: MatchView, devices: { name: string; updating?: string; connected?: string }[], now: number) {
  const recent = [{ start: now - STILL_SECONDS, end: now + 1e-6 }]
  const still: { name: string; key: string; value: number }[] = []
  let movingCount = 0
  for (const device of devices) {
    const key = device.updating
    if (!key) continue
    // Not announced, or announced with no value yet (the reader has no entry either way).
    if (!match.has(key)) {
      match.checkedOnlyPart(`${device.name}: the robot does not send ${key}`)
      continue
    }
    // can/device-dropout reports a device that is not connected.
    const connectedKey = device.connected
    if (connectedKey && match.has(connectedKey) && match.signal(connectedKey).at(now) < 0.5) continue

    const reading = match.signal(key, `${device.name} reading`)
    const held = reading.at(recent[0].start)
    const changed = reading.samples(recent).some((v) => v !== held && !(Number.isNaN(v) && Number.isNaN(held)))
    if (changed) movingCount++
    else still.push({ name: device.name, key, value: held })
  }
  return { still, movingCount }
}
