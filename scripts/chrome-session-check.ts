/**
 * Load many logs into the Session view of the built hindsight.html (file://, headless Chrome, the page's own file
 * input) and report time per log, peak memory, and the longest stretch the page couldn't respond.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-session-check.ts <out-dir> <folder-of-wpilogs>
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, folder] = process.argv.slice(2)
const files = readdirSync(folder).filter((f) => f.endsWith('.wpilog')).map((f) => resolve(join(folder, f)))
const profile = mkdtempSync(`${tmpdir()}/hindsight-chrome-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--enable-precise-memory-info', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let wsUrl = ''
for (let i = 0; i < 50 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(200) } }
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const evalIn = async (sid: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value
const rss = () => execSync('ps -axo rss=,command=').toString().split('\n').filter((l) => l.includes(profile) && l.includes('--type=renderer')).reduce((s, l) => s + parseInt(l.trim()), 0) / 1024

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1600, deviceScaleFactor: 1, mobile: false }, sessionId)
await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sessionId)
await sleep(1000)
await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Session').click()`)
await sleep(300)
// Watch how long the page goes without running a timer: the longest stall a student would feel.
await evalIn(sessionId, `window.__gap = 0; let last = performance.now(); setInterval(() => { const now = performance.now(); window.__gap = Math.max(window.__gap, now - last); last = now }, 20); 0`)
const before = rss()
let peak = before
const sampler = setInterval(() => { peak = Math.max(peak, rss()) }, 100)
const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".wpilog"]' }, sessionId)
const started = Date.now()
await send('DOM.setFileInputFiles', { nodeId, files }, sessionId)
let progress = ''
for (let i = 0; i < 3000; i++) {
  await sleep(200)
  progress = await evalIn(sessionId, `document.querySelector('.progress')?.innerText ?? ''`)
  if (new RegExp(`^${files.length} of ${files.length} logs`).test(progress)) break
}
const wallMs = Date.now() - started
clearInterval(sampler)
await sleep(500)
const sessions = await evalIn(sessionId, `[...document.querySelectorAll('.sessions button')].map(b => b.innerText.replace(/\\n/g, ' '))`)
const gap = await evalIn(sessionId, 'window.__gap')
const heap = await evalIn(sessionId, 'performance.memory.usedJSHeapSize / 1048576')
const { result: shot } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(`${outDir}/session-${files.length}.png`, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ chrome: execSync(`"${CHROME}" --version`).toString().trim(), logs: files.length, wallMs, msPerLog: Math.round(wallMs / files.length), progress, longestStallMs: Math.round(gap), jsHeapAfterMB: Math.round(heap), rendererRssBeforeMB: Math.round(before), rendererRssPeakMB: Math.round(peak), sessions }, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
