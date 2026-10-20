/**
 * The "not a real problem" mark in the Session view, rendered: headless Chrome on the built hindsight.html (file://).
 * Load an event's logs into the Session view, mark one check "not a real problem" on one match in Match review (the
 * real button), then read the Session view: the check's row, its grid cells, the printed report's line, the
 * session-findings.json entry and the phone card. Then start over with no history (the summaries stay saved in the
 * browser), and load the saved history file: the Session view should say the same as it did right after the mark.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-session-wrong-mark-check.ts <out-dir> <rule> <matches to mark, e.g. "Qualification 13" or "Qualification 13,Qualification 21"> <log> [<log> ...]
 *
 * Marking every match the check fired in should move its row out of the findings, the bottom line and the card, into
 * the "marked not a real problem in every match" list.
 *
 * Writes check.json, the history file it made, the card and screenshots to <out-dir>. The reason it types is a made-up
 * test string; nothing here is a real label.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [outArg, RULE, MARK_ON, ...logArgs] = process.argv.slice(2)
const out = resolve(outArg)
mkdirSync(out, { recursive: true })
const logs = logArgs.map((f) => resolve(f))
const REASON = 'test reason: switched off on purpose'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = mkdtempSync(`${tmpdir()}/hindsight-chrome-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let wsUrl = ''
for (let i = 0; i < 50 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(200) } }
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true })
const evalIn = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value
await send('Page.enable', {}, sid)
await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, sid)

async function shot(name: string) {
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid)
  writeFileSync(join(out, name), Buffer.from(result.data, 'base64'))
}
const mode = async (name: string) => { await evalIn(`[...document.querySelectorAll('.modes button')].find(b => b.innerText === ${JSON.stringify(name)}).click()`); await sleep(300) }
async function setFiles(selector: string, files: string[]) {
  const { result: { root } } = await send('DOM.getDocument', {}, sid)
  const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid)
  await send('DOM.setFileInputFiles', { nodeId, files }, sid)
}
// Match review: waits until the match bar lists `matches` logs (a history file adds none).
async function dropInReview(files: string[], matches: number) {
  await setFiles('input[type=file][accept=".wpilog,.dslog,.jsonl"]', files)
  for (let i = 0; i < 300; i++) { await sleep(200); if ((await evalIn(`document.querySelectorAll('nav.matches button').length`)) >= matches) break }
  await sleep(300)
}
const sessionMatches = () => evalIn(`(window.hindsight.sessionList?.() ?? []).reduce((n, s) => n + s.matches, 0)`)
async function loadSession(files: string[]) {
  await setFiles('[data-session-view] input[type=file][accept=".wpilog"]', files)
  for (let i = 0; i < 600; i++) { await sleep(200); if ((await sessionMatches()) >= files.length && !(await evalIn(`document.querySelector('[data-session-view] .progress')?.innerText.includes('reading')`))) break }
  await sleep(500)
}
const pick = (label: string) => evalIn(`[...document.querySelectorAll('nav.matches button')].find(b => b.innerText.includes(${JSON.stringify(label)}))?.click() ?? 'missing'`)
const labels = () => evalIn(`[...document.querySelectorAll('nav.matches button span')].map(s => s.innerText)`)
// Match review: the check's rows in the match in view (with every fold open: a check that fires in every match of the
// session is folded away, and a closed fold's rows have no innerText).
const reviewRows = () => evalIn(`(() => {
  for (const d of document.querySelectorAll('main details')) d.open = true
  return [...document.querySelectorAll('li.finding')].filter(li => li.querySelector(':scope > details > summary .rule')?.textContent === ${JSON.stringify(RULE)}).map(li => ({
    severity: li.className.replace('finding', '').trim(), section: li.closest('details.known-section') ? 'known' : 'active', title: li.querySelector('.title')?.innerText,
  }))
})()`)
// Session view: the check's merged rows, grid cells, printed-report lines, JSON entries and report-model rows.
const sessionState = () => evalIn(`(() => {
  const view = document.querySelector('[data-session-view]')
  for (const d of view.querySelectorAll('details.once-fold')) d.open = true
  const rows = [...view.querySelectorAll('ul.merged li')].filter(li => li.querySelector('.title code')?.innerText.startsWith(${JSON.stringify(RULE)})).map(li => ({
    className: li.className, chip: li.querySelector('.chip')?.innerText, title: li.querySelector('.title')?.innerText,
    marked: li.querySelector('.marked')?.innerText ?? null, codeColor: getComputedStyle(li.querySelector('.title code')).color,
  }))
  const tr = [...view.querySelectorAll('table.grid tbody tr')].find(tr => tr.querySelector('th code')?.innerText === ${JSON.stringify(RULE)})
  const columns = [...view.querySelectorAll('table.grid thead th.match')].map(th => th.innerText)
  const cells = tr ? [...tr.querySelectorAll('td.cell')].map((td, i) => ({ match: columns[i], className: td.className, title: td.title, color: getComputedStyle(td).color })) : null
  const printed = [...document.querySelectorAll('article.report li.sr-find')].filter(li => li.querySelector('code')?.innerText.startsWith(${JSON.stringify(RULE)})).map(li => li.innerText.replace(/\\s+/g, ' '))
  const json = JSON.parse(window.hindsight.sessionFindingsJson()).findings.filter(f => f.rule === ${JSON.stringify(RULE)}).map(f => ({ key: f.key, severity: f.severity, matches: f.matches, wrong: f.wrong, demoted: f.demoted, issue: f.issue }))
  const report = window.hindsight.sessionReport()
  const model = [...report.findings, ...report.filed].filter(f => f.rule === ${JSON.stringify(RULE)}).map(f => ({ filed: report.filed.includes(f), sevWord: f.sevWord, ratio: f.ratio, marks: f.marks, wrongIn: f.wrongIn }))
  const filedFold = view.querySelector('details.filed-fold summary')?.innerText ?? null
  const printedFiled = [...document.querySelectorAll('article.report p.once')].map(p => p.innerText).filter(t => t.startsWith('Marked not a real problem'))
  const printedGrid = [...document.querySelectorAll('article.report table.grid tbody tr')].find(tr => tr.querySelector('code')?.innerText === ${JSON.stringify(RULE)})?.innerText.replace(/\s+/g, ' ') ?? null
  return { rows, cells, printed, printedFiled, printedGrid, filedFold, json, model, bottomLine: report.bottomLine }
})()`)
async function card(name: string) {
  const url: string | null = await evalIn(`window.hindsight.sessionCardPng()`)
  if (url) writeFileSync(join(out, name), Buffer.from(url.split(',')[1], 'base64'))
}

const result: Record<string, unknown> = {}
await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sid)
await sleep(1000)
const MATCHES = logs.filter((f) => f.endsWith('.wpilog')).length

// 1. The Session view with no history.
await mode('Session')
await loadSession(logs.filter((f) => f.endsWith('.wpilog')))
result.noHistory = await sessionState()

// 2. Mark the check "not a real problem" on one match, with Match review's own button.
await mode('Match review')
await dropInReview(logs, MATCHES)
result.matches = await labels()
await evalIn(`window.prompt = () => ${JSON.stringify(REASON)}`)
result.clicked = []
// After the first mark, the check's reds on the other matches are amber: click the check's open row, whatever colour.
for (const label of MARK_ON.split(',')) {
  await pick(label)
  await sleep(300)
  ;(result.clicked as unknown[]).push(await evalIn(`(() => {
    for (const d of document.querySelectorAll('main details')) d.open = true
    const li = [...document.querySelectorAll('li.finding')].find(li => li.querySelector(':scope > details > summary .rule')?.textContent === ${JSON.stringify(RULE)} && !li.closest('details.known-section'))
    const b = li && [...li.querySelectorAll(':scope > details > .body .actions button')].find(b => b.innerText.startsWith('Not a real problem'))
    if (!b) return 'missing'
    b.click(); return 'clicked'
  })()`))
  await sleep(400)
}
result.review = {}
for (const label of (await labels()) as string[]) {
  await pick(label)
  await sleep(300)
  ;(result.review as Record<string, unknown>)[label] = await reviewRows()
}

// 3. The Session view right after the mark.
await mode('Session')
result.afterMark = await sessionState()
await shot('1-session-after-mark.png')
await card('1-session-card.png')
const history = await evalIn(`localStorage.getItem('hindsight.history')`)
const historyFile = join(out, 'hindsight-history.jsonl')
writeFileSync(historyFile, history ?? '')
result.history = (history ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

// 4. No history in the browser (the log summaries stay saved): back to red.
await evalIn(`localStorage.clear()`)
await send('Page.reload', {}, sid)
await sleep(1500)
await mode('Session')
for (let i = 0; i < 50 && (await sessionMatches()) < MATCHES; i++) await sleep(200)
result.reloadedNoHistory = await sessionState()

// 5. Load the history file (Match review's file input takes it): the Session view says what it said after the mark.
await mode('Match review')
await dropInReview([historyFile], 0)
await sleep(500)
await mode('Session')
result.withHistoryFile = await sessionState()
await shot('2-session-with-history-file.png')

const strip = (s: any) => JSON.stringify({ ...s, json: s.json.map((f: any) => ({ ...f, issue: undefined })) })
result.sameAsAfterMark = strip(result.withHistoryFile) === strip(result.afterMark)
result.sameAsNoHistory = strip(result.reloadedNoHistory) === strip(result.noHistory)
writeFileSync(join(out, 'check.json'), JSON.stringify(result, null, 1))
console.log(JSON.stringify(result, null, 1))
ws.close(); chrome.kill(); await sleep(500); rmSync(profile, { recursive: true, force: true })
