/** The shape of a robot profile. See 2026-offseason.ts for a filled-in example. */

export interface Motor {
  name: string
  /** CAN ID, for the "set it in Phoenix Tuner X" cards. */
  canId?: number
  supplyCurrent?: string
  statorCurrent?: string
  velocity?: string
  connected?: string
}

export interface CurrentLimits {
  supplyA?: number
  supplyEnabled?: boolean
  statorA?: number
  statorEnabled?: boolean
  /**
   * SupplyCurrentLowerLimit / SupplyCurrentLowerTime. Leave out when the code doesn't set them: Phoenix's defaults
   * apply (after 1.0 s at the supply limit, the cap drops to 40 A).
   */
  supplyLowerA?: number
  supplyLowerSeconds?: number
  /** Where the limits are set in the robot code, e.g. "DrumSubsystem.java:307". */
  where: string
  /** The lines a student edits to change the supply limit, e.g. "DrumSubsystem.java:309-310". */
  supplyLines?: string
}

export interface MotorGroup {
  name: string
  motors: Motor[]
  limits: CurrentLimits
  /** True when every motor in the group runs on one control loop and should match speed (leader + followers). */
  sameLoop?: boolean
  /** For the limits wizard: the group spins up to a speed (the first motor is the leader); its setpoint log key. */
  spinUp?: { setpoint?: string; appliedVolts?: string }
}

export interface ZeroingMechanism {
  mechanism: string
  position: string
  /** Multiply the logged position by this to get degrees (360 for rotations). */
  positionToDegrees: number
  /** Console text printed when the zero completes. */
  doneMessage: RegExp
  /** Movement (degrees) that counts as "the mechanism moved". */
  moveDegrees: number
  /** For a current-detected zero: the motor's stator current key, the detection threshold, and where it is set. */
  zeroCurrent?: { statorCurrent: string; thresholdA: number; statorLimitA: number; where: string }
  /**
   * Which hard stop the zero drives into: 'down' (toward lower positions) or 'up'. Travel toward that stop is the
   * zeroing itself; only travel the other way counts as moving before the zero completed.
   */
  zeroDirection: 'down' | 'up'
}

export interface Camera {
  name: string
  acceptedPose: string
  stale: string
  connected: string
}

/** The robot code a profile was read from: the branch the robot ran (often an event branch) and the commit on it. */
export interface CodePin {
  repo: string
  /** e.g. "main", or the branch the robot ran at an event. */
  branch: string
  /** The commit the motor groups, keys and current limits were copied from (7+ characters). */
  sha: string
}

export interface RobotProfile {
  /** The robot, as people call it: "2026 offseason robot". */
  name: string
  /**
   * How a log says it came from this robot: the code's /RealMetadata/Codebase value (an AdvantageKit metadata entry
   * the robot code sets). Several profiles may share one codebase, each pinned to a different branch.
   */
  codebase: string
  code: CodePin
  game: { name: string; autoSeconds: number; teleopSeconds: number }
  signals: {
    enabled: string
    autonomous: string
    fmsAttached: string
    dsAttached: string
    eventName: string
    matchType: string
    matchNumber: string
    replayNumber: string
    allianceStation: string
    gitSha: string
    gitBranch: string
    gitDate: string
    gitDirty: string
    epochMicros: string
    systemTimeValid: string
    batteryVoltage: string
    brownedOut: string
    brownoutVoltage: string
    commsDisableCount: string
    systemActive: string
    loopCycleMs: string
    console: string
    /** Each AdvantageKit Alert group has string[] children: errors, warnings, infos. */
    alertGroups: string[]
    gyroPitch: string
    gyroRoll: string
    accelX: string
    accelY: string
    odometryPose: string
  }
  /** Battery tracker keys. Each lists the places the key may be; the first one present is used. */
  battery: {
    id: string[]
    idSource: string[]
    gaugeValid: string[]
    effectiveCapacityAh: string[]
    ratedCapacityAh: string[]
    remainingChargePct: string[]
    numCycles: string[]
  }
  power: {
    otherLoadsAmps: number
    restVoltageMin: number
    marginVolts: number
    healthyResistanceMaxOhms: number
  }
  motorGroups: MotorGroup[]
  otherDevices: { name: string; connected: string }[]
  whatIfGroup: string
  /**
   * The power distribution board on the robot, if known: a REV PDH and a CTRE PDP (v1) report each channel's current
   * over CAN; a CTRE PDP 2.0 has no current telemetry at all.
   */
  powerDistribution?: 'rev-pdh' | 'ctre-pdp' | 'ctre-pdp-2'
  zeroing: ZeroingMechanism[]
  cameras: Camera[]
}
