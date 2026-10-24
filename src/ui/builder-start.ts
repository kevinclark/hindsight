/**
 * What the profile builder holds when a draft starts from a library log's code link ("Draft a profile from it"): nothing from an
 * earlier draft (so Keep can never replace a profile opened before), "Use GitHub" open and filled in, the linked repo remembered,
 * and the team stamped on the draft because the log is linked to this team's sources. Pure, so a test can check it.
 */
export interface BuilderStart {
  githubSpec: string
  askingGitHub: true
  linkedRepo: string
  stampTeam: true
  hintsFrom: string
  /** Everything a draft holds, back to empty. */
  keptAs: null
  openedProfile: false
  keptNote: ''
  problems: never[]
  draftNotes: never[]
  notUsed: never[]
  guessedSignals: never[]
  seenLimits: never[]
}

export const builderStart = (spec: string): BuilderStart => ({
  githubSpec: spec, askingGitHub: true, linkedRepo: spec.split('@')[0], stampTeam: true, hintsFrom: 'code folder',
  keptAs: null, openedProfile: false, keptNote: '', problems: [], draftNotes: [], notUsed: [], guessedSignals: [], seenLimits: [],
})
