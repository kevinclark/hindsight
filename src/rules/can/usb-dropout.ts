/**
 * Did the CANivore drop off the roboRIO's USB?
 *
 * Checks: the roboRIO's own kernel lines, which the Driver Station keeps in its event log (.dsevents): every
 * "USB disconnect" of the USB port a CANivore is on, during the match. Every device on that CANivore stops until it
 * reconnects: the kernel re-enumerated it about 1.3 s later in four of the five drops seen.
 * Why: a public 2026 robot's CANivore, plugged into a USB hub, dropped off 3 times in one elimination match and twice
 * in another; the kernel said the hub had disabled the port ("EMI?"). Moving the CANivores off the hub ended it.
 * Checked on: that robot's three matches only (3, 2 and 0 drops, all found). No other log Hindsight has comes with a
 * .dsevents, so a match with none is "none seen", not proof of a sound USB link.
 */
import { plural, round, rule } from '../rule.ts'
import { CD_CANIVORE_USB, CD_USB_HUB_CPU, CTRE_CANIVORE_API } from '../sources.ts'

/** The battery voltage is read over this long before each drop: the drops seen came 6 s or less after a sag. */
const LOOK_BACK_SECONDS = 6

export default rule({
  id: 'can/usb-dropout',
  title: 'CANivore dropped off USB',
  severity: 'error',
  judges: 'fault',
  who: ['pit'],
  meaning: 'The roboRIO lost the CANivore\'s USB connection, so every motor and sensor on that CAN bus stopped until it reconnected.',
  causes: [
    { id: 'hub', cause: 'The CANivore is on a USB hub that resets or disables its port', look: 'whether the CANivore plugs into a hub; plug it straight into the roboRIO' },
    { id: 'cable', cause: 'A loose or strained USB cable at the roboRIO or the CANivore', look: 'both ends of the USB cable: fully seated, strain-relieved, not pulled by a moving part' },
    { id: 'noise', cause: 'Electrical noise on the USB cable or hub from motor or battery wires', look: 'where the USB cable and hub run: keep them away from motor and battery wires' },
    { id: 'battery-sag', cause: 'The battery sagged far enough to reset the hub or the CANivore', look: 'the lowest battery voltage before each drop (below); the power/brownout finding' },
  ],
  nextStep: 'Plug the CANivore straight into the roboRIO, not through a hub, with the cable strain-relieved and away from motor wires.',
  incident: 'A public 2026 robot (two elimination matches): CANivore on a USB hub, 3 and 2 kernel "USB disconnect"s; fixed by moving it off the hub',
  sources: [
    { ...CD_CANIVORE_USB, says: 'A CANivore STAT LED double-blinking red was read as a bad or missing USB connection, and the bus stayed down until a roboRIO restart; one team believed a logging USB drive on an extension cable was the ESD source, and others added shielded USB cables.' },
    { ...CD_USB_HUB_CPU, says: 'A team traced high roboRIO CPU use to a USB hub that rebooted repeatedly during matches, then moved both CANivores to the roboRIO CAN bus, which they said solved those issues.' },
    { ...CTRE_CANIVORE_API, says: 'Phoenix logs "CANbus Disconnected" when it detects that a CANivore USB device has been disconnected, which helps tell a bad USB connection from a bad CAN connection.' },
  ],
  thresholds: [
    { name: 'battery read before each drop', value: 'over the 6 s before', basis: 'measured', how: 'The drops seen came 6 s or less after a sag.' },
  ],

  check(match) {
    const window = match.checkWindow
    const drops = match.signal('canivoreUsbDisconnects').increases(window)
    if (drops.length === 0) return

    const first = drops[0]
    const failedSends = match.signalIfLogged('canivoreTxFails')?.increases(window).length
    const portDisabled = match.signalIfLogged('usbPortDisabled')?.increases(window).length ?? 0
    const battery = match.signalIfLogged('batteryVoltage')
    const lowestBefore = battery ? drops.map((t) => round(battery.lowest(match.before(t, LOOK_BACK_SECONDS)).value)) : null
    const firstBrownout = match.signalIfLogged('brownedOut')?.turnsOn()[0]

    // The kernel saying the hub disabled the port puts the hub first.
    const likely: string[] = []
    if (portDisabled > 0) likely.push('hub')

    return {
      message: `CANivore dropped off USB ${plural(drops.length, 'time')}, first ${match.whenAt(first)}`,
      at: first,
      likely,
      evidence: {
        'drops (kernel "USB disconnect")': drops.length,
        'when': drops.map((t) => match.when(t)).join('; '),
        'failed USB sends (kernel "usb tx fail")': failedSends,
        'times the hub disabled the port (kernel "disabled by hub")': portDisabled,
        [`lowest battery voltage in the ${LOOK_BACK_SECONDS} s before each (V)`]: lowestBefore?.join(', '),
        'first brownout': firstBrownout === undefined ? undefined : match.when(firstBrownout),
      },
      measured: [{ label: 'CANivore USB drops', value: drops.length, unit: '' }],
      plot: battery
        ? { signals: [battery], unit: 'V', from: first - 10, to: drops[drops.length - 1] + 10, marks: drops }
        : { signals: ['canivoreUsbDisconnects'], unit: '' },
    }
  },
})
