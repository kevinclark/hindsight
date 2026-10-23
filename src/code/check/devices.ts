/**
 * The CTRE devices the code builds (`new TalonFX(id, bus)`, `new CANcoder(…)`, `new Pigeon2(…)`), each with its ID and
 * bus worked out along one chain of calls that builds it (flow.ts). duplicate-can-id compares their IDs, the robot
 * snapshot's code-settings check finds them on the bus, and the profile builder's hints leave out simulation code.
 */
import { classAround, field, nameOf, parts, superclassName, typeNamed, type Node } from './java.ts'
import { madeAlong, valueAlong } from './flow.ts'
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
  const built = deviceBuilt(site, project)
  if (!built?.id) return null
  const through = [...built.through, ...chain]
  const id = valueAlong(built.id, through, project)
  const bus = built.bus ? busAlong(built.bus, through, project) : { value: RIO, at: site }
  if (!id || !bus || typeof id.value !== 'number') return null
  return { kind: built.kind, id: id.value, bus: busName(bus.value), at: id.at, path: [id.at, bus.at, site, ...chain] }
}

/**
 * The bus a device is built on, as a name: a string, or a `new CANBus(…)` whose first argument (the name; CTRE's
 * second is a hoot log path) is worked out along the same chain, so `new CANBus(Constants.CANivore.canbusName)` is
 * "Clockwork". `new CANBus()` is the roboRIO's bus; an argument that can't be worked out gives null, never the roboRIO's.
 */
function busAlong(expr: Node, through: Node[], project: Project): { value: string; at: Node } | null {
  const made = madeAlong(expr, through, project)
  const found = valueAlong(expr, through, project)
  if (!made || !found) return null
  if (typeof found.value !== 'string' || !found.value.startsWith('new CANBus(')) return { value: String(found.value), at: found.at }
  const [name] = parts(made.at, 'arguments')
  if (!name) return { value: RIO, at: found.at }
  const named = valueAlong(name, made.chain, project)
  return typeof named?.value === 'string' ? { value: named.value, at: found.at } : null
}

/**
 * The Phoenix device a `new …(…)` builds, and the arguments that hold its ID and bus: its own (`new TalonFX(10,
 * "canivore")`), or for a project class that extends a device (`class HighlanderFalcon extends TalonFX`), the ones
 * its constructor hands on in `super(id, canbus)`, read through that `new` (`through`). Null for anything else.
 * Not followed yet: a class two steps below the device, and a constructor that calls `this(…)`.
 */
export function deviceBuilt(site: Node, project: Project): { kind: string; id?: Node; bus?: Node; through: Node[] } | null {
  const type = baseType(typeNamed(site))
  const passed = parts(site, 'arguments')
  if (type && PHOENIX_DEVICES.includes(type)) return { kind: type, id: passed[0], bus: passed[1], through: [] }
  const cls = project.classNamed(type)
  const kind = baseType(superclassName(cls))
  if (!cls || !kind || !PHOENIX_DEVICES.includes(kind)) return null
  // Constructors of this many parameters; two of one count (`(int id, double gearing)`, `(int id, String canbus)`) are
  // told apart by what the arguments work out to (a string or a number), else not at all.
  const params = (c: Node) => parts(c, 'parameters').filter((p) => p.type === 'formal_parameter')
  const fits = parts(field(cls, 'body')).filter((c) => c.type === 'constructor_declaration' && params(c).length === passed.length)
  const worksOut = (a: Node | undefined) => { const v = a && valueAlong(a, [], project)?.value; return typeof v === 'string' ? 'String' : typeof v === 'number' ? 'number' : null }
  const typed = fits.filter((c) => params(c).every((p, i) => { const k = worksOut(passed[i]); return k === null || (k === 'String') === (typeNamed(p) === 'String') }))
  const constructor = fits.length === 1 ? fits[0] : typed.length === 1 ? typed[0] : undefined
  const handOn = parts(field(constructor ?? cls, 'body')).find((c) => c.type === 'explicit_constructor_invocation' && c.text.startsWith('super'))
  if (!constructor || !handOn) return null
  const [id, bus] = parts(handOn, 'arguments')
  return { kind, id, bus, through: [site] }
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
