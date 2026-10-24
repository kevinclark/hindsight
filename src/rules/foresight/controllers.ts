/**
 * Are the drive team's controllers plugged in, on the ports the robot code reads?
 *
 * Checks (Foresight, the live pit check, only): each Driver Station port the robot profile lists (its controller-name
 * keys, `foresight.controllerNames`) reports a controller with a name right now, while the Driver Station is connected.
 * Why: a controller unplugged, or plugged into another port, leaves the driver with nothing on the field. In all
 * three 2026 match logs both Xbox controllers showed up on ports 0 and 1 within 0.2 s of the DS connecting.
 */
import { rule } from '../rule.ts'
import { WPILIB_DS_MESSAGES, WPILIB_JOYSTICKS } from '../sources.ts'

export default rule({
  id: 'foresight/controllers',
  title: 'Controller missing',
  severity: 'warning',
  judges: 'fault',
  foresightOnly: true,
  who: ['drive'],
  meaning: 'The Driver Station does not show a controller on a port the robot code reads, so that driver would have no control.',
  causes: [
    { id: 'unplugged', cause: 'The controller (or its USB hub) is unplugged or loose', look: 'the USB cables at the laptop and the hub; the Driver Station\'s USB tab: is the controller listed and green?' },
    { id: 'wrong-port', cause: 'The controller is plugged in but on another port number', look: 'the Driver Station\'s USB tab: drag the controllers into the order the code expects (0, 1, ...)' },
    { id: 'not-detected', cause: 'Windows has not picked the controller up (needs a replug, or a rescan)', look: 'press F1 in the Driver Station to rescan; replug the controller' },
  ],
  nextStep: 'Plug the controllers in and check the Driver Station\'s USB tab lists them on ports 0 and 1 (drag to reorder, F1 to rescan).',
  incident: 'Controller drops on the field (#in-hindsight: at least 8 episodes); Foresight proposal §5',
  sources: [
    { ...WPILIB_JOYSTICKS, says: 'The Driver Station assigns each controller an index (the robot code port) and tries to keep the order between runs; the page says to check it each time the Driver Station starts.' },
    { ...WPILIB_DS_MESSAGES, says: 'The Driver Station reports "Joystick Unplugged" among its diagnostic messages.' },
  ],

  check(match) {
    const stretch = match.pitStretch
    const fp = match.profile.foresight
    if (!fp) return match.couldNotCheck('the robot profile does not say how many controllers the drive team uses')
    const now = stretch.end
    if (match.signal('dsAttached').at(now) < 0.5) return match.couldNotCheck('the Driver Station is not connected to the robot')
    const names = fp.controllerNames.map((key) => match.text(key).at(now))
    const missing = names.flatMap((name, port) => (name ? [] : [port]))
    if (missing.length === 0) return

    // Every port empty points at the hub or laptop; only some, at a controller on the wrong port as well.
    const likely = ['unplugged']
    if (missing.length < names.length) likely.push('wrong-port')
    const portWord = missing.length === 1 ? 'port' : 'ports'
    return {
      likely,
      message: `No controller on Driver Station ${portWord} ${missing.join(' and ')} (the code reads ports 0 to ${names.length - 1})`,
      at: now,
      evidence: Object.fromEntries(names.map((name, port) => [`port ${port}`, name || '(nothing)'])),
      measured: [{ label: 'controllers missing', value: missing.length, unit: '' }],
    }
  },
})
