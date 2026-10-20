/**
 * How to write a code check. Read this file and rules/integer-division.ts and you know everything you need.
 *
 * A code check answers one question about the robot code ("Does a whole-number division go into a decimal?"). It is
 * a short description plus one function, `check`, that looks at one piece of code and says what's wrong, or nothing:
 *
 *   export default codeRule({
 *     id: 'code/integer-division',
 *     title: 'Whole-number division where a decimal was meant',
 *     meaning: 'Java divides two whole numbers as whole numbers: 50 / 12 is 4, not 4.17.',
 *     nextStep: 'Write one side as a decimal: 50.0 / 12.',
 *     incident: '2026-Offseason-Robot dd1f33c fixed 30 / 12 on the line next to 50 / 12, which stayed',
 *     forEach: 'binary_expression',
 *     check(expression, project) {
 *       if (operatorOf(expression) !== '/') return        // not a division: nothing to say
 *       ...
 *       return { message: '50 / 12 is 4, not 4.167 (−4.0 %)' }
 *     },
 *   })
 *
 * `forEach` names the piece of code by its tree-sitter type (java.ts says how to see the types of your own code):
 * 'binary_expression' runs `check` on every `a / b`, `a && b`, `a < b`; 'variable_declarator' on every variable.
 * Leave `forEach` out to look at the whole project at once: then `check(project)` returns a list. When a check can't
 * judge a piece (it can't work out a value), it says why with `return project.couldNotJudge('why')`.
 *
 * Code findings are context for the software lead. They never count toward Foresight's GO.
 */
import { definedOnly } from '../../rules/run.ts'
import { lineOf, type Node } from './java.ts'
import type { Project } from './project.ts'

/** What `check` returns when something is wrong. Return nothing when all is well. */
export interface CodeProblem {
  /** One line with the numbers: "GEAR_RATIO = 50 / 12 is 4, not 4.167 (−4.0 %)". */
  message: string
  /** The code to point at, when it isn't the piece `check` was given. */
  at?: Node
  /** The facts behind it, labelled in plain English. A value left undefined is left out. */
  evidence?: Record<string, number | string | undefined>
}

interface Description {
  /** 'code/<name>', the file name in rules/. */
  id: string
  title: string
  /** What it probably means, for a student reading the finding. */
  meaning: string
  /** The one thing to do next. */
  nextStep: string
  /** The real bug that made this check worth having (repo and commit). */
  incident: string
}
type PieceCheck = Description & { forEach: string; check(piece: Node, project: Project): CodeProblem | undefined }
type ProjectCheck = Description & { forEach?: undefined; check(project: Project): CodeProblem[] }
export type CodeRule = PieceCheck | ProjectCheck

export function codeRule<R extends CodeRule>(rule: R): R {
  return rule
}

/** One finding, ready to show. */
export interface CodeFinding {
  rule: string
  title: string
  file: string
  line: number
  message: string
  evidence: Record<string, number | string>
  meaning: string
  nextStep: string
}

export interface CodeReport {
  findings: CodeFinding[]
  /** Pieces a check looked at and couldn't judge, with why ("a value it can't work out"). */
  notJudged: { rule: string; file: string; line: number; why: string }[]
  /** Checks that threw, with the error: a bug in the check, never in the robot code. */
  crashed: { rule: string; why: string }[]
}

/** Runs every rule over the project. A rule that throws is listed under `crashed`; the others still run. */
export function runCodeRules(rules: CodeRule[], project: Project): CodeReport {
  const report: CodeReport = { findings: [], notJudged: [], crashed: [] }
  for (const rule of rules) {
    try {
      for (const { piece, problems, unjudged } of lookAt(rule, project)) {
        for (const problem of problems) report.findings.push({ ...describe(rule), ...where(rule, problem.at ?? piece, project), ...said(problem) })
        for (const note of unjudged) report.notJudged.push({ rule: rule.id, ...where(rule, note.at ?? piece, project), why: note.why })
      }
    } catch (error) {
      project.takeUnjudged()                          // a crashed check's notes would land on the next one
      report.crashed.push({ rule: rule.id, why: error instanceof Error ? error.message : String(error) })
    }
  }
  report.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))
  return report
}

/** Each piece a rule looked at (none for a whole-project rule), with the problems it found and what it couldn't judge. */
function lookAt(rule: CodeRule, project: Project) {
  if (rule.forEach === undefined) return [{ piece: undefined, problems: rule.check(project), unjudged: project.takeUnjudged() }]
  return project.nodes(rule.forEach).map((piece) => {
    const problem = rule.check(piece, project)
    return { piece, problems: problem ? [problem] : [], unjudged: project.takeUnjudged() }
  })
}

const describe = ({ id, title, meaning, nextStep }: CodeRule) => ({ rule: id, title, meaning, nextStep })

function where(rule: CodeRule, at: Node | undefined, project: Project): { file: string; line: number } {
  if (!at) throw new Error(`${rule.id}: a whole-project check must say where (at) for each problem and each couldNotJudge`)
  return { file: project.fileOf(at).path, line: lineOf(at) }
}

/** The problem's own words, with evidence left undefined dropped. */
const said = (problem: CodeProblem) => ({ message: problem.message, evidence: definedOnly(problem.evidence) })

// Numbers are said the same way as in the match rules.
export { pct, plural, round } from '../../rules/rule.ts'
