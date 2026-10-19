/** The shape of a robot profile. See 2026-offseason.ts for a filled-in example. */

export interface Motor {
  name: string
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
  /** Where the limits are set in the robot code, e.g. "DrumSubsystem.java:307". */
  where: string
}

export interface MotorGroup {
  name: string
  motors: Motor[]
  limits: CurrentLimits
  /** True when every motor in the group runs on one control loop and should match speed (leader + followers). */
  sameLoop?: boolean
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
}

export interface Camera {
  name: string
  acceptedPose: string
  stale: string
  connected: string
}

export interface RobotProfile {
  name: string
  repo: string
  configSha: string
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
  zeroing: ZeroingMechanism[]
  cameras: Camera[]
}
