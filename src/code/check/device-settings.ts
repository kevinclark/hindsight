/**
 * The settings the code gives each CTRE device it builds, read from the configuration it applies:
 * `motor.getConfigurator().apply(config)`, with the device and `config` followed back to where they are built (an
 * IO's constructor parameters, a `getHoodConfig()` method) and the fields set on the config there
 * (`config.MagnetSensor.MagnetOffset = -0.41`). Foresight compares them with what each device holds in a robot
 * snapshot (foresight/snapshot-checks.ts, snapshot/code-settings). Simulation code is left out (devices.ts).
 * Only fields set one by one are read: a `.withMagnetOffset(…)` builder, or a whole configs object set at once, isn't.
 */
import { field, fileName, lineOf, nameOf, operatorOf, parts, typeNamed, type Node } from './java.ts'
import { deviceAlong, inSimulation } from './devices.ts'
import { madeAlong, valueAlong, waysToReach } from './flow.ts'
import type { Project } from './project.ts'
import { declarationOf, visibleIn } from './types.ts'
import { valueOf } from './values.ts'

/** The Phoenix 6 config fields compared with the snapshot (MagnetSensorConfigs, FeedbackConfigs, CurrentLimitsConfigs). */
export const SETTING_FIELDS = ['MagnetOffset', 'SensorToMechanismRatio', 'StatorCurrentLimit', 'StatorCurrentLimitEnable', 'SupplyCurrentLimit', 'SupplyCurrentLimitEnable'] as const
export type SettingField = (typeof SETTING_FIELDS)[number]
/** Those, and the supply lower limit, which the profile builder reads but the snapshot check doesn't compare. */
export const READ_FIELDS = [...SETTING_FIELDS, 'SupplyCurrentLowerLimit', 'SupplyCurrentLowerTime'] as const
export type ReadField = (typeof READ_FIELDS)[number]

/** One setting the code gives one device. Plain data: it is handed from the Code panel to the Foresight check. */
export interface DeviceSetting<F extends ReadField = SettingField> {
  kind: string
  id: number
  /** As devices.ts names it: "canivore", "*", or "the roboRIO bus". */
  bus: string
  field: F
  value: number | boolean
  /** Where the code sets it: "TurretSubsystem.java:576". */
  where: string
}

/** Every setting the snapshot check compares that the code applies to a device it builds on the robot (not in simulation), each once. */
export function deviceSettings(project: Project): DeviceSetting[] {
  return readSettings(project).filter((s): s is DeviceSetting => (SETTING_FIELDS as readonly string[]).includes(s.field))
}

/** Every setting read, the supply lower limit included: the profile builder's. */
export function readSettings(project: Project): DeviceSetting<ReadField>[] {
  const applied = project.nodes('method_invocation').filter((call) => deviceOfApply(call)).flatMap((apply) => settingsApplied(apply, project))
  const unique = new Map(applied.map((s) => [JSON.stringify(s), s]))
  return [...unique.values()]
}

/** Phoenix 5's calls that apply a config to a device, and Phoenix 5's current limit config objects. */
const PHOENIX5_APPLY = ['configAllSettings', 'configSupplyCurrentLimit', 'configStatorCurrentLimit']
const PHOENIX5_LIMITS: Record<string, 'Supply' | 'Stator'> = { SupplyCurrentLimitConfiguration: 'Supply', StatorCurrentLimitConfiguration: 'Stator' }
/** Phoenix 5 TalonFXConfiguration's fields that hold them. */
const PHOENIX5_LIMIT_FIELDS = ['supplyCurrLimit', 'statorCurrLimit']

/**
 * The device a config is applied to: `<device>.getConfigurator().apply(<config>)` (Phoenix 6, with or without a
 * timeout), or `<device>.configAllSettings(<config>)` / `<device>.configSupplyCurrentLimit(<limit>)` (Phoenix 5). A
 * device's own class applying to itself (`this.configSupplyCurrentLimit(…)`) isn't read: which runs last can't be told.
 */
function deviceOfApply(call: Node): Node | null {
  const object = field(call, 'object')
  if (nameOf(call) === 'apply' && object?.type === 'method_invocation' && nameOf(object) === 'getConfigurator') return field(object, 'object')
  return PHOENIX5_APPLY.includes(nameOf(call) ?? '') && object && object.type !== 'this' ? object : null
}

/** The settings one apply call gives, along each chain of calls that reaches it on the robot. */
function settingsApplied(apply: Node, project: Project): DeviceSetting<ReadField>[] {
  const device = deviceOfApply(apply)
  const [config] = parts(apply, 'arguments')
  const ways = (waysToReach(apply, project) ?? []).filter((chain) => ![apply, ...chain].some(inSimulation))
  return ways.flatMap((chain) => {
    const site = madeAlong(device, chain, project)
    const built = site ? deviceAlong(site.at, site.chain, project) : null
    if (!built) return []
    return withOwnWrites(config ?? null, configSettings(config ?? null, chain, project), chain, project).map((s) => ({ kind: built.kind, id: built.id, bus: built.bus, ...s }))
  })
}

type Set = { field: ReadField; value: number | boolean; where: string }
const CURRENT_FIELDS: ReadField[] = ['StatorCurrentLimit', 'StatorCurrentLimitEnable', 'SupplyCurrentLimit', 'SupplyCurrentLimitEnable', 'SupplyCurrentLowerLimit', 'SupplyCurrentLowerTime']
const isWith = (expr: Node) => expr.type === 'method_invocation' && /^with[A-Z]/.test(nameOf(expr) ?? '')

/**
 * The settings a config gives: the fields set on the `new TalonFXConfiguration()` it starts from, and a
 * `.withCurrentLimits(new CurrentLimitsConfigs().withStatorCurrentLimit(80)…)` after it, which replaces every current
 * limit field (one it doesn't set is then Phoenix's default, so it isn't listed).
 */
function configSettings(config: Node | null, chain: Node[], project: Project): Set[] {
  const made = madeAlong(config, chain, project, { throughCalls: true, stopAt: isWith })
  if (!made) return []
  if (made.at.type === 'object_creation_expression' && PHOENIX5_LIMITS[typeNamed(made.at) ?? '']) return phoenix5Limit(made.at, made.chain, project)
  if (made.at.type === 'object_creation_expression') return fieldsSetOn(made.at, made.chain, project)
  const base = configSettings(field(made.at, 'object'), made.chain, project)
  if (nameOf(made.at) !== 'withCurrentLimits') return base
  const limits = builtLimits(parts(made.at, 'arguments')[0] ?? null, made.chain, project)
  return limits ? [...base.filter((s) => !CURRENT_FIELDS.includes(s.field)), ...limits] : base
}

/**
 * Phoenix 5's `new SupplyCurrentLimitConfiguration(enable, currentLimit, triggerThresholdCurrent, triggerThresholdTime)`
 * (or Stator…): the limit and whether it is on. Phoenix 5 holds the current to `currentLimit` once it has been above the
 * trigger for the trigger time, so the trigger is a short peak it allows, not the limit.
 */
function phoenix5Limit(made: Node, chain: Node[], project: Project): Set[] {
  const kind = PHOENIX5_LIMITS[typeNamed(made) ?? '']
  const [enable, limit] = parts(made, 'arguments')
  const where = `${fileName(project.fileOf(made).path)}:${lineOf(made)}`
  const on = settingValue(enable ?? null, chain, project)
  const amps = settingValue(limit ?? null, chain, project)
  return [
    ...(typeof amps === 'number' ? [{ field: `${kind}CurrentLimit` as ReadField, value: amps, where }] : []),
    ...(typeof on === 'boolean' ? [{ field: `${kind}CurrentLimitEnable` as ReadField, value: on, where }] : []),
  ]
}

/** `new CurrentLimitsConfigs().withSupplyCurrentLimit(30).withSupplyCurrentLimitEnable(true)`: each field it sets. */
function builtLimits(expr: Node | null, chain: Node[], project: Project): Set[] | null {
  const out: Set[] = []
  let at = expr
  for (; at && isWith(at); at = field(at, 'object')) {
    const setting = READ_FIELDS.find((f) => `with${f}` === nameOf(at!))
    const value = setting ? settingValue(parts(at, 'arguments')[0] ?? null, chain, project) : null
    if (setting && value !== null) out.unshift({ field: setting, value, where: `${fileName(project.fileOf(at).path)}:${lineOf(at)}` })
  }
  return at?.type === 'object_creation_expression' && typeNamed(at) === 'CurrentLimitsConfigs' ? out : null
}

/**
 * A config the apply call names by a variable of its own that starts from another config
 * (`var driveConfig = constants.DriveMotorInitialConfigs`): the fields written on that variable come after, so they
 * replace what the config it started from set.
 */
function withOwnWrites(config: Node | null, base: Set[], chain: Node[], project: Project): Set[] {
  const variable = config?.type === 'identifier' ? declarationOf(config, config.text, project) : null
  const start = variable?.type === 'variable_declarator' ? field(variable, 'value') : null
  if (!variable || !start || start.type === 'object_creation_expression') return base
  const own = fieldsSetOnVariable(variable, chain, project)
  return [...base.filter((s) => !own.some((o) => o.field === s.field)), ...own]
}

/**
 * The setting fields assigned on the config a `new TalonFXConfiguration()` starts, where its variable is seen. A value
 * passed in is read along the calls that made the config (`createRollerConfig(…, 20)` sets the supply limit to 20).
 */
function fieldsSetOn(made: Node, chain: Node[], project: Project): Set[] {
  const variable = configVariable(made, project)
  return variable ? fieldsSetOnVariable(variable, chain, project) : []
}

/** The setting fields assigned on this variable (or field), where it is seen. */
function fieldsSetOnVariable(variable: Node, chain: Node[], project: Project): Set[] {
  const name = nameOf(variable)
  const scope = variable && visibleIn(variable)
  if (!name || !scope) return []
  return scope.descendantsOfType('assignment_expression').flatMap((assignment) => {
    const target = assignment && field(assignment, 'left')
    if (!assignment || operatorOf(assignment) !== '=' || target?.type !== 'field_access' || !setsOn(target, variable, project)) return []
    // Phoenix 5: `config.supplyCurrLimit = new SupplyCurrentLimitConfiguration(…)`, or a name for one.
    if (PHOENIX5_LIMIT_FIELDS.includes(field(target, 'field')?.text ?? '')) {
      const limit = madeAlong(field(assignment, 'right'), chain, project)
      return limit?.at.type === 'object_creation_expression' && PHOENIX5_LIMITS[typeNamed(limit.at) ?? ''] ? phoenix5Limit(limit.at, limit.chain, project) : []
    }
    const setting = READ_FIELDS.find((f) => f === field(target, 'field')?.text)
    if (!setting) return []
    const value = settingValue(field(assignment, 'right'), chain, project)
    // A value passed in (`createRollerConfig(…, 20)`) is changed where it is passed: that line, not the helper's.
    const origin = madeAlong(field(assignment, 'right'), chain, project, { throughCalls: false, stopAt: isFlag })?.at
    const at = origin && !(origin.startIndex >= assignment.startIndex && origin.endIndex <= assignment.endIndex && origin.tree === assignment.tree) ? origin : assignment
    const where = `${fileName(project.fileOf(at).path)}:${lineOf(at)}`
    return value === null ? [] : [{ field: setting, value, where }]
  })
}

/** The variable or field a `new …Configuration()` is put in: `var config = new …` or `swerveAngleFXConfig = new …`. */
function configVariable(made: Node, project: Project): Node | null {
  if (made.parent?.type === 'variable_declarator') return made.parent
  const target = made.parent?.type === 'assignment_expression' ? field(made.parent, 'left') : null
  const name = target?.type === 'identifier' ? target.text : target?.type === 'field_access' && field(target, 'object')?.type === 'this' ? field(target, 'field')?.text : null
  return name ? declarationOf(target!, name, project) : null
}

/** Is `config.CurrentLimits.SupplyCurrentLimit` written on this config's variable (by its declaration, not its name)? */
function setsOn(target: Node, variable: Node, project: Project): boolean {
  let root = target
  while (root.type === 'field_access') root = field(root, 'object') ?? root
  if (root.type !== 'identifier') return false
  return declarationOf(root, root.text, project)?.equals(variable) === true
}

/** `Robot.isReal()` or `RobotBase.isReal()` (WPILib): true on the robot, the only place the settings are compared. */
const isReal = (n: Node) => n.type === 'method_invocation' && nameOf(n) === 'isReal' && parts(n, 'arguments').length === 0 && /^(Robot|RobotBase)$/.test(field(n, 'object')?.text ?? '')
const isFlag = (n: Node) => n.type === 'true' || n.type === 'false' || isReal(n)
/** `Amps.of(110.0)` (WPILib units, 2025 on): a current in amps. */
const isAmps = (n: Node) => n.type === 'method_invocation' && nameOf(n) === 'of' && /^(Units\.)?Amps$/.test(field(n, 'object')?.text ?? '')

/**
 * A setting's value: `true`, `false`, or a number it can work out (values.ts), through names and what calls passed. A
 * current given as `Amps.of(…)` is its number of amps; `Robot.isReal()` is true.
 */
function settingValue(written: Node | null, chain: Node[], project: Project): number | boolean | null {
  const made = madeAlong(written, chain, project, { throughCalls: false, stopAt: (n) => isFlag(n) || isAmps(n) })
  const flag = made?.at
  if (flag?.type === 'true' || flag?.type === 'false') return flag.type === 'true'
  if (flag && isReal(flag)) return true
  if (made && isAmps(made.at)) return settingValue(parts(made.at, 'arguments')[0] ?? null, made.chain, project)
  const number = valueOf(written, project)?.number ?? valueAlong(written, chain, project)?.value
  return typeof number === 'number' ? number : null
}
