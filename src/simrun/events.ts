/**
 * What happened in one sim run, read from the harness's output (tools/sim-run/SimRunHarness.java): the robot modes
 * the timeline set, every command start, finish and interrupt, and every line the robot printed, each at the robot
 * time it happened.
 */

export type Mode = 'disabled' | 'auto' | 'teleop' | 'test'

export interface CommandRef {
  /** Java's identity hash: the same command object keeps it for the whole run. */
  id: string
  name: string
  requirements: string[]
  isDefault: boolean
  /** "trigger" (a button or trigger binding), else the first stack frame in team code, else ''. */
  origin: string
}

export interface CommandEvent { t: number; kind: 'init' | 'finish' | 'interrupt'; command: CommandRef; by: CommandRef | null }

/** A line the robot printed. `native` lines came from C++ (the HAL, Phoenix) and carry the last time seen before them. */
export interface ConsoleLine { t: number; stream: 'out' | 'err' | 'native'; text: string }

export interface Chooser { key: string; options: string[]; defaultOption: string }

/** A stretch in one robot mode, from the timeline step that set it to the next one (or the end of the run). */
export interface Period { mode: Mode; start: number; end: number }

export interface RunRecord {
  /** Robot time the robot program finished starting; null when it never did (it crashed while starting). */
  started: number | null
  /** The timeline reached its end. False: the robot program stopped (or was stopped) first. */
  ended: boolean
  /** Robot time of the last line read. */
  last: number
  harnessError: string | null
  /** Why no log was recorded (an old WPILib), or null. */
  noLog: string | null
  /** Each timeline line as it was played, with the time. */
  steps: { t: number; line: string }[]
  commands: CommandEvent[]
  console: ConsoleLine[]
  choosers: Chooser[]
  periods: Period[]
}

/** One command's life: from its start to its finish, its interrupt, or the end of the run. */
export interface Lifetime { command: CommandRef; start: number; end: number; how: 'finished' | 'interrupted' | 'running'; by: CommandRef | null }

const PREFIX = '[sim-run]\t'

export function readRun(output: string): RunRecord {
  const run: RunRecord = { started: null, ended: false, last: 0, harnessError: null, noLog: null, steps: [], commands: [], console: [], choosers: [], periods: [] }
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(PREFIX)) {
      if (line.trim()) run.console.push({ t: run.last, stream: 'native', text: line })
      continue
    }
    const [time, kind, ...fields] = line.slice(PREFIX.length).split('\t')
    const t = Number(time)
    run.last = t
    if (kind === 'out' || kind === 'err') run.console.push({ t, stream: kind, text: fields.join('\t') })
    else if (kind === 'init' || kind === 'finish' || kind === 'interrupt') run.commands.push({ t, kind, command: commandRef(fields[0]), by: fields[1] ? commandRef(fields[1]) : null })
    else if (kind === 'step') run.steps.push({ t, line: fields[0] })
    else if (kind === 'chooser') run.choosers.push({ key: fields[0], options: fields[1] ? fields[1].split('|') : [], defaultOption: fields[2] ?? '' })
    else if (kind === 'started') run.started = t
    else if (kind === 'end') run.ended = true
    else if (kind === 'harness-error') run.harnessError = fields[0]
    else if (kind === 'no-log') run.noLog = fields[0]
  }
  run.periods = periodsOf(run)
  return run
}

function commandRef(field: string): CommandRef {
  const [id, name, requirements, isDefault, origin] = field.split('|')
  return { id, name, requirements: requirements ? requirements.split(',') : [], isDefault: isDefault === 'default', origin: origin ?? '' }
}

function periodsOf(run: RunRecord): Period[] {
  const changes = run.steps.flatMap((s) => {
    const mode = /^\S+ mode (\w+)/.exec(s.line)?.[1] as Mode | undefined
    return mode ? [{ mode, t: s.t }] : []
  })
  return changes.map((c, i) => ({ mode: c.mode, start: c.t, end: changes[i + 1]?.t ?? run.last }))
}

export const isEnabled = (p: Period) => p.mode !== 'disabled'

/** Every command's life in the run, in start order. */
export function lifetimes(run: RunRecord): Lifetime[] {
  const open = new Map<string, Lifetime>()
  const all: Lifetime[] = []
  for (const e of run.commands) {
    if (e.kind === 'init') {
      const life: Lifetime = { command: e.command, start: e.t, end: run.last, how: 'running', by: null }
      open.set(e.command.id, life)
      all.push(life)
      continue
    }
    const life = open.get(e.command.id)
    if (!life) continue
    open.delete(e.command.id)
    life.end = e.t
    life.how = e.kind === 'finish' ? 'finished' : 'interrupted'
    life.by = e.by
  }
  return all
}

/** The same command across runs (ids differ between runs): its name and what it needs. */
export const signature = (c: CommandRef) => `${c.name} [${c.requirements.join(', ')}]`

/** "ParallelCommandGroup (needs Drum, Intake)", as the report says a command. */
export function describeCommand(c: CommandRef): string {
  return c.requirements.length ? `${c.name} (needs ${c.requirements.join(', ')})` : `${c.name} (needs no subsystem)`
}

/** When a line the timeline played with a marker ("#p2") was played, or null if it never was. */
export function markerTime(run: RunRecord, marker: string): number | null {
  return run.steps.find((s) => s.line.split(/\s+/).includes(marker))?.t ?? null
}

export function periodAt(run: RunRecord, t: number): Period | undefined {
  return run.periods.find((p) => t >= p.start && t < p.end)
}
