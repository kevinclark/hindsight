/**
 * Wanted checks: rules Hindsight would run if the robot logged one more thing. Each is a problem that has happened,
 * and the signal the robot would need to publish for a rule to catch it. They never run and always read "not
 * covered": the Logging tab lists them so students can see what the robot code could add. When a robot logs the
 * signal, write the rule (CONTRIBUTING.md) and remove its entry here.
 *
 * Worded as the problem, never as code: how to log it is the students' call.
 */

export interface WantedCheck {
  /** "wanted/<name>": the id its rule will get, in the area it will go in. */
  id: string
  /** The question the rule would answer. */
  question: string
  /** What happened that it would have caught, and where. */
  incident: string
  /** What the robot would need to publish, in words. */
  needs: string
  /** Set when no log can show it, only a check of the robot itself (Foresight, in the pit): why. */
  liveOnly?: string
}

export const WANTED_CHECKS: WantedCheck[] = [
  {
    id: 'wanted/ctre-status-at-boot',
    question: 'Did every CTRE device report a good status within a few seconds of boot?',
    incident: 'OCR 2025: a start-up race left the gyro without a good status, and two qualification matches were lost',
    needs: 'whether each CTRE device has reported a good status since boot (or the Phoenix .hoot log next to the .wpilog)',
  },
  {
    id: 'wanted/hood-zeroed-since-boot',
    question: 'Was the hood zeroed since the robot code started?',
    incident: 'CalGames 2026 Q13 and Q21: the zero was cancelled at the start of auto, and the hood has no absolute encoder to fall back on',
    needs: 'a true/false "zeroed since boot" flag for the hood',
  },
  {
    id: 'wanted/camera-serial',
    question: 'Is each camera name on the camera it should be?',
    incident: 'The cameras swapped names twice',
    needs: 'each camera\'s serial number next to its name',
  },
  {
    id: 'wanted/log-usb-stick',
    question: 'Is the log USB stick in the roboRIO?',
    incident: 'Team pit checklist 2026 §10 checks for the log USB stick by hand',
    needs: 'a flag saying whether the log is being written to the USB stick',
    liveOnly: 'a log that exists was written somewhere, so a missing stick never shows in a log; only a check of the robot in the pit can see it',
  },
]
