/**
 * The motors the robot code builds, and the log keys their currents go to: what the code at the log's commit says, for
 * the profile builder's draft. A student confirms it; nothing uses it unchecked.
 *
 * AdvantageKit logs an IO's inputs in the folder `Logger.processInputs("<folder>", inputs)` names, each field as its
 * name with a capital first letter (`pivotAmps` is `/Shooter/PivotAmps`). The IO fills the field
 * (`inputs.pivotAmps = pivotAmps.getValue()`), and following that value back reaches the motor: `pivotAmps` is
 * `pivotMotor.getStatorCurrent()` (a stator current), and `pivotMotor` is `new TalonFX(10, "canivore")` (CAN ID 10).
 * A field filled with an array (`new double[] {leader.getStatorCurrent(), follower.getStatorCurrent()}`) is one key
 * per element (`/Elevator/CurrentAmps[0]`, `[1]`), as the log reader names them.
 *
 * A folder can be built at run time. A part the code fills from an inputs field (`String.format("Swerve/%s Module",
 * inputs.prefix)`) is that field's value for each motor's IO (`constants.prefix()`, "Front Left"); a part the code can't
 * tell (`"Swerve Module " + i`) stays open, and placeInLog picks the log's folder whose logged inputs match what the
 * code gives that IO (its `ModuleNumber`). Simulation code and tests are left out.
 */
import { valueAlong, waysToReach } from '../code/check/flow.ts'
import { deviceAlong, deviceBuilt, inSimulation } from '../code/check/devices.ts'
import { classAround, enclosing, field, fileName, lineOf, modifiersOf, nameOf, parts, typeNamed, type Node } from '../code/check/java.ts'
import { baseType, type Project } from '../code/check/project.ts'
import { typeOf } from '../code/check/types.ts'
import { madeAlong } from '../code/check/flow.ts'
import { readValues, type WpilogFile } from '../readers/wpilog.ts'

export type CurrentKind = 'supply' | 'stator' | 'torque'

/**
 * A folder as the code builds it: text, an inputs field's value, a method of the IO object (`io.getModuleName()`), or a
 * part it can't tell (`*` in a pattern).
 */
export type FolderPart = string | { field: string } | { call: string } | { open: string }

export interface CodeCurrent {
  /** The folder (from processInputs) and the key below it (`PivotAmps`, `CurrentAmps[1]`). */
  folder: FolderPart[]
  leaf: string
  kind: CurrentKind
  /** Where the code reads it: "ShooterIOReal.java:21". */
  where: string
}

export interface CodeMotor {
  /** Where the code builds it ("ShooterIOReal.java:15"): one place builds one motor per IO that runs it. */
  site: string
  id: number | null
  /** As devices.ts names it: "canivore", "*", "the roboRIO bus"; null when it can't tell. */
  bus: string | null
  currents: CodeCurrent[]
  /**
   * The values its IO gives inputs fields that are fixed for that IO ("Prefix" → "Front Left", "ModuleNumber" → 0), and
   * what the IO's methods a folder calls return for it ("getModuleName()" → "Front Left").
   */
  marks: Record<string, string | number>
  /** The object that built it: its chain of calls, as a key. Two motors one IO object builds share it. */
  instance: string
  /**
   * Its group: the motors built in one place and logged in one folder as written (the four modules' drive motors,
   * `Swerve/{prefix} Module`), not one shared IO class's (an arm's and an intake's PivotIOReal). A follower joins its
   * leader's.
   */
  group: string
  /** The site of the motor it follows (`setControl(new Follower(…))`, `follow(…)`), when the code says. */
  follows?: string
}

const CURRENT_READS: Record<string, CurrentKind> = { getStatorCurrent: 'stator', getSupplyCurrent: 'supply', getTorqueCurrent: 'torque' }
/** Calls that pass a current on unchanged: a status signal's value, its refresh, a sign dropped. */
const PASS_ON = ['getValue', 'getValueAsDouble', 'refresh', 'abs']

export const isTestCode = (path: string) => /(^|\/)src\/test\//.test(path)
const label = (node: Node, project: Project) => `${fileName(project.fileOf(node).path)}:${lineOf(node)}`
/** AdvantageKit's key for an inputs field: its name with a capital first letter. */
const keyOf = (fieldName: string) => fieldName.charAt(0).toUpperCase() + fieldName.slice(1)

/** Every Talon FX the robot code builds, with the log keys its currents are read into. */
export function codeMotors(project: Project): CodeMotor[] {
  const inputs = inputsClasses(project)
  const folders = processedFolders(project, inputs)
  const filled = assignments(project, inputs)
  const motors = new Map<string, { motor: CodeMotor; chain: Node[] }>()
  const chains = new Map<Node, Node[][]>()
  const instancesOf = (site: Node) => {
    if (!chains.has(site)) chains.set(site, (waysToReach(site, project) ?? [[]]).filter((c) => !c.some(inSimulation)))
    return chains.get(site)!
  }
  // The values an IO class gives its inputs fields, for one IO object (see placeInLog).
  const marksOf = (site: Node, chain: Node[]) => {
    const cls = classAround(site)
    const marks: Record<string, string | number> = {}
    for (const a of filled) {
      if (!cls || !classAround(a.node)?.equals(cls)) continue
      const value = literalAlong(a.value, chain, project)
      if (value !== undefined) marks[keyOf(a.field)] = value
    }
    const called = new Set([...folders.values()].flat().flatMap((f) => f.folder.flatMap((p) => (typeof p === 'object' && 'call' in p ? [p.call] : []))))
    for (const method of called) {
      const [declared] = project.membersNamed(cls, 'method', method).filter((m) => parts(m, 'parameters').length === 0)
      const returns = declared?.descendantsOfType('return_statement') ?? []
      const value = returns.length === 1 && returns[0] ? literalAlong(parts(returns[0])[0] ?? null, chain, project) : undefined
      if (value !== undefined) marks[`${method}()`] = value
    }
    return marks
  }
  const motorAt = (site: Node, chain: Node[]) => {
    // Keyed by place in the file, not line: two IOs can be built on one line.
    const at = (n: Node) => `${project.fileOf(n).path}@${n.startIndex}`
    const instance = chain.map(at).join(' < ')
    const key = `${at(site)} | ${instance}`
    if (!motors.has(key)) {
      const device = deviceAlong(site, chain, project)
      const motor = { site: label(site, project), id: device?.id ?? null, bus: device?.bus ?? null, currents: [], marks: marksOf(site, chain), instance, group: '' }
      motors.set(key, { motor, chain })
    }
    return motors.get(key)!
  }

  // Every Talon FX built on the robot, read into a log key or not (2024's elevator follower logs nothing).
  for (const site of project.nodes('object_creation_expression')) {
    if (deviceBuilt(site, project)?.kind !== 'TalonFX' || isTestCode(project.fileOf(site).path) || inSimulation(site)) continue
    for (const chain of instancesOf(site)) motorAt(site, chain)
  }
  for (const a of filled) {
    for (const read of currentReads(a.value, project)) {
      const site = madeAlong(read.receiver, [], project)?.at
      if (!site || deviceBuilt(site, project)?.kind !== 'TalonFX' || isTestCode(project.fileOf(site).path)) continue
      for (const chain of instancesOf(site)) {
        const { motor } = motorAt(site, chain)
        const leaf = `${keyOf(a.field)}${read.index === undefined ? '' : `[${read.index}]`}`
        for (const folder of foldersFor(folders.get(a.inputs) ?? [], chain)) {
          motor.currents.push({ folder, leaf, kind: read.kind, where: label(read.at, project) })
        }
      }
    }
  }
  const all = [...motors.values()].map((m) => m.motor)
  for (const m of all) m.group = `${m.site} ${JSON.stringify([...new Set(m.currents.map((c) => JSON.stringify(c.folder)))].sort())}`
  followers(project, all)
  return all
}

/** A number or a string the code gives, never an object it builds (its code isn't what the log holds). */
function literalAlong(expr: Node | null, chain: Node[], project: Project): string | number | undefined {
  const found = valueAlong(expr, chain, project)
  return found && found.at.type !== 'object_creation_expression' ? found.value : undefined
}

/** The inputs classes (annotated @AutoLog), by the names the code uses for them: `ShooterIOInputs` and `…AutoLogged`. */
function inputsClasses(project: Project): Map<string, string> {
  const names = new Map<string, string>()
  for (const cls of project.nodes('class_declaration')) {
    const modifiers = parts(cls).find((c) => c.type === 'modifiers')
    const name = nameOf(cls)
    if (!name || !modifiers?.text.includes('@AutoLog')) continue
    names.set(name, name)
    names.set(`${name}AutoLogged`, name)
  }
  return names
}

/** The inputs class of a value: its declared type, or an array's element type (`inputs[i]`). */
function inputsTypeOf(node: Node | null, project: Project, inputs: Map<string, string>): string | null {
  if (!node) return null
  const type = node.type === 'array_access' ? typeOf(field(node, 'array'), project)?.replace(/\[\]$/, '') : typeOf(node, project)
  return (type && inputs.get(type)) ?? null
}

/**
 * One folder an inputs class is logged in: the chains of calls that reach its processInputs, and the IO objects whose
 * `io.updateInputs(inputs)` fills the inputs it logs (the `new ModuleIOReal(…)` each Module is built with).
 */
interface Folder { folder: FolderPart[]; chains: Node[][]; ios: Node[] }

/** Each inputs class's folders: one per processInputs call and chain of calls that reaches it. */
function processedFolders(project: Project, inputs: Map<string, string>): Map<string, Folder[]> {
  const out = new Map<string, Folder[]>()
  for (const call of project.nodes('method_invocation')) {
    const [folderExpr, inputsExpr] = parts(call, 'arguments')
    if (nameOf(call) !== 'processInputs' || !folderExpr || !inputsExpr) continue
    const cls = inputsTypeOf(inputsExpr, project, inputs)
    if (!cls) continue
    const list = out.get(cls) ?? []
    // The calls in this class that fill these inputs: `io.updateInputs(inputs)`.
    const fills = (classAround(call)?.descendantsOfType('method_invocation') ?? []).filter((u): u is Node => !!u && nameOf(u) === 'updateInputs' && parts(u, 'arguments')[0]?.text === inputsExpr.text)
    for (const chain of instanceChains(call, project)) {
      const folder = folderOf(folderExpr, chain, project, inputs)
      const ios = fills.flatMap((u) => { const io = madeAlong(field(u, 'object'), chain, project)?.at; return io?.type === 'object_creation_expression' ? [io] : [] })
      const same = list.find((f) => JSON.stringify(f.folder) === JSON.stringify(folder))
      if (same) { same.chains.push(chain); same.ios.push(...ios) } else list.push({ folder, chains: [chain], ios })
    }
    out.set(cls, list)
  }
  return out
}

/**
 * The chains of calls that reach this code, as waysToReach gives them, except that a method nothing in the project calls
 * (`periodic()`, which the scheduler runs) runs once for each object of its class: then the chains that reach its
 * constructors, a subclass's `super(…)` included. RollerSubsystem's `processInputs(name, inputs)` is "Funnel" for one
 * and "Manipulator" for the other. A class with no constructor written keeps waysToReach's answer.
 */
function instanceChains(node: Node, project: Project): Node[][] {
  const chains = (waysToReach(node, project) ?? [[]]).filter((c) => !c.some(inSimulation))
  const method = enclosing(node, ['method_declaration'])
  if (chains.length !== 1 || chains[0].length > 0 || !method || modifiersOf(method).includes('static')) return chains
  // Each constructor's callers: `new RollerSubsystem(…)`, or a subclass's `super(io, NAME)` and what builds that.
  const cls = classAround(method)
  const constructors = parts(cls && field(cls, 'body')).filter((c) => c.type === 'constructor_declaration')
  const reached = constructors.flatMap((c) => (waysToReach(field(c, 'body') ?? c, project) ?? []).filter((chain) => chain.length && !chain.some(inSimulation)))
  return reached.length ? reached : chains
}

/** A folder expression as parts: text the code says, inputs fields, and open parts. */
function folderOf(expr: Node, chain: Node[], project: Project, inputs: Map<string, string>): FolderPart[] {
  const join = (a: FolderPart[], b: FolderPart[]) => {
    const out = [...a]
    for (const p of b) typeof p === 'string' && typeof out.at(-1) === 'string' ? (out[out.length - 1] += p) : out.push(p)
    return out
  }
  if (expr.type === 'binary_expression' && field(expr, 'operator')?.type === '+') {
    return join(folderOf(field(expr, 'left')!, chain, project, inputs), folderOf(field(expr, 'right')!, chain, project, inputs))
  }
  if (expr.type === 'method_invocation' && nameOf(expr) === 'format' && field(expr, 'object')?.text === 'String') {
    const [format, ...args] = parts(expr, 'arguments')
    const pattern = format ? valueAlong(format, chain, project)?.value : undefined
    if (typeof pattern !== 'string') return [{ open: expr.text }]
    const pieces = pattern.split(/%[sd]/)
    return pieces.reduce<FolderPart[]>((acc, piece, i) => join(join(acc, [piece]), i < args.length && i < pieces.length - 1 ? folderOf(args[i], chain, project, inputs) : []), [])
  }
  // new StringBuilder("Swerve/").append(inputs.prefix).append(" Module").toString()
  if (expr.type === 'method_invocation' && nameOf(expr) === 'toString') {
    const pieces: Node[] = []
    let at: Node | null = field(expr, 'object')
    for (; at?.type === 'method_invocation' && nameOf(at) === 'append'; at = field(at, 'object')) pieces.unshift(parts(at, 'arguments')[0]!)
    if (at?.type === 'object_creation_expression' && baseType(typeNamed(at)) === 'StringBuilder') {
      const start = parts(at, 'arguments')[0]
      return [...(start ? [start] : []), ...pieces].reduce<FolderPart[]>((acc, piece) => join(acc, folderOf(piece, chain, project, inputs)), [])
    }
  }
  if (expr.type === 'field_access' && inputsTypeOf(field(expr, 'object'), project, inputs)) return [{ field: field(expr, 'field')!.text }]
  // `io.getModuleName()`: a method of a project class or interface, answered by each IO object (marks).
  const receiver = expr.type === 'method_invocation' && parts(expr, 'arguments').length === 0 ? field(expr, 'object') : null
  if (receiver && project.ownersNamed(typeOf(receiver, project)).length) return [{ call: nameOf(expr)! }]
  const value = valueAlong(expr, chain, project)?.value
  return value === undefined ? [{ open: expr.text }] : [String(value)]
}

/** `inputs.field = value` in an IO's code: the inputs class, the field and the value. Simulation and tests left out. */
function assignments(project: Project, inputs: Map<string, string>): { node: Node; inputs: string; field: string; value: Node }[] {
  return project.nodes('assignment_expression').flatMap((node) => {
    const target = field(node, 'left')
    const value = field(node, 'right')
    const cls = target?.type === 'field_access' ? inputsTypeOf(field(target, 'object'), project, inputs) : null
    const name = target && field(target, 'field')?.text
    if (!cls || !name || !value || inSimulation(node) || isTestCode(project.fileOf(node).path)) return []
    return [{ node, inputs: cls, field: name, value }]
  })
}

/** The motor currents a value reads: one, or one per element of an array (`new double[] {a, b}`). */
function currentReads(value: Node, project: Project): { index?: number; kind: CurrentKind; receiver: Node; at: Node }[] {
  const initializer = value.type === 'array_creation_expression' ? field(value, 'value') : null
  if (initializer) return parts(initializer).flatMap((element, index) => currentRead(element, project).map((r) => ({ ...r, index })))
  return currentRead(value, project)
}

/**
 * `motor.getStatorCurrent()`, through what passes it on unchanged (`.getValueAsDouble()`, `Math.abs(…)`) and the one
 * value a name is given (`pivotAmps`, a status signal field). The motor is the call's receiver.
 */
function currentRead(value: Node | null, project: Project, steps = 0): { kind: CurrentKind; receiver: Node; at: Node }[] {
  if (!value || steps > 6) return []
  if (value.type === 'parenthesized_expression') return currentRead(parts(value)[0] ?? null, project, steps + 1)
  if (value.type === 'method_invocation') {
    const name = nameOf(value) ?? ''
    const receiver = field(value, 'object')
    if (CURRENT_READS[name] && receiver) return [{ kind: CURRENT_READS[name], receiver, at: value }]
    if (!PASS_ON.includes(name)) return []
    return currentRead(name === 'abs' ? parts(value, 'arguments')[0] ?? null : receiver, project, steps + 1)
  }
  if (value.type !== 'identifier' && value.type !== 'field_access') return []
  // A name: the one value the code gives it. madeAlong stops at a call it can't see through, which is the read itself.
  const given = onlyValue(value, project)
  return given ? currentRead(given, project, steps + 1) : []
}

/** The one expression a local or field is given (its start, or a single assignment), or null. */
function onlyValue(name: Node, project: Project): Node | null {
  const text = name.type === 'identifier' ? name.text : field(name, 'object')?.type === 'this' ? field(name, 'field')?.text : null
  const cls = classAround(name)
  if (!text || !cls) return null
  const declarators = project.fieldsNamed(text).filter((d) => classAround(d)?.equals(cls))
  const locals = name.type === 'identifier' ? localDeclarators(name, text) : []
  const declared = locals[0] ?? (declarators.length === 1 ? declarators[0] : null)
  if (!declared) return null
  const scope = locals[0] ? (declared.parent?.parent ?? cls) : cls
  const writes = scope.descendantsOfType('assignment_expression').filter((a) => {
    const t = a && field(a, 'left')
    return t && (t.text === text || t.text === `this.${text}`)
  })
  const values = [field(declared, 'value'), ...writes.map((w) => field(w!, 'right'))].filter((v): v is Node => !!v)
  return values.length === 1 ? values[0] : null
}

/** Local declarators of this name before the use, in the method it is in. */
function localDeclarators(use: Node, name: string): Node[] {
  const method = use.parent && (function up(n: Node | null): Node | null { return !n ? null : ['method_declaration', 'constructor_declaration'].includes(n.type) ? n : up(n.parent) })(use.parent)
  if (!method) return []
  return method.descendantsOfType('variable_declarator').filter((d): d is Node => !!d && nameOf(d) === name && d.startIndex < use.startIndex)
}

/**
 * The folder this motor's IO logs into. First the folder whose `updateInputs` is called on this motor's IO object; else
 * the one folder, or the one whose chain of calls meets the motor's closest in (a Module built around this IO, not just
 * the SwerveSubsystem every module shares). Several equally close: none, rather than a guess that gives one motor
 * another's ID.
 */
function foldersFor(folders: Folder[], chain: Node[]): FolderPart[][] {
  const filled = folders.filter((f) => f.ios.some((io) => chain.some((c) => c.equals(io))))
  if (filled.length) return filled.map((f) => f.folder)
  if (folders.length <= 1) return folders.map((f) => f.folder)
  const within = (x: Node, y: Node) => x.equals(y) || (x.tree === y.tree && x.startIndex >= y.startIndex && x.endIndex <= y.endIndex)
  const depth = (f: Folder) => Math.min(...f.chains.map((c) => { const i = c.findIndex((y) => chain.some((x) => within(x, y))); return i < 0 ? Infinity : i }))
  const best = Math.min(...folders.map(depth))
  const closest = folders.filter((f) => depth(f) === best)
  return best < Infinity && closest.length === 1 ? [closest[0].folder] : []
}

/**
 * Leaders and followers: `follower.setControl(new Follower(leader.getDeviceID(), …))` or `new Follower(10, …)` (Phoenix
 * 6), `follower.follow(leader)` or `follower.set(ControlMode.Follower, 25)` (Phoenix 5). A follower joins its leader's
 * group; leader and follower are paired within one IO object. No code we have uses `follow(…)` or StrictFollower:
 * no data covers those two.
 */
function followers(project: Project, motors: CodeMotor[]): void {
  const at = (expr: Node | null) => {
    const site = madeAlong(expr, [], project)?.at
    return site ? motors.filter((m) => m.site === label(site, project)) : []
  }
  for (const call of project.nodes('method_invocation')) {
    const name = nameOf(call)
    const passed = parts(call, 'arguments')
    const follower = at(field(call, 'object'))
    if (!follower.length || !['setControl', 'follow', 'set'].includes(name ?? '')) continue
    let leaders: CodeMotor[] = []
    let id: unknown
    if (name === 'follow') leaders = at(passed[0] ?? null)
    else if (name === 'set' && /ControlMode\.Follower$/.test(passed[0]?.text ?? '')) id = valueAlong(passed[1] ?? null, [], project)?.value
    else if (name === 'setControl' && passed[0]?.type === 'object_creation_expression' && /^(Strict)?Follower$/.test(baseType(typeNamed(passed[0])) ?? '')) {
      const leader = parts(passed[0], 'arguments')[0] ?? null
      if (leader?.type === 'method_invocation' && nameOf(leader) === 'getDeviceID') leaders = at(field(leader, 'object'))
      else id = valueAlong(leader, [], project)?.value
    }
    if (id !== undefined) leaders = motors.filter((m) => m.id === id)
    for (const f of follower) {
      const mine = leaders.filter((l) => l.instance === f.instance)
      const leader = mine.length === 1 ? mine[0] : leaders.length === 1 ? leaders[0] : null
      if (!leader || leader === f) continue
      f.follows = leader.site
      f.group = leader.group
    }
  }
}

/** A code motor's current key once its folder is known: `/Swerve/Front Left Module/DriveCurrentAmps[0]`. */
export interface PlacedCurrent extends CodeCurrent { key: string }

/**
 * The code's keys in this log. A folder with parts from inputs fields takes this motor's values for them; one with
 * open parts is matched to the log's folders, and the one whose logged inputs agree with the motor's marks (its
 * `ModuleNumber`, its `Prefix`) is taken. A key the log doesn't have, or a folder that two log folders fit, is left out.
 */
export function placeInLog(motor: CodeMotor, log: WpilogFile): PlacedCurrent[] {
  return motor.currents.flatMap((c) => {
    const markOf = (p: Exclude<FolderPart, string>) => ('field' in p ? motor.marks[keyOf(p.field)] : 'call' in p ? motor.marks[`${p.call}()`] : undefined)
    const parts = c.folder.map((p) => (typeof p === 'string' ? p : markOf(p) !== undefined ? String(markOf(p)) : p))
    const fixed = parts.every((p) => typeof p === 'string')
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^/${parts.map((p) => (typeof p === 'string' ? escape(p) : '([^/]+)')).join('')}/${escape(c.leaf)}$`)
    const leafEntry = c.leaf.replace(/\[\d+\]$/, '')
    const candidates = fixed
      ? [`/${parts.join('')}/${c.leaf}`]
      : [...log.entries.keys()].filter((k) => pattern.test(`${k.slice(0, k.length - leafEntry.length)}${c.leaf}`) && k.endsWith(`/${leafEntry}`)).map((k) => `${k.slice(0, k.length - leafEntry.length)}${c.leaf}`)
    const present = candidates.filter((k) => log.entries.has(k.replace(/\[\d+\]$/, '')))
    const agree = present.filter((k) => {
      const folder = k.slice(0, k.lastIndexOf('/'))
      return Object.entries(motor.marks).every(([mark, value]) => {
        const logged = readValues<unknown>(log, `${folder}/${mark}`)?.v[0]
        return logged === undefined || String(logged) === String(value)
      })
    })
    return agree.length === 1 ? [{ ...c, key: agree[0] }] : []
  })
}
