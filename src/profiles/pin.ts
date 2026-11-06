// How a profile's pinned code reads. Plain node loads this (the report and session code import it), so it imports nothing.
// A profile built from a public log has no commit: its code says 'unknown' for the branch and sha.

type Pin = { sha?: string; branch?: string }

const known = (text: string | undefined): text is string => !!text && text !== 'unknown'

/** Whether the profile's code names a commit or a branch ("unknown" is what a profile with no pinned code says). */
export function hasPin(code: Pin): boolean {
  return known(code.sha) || known(code.branch)
}

/** "1a2b3c4 on main", or "" when the profile names no commit. */
export function pinText(code: Pin): string {
  const sha = known(code.sha) ? code.sha.slice(0, 7) : ''
  const branch = known(code.branch) ? code.branch : ''
  return sha || branch ? `${sha || '?'} on ${branch || '?'}` : ''
}

/** "Code as of main 1a2b3c4", or "Code not known" when the profile names no commit. */
export function codeAsOf(code: Pin): string {
  return hasPin(code) ? `Code as of ${code.branch} ${code.sha}` : 'Code not known'
}
