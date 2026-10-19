/**
 * can/device-dropout — did a motor controller or sensor drop off CAN while enabled?
 *
 * Checks: every `Connected` flag in the profile (motors and other devices) going false while enabled, with the bus
 * voltage at that moment. A drop at low voltage points at the power path (the device browned out); a drop at
 * normal voltage points at CAN wiring or a connector.
 * Why: CalGames 2026 P0: flywheel follower 16 alone dropped off CAN 7 times, each at 5.85–6.31 V.
 * When it fires: low voltage → check that device's power connector and wire run against its siblings. Normal
 * voltage → check the CAN connectors, terminator and wire on that branch.
 */
import { has, num, type Match } from '../../match/match.ts'
import { intervalsWhere, lowIn, when } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const LOW_VOLTS = 7

export const deviceDropout: Rule = {
  id: 'can/device-dropout',
  title: 'Device dropped off CAN',
  fix: 'At low voltage: check the device\'s power connector and wire run. At normal voltage: check CAN connectors, the terminator, and the wire on that branch.',
  incident: 'CalGames 2026 P0: flywheel follower 16 off CAN 7 times at 5.85–6.31 V (P0 analysis); #in-hindsight: ≥ 11 CAN dropout episodes',
  needs: (m: Match) => [m.profile.signals.enabled, m.profile.signals.batteryVoltage],
  run(m: Match): Finding[] {
    const volts = num(m, m.profile.signals.batteryVoltage)!
    const devices = [
      ...m.profile.motorGroups.flatMap((g) => g.motors.map((x) => ({ name: x.name, connected: x.connected }))),
      ...m.profile.otherDevices,
    ]
    const out: Finding[] = []
    for (const d of devices) {
      if (!d.connected || !has(m, d.connected)) continue
      const drops = intervalsWhere(num(m, d.connected)!, (v) => v < 0.5, m.enabled, m.logEnd)
      if (drops.length === 0) continue
      // The flag goes false only after the device misses its status frames, so look at the 0.5 s before it.
      const atDrop = drops.map((iv) => lowIn(volts, iv.start - 0.5, iv.start).value)
      const lowCount = atDrop.filter((v) => v < LOW_VOLTS).length
      const likely = lowCount === drops.length ? 'power path (every drop at low voltage)'
        : lowCount === 0 ? 'CAN wiring or connector (voltage was normal)' : 'mixed: some drops at low voltage'
      out.push({
        rule: this.id,
        severity: 'error',
        title: `${d.name} dropped off CAN ${drops.length} time${drops.length === 1 ? '' : 's'}, first at ${when(m, drops[0].start)}`,
        time: drops[0].start,
        evidence: {
          drops: drops.length,
          'total seconds missing': +drops.reduce((s, iv) => s + iv.end - iv.start, 0).toFixed(2),
          'lowest bus voltage in the 0.5 s before each drop (V)': atDrop.map((v) => v.toFixed(2)).join(', '),
          'likely cause': likely,
        },
        plot: {
          from: drops[0].start - 3, to: drops[drops.length - 1].end + 2, unit: 'V',
          lines: [{ label: 'Battery voltage', key: m.profile.signals.batteryVoltage }],
          markers: drops.map((iv) => ({ t: iv.start, label: 'drop' })),
          threshold: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
        },
      })
    }
    return out
  },
}
