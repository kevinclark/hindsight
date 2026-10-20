/** How the Logging tab and the session view show a signal's state. */
import type { CoverageState } from './coverage.ts'

export const STATE_ICON: Record<CoverageState, string> = {
  logged: '✅', slow: '⚠️', 'never changes': '⚠️', 'not logged': '❌', 'profile gap': '⬜',
}

export const STATE_WORDS: Record<CoverageState, string> = {
  logged: 'logged', slow: 'logged too slowly', 'never changes': 'never changes', 'not logged': 'not logged',
  'profile gap': 'no key in the robot profile',
}
