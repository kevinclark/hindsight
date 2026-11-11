// The phone reads triage and never writes it: no mark control is drawn (hidden, not disabled), and the write path itself
// refuses, so no history line reaches the browser store or the hub. Invented data only (event TEST).
import { describe, expect, it, vi } from 'vitest'
import { render } from 'svelte/server'
import BoardView from '../src/ui/BoardView.svelte'
import BoardIssueDetail from '../src/ui/BoardIssueDetail.svelte'
import SummaryReview from '../src/ui/SummaryReview.svelte'
import { buildBoard } from '../src/board/model.ts'
import { keepHistory } from '../src/triage/keeper.ts'
import { triage, type HistoryEvent } from '../src/triage/history.ts'
import { input, match, profile, session, SCHEDULE } from './helpers/board-scene.ts'
import { mb, reviewTarget, sizeOf } from '../src/ui/phone-library.ts'
import type { Entry } from '../src/hub/catalog.ts'

const fires = [{ key: 'power/brownout' }, { key: 'mech/follower-mismatch · Flywheel', severity: 'warning' as const }]
const s = session([match(2, { fires }), match(3, { fires })])
const history: HistoryEvent[] = [
  { type: 'issue', key: 'power/brownout', status: 'known', note: 'test reason', when: '2099-03-05T18:00:00.000Z', match: 'TEST Qualification 2', event: 'TEST' },
]
const marks = triage(history)
const WRITE_CONTROLS = [/aria-label="Your role"/, /Save the pit line/, /Missed by Hindsight/, /Queue sheet/, /Save changes/, /Add note/, /Debug this/, /I've read this/, /aria-label="Playoff cut-off"/, />Close</, /Give it an owner/, /Mark as/, /Not a real problem…/, /Real problem…/]
const controls = (html: string) => WRITE_CONTROLS.filter((re) => re.test(html)).map(String)

describe('read-only mode', () => {
  it('the board draws no write control without a writer, and says it is read only', () => {
    const ro = render(BoardView, { props: ({ session: s, history, marks, schedule: SCHEDULE, scheduleNote: null, profiles: [profile] }) as never }).body
    expect(controls(ro)).toEqual([])
    expect(ro).toContain('Read only')
    expect(ro).toContain('data-issue') // the rows themselves are there
    // with a writer the same board has them (so the check above can fail)
    const rw = render(BoardView, { props: ({ session: s, history, marks, schedule: SCHEDULE, scheduleNote: null, profiles: [profile], onWrite: () => {} }) as never }).body
    expect(controls(rw).length).toBeGreaterThan(3)
  })

  it("an issue's page draws no note box, no actions and no Debug this without a writer", () => {
    const board = buildBoard(input(s, history))
    const issue = board.issues[0]
    const ro = render(BoardIssueDetail, { props: ({ issue, board, rate: undefined, role: null, onBack: () => {} }) as never }).body
    expect(controls(ro)).toEqual([])
    const rw = render(BoardIssueDetail, { props: ({ issue, board, rate: undefined, role: 'pit', onBack: () => {}, onChange: () => {}, onDebug: () => {} }) as never }).body
    expect(controls(rw).length).toBeGreaterThan(1)
  })

  it('Match review from a summary shows the marks and draws no mark button', () => {
    const summary = match(2, { fires })
    const issues = new Map([['power/brownout', history[0] as never]])
    const html = render(SummaryReview, { props: ({ summary, issues, wrong: new Map(), real: new Map(), laptop: 'laptop-a', olderRead: null }) as never }).body
    expect(controls(html)).toEqual([])
    expect(html).toContain('Known issue')
    expect(html).toContain('test reason')
    expect(html).toContain("laptop laptop-a's summary")
  })

  it('Match review from a summary says when its breaker warnings use settings the pit has changed since', () => {
    const summary = match(2, { fires })
    const props = { summary, issues: new Map(), wrong: new Map(), real: new Map(), laptop: 'laptop-a', olderRead: null }
    const stale = render(SummaryReview, { props: ({ ...props, mapStale: true }) as never }).body
    expect(stale).toContain('The breaker settings changed after this log was read: its breaker warnings use the old settings until a laptop reads it again.')
    expect(stale).not.toMatch(/Read again/)
    expect(render(SummaryReview, { props: ({ ...props, mapStale: false }) as never }).body).not.toContain('data-breaker-note')
  })

  it('Match review draws a match that holds the same finding key twice (two events of one check)', () => {
    const twice = match(4, { fires: [{ key: 'power/brownout' }, { key: 'power/brownout' }] })
    const html = render(SummaryReview, { props: ({ summary: twice, issues: new Map(), wrong: new Map(), real: new Map(), laptop: null, olderRead: null }) as never }).body
    expect(html.match(/test finding power\/brownout/g)?.length).toBe(2)
  })

  it('the write path refuses: no history line reaches the hub or the browser store', () => {
    const append = vi.fn(), store = vi.fn()
    const mark: HistoryEvent = { type: 'issue', key: 'power/brownout', status: 'wrong', note: 'test reason', when: '2099-03-05T19:00:00.000Z', match: 'TEST Qualification 3' }
    const kept = keepHistory(history, [...history, mark], { readOnly: true, append, store })
    expect(kept).toEqual({ history, wrote: false })
    expect(append).not.toHaveBeenCalled()
    expect(store).not.toHaveBeenCalled()
    // the desktop app appends only the new line; the page with no library keeps the whole history in this browser
    expect(keepHistory(history, [...history, mark], { readOnly: false, append }).wrote).toBe(true)
    expect(append).toHaveBeenCalledWith(`${JSON.stringify(mark)}\n`)
    keepHistory(history, [...history, mark], { readOnly: false, store })
    expect(store).toHaveBeenCalledTimes(1)
  })
})

describe('read-only Match review of a whole log (the phone opens one from the Library)', () => {
  it('draws no mark buttons and no Debug this without a writer; with one, it does', async () => {
    const { analyzeFixture } = await import('./helpers/load.ts')
    const MatchTab = (await import('../src/ui/MatchTab.svelte')).default
    const analysis = analyzeFixture('brownout').analyses[0]
    const ro = render(MatchTab, { props: ({ analysis, issues: new Map() }) as never }).body
    expect(controls(ro)).toEqual([])
    expect(ro).toMatch(/power\/brownout|Brownout/i) // the findings themselves are there
    const rw = render(MatchTab, { props: ({ analysis, issues: new Map(), onMark: () => {}, debug: { marks: () => ({}), write: () => {}, role: null, setRole: () => {} } }) as never }).body
    expect(controls(rw).length).toBeGreaterThan(1)
  })
})

describe('Match review on the phone offers the whole log when the Library has it and the phone has not kept it', () => {
  const summary = { ...match(2, { fires }), fileName: 'q2.wpilog', fileSize: 12 * 2 ** 20 }
  const entry = { record: { sha256: 'a', size: 12 * 2 ** 20, names: ['q2.wpilog'] }, attached: { dslog: [{ sha256: 'b', size: 2 ** 20 }], dsevents: [], hoot: [] } } as unknown as Entry
  const props = { summary, issues: new Map(), wrong: new Map(), real: new Map(), laptop: 'laptop-a', olderRead: null }

  it('draws "Full review · N MB" (the log plus its DS logs) for a summary whose log is not kept, and not for one kept or not in the Library', () => {
    const target = reviewTarget([entry], new Set(), summary)
    expect(target?.kept).toBe(false)
    const full = { size: mb(sizeOf(target!.entry)), onOpen: () => {}, progress: null, onStop: () => {}, problem: null }
    const html = render(SummaryReview, { props: ({ ...props, full }) as never }).body
    expect(html).toContain('Full review · 13 MB')
    expect(html).not.toContain('<progress')
    expect(render(SummaryReview, { props: (props) as never }).body).not.toContain('Full review')
    expect(reviewTarget([entry], new Set(['a', 'b']), summary)?.kept).toBe(true) // kept: it opens by itself, no button
    expect(reviewTarget([], new Set(), summary)).toBeNull()
  })

  it('shows the download progress with Stop in place of the button, and a failure in words with the match name', () => {
    const progress = { got: 2 ** 20, total: 13 * 2 ** 20 }
    const html = render(SummaryReview, { props: ({ ...props, full: { size: '13', onOpen: () => {}, progress, onStop: () => {}, problem: null } }) as never }).body
    expect(html).toContain('<progress')
    expect(html).toContain('Downloading Qualification 2: 1.0 of 13 MB')
    expect(html).toContain('>Stop<')
    expect(html).not.toContain('Full review ·')
    const failed = render(SummaryReview, { props: ({ ...props, full: { size: '13', onOpen: () => {}, progress: null, onStop: () => {}, problem: 'Could not open Qualification 2 (offline).' } }) as never }).body
    expect(failed).toContain('Could not open Qualification 2 (offline).')
    expect(failed).toContain('Full review · 13 MB')
  })
})
