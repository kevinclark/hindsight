/** The shape of a robot profile. See 2026-offseason.ts for a filled-in example. */

export interface Motor {
  name: string
  /** CAN ID, for the "set it in Phoenix Tuner X" cards. */
  canId?: number
  supplyCurrent?: string
  statorCurrent?: string
  velocity?: string
  connected?: string
  /** The controller's temperature (°C), e.g. a TalonFX's DeviceTemp. */
  temperature?: string
  /**
   * A signal that changes every few robot loops even while the motor sits still and disabled, so a value frozen for
   * seconds means the readings stopped (foresight/values-updating). Leave out when the motor has none: a still
   * motor's position and velocity sit unchanged for minutes, so they can't tell.
   */
  updating?: string
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
  /** The robot pose the code took from this camera (logged only when the code made one, e.g. from two or more tags). */
  acceptedPose: string
  /** The camera's raw PhotonVision pipeline result (proto:photonvision.proto.ProtobufPhotonPipelineResult): what it saw. */
  result?: string
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
  /** Other branches that ran this same code (e.g. a branch merged into this one): their logs use this profile too. */
  alsoBranches?: string[]
}

export interface RobotProfile {
  /** The robot, as people call it: "2026 offseason robot". */
  name: string
  /**
   * Set only on a profile kept in this browser (src/builder/store.ts keptId): the id every page knows it by, so a
   * kept profile never shares an id with a built-in one of the same name and branch.
   */
  keptAs?: string
  /**
   * How a log says it came from this robot: the code's /RealMetadata/Codebase value (an AdvantageKit metadata entry
   * the robot code sets). Several profiles may share one codebase, each pinned to a different branch.
   */
  codebase: string
  code: CodePin
  /** `field`: the field's length (x) and width (y) in meters, from the season's AprilTag layout, for "is this pose on the field". */
  game: { name: string; autoSeconds: number; teleopSeconds: number; field?: { length: number; width: number } }
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
    /** The Driver Station's e-stop flag (true from the e-stop until the robot program restarts). */
    emergencyStop: string
    /** The Driver Station's match clock: seconds left in the current period (auto or teleop). */
    matchTimeLeft: string
    /** The auto chooser's selection (text), e.g. AdvantageKit's LoggedDashboardChooser. */
    autoChoice: string
    /** Each Driver Station joystick port's button count (0 = nothing plugged in), port 0 first. */
    joystickButtonCounts: string[]
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
  /** `updating`: as for a motor (Motor.updating). */
  otherDevices: { name: string; connected: string; updating?: string }[]
  /**
   * Each CAN bus and the health signals of the devices on it, so a drop of the whole bus (the CANivore, its USB cable
   * or its power) reads as one event rather than as one device. `key` is a Connected flag (true = fine), or, with
   * `ok`, a status text that is fine only when it equals `ok` (e.g. a Phoenix refresh status code, "OK"). A member's
   * name matches a device's name (otherDevices, or a motor with a Connected flag) when it is one.
   */
  canBuses?: { name: string; members: { name: string; key: string; ok?: string }[] }[]
  /**
   * The robot's main state machine (a superstructure), for mech/stuck-state. Each team names it differently, so the
   * profile author confirms the key; nothing guesses it. `idle`: states where waiting is the job; `waitsOnPurpose`:
   * states that hold for a long time by design (e.g. before a climb); `requests`: the drivers' request flags (true
   * while a button asks for something); `sensors`: true/false sensors that may be what a state waits for (learned
   * from the state's normal exits, never mapped by hand).
   */
  stateMachine?: {
    name: string
    state: string
    idle: string[]
    waitsOnPurpose: string[]
    requests: { name: string; key: string }[]
    sensors: { name: string; key: string }[]
  }
  whatIfGroup: string
  /**
   * The power distribution board on the robot, if known: a REV PDH and a CTRE PDP (v1) report each channel's current
   * over CAN; a CTRE PDP 2.0 has no current telemetry at all.
   */
  powerDistribution?: 'rev-pdh' | 'ctre-pdp' | 'ctre-pdp-2'
  zeroing: ZeroingMechanism[]
  cameras: Camera[]
  /** What Foresight's pre-match checks need beyond the rest of the profile (src/foresight/). */
  foresight?: ForesightProfile
}

/** Foresight (the live pit check): the robot's controllers, gyro and the zeros it can check against an absolute sensor. */
export interface ForesightProfile {
  /** Each Driver Station port the robot code reads a controller from, port 0 first: the key of its controller name. */
  controllerNames: string[]
  /** The gyro's yaw (struct:Rotation2d, radians). */
  gyroYaw: string
  /** Mechanisms whose motor position can be checked against an absolute encoder, and those that can't (and why). */
  zeroChecks: ZeroCheck[]
  /** What a robot snapshot should show beyond the motor groups (src/foresight/snapshot-checks.ts). */
  snapshot?: SnapshotExpectations
}

/** The robot code's settings that only the devices themselves can confirm, read back through a robot snapshot. */
export interface SnapshotExpectations {
  /** CTRE devices besides the motors (the motors come from motorGroups), each by model and CAN ID. */
  devices: {
    name: string
    model: 'CANcoder' | 'Pigeon 2'
    canId: number
    /** A CANcoder's MagnetOffset as the code applies it (rotations). */
    magnetOffset?: number
    /** The CAN ID of the motor that reads this CANcoder: that motor's FeedbackRemoteSensorID must be this CANcoder's ID. */
    readBy?: number
    where?: string
  }[]
  /** Feedback ratios the code applies to every motor of a motor group (Phoenix SensorToMechanismRatio, RotorToSensorRatio). */
  ratios: { group: string; sensorToMechanism?: number; rotorToSensor?: number; where: string }[]
}

export type ZeroCheck =
  | {
    mechanism: string
    /** The absolute encoder's position, and its unit in the log ('radians' for a Rotation2d). */
    absolute: string
    absoluteUnit: 'radians' | 'rotations'
    /** The motor's position (mechanism rotations). */
    motor: string
    /** Absolute-encoder rotations per mechanism rotation (Phoenix SensorToMechanismRatio), and where it is set. */
    sensorToMechanism: number
    where: string
  }
  | { mechanism: string; notCheckable: string }
