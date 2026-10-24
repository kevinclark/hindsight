/**
 * Is any motor already hot before the match?
 *
 * Checks (Foresight, the live pit check, only): each motor controller's temperature (a Talon FX's DeviceTemp, its
 * own reading, not the winding's) at the latest moment of the disabled stretch. Fires above 60 °C.
 * Measured on the 2026 logs (three matches; 19 motors each): 22–31 °C while disabled before the match, a
 * highest of 60 °C during a match (a swerve drive motor, log B), and 26–54 °C from 10 s after it to the end of the log. So 60 °C is
 * hotter than any of the robot's motors ended a full match: one that starts there has less margin than the hottest
 * one had at the final buzzer. The line is measured from 8033's own logs; where the Talon FX itself starts cutting
 * power is not measured here and is not what this line rests on.
 */
import { rule, round } from '../rule.ts'
import { CTRE_TALONFX, CTRE_TALONFX_API } from '../sources.ts'

const HOT_C = 60

export default rule({
  id: 'foresight/motor-temperature',
  title: 'Motor hot before the match',
  severity: 'warning',
  judges: 'performance',
  foresightOnly: true,
  who: ['pit'],
  meaning: 'A motor is already hotter than any of this robot\'s motors got by the end of a full match. It has less room before it overheats and loses power during the match.',
  causes: [
    { id: 'recent', cause: 'It is still hot from the last match or from testing in the pit', look: 'when the robot last ran; whether this motor was run on the cart (e.g. the flywheel spun up)' },
    { id: 'binding', cause: 'The mechanism binds or drags, so the motor works harder than the others', look: 'turn the mechanism by hand with the robot off: does it drag? Compare with the motors next to it' },
    { id: 'cooling', cause: 'The motor\'s airflow is blocked', look: 'the motor\'s vents and anything packed against it' },
  ],
  nextStep: 'Let the motor cool with the robot off (a fan helps) and check it again; if it was not run since the last match, check the mechanism for binding.',
  incident: 'The team\'s 2026 pit checklist: "No motors overheating"',
  sources: [
    { ...CTRE_TALONFX, says: 'A Talon FX in thermal cutoff shows an offset orange/off light pattern; let it cool and consider stator current limits to reduce heat.' },
    { ...CTRE_TALONFX_API, says: 'Fault_DeviceTemp is "Device temperature exceeded limit"; the page gives no temperature in degrees.' },
  ],
  thresholds: [
    { name: 'motor controller temperature', value: 'above 60 °C', basis: 'measured', how: 'the three 2026 offseason-event matches (19 motors each): 22 to 31 °C disabled before the match, a highest of 60 °C during a match, 26 to 54 °C from 10 s after it. Where the Talon FX itself cuts power is not measured.' },
  ],
  forEach: 'motor',

  check(motor, match) {
    const stretch = match.pitStretch
    const temperature = motor.temperature()
    const now = temperature.at(stretch.end)
    if (!Number.isFinite(now)) return match.couldNotCheck(`${motor.name} sent no temperature yet`)
    if (now <= HOT_C) return
    return {
      message: `${motor.name} is at ${Math.round(now)} °C with the robot disabled (above ${HOT_C} °C)`,
      at: stretch.end,
      measured: [{ label: 'motor temperature', value: round(now, 1), unit: '°C', threshold: HOT_C }],
      evidence: {
        'temperature now (°C)': round(now, 1),
        '2026 offseason event, 19 motors (°C)': '22–31 before the match; 60 at most during one; 26–54 after',
      },
    }
  },
})
