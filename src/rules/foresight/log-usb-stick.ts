/**
 * Is the robot's log going to the USB stick?
 *
 * Checks (Foresight, the live pit check, only): the Hindsight companion library's own reading of the drive the log
 * folder is on (/Hindsight/LogDrive/OnUsb), which it takes once, when the robot code starts. Fires when the log is
 * not on a USB stick. A robot without the companion never sends the reading, and the check says "not checked".
 * Why: with no stick, AdvantageKit writes to the roboRIO's own storage or nowhere, and the match the team most needs
 * to replay is not on the stick. The team's pit checklist checks the stick by hand.
 * Amber only: no log of ours has this reading yet, so it has never fired for real (proven.ts).
 */
import { rule } from '../rule.ts'
import { LOG_DRIVE_KEYS } from '../../foresight/keys.ts'

export default rule({
  id: 'foresight/log-usb-stick',
  title: 'Robot log not going to the USB stick',
  severity: 'warning',
  foresightOnly: true,
  who: ['pit', 'software'],
  meaning: 'When the robot code started, its log folder was not on a USB stick, so this match\'s log ends up on the roboRIO\'s own storage or nowhere: not on the stick you pull afterwards.',
  causes: [
    { id: 'no-stick', cause: 'The USB stick is missing or not pushed fully into the roboRIO', look: 'the roboRIO\'s USB port: is the stick there and seated?' },
    { id: 'late', cause: 'The stick went in after the robot code started, so the code never saw it', look: 'restart the robot code (or power-cycle) with the stick in, then check again' },
    { id: 'path', cause: 'The robot code logs to a folder that is not the stick', look: 'the log folder in the evidence: the stick is /U on a roboRIO' },
  ],
  nextStep: 'Put the log USB stick in the roboRIO, restart the robot code, and check again.',
  incident: 'Team pit checklist 2026 §10: "Log stick in", checked by hand',

  check(match) {
    if (!match.has(LOG_DRIVE_KEYS.onUsb)) return match.couldNotCheck(`the robot doesn't send ${LOG_DRIVE_KEYS.onUsb}: check by hand`)
    const at = match.pitStretch.end
    const status = match.has(LOG_DRIVE_KEYS.status) ? match.text(LOG_DRIVE_KEYS.status).at(at) : ''
    if (status && status !== 'ok') return match.couldNotCheck(`the robot could not read where its log goes (${status})`)
    const onUsb = match.signal(LOG_DRIVE_KEYS.onUsb).at(at)
    if (Number.isNaN(onUsb)) return match.couldNotCheck(`the robot sent ${LOG_DRIVE_KEYS.onUsb} only after the stretch checked`)
    if (onUsb >= 0.5) return
    const text = (key: string) => (match.has(key) ? match.text(key).at(at) : '')
    const path = text(LOG_DRIVE_KEYS.path)
    const device = text(LOG_DRIVE_KEYS.device)
    return {
      message: `The robot log ${path ? `(${path}) ` : ''}is not on a USB stick${device ? `: it is on ${device}` : ''}`,
      at,
      evidence: { 'log folder': path || undefined, 'mounted from': device || undefined },
    }
  },
})
