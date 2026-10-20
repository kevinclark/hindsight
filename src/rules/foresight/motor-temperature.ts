/**
 * Is any motor already hot before the match?
 *
 * Checks (Foresight, the live pit check, only): each motor controller's temperature (a Talon FX's DeviceTemp, its
 * own reading, not the winding's) at the latest moment of the disabled stretch. Fires above 60 °C.
 * Measured on the CalGames 2026 logs (Q13, Q21, P0; 19 motors each): 22–31 °C while disabled before the match, a
 * highest of 60 °C during a match (a swerve drive motor, Q21), and 26–54 °C from 10 s after it to the end of the log. So 60 °C is
 * hotter than any of the robot's motors ended a full match: one that starts there has less margin than the hottest
 * one had at the final buzzer. The line is measured from 8033's own logs; where the Talon FX itself starts cutting
 * power is not measured here and is not what this line rests on.
 */
import { rule, round } from '../rule.ts'

const HOT_C = 60

export default rule({
  id: 'foresight/motor-temperature',
  title: 'Motor hot before the match',
  severity: 'warning',
  who: ['pit'],
  meaning: 'A motor is already hotter than any of this robot\'s motors got by the end of a full match. It has less room before it overheats and loses power during the match.',
  causes: [
    { id: 'recent', cause: 'It is still hot from the last match or from testing in the pit', look: 'when the robot last ran; whether this motor was run on the cart (e.g. the flywheel spun up)' },
    { id: 'binding', cause: 'The mechanism binds or drags, so the motor works harder than the others', look: 'turn the mechanism by hand with the robot off: does it drag? Compare with the motors next to it' },
    { id: 'cooling', cause: 'The motor\'s airflow is blocked', look: 'the motor\'s vents and anything packed against it' },
  ],
  nextStep: 'Let the motor cool with the robot off (a fan helps) and check it again; if it was not run since the last match, check the mechanism for binding.',
  incident: 'The team\'s 2026 pit checklist: "No motors overheating"',
  forEach: 'motor',

  check(motor, match) {
    const stretch = match.beforeEnable.at(-1)
    if (!stretch) return // a match log: this is a pit check
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
        'CalGames 2026, 19 motors (°C)': '22–31 before the match; 60 at most during one; 26–54 after',
      },
    }
  },
})
