import { describe, expect, it } from 'vitest'
import { changelogEntries, whatsNew } from '../src/now/changelog.ts'

const row = (sha: string, parents: string, ...lines: string[]) => `${sha} ${parents}\x1f${lines.join('\n')}\n\x1e`

describe('changelogEntries', () => {
  it('counts a release as its commits, and puts a branch line in the release that merged it', () => {
    // a <- b <- m (main), and a <- s (branch, 2 commits when written), merged at m: 4 commits.
    const log = [row('m', 'b s', 'Merged.'), row('s', 'a', 'From a branch.'), row('b', 'a', 'On main.'), row('a', '')].join('\n')
    expect(changelogEntries(log, 'm')).toEqual([{ version: 2, lines: ['On main.'] }, { version: 4, lines: ['Merged.', 'From a branch.'] }])
  })
  it('is empty with no history', () => {
    expect(changelogEntries('', 'x')).toEqual([])
  })
})

describe('whatsNew', () => {
  const entries = [{ version: 5, lines: ['five'] }, { version: 7, lines: ['seven', 'shared'] }, { version: 9, lines: ['nine', 'shared'] }, { version: 11, lines: ['eleven'] }]
  it('lists what landed after the version seen up to the one running, newest first, each line once', () => {
    expect(whatsNew(entries, '0.1.9', '0.1.5', true)).toEqual(['nine', 'shared', 'seven'])
  })
  it('shows nothing once the running version is seen, or after going back to an older one', () => {
    expect(whatsNew(entries, '0.1.9', '0.1.9', true)).toEqual([])
    expect(whatsNew(entries, '0.1.7', '0.1.9', true)).toEqual([])
  })
  it('shows nothing on a fresh install', () => {
    expect(whatsNew(entries, '0.1.9', null, false)).toEqual([])
  })
  it('shows the newest release to a copy that holds logs and never recorded a version', () => {
    expect(whatsNew(entries, '0.1.9', null, true)).toEqual(['nine', 'shared'])
  })
  it('shows nothing on a build with no release number', () => {
    expect(whatsNew(entries, '0.1.0', '0.1.5', true)).toEqual([])
    expect(whatsNew(entries, 'dev', null, true)).toEqual([])
  })
})
