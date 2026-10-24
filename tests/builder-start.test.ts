// What the profile builder holds when a draft starts from a library log's code link. No test in this repo mounts a Svelte
// component, so the decision is a pure function (src/ui/builder-start.ts) and the component only applies it.
import { describe, expect, it } from 'vitest'
import { builderStart } from '../src/ui/builder-start.ts'

describe('starting a draft from a code link', () => {
  const s = builderStart('example-org/robot-9999@abc1234')
  it('opens Use GitHub with the spec filled in and remembers the repo', () => {
    expect(s).toMatchObject({ githubSpec: 'example-org/robot-9999@abc1234', askingGitHub: true, linkedRepo: 'example-org/robot-9999' })
  })
  it('stamps the team on the draft', () => {
    expect(s.stampTeam).toBe(true)
  })
  it('leaves nothing of an earlier draft: no kept profile to replace, nothing opened, no notes or problems', () => {
    expect(s).toMatchObject({ keptAs: null, openedProfile: false, keptNote: '', problems: [], draftNotes: [], notUsed: [], guessedSignals: [], seenLimits: [], hintsFrom: 'code folder' })
  })
})
