/**
 * The settings the code gives each CTRE device it builds, read from the configuration it applies:
 * `motor.getConfigurator().apply(config)`, with the device and `config` followed back to where they are built (an
 * IO's constructor parameters, a `getHoodConfig()` method) and the fields set on the config there
 * (`config.MagnetSensor.MagnetOffset = -0.41`). Foresight compares them with what each device holds in a robot
 * snapshot (foresight/snapshot-checks.ts, snapshot/code-settings). Simulation code is left out (devices.ts).
 * Only fields set one by one are read: a `.withMagnetOffset(…)` builder, or a whole configs object set at once, isn't.
 */
import { field, fileName, lineOf, nameOf, operatorOf, parts, type Node } from './java.ts'
import { deviceAlong, inSimulation } from './devices.ts'
import { valueAlong, waysToReach } from './flow.ts'
import type { Project } from './project.ts'
import { declarationOf, visibleIn } from './types.ts'
import { valueOf } from './values.ts'

/** The Phoenix 6 config fields compared with the snapshot (MagnetSensorConfigs, FeedbackConfigs, CurrentLimitsConfigs). */
export const SETTING_FIELDS = ['MagnetOffset', 'SensorToMechanismRatio', 'StatorCurrentLimit', 'StatorCurrentLimitEnable', 'SupplyCurrentLimit', 'SupplyCurrentLimitEnable'] as const
export type SettingField = (typeof SETTING_FIELDS)[number]

/** One setting the code gives one device. Plain data: it is handed from the Code panel to the Foresight check. */
export interface DeviceSetting {
  kind: string
  id: number
  /** As devices.ts names it: "canivore", "*", or "the roboRIO bus". */
  bus: string
  field: SettingField
  value: number | boolean
  /** Where the code sets it: "TurretSubsystem.java:576". */
  where: string
}

/** Every setting the code applies to a device it builds on the robot (not in simulation), each once. */
export function deviceSettings(project: Project): DeviceSetting[] {
  const applied = project.nodes('method_invocation').filter(isConfigApply).flatMap((apply) => settingsApplied(apply, project))
  const unique = new Map(applied.map((s) => [JSON.stringify(s), s]))
  return [...unique.values()]
}

/** `<device>.getConfigurator().apply(<config>)` (with or without a timeout). */
function isConfigApply(call: Node): boolean {
  const configurator = field(call, 'object')
  return nameOf(call) === 'apply' && configurator?.type === 'method_invocation' && nameOf(configurator) === 'getConfigurator'
}

/** The settings one apply call gives, along each chain of calls that reaches it on the robot. */
function settingsApplied(apply: Node, project: Project): DeviceSetting[] {
  const device = field(field(apply, 'object') ?? apply, 'object')
  const [config] = parts(apply, 'arguments')
  const ways = (waysToReach(apply, project) ?? []).filter((chain) => ![apply, ...chain].some(inSimulation))
  return ways.flatMap((chain) => {
    const site = valueAlong(device, chain, project)?.at
    const built = site ? deviceAlong(site, chain, project) : null
    const made = valueAlong(config ?? null, chain, project, { throughCalls: true })?.at
    if (!built || made?.type !== 'object_creation_expression') return []
    return fieldsSetOn(made, project).map((s) => ({ kind: built.kind, id: built.id, bus: built.bus, ...s }))
  })
}

/** The setting fields assigned on the config a `new TalonFXConfiguration()` starts, where its variable is seen. */
function fieldsSetOn(made: Node, project: Project): { field: SettingField; value: number | boolean; where: string }[] {
  const variable = made.parent?.type === 'variable_declarator' ? made.parent : null
  const name = variable && nameOf(variable)
  const scope = variable && visibleIn(variable)
  if (!name || !scope) return []
  return scope.descendantsOfType('assignment_expression').flatMap((assignment) => {
    const target = assignment && field(assignment, 'left')
    if (!assignment || operatorOf(assignment) !== '=' || target?.type !== 'field_access' || !setsOn(target, variable, project)) return []
    const setting = SETTING_FIELDS.find((f) => f === field(target, 'field')?.text)
    if (!setting) return []
    const value = settingValue(field(assignment, 'right'), project)
    const where = `${fileName(project.fileOf(assignment).path)}:${lineOf(assignment)}`
    return value === null ? [] : [{ field: setting, value, where }]
  })
}

/** Is `config.CurrentLimits.SupplyCurrentLimit` written on this config's variable (by its declaration, not its name)? */
function setsOn(target: Node, variable: Node, project: Project): boolean {
  let root = target
  while (root.type === 'field_access') root = field(root, 'object') ?? root
  if (root.type !== 'identifier') return false
  return declarationOf(root, root.text, project)?.equals(variable) === true
}

/** A setting's value as written: `true`, `false`, or a number it can work out (values.ts). */
function settingValue(written: Node | null, project: Project): number | boolean | null {
  if (written?.type === 'true' || written?.type === 'false') return written.type === 'true'
  return valueOf(written, project)?.number ?? null
}
