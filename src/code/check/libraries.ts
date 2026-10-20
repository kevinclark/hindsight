/**
 * What the code checks know about WPILib and Phoenix 6, as short tables. Each entry was read from the library's own
 * source or API docs (2026-10-20): WPILib v2026.2.1 (github.com/wpilibsuite/allwpilib, tag v2026.2.1), Phoenix 6
 * 26.3.0 (api.ctr-electronics.com/phoenix6/stable/java). To add one, read it there first and say where in a comment.
 */

/**
 * Phoenix 6 config fields that hold a decimal (`public double`), from FeedbackConfigs, MotionMagicConfigs,
 * Slot0Configs, CurrentLimitsConfigs and MagnetSensorConfigs. `FeedbackRemoteSensorID` is an int and isn't here.
 */
export const PHOENIX_DECIMAL_FIELDS = new Set([
  'SensorToMechanismRatio', 'RotorToSensorRatio', 'FeedbackRotorOffset', 'VelocityFilterTimeConstant',
  'MotionMagicCruiseVelocity', 'MotionMagicAcceleration', 'MotionMagicJerk', 'MotionMagicExpo_kV', 'MotionMagicExpo_kA',
  'kP', 'kI', 'kD', 'kS', 'kV', 'kA', 'kG', 'GravityArmPositionOffset',
  'StatorCurrentLimit', 'SupplyCurrentLimit', 'SupplyCurrentLowerLimit', 'SupplyCurrentLowerTime',
  'MagnetOffset', 'AbsoluteSensorDiscontinuityPoint',
])

/**
 * WPILib classes whose objects never change (every field final), with the methods that return a new object and leave
 * the old one as it was: calling one and not using the answer does nothing. From wpimath's Matrix.java (each returns
 * `new Matrix<>(...)`) and geometry/*.java.
 */
const POSE = ['plus', 'minus', 'times', 'div', 'rotateBy', 'transformBy', 'relativeTo', 'rotateAround', 'exp', 'log', 'nearest', 'interpolate']
const TRANSLATION = ['rotateBy', 'rotateAround', 'plus', 'minus', 'unaryMinus', 'times', 'div', 'nearest', 'interpolate']
const ROTATION = ['plus', 'minus', 'unaryMinus', 'times', 'div', 'rotateBy', 'relativeTo', 'interpolate']
const TRANSFORM = ['times', 'div', 'plus', 'inverse']
const MATRIX = ['times', 'plus', 'minus', 'div', 'transpose', 'inv', 'elementTimes', 'elementPower', 'copy', 'exp', 'pow', 'diag']
export const UNCHANGING: Record<string, string[]> = {
  Matrix: MATRIX, Vector: MATRIX,
  Pose2d: POSE, Pose3d: POSE, Translation2d: TRANSLATION, Translation3d: TRANSLATION,
  Rotation2d: ROTATION, Rotation3d: ROTATION, Transform2d: TRANSFORM, Transform3d: TRANSFORM,
}

/** Every static method of `Commands` returns a new Command (wpilibNewCommands Commands.java). */
export const COMMAND_FACTORIES = 'Commands'
/** Command methods that return a new Command wrapping it (Command.java): the original isn't changed or run. */
export const COMMAND_DECORATORS = [
  'withTimeout', 'until', 'onlyWhile', 'beforeStarting', 'andThen', 'withDeadline', 'deadlineWith', 'deadlineFor', 'alongWith',
  'raceWith', 'repeatedly', 'asProxy', 'unless', 'onlyIf', 'finallyDo', 'handleInterrupt', 'ignoringDisable',
  'withInterruptBehavior', 'withName',
]
/** Subsystem's default methods that build a Command (Subsystem.java), called on a subsystem or from inside one. */
export const SUBSYSTEM_COMMANDS = ['idle', 'runOnce', 'run', 'startEnd', 'runEnd', 'startRun', 'defer']
/** The classes a subsystem extends or implements (wpilibNewCommands). */
export const SUBSYSTEM_TYPES = ['SubsystemBase', 'Subsystem']

/** Calls that return an Optional (`receiver.method`): DriverStation.java `public static Optional<Alliance> getAlliance()`. */
export const OPTIONAL_CALLS = new Set(['DriverStation.getAlliance'])

/** The WPILib (and AdvantageKit) robot classes: WPILib builds the robot (`RobotBase.startRobot(Robot::new)`). */
export const ROBOT_BASES = ['TimedRobot', 'LoggedRobot', 'IterativeRobotBase', 'RobotBase', 'TimesliceRobot']
