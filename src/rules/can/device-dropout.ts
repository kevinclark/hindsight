/**
 * Did a motor controller or sensor drop off CAN while enabled?
 *
 * Checks: each device's Connected flag going false while the robot was enabled, and the lowest battery voltage in
 * the 0.5 s before. A drop at low voltage points at the power path (the device browned out); a drop at normal
 * voltage points at CAN wiring or a connector.
 * Why: CalGames 2026 P0: flywheel follower 16 alone dropped off CAN 7 times, each at 5.85–6.31 V.
 */
import { isFalse, rule, round } from '../rule.ts'

const LOW_VOLTS = 7

export default rule({
  id: 'can/device-dropout',
  title: 'Device dropped off CAN',
  severity: 'error',
  who: ['pit'],
  fix: 'At low voltage: check the device\'s power connector and wire run. At normal voltage: check CAN connectors, the terminator, and the wire on that branch.',
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
        'likely cause': closeCall ? `possibly ${cause}; a voltage is within 0.5 V of the ${LOW_VOLTS} V line` : cause,
      },
      plot: [battery], plotUnit: 'V', plotFrom: drops[0].start - 3, plotTo: drops[drops.length - 1].end + 2,
      plotMarks: drops.map((d) => d.start), plotLine: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
    }
  },
})
