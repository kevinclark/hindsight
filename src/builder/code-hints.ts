/**
 * Hints from a team's robot-code folder: where the code builds each Talon FX, with the CAN ID it passes. Hints only:
 * the ID usually reaches the subsystem that logs the motor through two or three files, so no single line proves which
 * log key a constructor is. They label the CAN ID choices in the builder ("15: Shooter.java:45, FLYWHEEL_LEADER_ID").
 *
 * Read only, in the browser: the folder's files are never changed or uploaded. The text comes from the folder's
 * working tree (uncommitted edits count) or from GitHub at one commit; the commit and branch from `codeHead`.
 */
import { GitUnreadable, type GitRepo } from '../code/git.ts'
import type { CodeSource } from '../code/source.ts'

export interface CodeFile { path: string; text: string }

export interface TalonSite {
  /** The CAN ID, when it is a number or a constant found in the folder. */
  id: number | null
  /** What the code passes: "15" or "FLYWHEEL_LEADER_ID". */
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

/** `new TalonFX(15)` (Java) or `TalonFX(15)` (Kotlin). */
const NEW_TALON = /\b(?:new\s+)?TalonFX\s*\(\s*([A-Za-z_][\w.]*(?:\(\))?|\d+)\s*(?:,\s*([^()]*?(?:\([^()]*\))?[^()]*?))?\s*\)/g
/** `final int NAME = 15;` (Java) or `const val NAME = 15` / `val NAME: Int = 15` (Kotlin). Parameters and locals don't count. */
const INT_CONST = /\b(?:(?:static\s+)?final\s+(?:static\s+)?(?:int|Integer)|const\s+val|val)\s+([A-Za-z_]\w*)\s*(?::\s*Int\s*)?=\s*(\d+)(?![\w.])/g

const fileName = (p: string) => p.split('/').pop() ?? p
const SOURCE_FILE = /\.(java|kt)$/

/** The commit the code is on and its branch (null when detached), or why that can't be told. */
export type CodeHead = { sha: string; branch: string | null } | { why: string }

export function codeHints(files: CodeFile[], head: CodeHead): CodeHints {
  const notes: string[] = []
  const sources = files.filter((f) => SOURCE_FILE.test(f.path))
  // Integer constants by simple name. A name defined with two values can't be resolved.
  const constants = new Map<string, number | null>()
  for (const f of sources) {
    for (const m of f.text.matchAll(INT_CONST)) {
      const prev = constants.get(m[1])
      constants.set(m[1], prev === undefined || prev === Number(m[2]) ? Number(m[2]) : null)
    }
  }
  const sites: TalonSite[] = []
  for (const f of sources) {
    for (const m of f.text.matchAll(NEW_TALON)) {
      const expr = m[1]
      const simple = expr.replace(/\(\)$/, '').split('.').pop()!
      const id = /^\d+$/.test(expr) ? Number(expr) : (constants.get(simple) ?? null)
      const line = f.text.slice(0, m.index).split('\n').length
      sites.push({ id, expr, bus: m[2]?.trim() || null, file: f.path, line })
    }
  }
  if (sources.length && sites.length === 0) notes.push('No `new TalonFX(...)` in the folder\'s Java or Kotlin files.')
  const git = 'why' in head ? { sha: null, branch: null, notes: [head.why] } : { ...head, notes: [] }
  return { sites: sites.sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9) || a.file.localeCompare(b.file)), ...git, notes: [...notes, ...git.notes] }
}

/** Hints from the code at a branch or commit (GitHub): every Java and Kotlin file's text at that commit. */
export async function hintsAt(source: CodeSource, ref: string): Promise<CodeHints> {
  const sha = await source.resolve(ref)
  const paths = (await source.files(sha)).map((f) => f.path).filter((path) => SOURCE_FILE.test(path))
  const files = await Promise.all(paths.map(async (path) => ({ path, text: await source.textAt(sha, path) })))
  return codeHints(files, { sha, branch: branchOf(sha, ref) })
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
