import { describe, expect, it } from 'vitest'
import { askText, asking } from '../src/ui/ask-text.svelte.ts'

// No DOM in this test setup (no jsdom/happy-dom), so the dialog itself is checked by the rendered scripts; this is its logic.
describe('askText', () => {
  it('shows the question and starting text, then resolves with the answer', async () => {
    const p = askText('Session name', 'old')
    expect(asking()).toMatchObject({ question: 'Session name', initial: 'old' })
    asking()!.resolve('new')
    expect(await p).toBe('new')
    expect(asking()).toBeNull()
  })
  it('resolves null when cancelled, and an empty answer stays empty', async () => {
    const a = askText('q')
    asking()!.resolve(null)
    expect(await a).toBeNull()
    const b = askText('q')
    asking()!.resolve('')
    expect(await b).toBe('')
  })
  it('a second question cancels the first; a second answer to one request is ignored', async () => {
    const a = askText('first')
    const firstReq = asking()!
    const b = askText('second')
    expect(await a).toBeNull()
    firstReq.resolve('late')
    expect(asking()?.question).toBe('second')
    asking()!.resolve('x')
    expect(await b).toBe('x')
  })
})
