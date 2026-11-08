/**
 * Writes the phone's demo fixture (fixtures/phone/event.json): an invented event (key 2099test, event TEST) whose match
 * summaries come from the repository's own synthetic fixture logs, renamed Q1..Q5, as two laptops' event files, plus a
 * history file with invented marks. The page loads it with ?phone-fixture in a dev build (src/phone-fixture.ts), so the
 * phone layout can be seen and screenshotted without a Drive. Run: node --experimental-strip-types scripts/phone-fixture.ts
 */
import { writeFileSync } from 'node:fs'
import { loadFixture } from '../tests/helpers/load.ts'
import { summarizeLog, SUMMARY_SHAPE, type MatchSummary } from '../src/session/summary.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { serializeEventLine, withoutMarks } from '../src/hub/event-file.ts'

const NAMES = ['brownout', 'follower-mismatch', 'drive-plateau', 'flywheel-spinups', 'auto-and-comms']
const START = Date.UTC(2099, 2, 5, 17)
const sha = (n: number) => n.toString(16).padStart(64, '0')

const lines: string[][] = [[], []]
NAMES.forEach((name, i) => {
  const s = summarizeLog(loadFixture(name)[0], offseason2026)!
  const n = i + 1
  const summary: MatchSummary = { ...withoutMarks(s), fileName: `test_q${n}.wpilog`, event: 'TEST', matchLabel: `Qualification ${n}`, matchType: 2, onField: true, playedAt: START + i * 50 * 60e3, playedAtSource: 'robot clock', clockNote: null, problems: [] }
  lines[i % 2].push(serializeEventLine({ sha256: sha(n), analyzer: '0.1.0+demo', shape: SUMMARY_SHAPE, at: START + i * 50 * 60e3 + 120e3, summary }))
})
const first = Object.values(JSON.parse(lines[0][0]).summary.rules as MatchSummary['rules']).flatMap((r) => r.findings)
const keys = first.map((f) => f.key)
const when = (min: number) => new Date(START + min * 60e3).toISOString()
const history = [
  { type: 'issue', key: keys[0], status: 'known', note: 'test reason: battery swapped after Q1', when: when(30), match: 'TEST Qualification 1', event: 'TEST' },
  ...(keys[1] ? [{ type: 'issue', key: keys[1], status: 'wrong', note: 'test reason', when: when(31), match: 'TEST Qualification 1', event: 'TEST', played: new Date(START).toISOString() }] : []),
].map((e) => `${JSON.stringify(e)}\n`).join('')

writeFileSync('fixtures/phone/event.json', `${JSON.stringify({
  note: 'Invented event for the phone layout (scripts/phone-fixture.ts): summaries of the synthetic fixture logs, renamed.',
  files: { 'events/2099test--laptop-a.jsonl': lines[0].join(''), 'events/2099test--laptop-b.jsonl': lines[1].join(''), 'history/laptop-a.jsonl': history },
}, null, 1)}\n`)
console.log(`wrote ${lines.flat().length} lines, ${history.split('\n').length - 1} marks`)
