// How a profile's pinned code reads. Plain node loads this (the report and session code import it), so it imports only types.
// A profile built from a public log has no commit: its code says 'unknown' for the branch and sha.

import type { CodePin } from './types.ts'

type Pin = Partial<Pick<CodePin, 'sha' | 'branch'>>

/** Whether a pin's branch or sha names something. */
export const known = (text: string | undefined): text is string => !!text && text !== 'unknown'

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
