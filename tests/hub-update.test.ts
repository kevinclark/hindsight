import { describe, expect, it } from 'vitest'
import { checkForUpdate, isNewer } from '../src/hub/update.ts'

const releases = (list: object[]): typeof fetch => async () => new Response(JSON.stringify(list), { status: 200 })

describe('update banner', () => {
  it('compares versions number by number', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })
  it('offers the newest app release that is newer, and ignores robot-snapshot releases, drafts and prereleases', async () => {
    const u = await checkForUpdate('0.1.0', releases([
      { tag_name: 'robot-snapshot-v9.0.0', html_url: 'https://example.com/snap' },
      { tag_name: 'v0.3.0', html_url: 'https://example.com/draft', draft: true },
      { tag_name: 'v0.4.0', html_url: 'https://example.com/pre', prerelease: true },
      { tag_name: 'v0.2.0', html_url: 'https://example.com/0.2.0' },
      { tag_name: 'v0.1.5', html_url: 'https://example.com/0.1.5' },
    ]))
    expect(u).toEqual({ version: '0.2.0', url: 'https://example.com/0.2.0' })
  })
  it('says nothing when up to date, when GitHub refuses, or when it cannot be reached', async () => {
    expect(await checkForUpdate('0.2.0', releases([{ tag_name: 'v0.2.0', html_url: 'x' }]))).toBeNull()
    expect(await checkForUpdate('0.1.0', async () => new Response('rate limited', { status: 403 }))).toBeNull()
    expect(await checkForUpdate('0.1.0', async () => { throw new TypeError('offline') })).toBeNull()
  })
})
