/** The command line of scripts/code-check.ts. */
import { parseArgs } from 'node:util'

export type FailOn = 'none' | 'new' | 'any'

export interface Options {
  tree: boolean
  folder: string | undefined
  /** The commit to check (default: the folder's HEAD), or with --tree, `File.java:50`. */
  wanted: string | undefined
  /** The commit to compare with, or undefined (an empty --base counts as none: the action passes one when it has it). */
  base: string | undefined
  failOn: FailOn
  /** Rule ids to leave out, e.g. 'code/integer-division'. */
  excluded: string[]
  github: boolean
}

export const USAGE = `usage: code-check.ts <robot-code folder> [commit] [--base <commit>] [--fail-on none|new|any] [--exclude-rules a,b] [--github]
       code-check.ts --tree <folder> File.java:50`

/** The options, or what is wrong with the command line (the caller prints it and USAGE). */
export function parseOptions(argv: string[]): Options | string {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tree: { type: 'boolean' },
        base: { type: 'string' },
        'fail-on': { type: 'string' },
        'exclude-rules': { type: 'string' },
        github: { type: 'boolean' },
      },
    })
    const failOn = values['fail-on'] || 'any'
    if (failOn !== 'none' && failOn !== 'new' && failOn !== 'any') return `--fail-on must be none, new or any, not "${failOn}"`
    const excluded = (values['exclude-rules'] ?? '').split(',').map((id) => id.trim()).filter(Boolean)
    const [folder, wanted] = positionals
    return { tree: Boolean(values.tree), folder, wanted, base: values.base || undefined, failOn, excluded, github: Boolean(values.github) }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
