/**
 * Does a CTRE device have a sticky fault set?
 *
 * Checks (Foresight, the live pit check, only): each device the robot code watches with the Hindsight companion
 * (HindsightDevices.watch): its sticky fault field (/Hindsight/Devices/<bus>/<model>/<id>/StickyFaultField) right now,
 * and the live fault field beside it. Fires when any sticky bit is set.
 * The field is shown raw: Phoenix calls its bits device-specific and publishes no layout, so Hindsight doesn't decode
 * it. Phoenix Tuner X names each fault.
 * Why: a sticky fault says something went wrong since faults were last cleared (a brownout, a reboot while enabled,
 * an unlicensed feature), and it is wiped by Clear Faults, often before anyone has read it.
 * Amber only: no log of ours has this reading yet, so it has never fired for real (proven.ts).
 */
import { rule } from '../rule.ts'
import { faultFieldText } from '../../match/companion.ts'

export default rule({
  id: 'foresight/sticky-faults',
  title: 'Sticky fault set',
  severity: 'warning',
  foresightOnly: true,
  who: ['pit', 'software'],
  meaning: 'The device has recorded a fault since its faults were last cleared. It may be fine now, but something happened to it: a brownout, a reboot while enabled, a hardware or licence problem.',
  causes: [
    { id: 'power', cause: 'The device lost power or browned out (Undervoltage, Boot During Enable)', look: 'Phoenix Tuner X: the device\'s faults; then its power connector, wire and breaker' },
    { id: 'hardware', cause: 'A hardware fault (overheating, a bad sensor or magnet, a damaged motor)', look: 'Phoenix Tuner X: which fault it is; the device itself' },
    { id: 'config', cause: 'The robot code asked for something the device can\'t do (a Pro feature without a licence, a missing remote sensor)', look: 'Phoenix Tuner X: the fault name; the software lead for the config' },
  ],
  nextStep: 'Open the device in Phoenix Tuner X to see which fault it is. Save the log (and a robot snapshot) before anyone presses Clear Faults.',
  incident: 'Hindsight companion library (2026-10-20): it logs each device\'s sticky faults; Clear Faults in Tuner X wipes them unread',
  forEach: 'watchedDevice',

  check(device, match) {
    const now = match.pitStretch.end
    const status = device.status().at(now)
    if (!(device.connected().at(now) >= 0.5)) return match.couldNotCheck('not answering now (can/device-dropout says so)')
    if (status !== 'OK') return match.couldNotCheck(`the companion couldn't read it (${status || 'no status'})`)
    const sticky = device.stickyFaults().at(now)
    if (Number.isNaN(sticky)) return match.couldNotCheck('no sticky fault reading yet')
    if (sticky === 0) return
    const live = device.faults().at(now)
    return {
      message: `${device.name} has sticky faults set (field ${faultFieldText(sticky)})${live ? ', and a live fault now' : ''}`,
      at: now,
      evidence: {
        'sticky fault field': faultFieldText(sticky),
        'live fault field': faultFieldText(live),
        'which faults': 'not decoded: the bits differ by model and Phoenix publishes no layout; Phoenix Tuner X names them',
      },
    }
  },
})
