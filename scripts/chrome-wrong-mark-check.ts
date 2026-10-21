/**
 * The "not a real problem" mark, rendered: headless Chrome on the built hindsight.html (file://). Load several matches
 * of one event, mark one check "not a real problem" on the first, save the history, then start over with an empty
 * browser and load the logs again with that history file. The check's reds on the other matches should be amber with
 * the reason, and every finding of a marked check should carry a "How sure" line. Last, mark it a real problem on one of
 * them: that red comes back and How sure counts it.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-wrong-mark-check.ts <out-dir> <rule> <match to mark, e.g. "Qualification 13"> <log> <log> [<log> ...]
 *
 * The rule must be red on the match to mark and fire on at least one other: a wrong mark demotes only reds
 * (track-record.ts demotion), so a warning rule such as power/margin has nothing to show. On the CalGames Q13, Q21
 * and Q42 logs, power/limit-not-applied does. A run that can't go on stops with exit code 1 and says why.
 *
 * Writes check.json, the history file it made, and screenshots to <out-dir>. The reason it types is a made-up test
 * string; nothing here is a real label.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [outArg, RULE, MARK_ON, ...logArgs] = process.argv.slice(2)
if (!outArg || !RULE || !MARK_ON || logArgs.filter((f) => f.endsWith('.wpilog')).length < 2) { console.error('usage: chrome-wrong-mark-check.ts <out-dir> <rule> <match to mark> <log> <log> [<log> ...] (at least two .wpilog matches)'); process.exit(2) }
const out = resolve(outArg)
mkdirSync(out, { recursive: true })
const logs = logArgs.map((f) => resolve(f))
const REASON = 'test reason: switched off on purpose'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = mkdtempSync(`${tmpdir()}/hindsight-chrome-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill()) // an error anywhere below would otherwise leave Chrome running
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

const close = async () => { ws.close(); chrome.kill(); await sleep(500); rmSync(profile, { recursive: true, force: true }) }
// Stops the run with what it found so far, closing Chrome rather than leaving it running.
async function fail(why: string): Promise<never> {
  writeFileSync(join(out, 'check.json'), JSON.stringify(result, null, 1))
  console.error(`chrome-wrong-mark-check: ${why}`)
  await close()
  process.exit(1)
}
async function shot(name: string) {
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid)
  writeFileSync(join(out, name), Buffer.from(result.data, 'base64'))
}
// Waits until the match bar lists `matches` logs (a .dslog or history file adds none).
async function drop(files: string[], matches: number) {
  const { result: { root } } = await send('DOM.getDocument', {}, sid)
  const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".wpilog,.dslog,.jsonl"]' }, sid)
  await send('DOM.setFileInputFiles', { nodeId, files }, sid)
  for (let i = 0; i < 300; i++) { await sleep(200); if ((await evalIn(`document.querySelectorAll('nav.matches button').length`)) >= matches) break }
  await sleep(300)
}
const pick = (label: string) => evalIn(`[...document.querySelectorAll('nav.matches button')].find(b => b.innerText.includes(${JSON.stringify(label)}))?.click() ?? 'missing'`)
const labels = () => evalIn(`[...document.querySelectorAll('nav.matches button span')].map(s => s.innerText)`)
// Every row of the check in the match in view, open: its severity, badge, notes and How sure line.
const rows = () => evalIn(`(() => {
  for (const d of document.querySelectorAll('details.known-section')) d.open = true
  return [...document.querySelectorAll('li.finding')].filter(li => li.querySelector(':scope > details > summary .rule')?.innerText === ${JSON.stringify(RULE)}).map(li => {
    li.querySelector(':scope > details').open = true
    return {
      severity: li.className.replace('finding', '').trim(),
      section: li.closest('details.known-section') ? 'known' : 'active',
      title: li.querySelector('.title')?.innerText,
      notes: [...li.querySelectorAll(':scope > details > .body .issue-note')].map(p => p.innerText),
      howSure: li.querySelector(':scope > details > .body .sure')?.innerText ?? null,
      buttons: [...li.querySelectorAll(':scope > details > .body .actions button')].map(b => b.innerText),
    }
  })
})()`)
const head = () => evalIn(`({ counts: document.querySelector('.counts')?.innerText, history: [...document.querySelectorAll('p.history')].find(p => p.offsetParent)?.innerText ?? null, known: document.querySelector('details.known-section h3')?.innerText ?? null })`)

const result: Record<string, unknown> = {}
await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sid)
await sleep(1000)
const MATCHES = logs.filter((f) => f.endsWith('.wpilog')).length
await drop(logs, MATCHES)
result.matches = await labels()
if (!(result.matches as string[]).some((l) => l.includes(MARK_ON))) await fail(`no open match is named ${MARK_ON} (open: ${(result.matches as string[]).join(', ')})`)

// 1. Mark the check "not a real problem" on one match.
await pick(MARK_ON)
await sleep(300)
result.before = { head: await head(), rows: await rows() }
await evalIn(`window.prompt = () => ${JSON.stringify(REASON)}`)
result.clicked = await evalIn(`(() => {
  const li = [...document.querySelectorAll('li.finding')].find(li => li.querySelector(':scope > details > summary .rule')?.innerText === ${JSON.stringify(RULE)} && li.classList.contains('error'))
  const b = li && [...li.querySelectorAll(':scope > details > .body .actions button')].find(b => b.innerText.startsWith('Not a real problem'))
  if (!b) return 'missing'
  b.click(); return 'clicked'
})()`)
if (result.clicked !== 'clicked') {
  const seen = (result.before as { rows: { severity: string }[] }).rows.map((r) => r.severity.split(' ')[0])
  await fail(`${RULE} has no red finding on ${MARK_ON} to mark (its rows there: ${seen.join(', ') || 'none'}). A wrong mark demotes only reds; pick a check that is red on that match.`)
}
await sleep(400)
result.afterMark = { head: await head(), rows: await rows() }
await shot('1-marked.png')
const history = await evalIn(`localStorage.getItem('hindsight.history')`)
if (!history) await fail('the mark was clicked but nothing was saved in localStorage (hindsight.history)')
const historyFile = join(out, 'hindsight-history.jsonl')
writeFileSync(historyFile, history)
result.history = history.trim().split('\n').map((l: string) => JSON.parse(l))

// 2. An empty browser: no history, so nothing is demoted and no How sure line shows.
await evalIn(`localStorage.clear()`)
await send('Page.reload', {}, sid)
await sleep(1500)
await drop(logs, MATCHES)
const others = ((await labels()) as string[]).filter((l) => !l.includes(MARK_ON))
if (!others.length) await fail(`no match other than ${MARK_ON} is open, so nothing can be demoted`)
await pick(others[0])
await sleep(300)
result.noHistory = { match: others[0], head: await head(), rows: await rows() }

// 3. Load the history file too: the other matches show the check amber, with the reason and How sure.
await drop([historyFile], MATCHES)
await sleep(1500)
result.withHistory = {}
for (const label of others) {
  await pick(label)
  await sleep(300)
  ;(result.withHistory as Record<string, unknown>)[label] = { head: await head(), rows: await rows() }
}
await pick(others[0])
await sleep(300)
await rows()
await shot('2-demoted.png')
await pick(MARK_ON)
await sleep(300)
result.markedMatchAfterReload = { head: await head(), rows: await rows() }
await shot('3-marked-match-after-reload.png')

// 4. Mark the check a real problem on the next match: it goes back to red there (a look beats a wrong mark elsewhere),
// stays in the list, and How sure counts it.
await pick(others[0])
await sleep(300)
await evalIn(`window.prompt = () => 'test note'`)
result.clickedReal = await evalIn(`(() => {
  const li = [...document.querySelectorAll('li.finding')].find(li => li.querySelector(':scope > details > summary .rule')?.innerText === ${JSON.stringify(RULE)})
  if (li) li.querySelector(':scope > details').open = true // a closed row's buttons have no innerText
  const b = li && [...li.querySelectorAll(':scope > details > .body .actions button')].find(b => b.innerText.startsWith('Real problem'))
  if (!b) return 'missing'
  b.click(); return 'clicked'
})()`)
if (result.clickedReal !== 'clicked') await fail(`${RULE} has no "Real problem" button on ${others[0]}: the check did not fire there`)
await sleep(400)
result.afterReal = { match: others[0], head: await head(), rows: await rows() }
await shot('4-real.png')

writeFileSync(join(out, 'check.json'), JSON.stringify(result, null, 1))
console.log(JSON.stringify(result, null, 1))
await close()
