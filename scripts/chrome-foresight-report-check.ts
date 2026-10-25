/**
 * The Foresight report end to end: the built hindsight.html opened from file:// in headless Google Chrome, connected to
 * one of the team's logs (tests/helpers/team-logs.ts) replayed as the robot's NT4 stream (tests/helpers/nt4-replay-server.ts), then printed to PDF with the
 * print stylesheet and its phone card saved as a PNG, exactly as "Save for Slack" does (minus the print dialog).
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-foresight-report-check.ts <out-dir> [--dark]
 *
 * Replays log C (expect NO-GO: uncommitted code) and log A (expect GO), each tethered in the pit. Writes
 * foresight-<name>.report.pdf and foresight-<name>.card.png, and prints the verdict seen on screen.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startReplayServer } from '../tests/helpers/nt4-replay-server.ts'
import { LOGS } from '../tests/helpers/load.ts'

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
  { name: 'c', file: 'c' as const, speed: 10, expect: 'NO-GO' },
  { name: 'a', file: 'a' as const, speed: 30, expect: 'GO' },
]
const results: object[] = []
try {
  await start()
  for (const c of cases) {
    const server = await startReplayServer({ bytes: new Uint8Array(readFileSync(log(c.file))), pit: true, speed: c.speed })
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
    let verdict = ''
    for (let i = 0; i < 80; i++) { // up to 40 s for a verdict (not "NOT CHECKED")
      await sleep(500)
      verdict = await evalIn(sessionId, `document.querySelector('.verdict .big')?.innerText ?? ''`)
      if (verdict === 'GO' || verdict === 'NO-GO') break
    }
    await sleep(1200) // one more second of updates, so the report is stamped with a settled reading
    const button = await evalIn(sessionId, `[...document.querySelectorAll('.readings button')].map(b => b.innerText)`)
    const { result: pdf } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 }, sessionId)
    writeFileSync(`${outDir}/foresight-${c.name}.report.pdf`, Buffer.from(pdf.data, 'base64'))
    const png: string | null = await evalIn(sessionId, 'hindsight.foresightCardPng()')
    if (png) writeFileSync(`${outDir}/foresight-${c.name}.card.png`, Buffer.from(png.split(',')[1], 'base64'))
    results.push({ case: c.name, expected: c.expect, seen: verdict, ok: verdict === c.expect, buttons: button, card: !!png })
    await send('Target.closeTarget', { targetId })
    await server.close()
  }
  console.log(JSON.stringify({ page, chrome: execSync(`"${CHROME}" --version`).toString().trim(), results }, null, 1))
} finally {
  ws?.close()
  chrome?.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
