/**
 * Are two CAN devices of one kind given the same ID on the same bus?
 *
 * Checks: every `new TalonFX(id, bus)`, `new CANcoder(…)` and `new Pigeon2(…)`, with the ID and bus followed back to
 * where they are written (flow.ts): through constants, fields set once, and the parameters of constructors and
 * methods, along each chain of calls that builds the device (`new FollowerIO(16, …)`, `ShooterIO.create()`). Two of one kind with one ID on one bus is a finding, unless they are in
 * different arms of one `if`, `? :` or `switch` (sim or real, ALPHA or COMP robot: only one is built), or their ID is
 * the same written number reached two ways (whether one class is built twice isn't judged: no bug so far was). A TalonFX and a
 * CANcoder may share an ID (CTRE IDs are per kind of device). The bus `"*"` (any CANivore) counts as the project's
 * one named CANivore when it has exactly one. An ID or bus it can't follow is listed as not judged.
 * Why: 2026-Offseason-Robot fd8fa0d and 427d98e, Rebuilt 505d4f1, 39dec94 and f7edbfe, and Charged-Up-Offseason-Training
 * 141b8cd each fixed devices built with an ID another device already had.
 */
import { lineOf, parts, typeNamed, type Node } from '../java.ts'
import { canBothHappen, valueAlong, waysToReach } from '../flow.ts'
import { baseType, type Project } from '../project.ts'
import { codeRule, type CodeProblem } from '../rule.ts'

const DEVICES = ['TalonFX', 'CANcoder', 'Pigeon2']
const RIO = 'the roboRIO bus'
const ANY_CANIVORE = '*'

export default codeRule({
  id: 'code/duplicate-can-id',
  title: 'Two CAN devices with one ID',
  meaning: 'Two devices of the same kind on one CAN bus share an ID. Only one of them can answer: the other reads as disconnected, or both motors follow one set of commands.',
  nextStep: 'Give each device its own ID (Phoenix Tuner X shows the IDs on the robot), and change the code to match.',
  incident: '2026-Offseason-Robot 427d98e: three flywheel followers all built with ID 0',

  check(project) {
    const devices = project.nodes('object_creation_expression').flatMap((site) => devicesBuiltAt(site, project))
    return [...byIdAndBus(devices)].flatMap(([key, group]) => clash(key, group, project))
  },
})

interface Device {
  kind: string
  id: number
  bus: string
  /** Where the ID is written: the line to change. */
  at: Node
  /** Everywhere the ID and bus passed through to get here, to tell whether two devices can both be built. */
  path: Node[]
}

/** The devices one `new TalonFX(…)` builds: one for each chain of calls that reaches it. Ones it can't follow aren't judged. */
function devicesBuiltAt(site: Node, project: Project): Device[] {
  const kind = baseType(typeNamed(site))
  const [idArgument, busArgument] = parts(site, 'arguments')
  if (!kind || !DEVICES.includes(kind) || !idArgument) return []
  const devices = waysToReach(site, project).map((chain) => {
    const id = valueAlong(idArgument, chain, project)
    const bus = busArgument ? valueAlong(busArgument, chain, project) : { value: RIO, at: site }
    if (!id || !bus || typeof id.value !== 'number') return null
    return { kind, id: id.value, bus: busName(bus.value), at: id.at, path: [id.at, bus.at, site, ...chain] }
  })
  if (devices.includes(null)) project.couldNotJudge(`can't work out the ID or bus of this ${kind}`, site)
  return devices.filter((d) => d !== null)
}

/** Devices grouped by kind, ID and bus, keyed by how a message says it ("TalonFX 15 on the CANivore ("*")"). */
function byIdAndBus(devices: Device[]): Map<string, Device[]> {
  const named = new Set(devices.map((d) => d.bus).filter((b) => b !== RIO && b !== ANY_CANIVORE))
  const onlyCanivore = named.size === 1 ? [...named][0] : null
  const groups = new Map<string, Device[]>()
  for (const d of devices) {
    const bus = d.bus === ANY_CANIVORE && onlyCanivore ? onlyCanivore : d.bus
    const key = `${d.kind} ${d.id} on ${busLabel(bus)}`
    groups.set(key, [...(groups.get(key) ?? []), d])
  }
  return groups
}

function busLabel(bus: string): string {
  if (bus === ANY_CANIVORE) return 'the CANivore ("*")'
  if (bus === RIO) return bus
  return `"${bus}"`
}

/** A finding at each device in a group that another one in it can be built with: each line to change gets one. */
function clash(key: string, group: Device[], project: Project): CodeProblem[] {
  const where = (d: Device) => `${project.fileOf(d.at).path.split('/').pop()}:${lineOf(d.at)}`
  const together = (a: Device, b: Device) => !a.at.equals(b.at) && canBothHappen(a.path, b.path)
  const said = new Set<number>()
  return group.flatMap((device) => {
    const others = [...new Set(group.filter((other) => together(device, other)).map(where))]
    if (others.length === 0 || said.has(device.at.id)) return []
    said.add(device.at.id)
    return [{ message: `${key} is also built at ${others.join(', ')}`, at: device.at }]
  })
}

/** A bus as a name: "canivore", "*", or the roboRIO's own bus for "", "rio" and `new CANBus()`. */
function busName(value: number | string): string {
  const text = String(value)
  const named = /^new CANBus\(\s*"([^"]*)"/.exec(text)?.[1] ?? (text.startsWith('new CANBus(') ? '' : text)
  return named === '' || named === 'rio' ? RIO : named
}
