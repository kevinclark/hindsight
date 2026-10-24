/**
 * Is the robot's log going to the USB stick?
 *
 * Checks (Foresight, the live pit check, only): the Hindsight companion library's own reading of the drive the log
 * folder is on (/Hindsight/LogDrive/OnUsb), taken once a second. OnUsb is true only while every reading since the
 * robot code started found the folder on a USB stick (AdvantageKit opens its log file once, so a stick that was out
 * has lost the log even after it goes back in). Fires when the log is not on a USB stick. A robot without the
 * companion never sends the reading, and the check says "not checked".
 * Why: with no stick, AdvantageKit writes to the roboRIO's own storage or nowhere, and the match the team most needs
 * to replay is not on the stick. The team's pit checklist checks the stick by hand.
 * Amber only: no log of ours has this reading yet, so it has never fired for real (proven.ts).
 */
import { rule } from '../rule.ts'
import { ADVANTAGEKIT_INSTALL, CD_CANIVORE_USB } from '../sources.ts'
import { LOG_DRIVE_KEYS, USB_DEVICE_PREFIX } from '../../foresight/keys.ts'

export default rule({
  id: 'foresight/log-usb-stick',
  title: 'Robot log not going to the USB stick',
  severity: 'warning',
  foresightOnly: true,
  who: ['pit', 'software'],
  meaning: 'Since the robot code started, its log folder has not been on a USB stick the whole time, so this match\'s log ends up on the roboRIO\'s own storage or nowhere: not on the stick you pull afterwards.',
  causes: [
    { id: 'no-stick', cause: 'The USB stick is missing or not pushed fully into the roboRIO', look: 'the roboRIO\'s USB port: is the stick there and seated?' },
    { id: 'late', cause: 'The stick went in after the robot code started, so AdvantageKit had already opened its log file elsewhere', look: 'restart the robot code (or power-cycle) with the stick in, then check again' },
    { id: 'pulled', cause: 'The stick was pulled after the robot code started (to copy logs off, say): the log stopped there and does not carry on when the stick goes back in', look: 'restart the robot code with the stick in, then check again' },
    { id: 'path', cause: 'The robot code logs to a folder that is not the stick', look: 'the log folder in the evidence: the stick is /U on a roboRIO' },
  ],
  nextStep: 'Put the log USB stick in the roboRIO, restart the robot code, and check again.',
  incident: 'Team pit checklist 2026 §10: "Log stick in", checked by hand',
  sources: [
    { ...ADVANTAGEKIT_INSTALL, says: 'By default WPILOGWriter writes to a USB stick on the roboRIO ("/U/logs"), and a FAT32 stick must be in one of its USB ports.' },
    { ...CD_CANIVORE_USB, says: 'One team believed a logging USB drive on an extension cable was the ESD source that dropped its CANivore, and plugging it straight into the roboRIO fixed it.' },
  ],

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
      message: device.startsWith(USB_DEVICE_PREFIX)
        ? `The robot log ${path ? `(${path}) ` : ''}is not on the USB stick: the stick was out at some point since the robot code started`
        : `The robot log ${path ? `(${path}) ` : ''}is not on a USB stick${device ? `: it is on ${device}` : ''}`,
      at,
      evidence: { 'log folder': path || undefined, 'mounted from': device || undefined },
    }
  },
})
