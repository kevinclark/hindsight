/**
 * The CTRE devices the code builds (`new TalonFX(id, bus)`, `new CANcoder(…)`, `new Pigeon2(…)`), each with its ID and
 * bus worked out along one chain of calls that builds it (flow.ts). duplicate-can-id compares their IDs, the robot
 * snapshot's code-settings check finds them on the bus, and the profile builder's hints leave out simulation code.
 */
import { classAround, nameOf, parts, typeNamed, type Node } from './java.ts'
import { valueAlong } from './flow.ts'
import { baseType, type Project } from './project.ts'
import { busName, RIO } from './bus-names.ts'

export const PHOENIX_DEVICES = ['TalonFX', 'CANcoder', 'Pigeon2']

export interface Device {
  kind: string
  id: number
  bus: string
  /** Where the ID is written: the line to change. */
  at: Node
  /** Everywhere the ID and bus passed through to get here, to tell whether two devices can both be built. */
  path: Node[]
}

/** The device `new TalonFX(…)` builds when reached through `chain`, or null when its ID or bus can't be worked out. */
export function deviceAlong(site: Node, chain: Node[], project: Project): Device | null {
  const kind = baseType(typeNamed(site))
  const [idArgument, busArgument] = parts(site, 'arguments')
  if (!kind || !PHOENIX_DEVICES.includes(kind) || !idArgument) return null
  const id = valueAlong(idArgument, chain, project)
  const bus = busArgument ? valueAlong(busArgument, chain, project) : { value: RIO, at: site }
  if (!id || !bus || typeof id.value !== 'number') return null
  return { kind, id: id.value, bus: busName(bus.value), at: id.at, path: [id.at, bus.at, site, ...chain] }
}

/**
 * Is this call simulation code: in a class whose name ends in "Sim", or building one (`new FlywheelIOSim(…, 11, 12)`)?
 * AdvantageKit's IO pattern names them so, and their IDs needn't match the robot's: Rebuilt 3eca5e5 gives the
 * simulated flywheel 11 and 12, the real hood's and flywheel's IDs.
 */
export function inSimulation(call: Node): boolean {
  const named = (name: string | null | undefined) => !!name?.endsWith('Sim')
  return named(nameOf(classAround(call) ?? call)) || (call.type === 'object_creation_expression' && named(baseType(typeNamed(call))))
}
