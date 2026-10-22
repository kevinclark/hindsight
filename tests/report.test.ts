// The report export: the phone card (pure SVG), the model behind it and behind the printed report.
import { descendants } from '../src/report/finding-tree.ts'
import { describe, expect, it } from 'vitest'
import { buildCard, CARD_MAX_HEIGHT, CARD_MIN_TYPE, CARD_WIDTH, wrap, type CardModel } from '../src/report/card.ts'
import { bottomLine, cardTitle, keyNumber, reviewCard, reviewModel, shortTitle, stripRepoPaths, titleHasValue } from '../src/report/review-model.ts'
import { didNotRun, foresightCard, shortShas, type ForesightReportInput } from '../src/report/foresight-model.ts'
import { RULES } from '../src/rules/index.ts'
import type { Finding } from '../src/rules/types.ts'
import { analyzeFixture } from './helpers/load.ts'

const model = (n: number, over: Partial<CardModel> = {}): CardModel => ({
  context: 'Qualification 42 · cacg · 2026-10-18',
  heading: `${n} errors`, headingTone: 'error', subheading: '9 warnings · 6 info',
  items: Array.from({ length: n }, (_, i) => ({ word: 'ERROR', tone: 'error' as const, title: `Problem number ${i + 1} happened & it was <bad> at 2:2${i % 10} into the match`, number: `${i + 1} things` })),
  emptyText: 'Nothing to fix.', footer: ['code abc1234 on main', 'Hindsight 0.1.0'], uncommitted: true, uncommittedText: 'UNCOMMITTED CODE ran this match',
  ...over,
})
const fontSizes = (svg: string) => [...svg.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]))

describe('phone card', () => {
  const card = buildCard(model(3))
  it('is 1080 px wide and at most 4:5', () => {
    expect(card.width).toBe(CARD_WIDTH)
    expect(card.height).toBeLessThanOrEqual(CARD_MAX_HEIGHT)
    expect(card.width / card.height).toBeGreaterThanOrEqual(0.8)
    expect(card.svg).toContain(`width="1080" height="${card.height}"`)
  })
  it('keeps every piece of type at 32 px or more (10.7 px at 360 px wide)', () => {
    const sizes = fontSizes(card.svg)
    expect(sizes.length).toBeGreaterThan(8)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(CARD_MIN_TYPE)
  })
  it('is pure SVG: no foreignObject, image, script or external font', () => {
    expect(card.svg).not.toMatch(/foreignObject|<image|<script|@font-face|url\(/i)
    expect(card.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  })
  it('says the verdict, each title, its number, the build and the uncommitted flag, with severity as a word', () => {
    for (const t of ['3 errors', 'Problem number 1', 'Problem number 3', '3 things', 'code abc1234 on main', 'UNCOMMITTED CODE ran this match', 'Qualification 42', 'ERROR']) expect(card.svg).toContain(t)
  })
  it('escapes markup in finding text', () => {
    expect(card.svg).toContain('&amp; it was &lt;bad&gt;')
    expect(card.svg).not.toContain('<bad>')
  })
  it('never clips: the height covers every drawn line, and one item shows even if it alone is too tall', () => {
    const tall = buildCard(model(1, { items: [{ word: 'ERROR', tone: 'error', title: 'word '.repeat(300), number: 'n '.repeat(300) }], footer: ['f '.repeat(400)] }))
    expect(tall.shown).toBe(1)
    for (const c of [tall, buildCard(model(3)), buildCard(model(40))]) {
      const ys = [...c.svg.matchAll(/<text [^>]*y="(\d+)"/g)].map((m) => Number(m[1]))
      expect(c.height).toBeGreaterThanOrEqual(Math.max(...ys))
    }
  })
  it('lists the most that fit, then says "+N more", and never grows past 4:5', () => {
    const big = buildCard(model(40))
    expect(big.height).toBeLessThanOrEqual(CARD_MAX_HEIGHT)
    expect(big.shown).toBeGreaterThan(2)
    expect(big.shown).toBeLessThan(40)
    expect(big.hidden).toBe(40 - big.shown)
    expect(big.svg).toContain(`+${big.hidden} more in the PDF`)
    expect(big.svg).toContain('Problem number 1 ')
    expect(big.svg).not.toContain(`Problem number ${big.shown + 1} happened`)
  })
  it('draws no flag box when the code was committed, and a short empty card is shorter than a full one', () => {
    const clean = buildCard(model(0, { uncommitted: false, heading: 'No errors', headingTone: 'ok' }))
    expect(clean.svg).not.toContain('UNCOMMITTED')
    expect(clean.svg).toContain('Nothing to fix.')
    expect(clean.height).toBeLessThan(card.height)
  })
})

describe('wrap', () => {
  it('breaks at words within the width and ends a cut line with an ellipsis', () => {
    const lines = wrap('one two three four five six seven eight nine ten eleven twelve thirteen fourteen', 32, 400, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1].endsWith('…')).toBe(true)
    expect(lines.every((l) => l.length <= Math.floor(400 / (32 * 0.5)))).toBe(true)
  })
  it('breaks one long token (a file name) rather than overflow', () => {
    const lines = wrap('x'.repeat(200), 32, 400, 5)
    expect(lines.every((l) => l.length <= 25)).toBe(true)
  })
  it('never splits words joined by a no-break space ("1 in 35")', () => {
    // 25 characters a line: a plain space would leave "1 in" on the first line and "35" on the next.
    const lines = wrap('potentially fixed: since Q21, 1\u00a0in\u00a035', 32, 400, 3)
    expect(lines.some((l) => l.endsWith('1\u00a0in\u00a035'))).toBe(true)
  })
})

describe('report model, from the real CalGames fixtures', () => {
  const p0 = analyzeFixture('p0-brownout').analyses[0]
  const q13 = analyzeFixture('q13-auto-and-comms').analyses[0]
  it('splits errors, warnings and info the way the Match tab does, and names the worst', () => {
    const m = reviewModel(q13, new Map())
    expect(m.errors.length + m.warnings.length + m.infos.length).toBe(m.active.length)
    expect(m.active.every((f) => f.rule !== 'meta/not-checked')).toBe(true)
    expect(m.errors.length).toBeGreaterThan(0)
    expect(m.bottomLine).toMatch(/^\d+ errors?, \d+ warnings?, \d+ info\. Worst: /)
    expect(m.jsonFile).toBe('q13-auto-and-comms.findings.json'.replace('q13-auto-and-comms', q13.match.fileName.replace(/\.wpilog$/i, '')))
    expect(m.schema).toBe('hindsight.findings/2')
  })
  it('files a known finding under Known and out of the active list', () => {
    const first = p0.report.findings.find((f) => f.severity === 'error')!
    const issues = new Map([[first.key, { type: 'issue' as const, key: first.key, status: 'known' as const, note: 'belt', when: '2026-10-01T00:00:00Z' }]])
    const m = reviewModel(p0, issues)
    expect(m.known.map((f) => f.key)).toContain(first.key)
    expect(m.active.map((f) => f.key)).not.toContain(first.key)
    expect(m.bottomLine).toContain('known')
  })
  it('puts one decisive number on every error, in the card', () => {
    const card = reviewCard(reviewModel(p0, new Map()))
    expect(card.items.length).toBeGreaterThan(0)
    for (const item of card.items) { expect(item.word).toBe('ERROR'); expect(item.number.length === 0 ? /^(Browned out|Flywheel follower \d+ dropped|Alert)/.test(item.title) : true).toBe(true); expect(item.title).not.toMatch(/robot time/) }
    expect(buildCard(card).svg).toContain(card.items[0].title.slice(0, 20))
  })
  it('never calls a trip line a "limit", on any P0 or Q13 finding', () => {
    for (const a of [p0, q13]) for (const f of a.report.findings) expect(keyNumber(f).text, f.rule).not.toMatch(/limit/i)
    const f = p0.report.findings.find((x) => x.measured?.[0]?.threshold !== undefined)!
    expect(keyNumber(f).text).toContain('(line ')
  })
  it('leaves the number line out when the title already says the value', () => {
    const brown = p0.report.findings.find((x) => x.rule === 'power/brownout')!
    expect(keyNumber(brown).inTitle).toBe(true)
    const drop = p0.report.findings.find((x) => x.rule === 'can/device-dropout')!
    expect(keyNumber(drop).inTitle).toBe(true)
    const items = reviewCard(reviewModel(p0, new Map())).items
    // No number (the title says 53); only what it explains (in this cut: the follower dropout and the margin).
    expect(items.find((i) => i.title.startsWith('Browned out 53 times'))!.number).toBe('explains 1 error, 1 warning')
    expect(titleHasValue('Lost comms at 2:27 into the match', 2)).toBe(false)
    expect(titleHasValue('Browned out 53 times', 53)).toBe(true)
    expect(titleHasValue('Browned out 253 times', 53)).toBe(false)
    // Equal at the title's own precision, sign ignored (the key-number line would only restate the title).
    expect(titleHasValue('Pitch -24° for 0.8 s', 23.7)).toBe(true)
    expect(titleHasValue('Battery fell 2.4 V below the line', 2.37)).toBe(true)
    expect(titleHasValue('Battery fell 2.4 V below the line', 22.8)).toBe(false)
    expect(titleHasValue('Fell to 22.1 %', 22.8)).toBe(false)
  })
  it('marks a finding that came back after a fix, on the card and in the model', () => {
    const first = p0.report.findings.find((f) => f.severity === 'error')!
    const issues = new Map([[first.key, { type: 'issue' as const, key: first.key, status: 'fixed' as const, note: 'belt', when: '2020-01-01T00:00:00Z' }]])
    expect(p0.match.matchStart).not.toBeNull()
    const dated = { ...p0, match: { ...p0.match, epochOffset: 1.7e9 } } // played in 2023, fixed in 2020: it came back
    const m = reviewModel(dated, issues)
    expect(m.cameBack.has(first.key)).toBe(true)
    expect(reviewCard(m).items.some((i) => i.word === 'ERROR · CAME BACK')).toBe(true)
  })
  it('folds standing headlines out of the report lists and the card, and changes nothing without a session', () => {
    const none = reviewModel(p0, new Map())
    expect(none.standing).toEqual([])
    expect(reviewModel(p0, new Map(), new Set())).toEqual(none)
    expect(reviewCard(none).standingNote).toBeUndefined()
    const keys = new Set(none.headlines.map((n) => n.finding.key))
    const all = reviewModel(p0, new Map(), keys)
    expect(all.headlines.length + all.standing.length).toBe(none.headlines.length)
    expect(all.standing.length).toBeGreaterThan(0)
    // Counts still count every finding; the card names how many it left off.
    expect(all.errors).toEqual(none.errors)
    expect(all.bottomLine).toBe(none.bottomLine)
    const card = reviewCard(all)
    expect(card.standingNote).toBe(`+ ${all.standing.length} in every match this session`)
    expect(card.heading).toBe(reviewCard(none).heading)
    expect(card.items.length).toBe(all.headlines.filter((n) => n.finding.severity === 'error').length)
    expect(buildCard(card).svg).toContain('in every match this session')
  })
  it('says "no new errors", never "nothing new", when only the error headlines fold and new warnings stay', () => {
    const none = reviewModel(p0, new Map())
    const errorKeys = new Set(none.headlines.filter((n) => n.finding.severity === 'error').flatMap((n) => [n.finding, ...descendants(n)]).map((f) => f.key))
    const m = reviewModel(p0, new Map(), errorKeys)
    const card = reviewCard(m)
    expect(card.items.length).toBe(0)
    expect(m.headlines.some((n) => n.finding.severity === 'warning')).toBe(true)
    expect(card.emptyText).toBe('No new errors in this match.')
    expect(card.standingNote).toContain(', including ')
  })
  it('says a crashed rule on the card and in the report model, and a clean run says none', () => {
    const crashed = { ...p0, report: { ...p0.report, crashed: [{ rule: 'x/boom', reason: 'it threw' }] } }
    const m = reviewModel(crashed, new Map())
    expect(m.crashed).toEqual([{ rule: 'x/boom', reason: 'crashed: it threw' }])
    expect(reviewCard(m).subheading).toContain('1 rule crashed')
    expect(reviewCard(reviewModel(p0, new Map())).subheading).not.toContain('crashed')
  })
  it('flags uncommitted code on the card when the log says so', () => {
    const m = reviewModel(p0, new Map())
    expect(m.header.build.uncommitted).toBe(/uncommitted/i.test(p0.match.build.dirty))
    expect(reviewCard(m).uncommitted).toBe(m.header.build.uncommitted)
  })
  it('uses the judged measurement as the number when the rule gave one, else the first evidence line', () => {
    const f = p0.report.findings.find((x) => x.measured?.length)!
    expect(keyNumber(f).text).toContain(String(f.measured![0].value))
    expect(keyNumber(f).text).not.toContain('limit')
    const bare = { ...f, measured: undefined }
    expect(keyNumber(bare).text).toBe(`${Object.keys(f.evidence)[0]}: ${Object.values(f.evidence)[0]}`)
  })
})

describe('shortTitle (the bottom line)', () => {
  it('keeps what happened for the three real titles that lost it', () => {
    expect(shortTitle('Hood moved at 0:00 into the match (auto; robot time 270.9 s) before its zero completed, 22.6 s later')).toMatch(/^Hood moved at 0:00 into the match before its zero…?/)
    expect(shortTitle('Disabled in auto at 0:12 into the match (auto; robot time 282.7 s) with 7.4 s of auto left')).toBe('Disabled in auto at 0:12 into the match with 7.4 s of auto left')
    const amps = shortTitle('Flywheel supply current reached 77 A against a 40 A limit that is switched off in code (as of event-calgames d339f29; this log ran 123eec6)')
    expect(amps.length).toBeLessThanOrEqual(70)
    expect(amps).toMatch(/…$/)
    expect(amps).toMatch(/ (code|in|off|is)…$|[a-z]…$/)
    expect(amps.replace(/…$/, '').endsWith(' ')).toBe(false)
    expect('Flywheel supply current reached 77 A against a 40 A limit that is switched off in code').toContain(amps.replace(/…$/, ''))
    expect(shortTitle('Browned out 53 times, first at 2:25 into the match (teleop; robot time 532.8 s)')).toBe('Browned out 53 times')
    expect(shortTitle('Flywheel follower 18 ran more than 15 % off Flywheel leader for 1.2 s (median 97 %)')).toBe('Flywheel follower 18 ran more than 15 % off Flywheel leader for 1.2 s')
  })
})

describe('wording', () => {
  it('drops repo-path citations from every rule\'s "why this rule exists", keeping the sentence', () => {
    for (const r of RULES) {
      const text = stripRepoPaths(r.incident)
      expect(text, r.id).not.toMatch(/\.md|hindsight-research|8033\/robot/)
      expect(text.length, r.id).toBeGreaterThan(10)
    }
    expect(stripRepoPaths('CalGames Q13: hood moved (2026-10-17-calgames-q13-log-analysis.md §1) before its zero')).toBe('CalGames Q13: hood moved before its zero')
    expect(stripRepoPaths('Seen at MTTD 2025 (mttd-2025-context.md §1).')).toBe('Seen at MTTD 2025.')
  })
  it('shortens a card title without losing what happened', () => {
    expect(cardTitle('Browned out 53 times, first at 2:25 into the match (teleop; robot time 532.8 s)')).toBe('Browned out 53 times, first at 2:25 into the match')
    expect(cardTitle('Flywheel supply current reached 77 A against a 40 A limit (as of event-x d339f29; this log ran 123eec6)')).toBe('Flywheel supply current reached 77 A against a 40 A limit')
  })
  it('says "No errors" without claiming a count of zero twice', () => {
    expect(bottomLine([], [], [], 0)).toBe('No errors or warnings. 0 warnings, 0 info.')
  })
})

describe('Foresight card', () => {
  const base: ForesightReportInput = {
    verdict: 'NO-GO', why: '1 to fix before the robot goes on the field', state: 'connected', message: 'Connected', url: 'ws://x', readAt: new Date(2026, 9, 19, 17, 36, 4),
    robot: '2026 offseason robot', items: [], onchecks: [], battery: 12.6, controllers: [], build: { sha: '123eec6268b7', branch: 'event-calgames', dirty: 'Uncommitted changes' }, notChecked: [],
  }
  it('puts the verdict word first, stamps the time read, and flags uncommitted code', () => {
    const c = foresightCard(base)
    expect(c.heading).toBe('NO-GO')
    expect(c.context).not.toContain('2026')
    expect(c.footer[0]).toContain('2026-10-19 17:36:04')
    expect(c.footer.join(' ')).toContain('123eec6')
    expect(c.footer.join(' ')).not.toContain('123eec6268b7')
    expect(c.uncommitted).toBe(true)
    expect(c.uncommittedText).toContain('robot')
  })
  it('shows a 40-character sha as 7 characters in an item\'s number line', () => {
    const sha = '123eec6268b7956526d03c7971a03b6fd8e29b2c'
    const finding = { rule: 'build/dirty', title: `Robot ran uncommitted changes on top of ${sha.slice(0, 7)}`, evidence: { 'git sha': sha } }
    const item = { finding, level: 'red', proof: '', action: 'x', explains: [] } as unknown as ForesightReportInput['items'][number]
    const text = JSON.stringify(foresightCard({ ...base, items: [item] }).items)
    expect(text).not.toContain(sha)
  })
  it('keeps a number line whose digits only appear inside another number in the title', () => {
    const finding = { rule: 'can/device-dropout', title: 'Intake roller dropped off CAN for 13 s', evidence: { 'devices dropped': 1 } }
    const item = { finding, level: 'red', proof: '', action: 'x', explains: [] } as unknown as ForesightReportInput['items'][number]
    expect(foresightCard({ ...base, items: [item] }).items[0].number).toBe('devices dropped: 1')
  })
  it('drops the uncommitted box only when the first item, which is always drawn, says it', () => {
    const mk = (title: string, level = 'red') => ({ finding: { rule: 'x', title, evidence: {} }, level, proof: '', action: 'x', explains: [] }) as unknown as ForesightReportInput['items'][number]
    expect(foresightCard({ ...base, items: [mk('Robot ran uncommitted changes on top of 123eec6')] }).uncommitted).toBe(false)
    expect(foresightCard({ ...base, items: [mk('Battery low'), mk('Robot ran uncommitted changes on top of 123eec6', 'amber')] }).uncommitted).toBe(true)
  })
  it('shortens shas with one helper and counts the checks that did not run only when there are some', () => {
    const sha = '123eec6268b7956526d03c7971a03b6fd8e29b2c'
    expect(shortShas(`${sha} and ${sha.slice(0, 7)}`)).toBe('123eec6 and 123eec6')
    expect(didNotRun(11, 21)).toBe('11 of 21 checks not fully run')
    expect(didNotRun(0, 21)).toBeNull()
  })
  it('a withdrawn verdict prints as NOT CHECKED, never GO', () => {
    const c = foresightCard({ ...base, verdict: 'NOT CHECKED', why: 'not connected', build: null })
    expect(c.heading).toBe('NOT CHECKED')
    expect(c.headingTone).toBe('muted')
    expect(c.uncommitted).toBe(false)
    expect(buildCard(c).svg).toContain('NOT CHECKED')
  })
})

describe('printed report component', () => {
  it('names a crashed rule in the not-checked line and never says "every rule ran" then', async () => {
    const { render } = await import('svelte/server')
    const { default: ReviewReport } = await import('../src/ui/ReviewReport.svelte')
    const a = analyzeFixture('p0-brownout').analyses[0]
    const crashed = { ...a, report: { ...a.report, skipped: [], crashed: [{ rule: 'x/boom', reason: 'it threw' }] } }
    const html = render(ReviewReport, { props: { analysis: crashed, issues: new Map() } }).body
    expect(html).toContain('1 rule crashed')
    expect(html).toContain('x/boom (crashed: it threw)')
    expect(html).not.toContain('every rule ran')
    const clean = render(ReviewReport, { props: { analysis: { ...a, report: { ...a.report, skipped: [], crashed: [] } }, issues: new Map() } }).body
    expect(clean).toContain('every rule ran')
  })
})

describe('Foresight printed report component', () => {
  it('prints the did-not-run sub-line, a "–" before Not checked, and no ws URL', async () => {
    const { render } = await import('svelte/server')
    const { default: ForesightReport } = await import('../src/ui/ForesightReport.svelte')
    const sha = '123eec6268b7956526d03c7971a03b6fd8e29b2c'
    const finding = { rule: 'build/dirty', key: 'k', title: 'Robot ran uncommitted changes', evidence: { 'git sha': sha } }
    const checked = { verdict: { verdict: 'NO-GO', items: [{ finding, level: 'red', proof: '', action: 'x', explains: [] }], notChecked: [{ rule: 'a/b', reason: 'r' }], crashed: [] }, match: { build: { sha, branch: 'b', dirty: 'clean' } } }
    const onchecks = [{ line: 'Line A', state: 'ok', detail: '' }, { line: 'Line B', state: 'not checked', detail: '' }]
    const props = { status: { state: 'connected', message: 'Connected', url: 'ws://secret-host:5810/nt' }, checked, verdict: 'NO-GO', why: 'x', onchecks, battery: 12.6, controllers: [], totalChecks: 21 }
    const html = render(ForesightReport, { props: props as never }).body
    expect(html).toContain('1 of 21 checks not fully run')
    expect(html).toContain('– Not checked')
    expect(html).not.toContain('secret-host')
    expect(html).not.toContain(sha)
    expect(render(ForesightReport, { props: { ...props, checked: { ...checked, verdict: { ...checked.verdict, notChecked: [] } } } as never }).body).not.toContain('not fully run')
  })
})

describe('keyNumber fallback (no measured value)', () => {
  const base = { rule: 'alerts/passthrough', severity: 'error', key: 'k', time: 0 } as unknown as Finding
  it('skips evidence lines without a number', () => {
    const f = { ...base, title: 'Alert "X" during the match', evidence: { group: 'Alerts', 'seconds during the match': 4.4 } } as Finding
    expect(keyNumber(f).text).toBe('seconds during the match: 4.4')
  })
  it('marks the number as already in the title', () => {
    const f = { ...base, title: 'Alert "X" 7× during the match', evidence: { group: 'Alerts', 'times during the match': 7 } } as Finding
    expect(keyNumber(f).inTitle).toBe(true)
  })
})
