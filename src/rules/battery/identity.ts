/**
 * Do we know which battery was in the robot?
 *
 * Checks: the FRC8033BatteryTracker keys (Battery/Id, Battery/IdSource) at the start of the match. Fires when the ID
 * is unknown, or came from the dashboard because the fuel gauge wasn't reporting.
 * Why: One 2026 match browned out on a weak battery and nobody could say which one.
 */
import { rule } from '../rule.ts'
import { CD_BATTERY_TRACKING, PWF_BATTERY_FUEL_GAUGE } from '../sources.ts'

export default rule({
  id: 'battery/identity',
  title: 'Battery not identified',
  severity: 'warning',
  judges: 'performance',
  who: ['pit'],
  meaning: 'Hindsight cannot tell which battery was in the robot, so a weak battery cannot be followed from match to match.',
  causes: [
    { id: 'gauge-unplugged', cause: 'The battery\'s fuel gauge is not plugged in, or is not powered', look: 'the gauge on the battery: is it connected to the robot\'s port, and does it light up? Log keys Battery/Id and Battery/IdSource' },
    { id: 'no-label', cause: 'Nobody typed the battery\'s label into the dashboard after the swap', look: 'the battery-ID field on the dashboard: is it filled in for this match?' },
    { id: 'code', cause: 'The robot code is not logging the battery ID at all', look: 'the robot code: is the battery tracker created in robotInit, and does it log Battery/Id?' },
  ],
  nextStep: 'Plug in the battery\'s fuel gauge, or type its label in the battery-ID dashboard field after every swap.',
  incident: 'One 2026 match: the weak battery could not be identified after the match (hindsight-proposal.md §3); library: kevinclark/8033-battery-tracker',
  sources: [
    { ...CD_BATTERY_TRACKING, says: 'A poster recalls a team\'s battery tracker with a QR code on each battery and quotes others proposing an NFC/RFID tag per battery to collect usage data.' },
    { ...PWF_BATTERY_FUEL_GAUGE, says: 'The fuel gauge has a user-definable battery name, shown on its Home page, to identify each battery.' },
  ],

  check(match) {
    const at = match.autoStart ?? Infinity
    const id = match.text(match.batteryKey('id')).at(at)
    const source = match.text(match.batteryKey('idSource')).at(at) || 'none'
    if (id && (source === 'gauge' || source === 'gauge-cached')) return

    // An ID from the dashboard means the code works and someone typed a label; only the gauge was missing.
    const message = id ? `Battery ${id} identified from the dashboard, not its fuel gauge` : 'Battery ID unknown for this match'
    return {
      message,
      at: match.autoStart,
      likely: id ? ['gauge-unplugged'] : undefined,
      ruledOut: id ? { code: 'the code logged a battery ID', 'no-label': 'a label was typed in' } : undefined,
      nextStep: id ? 'The ID was typed in, not read from the gauge: plug the gauge in so it is read automatically.' : undefined,
      evidence: { 'battery id': id || '(none)', 'id source': source },
    }
  },
})
