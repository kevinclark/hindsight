/**
 * Foresight's On checks in a real browser, during a replayed enable: the built hindsight.html from file:// in headless
 * Google Chrome, connected to a pit run replayed as the robot's NT4 stream (tests/helpers/nt4-replay-server.ts).
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-foresight-oncheck.ts <out-dir> <pit-run.wpilog> [--speed 4]
 *
 * It samples the page every 0.5 s and, the first time the On checks block marks a line amber while the robot is still
 * enabled, screenshots it at the window's width and again at 390 px (the phone app mounts the same pages), recording
 * whether the page is wider than the screen there (scrollWidth vs innerWidth). Then it lets the replay run to the log's
 * end (its length over the speed) and screenshots the last state, and the On checks block once the robot stops sending. Prints JSON: each distinct verdict, each distinct On checks reading, the moments shot.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startReplayServer } from '../tests/helpers/nt4-replay-server.ts'
import { openWpilog } from '../src/readers/wpilog.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, logPath, ...rest] = process.argv.slice(2)
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null }
const speed = Number(flag('--speed') ?? 4)
const page = `file://${resolve('hindsight.html')}`
const profileDir = mkdtempSync(`${tmpdir()}/foresight-oncheck-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1000,1400', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdpUrl() {
  for (let i = 0; i < 50; i++) {
    try { return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl } catch { await sleep(200) }
  }
  throw new Error('Chrome did not start')
}
const ws = new WebSocket(await cdpUrl())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
})
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const evalIn = async (sessionId: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value

const bytes = new Uint8Array(readFileSync(logPath))
const replayLog = openWpilog(bytes)
/** Wall seconds the replay takes, plus a margin for connecting. */
const budget = (replayLog.lastTime - Math.max(0, replayLog.firstTime)) / speed + 40
const server = await startReplayServer({ bytes, pit: true, speed })
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: page }, sessionId)
await sleep(800)
await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Robot check').click()`)
await sleep(200)
await evalIn(sessionId, `(() => { const i = document.querySelector('.connect input'); i.value = '127.0.0.1:${server.port}'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
await evalIn(sessionId, `[...document.querySelectorAll('.connect button')].find(b => b.innerText === 'Connect').click()`)

const read = `({ verdict: document.querySelector('.verdict .big')?.innerText ?? '', why: document.querySelector('.verdict p:nth-child(2)')?.innerText ?? '',
  onRun: [...document.querySelectorAll('.onrun .oc')].map(li => li.innerText.replace(/\\s+/g, ' ')),
  amber: !!document.querySelector('.onrun .oc.amber'), status: [...document.querySelectorAll('.connect .status')].map((e) => e.innerText).join(' | ') })`
async function shot(name: string, width: number | null) {
  if (width) await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId)
  await sleep(400)
  const fit = await evalIn(sessionId, `({ scrollWidth: document.documentElement.scrollWidth, innerWidth: innerWidth })`)
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, 'base64'))
  if (width) await send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
  return { name, width: width ?? 1000, ...fit }
}

const verdicts = new Set<string>()
const readings = new Set<string>()
const shots: object[] = []
const started = Date.now()
while (Date.now() - started < budget * 1000) {
  await sleep(500)
  const s = await evalIn(sessionId, read)
  verdicts.add(`${s.verdict} | ${s.why.replace(/\d+ s\b/g, 'n s')}`)
  const pair = s.onRun.find((l: string) => /one shaft/.test(l)) ?? ''
  readings.add(pair.replace(/\d+(\.\d+)? s\b/g, 'n s'))
  if (!shots.length && s.amber && /enabled/.test(s.why)) {
    shots.push({ t: (Date.now() - started) / 1000, why: s.why, pair, ...(await shot('oncheck-enabled-1000', null)) })
    shots.push(await shot('oncheck-enabled-390', 390))
  }
  // The replay ended (a pit run powered off): the last grade should stay, headed as the last.
  if (/No data from the robot/i.test(s.status)) { await sleep(1500); shots.push({ heading: await evalIn(sessionId, `document.querySelector('.onrun h3')?.innerText ?? ''`), ...(await shot('oncheck-stopped-1000', null)) }); break }
  if (/closed/i.test(s.status)) break
}
shots.push(await shot('oncheck-end-1000', null))
shots.push(await shot('oncheck-end-390', 390))
const last = await evalIn(sessionId, read)
console.log(JSON.stringify({ page, speed, verdicts: [...verdicts], pairReadings: [...readings], shots, last }, null, 1))
await server.close()
ws.close()
chrome.kill()
await sleep(500)
rmSync(profileDir, { recursive: true, force: true })
