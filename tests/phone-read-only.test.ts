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
