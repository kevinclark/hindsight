/**
 * The code check: the robot code at one commit, read from the folder's .git, parsed, and run through the code rules
 * (rules/). Foresight shows the findings as context for the software lead (never toward GO); scripts/code-check.ts
 * prints them. Read only: nothing in the folder is changed.
 */
import type { CodeHead } from '../../builder/code-hints.ts'
import { GitUnreadable } from '../git.ts'
import type { CodeSource } from '../source.ts'
import { Project } from './project.ts'
import { runCodeRules, type CodeReport, type CodeRule } from './rule.ts'
import discardedResult from './rules/discarded-result.ts'
import duplicateCanId from './rules/duplicate-can-id.ts'
import impossibleRange from './rules/impossible-range.ts'
import integerDivision from './rules/integer-division.ts'
import neverSet from './rules/never-set.ts'
import optionalEquals from './rules/optional-equals.ts'

/** In the order the panel lists them: the ones that cost a match most directly first. */
export const CODE_RULES: CodeRule[] = [duplicateCanId, neverSet, impossibleRange, optionalEquals, discardedResult, integerDivision]

/** Runs the code rules over these files (call loadJava first). */
export function checkCode(sources: { path: string; text: string }[], rules = CODE_RULES): CodeReport {
  const project = new Project(sources)
  try {
    return runCodeRules(rules, project)
  } finally {
    project.close()
  }
}

/** Every .java file in a commit, with its text. */
export async function javaFilesAt(source: CodeSource, commit: string): Promise<{ path: string; text: string }[]> {
  const files = (await source.files(commit)).filter((f) => f.path.endsWith('.java'))
  return Promise.all(files.map(async (f) => ({ path: f.path, text: await source.textAt(commit, f.path) })))
}

/** What the code check ran on, and what it found. */
export interface FolderCheck {
  report: CodeReport
  /** The commit checked. */
  commit: string
  /** 'robot' when it is the commit the robot reports; 'head' when it is the code's own head (`head`) instead. */
  ranOn: 'robot' | 'head'
  /** The branch of that head, when it checked one. */
  branch: string | null
  /** Why it didn't check the robot's commit (none reported, or not in this code), when it didn't. */
  why: string | null
  files: number
}

/**
 * Checks the commit the robot reports when the code has it (the code on the robot), else `head` (a folder's HEAD,
 * from codeHead), and says which. Uncommitted edits, in the folder or on the robot, are never checked: only commits.
 */
export async function checkFolder(source: CodeSource, robotSha: string | null, head: CodeHead): Promise<FolderCheck> {
  const robot = await robotCommitIn(source, robotSha)
  const fallback = 'why' in head ? null : head
  if (!robot.commit && !fallback) throw new GitUnreadable(`${'why' in head ? head.why : ''} ${robot.why ?? ''}`.trim())
  const commit = robot.commit ?? fallback?.sha ?? ''
  const files = await javaFilesAt(source, commit)
  const ranOn = robot.commit ? 'robot' : 'head'
  return { report: checkCode(files), commit, ranOn, branch: robot.commit ? null : (fallback?.branch ?? null), why: robot.why, files: files.length }
}

/** The robot's commit in this code, or why it can't be checked. */
async function robotCommitIn(source: CodeSource, robotSha: string | null): Promise<{ commit: string | null; why: string | null }> {
  if (!robotSha) return { commit: null, why: 'the robot is not connected, or has not reported its commit' }
  try {
    return { commit: await source.resolve(robotSha), why: null }
  } catch (error) {
    if (!(error instanceof GitUnreadable)) throw error
    return { commit: null, why: `the robot runs ${robotSha.slice(0, 7)}: ${error.message}` }
  }
}
