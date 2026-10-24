/**
 * Was the robot e-stopped?
 *
 * Checks: the Driver Station's e-stop flag (/DriverStation/EmergencyStop) turning on. Each one is a finding: on the
 * field it ended the robot's match (error); off the field it cost a roboRIO reboot (warning).
 * Why: One 2025 match was e-stopped 1.5 s before the end, and on one day three program runs in a row were e-stopped
 * 0.02 s after their first enable (the team's Slack PSA blamed the DS space bar). No rule read the flag.
 */
import { rule, round, secs, type Problem } from '../rule.ts'
import { GAME_MANUAL_2026, WPILIB_DS } from '../sources.ts'

const ONE_LOOP_SLACK = 0.1 // s: a disable logged up to a few loops before the e-stop flag is the same event (assumed)

export default rule({
  id: 'comms/emergency-stop',
  title: 'Robot e-stopped',
  severity: 'error',
  who: ['drive'],
  meaning: 'Someone e-stopped the robot. It stays disabled until the roboRIO is rebooted, so on the field it sat out the rest of the match.',
  causes: [
    { id: 'space-bar', cause: 'The space bar on the Driver Station laptop was pressed (it is the DS e-stop key), e.g. by a hand resting on the keyboard', look: 'who was at the DS laptop keyboard, and what they did; the DS log for this time shows the e-stop but not the key' },
    { id: 'on-purpose', cause: 'The drive team pressed the e-stop on purpose because the robot was unsafe or out of control', look: 'ask the drive team; the match video at this time' },
    { id: 'field', cause: 'The field staff (FTA or head referee) e-stopped the robot', look: 'ask the FTA why; the field log for this match' },
  ],
  nextStep: 'Ask the drive team who pressed the e-stop (the button or the DS space bar) and why. Keep hands off the DS keyboard once the robot is enabled.',
  incident: 'One 2025 match: e-stopped 1.5 s before the end; on one day, three runs e-stopped 0.02 s after enable',
  sources: [
    { ...WPILIB_DS, says: 'The space bar is the Driver Station e-stop whether or not its window has focus; after an e-stop the roboRIO must be rebooted before the robot can be enabled again.' },
    { ...GAME_MANUAL_2026, says: 'Section 5.9.1: each driver station has an E-Stop button to deactivate a robot in an emergency and an A-Stop button to disable a robot during auto.' },
  ],
  thresholds: [
    { name: 'same event as the disable', value: 'a disable logged up to 0.1 s before the e-stop flag', basis: 'judgment', how: 'Assumed: a few loops of slack.' },
  ],

  check(match) {
    const estop = match.signal('emergencyStop')
    const fms = match.signal('fmsAttached')
    return estop.turnsOn().map((t): Problem => {
      const onField = fms.at(t) > 0.5
      // The enable it ended (the robot reads as disabled at t itself, and the disable can be logged a loop earlier).
      const enable = match.enabled.find((iv) => iv.start <= t && iv.end >= t - ONE_LOOP_SLACK)
      const sinceEnable = enable ? t - enable.start : null
      const left = onField && match.inMatch(t) ? match.timeLeft(t) : NaN
      const knowsTimeLeft = Number.isFinite(left)

      let message: string
      if (onField) {
        const timeLeftWords = knowsTimeLeft ? ` with ${secs(left)} of ${match.phaseAt(t - 0.001)} left` : ''
        message = `E-stopped ${match.whenAt(t - 0.001)}${timeLeftWords}`
      } else {
        const enabledWords = sinceEnable === null ? ' while disabled' : ` ${sinceEnable.toFixed(2)} s after the robot was enabled`
        message = `E-stopped off the field${enabledWords} (robot time ${t.toFixed(1)} s)`
      }

      // Pressed in the same instant as the enable: not a reaction to what the robot did.
      const nextStep = sinceEnable !== null && sinceEnable < 0.5
        ? `The e-stop came ${sinceEnable.toFixed(2)} s after the enable, before the robot could have done anything to react to: look for a key pressed at enable (the DS space bar).`
        : undefined

      return {
        message,
        at: t,
        severity: onField ? 'error' : 'warning',
        evidence: {
          'e-stopped (robot time, s)': round(t),
          'on the field': onField ? 'yes' : 'no',
          'enabled for, before the e-stop (s)': sinceEnable === null ? 'not enabled' : round(sinceEnable),
          'left in the period (s)': knowsTimeLeft ? round(left, 1) : undefined,
        },
        nextStep,
      }
    })
  },
})
