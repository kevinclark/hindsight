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
 * A simulation class gets no pass of its own: only the arms decide. A `…IOSim` built on the robot still builds a real
 * device on the bus, and two sim IOs built in one run clash in simulation (Rebuilt 3eca5e5).
 * Why: 2026-Offseason-Robot fd8fa0d and 427d98e, Rebuilt 505d4f1, 39dec94 and f7edbfe, and Charged-Up-Offseason-Training
 * 141b8cd each fixed devices built with an ID another device already had.
 */
import { fileName, lineOf, parts, typeNamed, type Node } from '../java.ts'
import { deviceAlong, deviceBuilt, type Device } from '../devices.ts'
import { ANY_CANIVORE, RIO } from '../bus-names.ts'
import { canBothHappen, waysToReach } from '../flow.ts'
import { baseType, type Project } from '../project.ts'
import { codeRule, type CodeProblem } from '../rule.ts'
import { groupBy } from '../../../rules/run.ts'

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

/** The devices one `new TalonFX(…)` builds: one for each chain of calls that reaches it. Ones it can't follow aren't judged. */
function devicesBuiltAt(site: Node, project: Project): Device[] {
  const kind = deviceBuilt(site, project)?.kind
  if (!kind || parts(site, 'arguments').length === 0) return []
  const ways = waysToReach(site, project)
  if (!ways) {
    project.couldNotJudge(`this ${kind} is built along too many paths to follow`, site)
    return []
  }
  const devices = ways.map((chain) => deviceAlong(site, chain, project))
  if (devices.includes(null)) project.couldNotJudge(`can't work out the ID or bus of this ${kind}`, site)
  return devices.filter((d) => d !== null)
}

/** Devices grouped by kind, ID and bus, keyed by how a message says it ("TalonFX 15 on the CANivore ("*")"). */
function byIdAndBus(devices: Device[]): Map<string, Device[]> {
  const named = new Set(devices.map((d) => d.bus).filter((b) => b !== RIO && b !== ANY_CANIVORE))
  const onlyCanivore = named.size === 1 ? [...named][0] : null
  const busOf = (d: Device) => (d.bus === ANY_CANIVORE && onlyCanivore ? onlyCanivore : d.bus)
  return groupBy(devices, (d) => `${d.kind} ${d.id} on ${busLabel(busOf(d))}`)
}

function busLabel(bus: string): string {
  if (bus === ANY_CANIVORE) return 'the CANivore ("*")'
  if (bus === RIO) return bus
  return `"${bus}"`
}

/** A finding at each device in a group that another one in it can be built with: each line to change gets one. */
function clash(key: string, group: Device[], project: Project): CodeProblem[] {
  const where = (d: Device) => `${fileName(project.fileOf(d.at).path)}:${lineOf(d.at)}`
  const together = (a: Device, b: Device) => !a.at.equals(b.at) && canBothHappen(a.path, b.path)
  const said = new Set<number>()
  return group.flatMap((device) => {
    const others = [...new Set(group.filter((other) => together(device, other)).map(where))]
    if (others.length === 0 || said.has(device.at.id)) return []
    said.add(device.at.id)
    return [{ message: `${key} is also built at ${others.join(', ')}`, at: device.at }]
  })
}
