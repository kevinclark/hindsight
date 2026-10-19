/**
 * Did a motor controller or sensor drop off CAN while enabled?
 *
 * Checks: each device's Connected flag going false while the robot was enabled, and the lowest battery voltage in
 * the 0.5 s before. A drop at low voltage points at the power path (the device browned out); a drop at normal
 * voltage points at CAN wiring or a connector.
 * Why: CalGames 2026 P0: flywheel follower 16 alone dropped off CAN 7 times, each at 5.85–6.31 V.
 */
import { isFalse, rule, round } from '../rule.ts'
import type { MatchView } from '../view.ts'

const LOW_VOLTS = 7

/** When each other device dropped off CAN while enabled (every motor with a Connected flag, and the other devices). */
function otherDevices(match: MatchView, except: string) {
  const all = [
    ...match.profile.motorGroups.flatMap((g) => g.motors.filter((m) => m.connected).map((m) => ({ name: m.name, key: m.connected! }))),
    ...match.profile.otherDevices.map((d) => ({ name: d.name, key: d.connected })),
  ]
  return all
    .filter((d) => d.name !== except && match.has(d.key))
    .map((d) => ({ name: d.name, drops: match.signal(d.key).episodes(isFalse, { touching: match.enabled }).map((e) => e.start) }))
}

export default rule({
  id: 'can/device-dropout',
  title: 'Device dropped off CAN',
  severity: 'error',
  who: ['pit'],
  meaning: 'A motor controller or sensor stopped answering on the CAN bus while the robot was enabled. If it is a motor, it stopped working until it came back.',
  causes: [
    { id: 'battery-sag', cause: 'The battery sagged so low that the device lost power (voltage under about 7 V)', look: 'Power tab: battery voltage at each drop; the power/brownout and power/margin findings' },
    { id: 'shared-wiring', cause: 'Wiring or power shared by several devices (a CAN splice, a shared power breaker or channel)', look: 'which other devices dropped at the same moment, and what they share: the same CAN branch, the same PDH channel' },
    { id: 'can-connector', cause: 'A loose or damaged CAN connector or wire on that device\'s branch', look: 'tug the CAN wires at that device and at the ones either side of it; look for pinched or cracked wire' },
    { id: 'device-power', cause: 'The device\'s own power connector, wire or breaker', look: 'wiggle the power connector and wire at that device; its breaker and PDH channel' },
    { id: 'terminator', cause: 'A missing or loose terminating resistor at an end of the CAN chain', look: 'the far end of the CAN chain: the PDH/PDP termination jumper or a 120 Ω resistor on the last device (the roboRIO end is built in)' },
    { id: 'device-fault', cause: 'The device itself (old firmware, damage)', look: 'its status light during a dropout; the vendor tool (Phoenix Tuner, REV Hardware Client) for firmware and faults' },
  ],
  nextStep: 'Tug-test the CAN connectors on that device and the ones next to it, and check the CAN termination at the far end of the chain.',
  incident: 'CalGames 2026 P0: flywheel follower 16 off CAN 7 times at 5.85–6.31 V (P0 analysis); #in-hindsight: ≥ 11 CAN dropout episodes',
  forEach: 'device',

  check(device, match) {
    // `touching` keeps a drop that spans the auto→teleop gap as one drop.
    const drops = device.connected().episodes(isFalse, { touching: match.enabled })
    if (drops.length === 0) return
    const battery = match.signal('batteryVoltage')
    // The flag goes false only after the device misses its status frames, so look at the 0.5 s before it.
    const voltages = drops.map((d) => battery.lowest(match.before(d.start, 0.5)).value)
    const lowOnes = voltages.filter((v) => v < LOW_VOLTS).length
    const closeCall = voltages.some((v) => Math.abs(v - LOW_VOLTS) < 0.5)
    // Other devices that dropped within 1 s of any of this one's drops: a shared cause (power or the CAN trunk).
    const others = otherDevices(match, device.name)
    const together = others.filter((o) => o.drops.some((d) => drops.some((own) => Math.abs(d - own.start) < 1))).map((o) => o.name)
    const allLow = lowOnes === drops.length
    const likely: string[] = []
    const ruledOut: Record<string, string> = {}
    if (allLow) likely.push('battery-sag')
    else if (lowOnes === 0 && !closeCall) ruledOut['battery-sag'] = 'the battery stayed above 7 V at every drop'
    if (together.length) {
      likely.push('shared-wiring')
      ruledOut['device-fault'] = `${together.length} other device${together.length === 1 ? '' : 's'} dropped at the same moment`
    } else if (others.length) {
      ruledOut['shared-wiring'] = 'no other device dropped at the same moment'
      likely.push(allLow ? 'device-power' : 'can-connector')
    }
    const nextStep = allLow ? 'The battery was low at every drop: fix the voltage sag first (Power tab), then wiggle-test the power connector on that device.'
      : together.length ? `${together.join(', ')} dropped at the same moment: check what they share (the same CAN branch or splice, the same power channel).`
      : undefined
    const cause = lowOnes === drops.length ? 'power path (every drop at low voltage)'
      : lowOnes === 0 ? 'CAN wiring or connector (voltage was normal)'
      : 'mixed: some drops at low voltage'
    return {
      message: `${device.name} dropped off CAN ${drops.length} time${drops.length === 1 ? '' : 's'}, first at ${match.when(drops[0].start)}`,
      at: drops[0].start,
      evidence: {
        drops: drops.length,
        'seconds missing': round(drops.reduce((s, d) => s + d.seconds, 0)),
        'lowest battery voltage in the 0.5 s before each drop (V)': voltages.map((v) => v.toFixed(2)).join(', '),
        'other devices dropped at the same moment': together.length ? together.join(', ') : others.length ? 'none' : 'not checked (no other devices)',
        'likely cause': closeCall ? `possibly ${cause}; a voltage is within 0.5 V of the ${LOW_VOLTS} V line` : cause,
      },
      likely, ruledOut, nextStep,
      measured: [{ label: 'drops off CAN', value: drops.length, unit: '' }],
      plot: [battery], plotUnit: 'V', plotFrom: drops[0].start - 3, plotTo: drops[drops.length - 1].end + 2,
      plotMarks: drops.map((d) => d.start), plotLine: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
    }
  },
})
