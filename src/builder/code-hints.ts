/**
 * Hints from a team's robot-code folder: where the code builds each Talon FX, with the CAN ID it passes. Hints only:
 * the ID usually reaches the subsystem that logs the motor through two or three files, so no single line proves which
 * log key a constructor is. They label the CAN ID choices in the builder ("15: Shooter.java:45, FLYWHEEL_LEADER_ID").
 *
 * The code is read by the code check's Java parser (code/check/), which follows an ID back to where it is written:
 * through constants, and through the constructors and methods it is passed to (`new FollowerIO(16, …)`). Call
 * loadJava first. Read only, in the browser: the folder's files are never changed or uploaded. The text comes from
 * the folder's working tree (uncommitted edits count) or from GitHub at one commit; the commit and branch from
 * `codeHead`.
 */
import { GitUnreadable, type GitRepo } from '../code/git.ts'
import { javaFilesAt, type CodeSource } from '../code/source.ts'
import { valueAlong, waysToReach } from '../code/check/flow.ts'
import { inSimulation } from '../code/check/devices.ts'
import { codeOf, fileName, lineOf, parts, typeNamed, type Node } from '../code/check/java.ts'
import { baseType, Project } from '../code/check/project.ts'

export interface CodeFile { path: string; text: string }

export interface TalonSite {
  /** The CAN ID, when it is a number or a constant found in the folder, or what the call that builds the class passed. */
  id: number | null
  /** What the code passes: "15" or "FLYWHEEL_LEADER_ID" (or a parameter, "motorID", when a call passes the ID). */
  expr: string
  /** The bus argument as written, if any ("canivore", "kCANBus"). */
  bus: string | null
  file: string
  line: number
}

export interface CodeHints {
  sites: TalonSite[]
  /** The commit the folder is on (from .git), if it could be read. */
  sha: string | null
  branch: string | null
  notes: string[]
}

/** The commit the code is on and its branch (null when detached), or why that can't be told. */
export type CodeHead = { sha: string; branch: string | null } | { why: string }

export function codeHints(files: CodeFile[], head: CodeHead): CodeHints {
  const sites = talonSites(files.filter((f) => f.path.endsWith('.java')))
  const notes: string[] = []
  if (sites.length === 0) notes.push('No `new TalonFX(...)` in the folder\'s Java files.')
  const git = 'why' in head ? { sha: null, branch: null, notes: [head.why] } : { ...head, notes: [] }
  return { sites: sites.sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9) || a.file.localeCompare(b.file)), ...git, notes: [...notes, ...git.notes] }
}

/** Every `new TalonFX(…)` in these Java files, with its IDs. */
function talonSites(java: CodeFile[]): TalonSite[] {
  const project = new Project(java)
  try {
    const talons = project.nodes('object_creation_expression').filter((n) => baseType(typeNamed(n)) === 'TalonFX')
    return talons.flatMap((talon) => sitesOf(talon, project))
  } finally {
    project.close()
  }
}

/**
 * One `new TalonFX(…)`, with each ID it is built with: one per chain of calls that reaches it (`new FollowerIO(16, …)`
 * and `new FollowerIO(17, …)` both reach FollowerIO's), or no ID when a chain's can't be worked out. Chains through
 * simulation code are left out (see inSimulation). Code nothing builds, or that is reached too many ways to follow,
 * still gets the IDs written as constants.
 * Not followed yet: `this(…)` calls, and a `? :` choosing the ID. A call is matched to a constructor by its number of
 * arguments only.
 */
function sitesOf(talon: Node, project: Project): TalonSite[] {
  const [idArgument, busArgument] = parts(talon, 'arguments')
  if (!idArgument) return []
  const onRobot = (waysToReach(talon, project) ?? []).filter((chain) => !chain.some(inSimulation))
  // Nothing on the robot builds it (or too many ways do): read the ID as written, with no call to look through.
  const chains = onRobot.length ? onRobot : [[]]
  const ids = chains.map((chain) => valueAlong(idArgument, chain, project)?.value)
  const each = [...new Set(ids.map((id) => (typeof id === 'number' ? id : null)))]
  const bus = busArgument ? codeOf(busArgument) : null
  const where = { expr: codeOf(idArgument), bus, file: project.fileOf(talon).path, line: lineOf(talon) }
  return each.map((id) => ({ id, ...where }))
}

/** Hints from the code at a branch or commit (GitHub): every Java file's text at that commit. */
export async function hintsAt(source: CodeSource, ref: string): Promise<CodeHints> {
  const sha = await source.resolve(ref)
  return codeHints(await javaFilesAt(source, sha), { sha, branch: branchOf(sha, ref) })
}

/** The commit a branch or hash names (GitHub), or why it can't be told. */
export async function headAt(source: CodeSource, ref: string): Promise<CodeHead> {
  try {
    const sha = await source.resolve(ref)
    return { sha, branch: branchOf(sha, ref) }
  } catch (error) {
    if (!(error instanceof GitUnreadable)) throw error
    return { why: sentence(error.message) }
  }
}

/** The branch typed, or null when a hash was typed. */
const branchOf = (sha: string, ref: string) => (sha.startsWith(ref.trim().toLowerCase()) ? null : ref.trim())
/** "couldn't find x" → "Couldn't find x.", as the builder's notes read. */
const sentence = (message: string) => `${message[0].toUpperCase()}${message.slice(1)}.`

/** The commit a code folder's .git is on (null: the folder has no .git). */
export async function codeHead(repo: GitRepo | null): Promise<CodeHead> {
  if (!repo) return { why: 'No .git folder: can\'t tell which commit this code is.' }
  try {
    return await repo.head()
  } catch (error) {
    if (!(error instanceof GitUnreadable)) throw error
    return { why: sentence(error.message) }
  }
}

/** A warning when the code folder isn't the commit the log ran (the log's GitSHA may be short). */
export function shaWarning(hints: CodeHints, logSha: string): string | null {
  if (!hints.sha || !logSha) return null
  const a = hints.sha.toLowerCase(), b = logSha.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (b.length >= 7 && (a.startsWith(b) || b.startsWith(a))) return null
  return `This code is on ${hints.branch ?? 'a detached commit'} ${hints.sha.slice(0, 7)}, but the log ran ${logSha.slice(0, 7)}: CAN IDs may have changed.`
}

export const siteLabel = (s: TalonSite) => `${fileName(s.file)}:${s.line}${/^\d+$/.test(s.expr) ? '' : ` (${s.expr})`}`
