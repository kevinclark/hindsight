/**
 * Are the drive team's controllers plugged in, on the ports the robot code reads?
 *
 * Checks (Foresight, the live pit check, only): Driver Station ports 0..n-1 (n from the robot profile) each report a
 * controller with a name right now, while the Driver Station is connected.
 * Why: a controller unplugged, or plugged into another port, leaves the driver with nothing on the field. In all
 * three CalGames match logs both Xbox controllers showed up on ports 0 and 1 within 0.2 s of the DS connecting.
 */
import { rule } from '../rule.ts'

export default rule({
  id: 'foresight/controllers',
  title: 'Controller missing',
  severity: 'warning',
  who: ['drive'],
  meaning: 'The Driver Station does not show a controller on a port the robot code reads, so that driver would have no control.',
  causes: [
    { id: 'unplugged', cause: 'The controller (or its USB hub) is unplugged or loose', look: 'the USB cables at the laptop and the hub; the Driver Station\'s USB tab: is the controller listed and green?' },
    { id: 'wrong-port', cause: 'The controller is plugged in but on another port number', look: 'the Driver Station\'s USB tab: drag the controllers into the order the code expects (0, 1, ...)' },
    { id: 'not-detected', cause: 'Windows has not picked the controller up (needs a replug, or a rescan)', look: 'press F1 in the Driver Station to rescan; replug the controller' },
  ],
  nextStep: 'Plug the controllers in and check the Driver Station\'s USB tab lists them on ports 0 and 1 (drag to reorder, F1 to rescan).',
  incident: 'Controller drops on the field (#in-hindsight: at least 8 episodes); Foresight proposal §5',

  check(match) {
    const stretch = match.beforeEnable.at(-1)
    if (!stretch) return // a match log: this is a pit check
    const fp = match.profile.foresight
    if (!fp) return match.couldNotCheck('the robot profile does not say how many controllers the drive team uses')
    const now = stretch.end
    if (match.signal('dsAttached').at(now) < 0.5) return match.couldNotCheck('the Driver Station is not connected to the robot')
    const names = Array.from({ length: fp.controllers }, (_, port) => match.text(`/DriverStation/Joystick${port}/Name`).at(now))
    const missing = names.flatMap((name, port) => (name ? [] : [port]))
    if (missing.length === 0) return
    return {
      likely: missing.length === fp.controllers ? ['unplugged'] : ['unplugged', 'wrong-port'],
      message: `No controller on Driver Station port${missing.length === 1 ? '' : 's'} ${missing.join(' and ')} (the code reads ports 0 to ${fp.controllers - 1})`,
      at: now,
      evidence: Object.fromEntries(names.map((name, port) => [`port ${port}`, name || '(nothing)'])),
      measured: [{ label: 'controllers missing', value: missing.length, unit: '' }],
    }
  },
})
