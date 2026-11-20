/**
 * The Foresight report end to end: the built hindsight.html opened from file:// in headless Google Chrome, connected to
 * one of the team's logs (tests/helpers/team-logs.ts) replayed as the robot's NT4 stream (tests/helpers/nt4-replay-server.ts), then printed to PDF with the
 * print stylesheet and its phone card saved as a PNG, exactly as "Save for Slack" does (minus the print dialog).
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-foresight-report-check.ts <out-dir> [--dark]
 *
 * Replays log C (uncommitted code) and log A (committed), each tethered in the pit with no next match, so the box shows
 * the practice-start list's end ("Ready to drive" or "N left"), never GO or NO-GO. Expect C's open items to include
 * "No undeployed changes" (build/dirty) and A's not to. Writes foresight-<name>.report.pdf and
 * foresight-<name>.card.png, prints the word and open items seen on screen, and exits 1 if a case differs.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startReplayServer } from '../tests/helpers/nt4-replay-server.ts'
import { LOGS } from '../tests/helpers/load.ts'
import { checkAfterLastEnable } from '../tests/helpers/foresight-timing.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2)
const dark = args.includes('--dark')
const [outDir] = args.filter((a) => !a.startsWith('--'))
if (!outDir) { console.error('usage: chrome-foresight-report-check.ts <out-dir> [--dark]'); process.exit(2) }
mkdirSync(outDir, { recursive: true })
const page = `file://${resolve('hindsight.html')}`
const profile = mkdtempSync(`${tmpdir()}/foresight-report-`)
const port = 9300 + Math.floor(Math.random() * 500)
let chrome: ChildProcess | undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (k: 'a' | 'b' | 'c') => LOGS[k]

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try { return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl } catch { await sleep(200) }
  }
  throw new Error('Chrome did not start')
}
let ws!: WebSocket
let nextId = 1
/** Start Chrome and connect. Called inside the try below, so a failure still kills Chrome and removes the profile. */
async function start() {
  chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1000,1400', 'about:blank'], { stdio: 'ignore' })
  ws = new WebSocket(await cdp())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
}
const pending = new Map<number, (v: any) => void>()
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const evalIn = async (sessionId: string, expression: string) => {
  const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result
  if (r?.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r?.result?.value
}

const cases = [
  { name: 'c', file: 'c' as const, speed: 10, undeployed: true },
  { name: 'a', file: 'a' as const, speed: 20, undeployed: false },
]
const UNDEPLOYED = 'No undeployed changes' // the practice-start line build/dirty leaves open (src/foresight/onchecks.ts)
const PRACTICE_END = /^(Ready to drive|\d+ left)$/
const results: object[] = []
try {
  await start()
  for (const c of cases) {
    const bytes = new Uint8Array(readFileSync(log(c.file)))
    const timing = checkAfterLastEnable(bytes, `log ${c.name.toUpperCase()}`)
    const server = await startReplayServer({ bytes, pit: true, speed: c.speed })
    const wallAt = (robotTime: number) => Date.now() + ((robotTime - timing.first) / c.speed) * 1000 // the replay clock starts at the log's first record
    const checkFrom = timing.at === null ? Date.now() : wallAt(timing.at)
    const replayEnds = wallAt(timing.last)
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    if (dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId)
    await send('Page.navigate', { url: page }, sessionId)
    await sleep(800)
    await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Robot check').click()`)
    await sleep(200)
    await evalIn(sessionId, `(() => { const i = document.querySelector('.connect input'); i.value = ${JSON.stringify(`127.0.0.1:${server.port}`)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await evalIn(sessionId, `[...document.querySelectorAll('.connect button')].find(b => b.innerText === 'Connect').click()`)
    // A pit check with no next match is practice: the box ends "Ready to drive" or "N left", never GO (ForesightView's
    // shownWord). The first such word comes before the robot is enabled, and while it is enabled or recovering the box
    // says NOT CHECKED: wait for the word that grades the log's last enable, plus one check interval
    // (src/foresight/live.ts, 1 s) for the page to take the next reading.
    const wait = Math.max(0, checkFrom - Date.now()) + 1100
    console.error(`foresight ${c.name}: waiting ${(wait / 1000).toFixed(1)} s for the check after the log's last enable`)
    await sleep(wait)
    let verdict = ''
    for (let i = 0; i < 60; i++) { // then up to 30 s for a word other than NOT CHECKED
      verdict = await evalIn(sessionId, `document.querySelector('.verdict .big')?.innerText ?? ''`)
      if (!['', 'NOT CHECKED'].includes(verdict.split(':')[0])) break
      await sleep(500)
    }
    await sleep(1200) // one more second of updates, so the report is stamped with a settled reading
    const button = await evalIn(sessionId, `[...document.querySelectorAll('.readings button')].map(b => b.innerText)`)
    const { result: pdf } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 }, sessionId)
    writeFileSync(`${outDir}/foresight-${c.name}.report.pdf`, Buffer.from(pdf.data, 'base64'))
    const png: string | null = await evalIn(sessionId, 'hindsight.foresightCardPng()')
    if (png) writeFileSync(`${outDir}/foresight-${c.name}.card.png`, Buffer.from(png.split(',')[1], 'base64'))
    // Once the replay runs out the page reads a silent robot ("reading the robot…"): the report must come before.
    const inTime = Date.now() <= replayEnds
    if (!inTime) console.error(`foresight ${c.name}: the replay ended before the report was saved: lower this log's speed (${c.speed}x)`)
    const open: string = await evalIn(sessionId, `document.querySelector('.verdict .big')?.nextElementSibling?.innerText ?? ''`)
    const ok = PRACTICE_END.test(verdict) && open.includes(UNDEPLOYED) === c.undeployed && inTime && !!png
    results.push({ case: c.name, expected: `${c.undeployed ? '' : 'no '}"${UNDEPLOYED}" open`, seen: verdict, open, ok, buttons: button, card: !!png })
    await send('Target.closeTarget', { targetId })
    await server.close()
  }
  console.log(JSON.stringify({ page, chrome: execSync(`"${CHROME}" --version`).toString().trim(), results }, null, 1))
  if (results.some((r) => !(r as { ok: boolean }).ok)) process.exitCode = 1
} finally {
  ws?.close()
  chrome?.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
