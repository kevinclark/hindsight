/**
 * The steps of "Set up this laptop" (ADR b): what is set, what each step adds, and which apply to this build. Pure: the
 * state comes in. Every step is optional and nothing waits for it; the card is hidden once every applicable step is done.
 */

export interface SetupState {
  /** The desktop app (it has the shared library, so the Google step applies). */
  hub: boolean
  team: number | null
  tbaKey: boolean
  /** At least one GitHub source (the app's saved sources, or the page's chosen code). */
  github: boolean
  /** Hub only: signed in to Google, and a team folder chosen. */
  google: { signedIn: boolean; teamFolder: boolean }
}

export type SetupStepId = 'team' | 'tba' | 'github' | 'google'

export interface SetupStep {
  id: SetupStepId
  title: string
  /** What the step adds: shown on the step, so nobody does it blind. */
  adds: string
  done: boolean
  /** Not for this build (the page opened from disk has no shared library). */
  applicable: boolean
}

export function setupSteps(s: SetupState): SetupStep[] {
  return [
    { id: 'team', title: 'Team number', adds: "filters the robot lists to your team's robots, and finds your matches", done: s.team !== null, applicable: true },
    { id: 'tba', title: 'The Blue Alliance read key', adds: 'names the event and its schedule; without it each laptop types the next match', done: s.tbaKey, applicable: true },
    { id: 'github', title: 'GitHub source', adds: 'links logs to their code for code checks', done: s.github, applicable: true },
    { id: 'google', title: 'Google sign-in and team folder', adds: 'the shared library and triage history across laptops', done: s.google.signedIn && s.google.teamFolder, applicable: s.hub },
  ]
}

/** The steps still to do on this build. */
export const stepsLeft = (steps: readonly SetupStep[]): SetupStep[] => steps.filter((x) => x.applicable && !x.done)

/** The card shows while any applicable step is open. */
export const showSetupCard = (steps: readonly SetupStep[]): boolean => stepsLeft(steps).length > 0
