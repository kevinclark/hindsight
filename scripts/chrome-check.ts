/**
 * Open the built hindsight.html from file:// in headless Google Chrome, load logs through the page's own file
 * input, and report timings, memory and screenshots of both tabs. Nothing is uploaded anywhere.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-check.ts <out-dir> <log> [<log> ...]
 *
 * Each argument group separated by "--" is loaded on a fresh page, e.g. one log per page to time each alone.
 * Memory: peak resident size of Chrome's renderer processes, sampled every 50 ms, plus the JS heap.
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, ...rest] = process.argv.slice(2)
const groups: string[][] = [[]]
for (const a of rest) { if (a === '--') groups.push([]); else groups.at(-1)!.push(resolve(a)) }
const page = `file://${resolve('hindsight.html')}`
const profile = mkdtempSync(`${tmpdir()}/hindsight-chrome-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--enable-precise-memory-info', '--no-first-run', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return v.webSocketDebuggerUrl as string } catch { await sleep(200) }
  }
  throw new Error('Chrome did not start')
}

function rendererRssMB(): number {
  const out = execSync('ps -axo rss=,command=').toString()
  return out.split('\n').filter((l) => l.includes(profile) && l.includes('--type=renderer')).reduce((s, l) => s + parseInt(l.trim()), 0) / 1024
}

const ws = new WebSocket(await cdp())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const evalIn = async (sessionId: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value

const results: object[] = []
for (const [gi, files] of groups.entries()) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('DOM.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId)
  await send('Page.navigate', { url: page }, sessionId)
  await sleep(1000)
  const baseRss = rendererRssMB()
  // The app opens on Now: go to Match review, and use that page's own file input (its accept list has grown since this was written).
  await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Match review').click()`)
  const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
  const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#app > div:not([hidden]) > section.drop input[type=file][accept]' }, sessionId)
  let peak = baseRss
  const sampler = setInterval(() => { peak = Math.max(peak, rendererRssMB()) }, 50)
  const started = Date.now()
  await send('DOM.setFileInputFiles', { nodeId, files }, sessionId)
  // Wait until the page shows a match heading (or a problem), up to 60 s.
  let state = ''
  for (let i = 0; i < 600 && !state; i++) { await sleep(100); state = await evalIn(sessionId, `document.querySelector('.match-head h2')?.innerText || document.querySelector('.problem')?.innerText || ''`) }
  const wallMs = Date.now() - started
  await sleep(300)
  clearInterval(sampler)
  const timings = await evalIn(sessionId, 'JSON.stringify(window.hindsight.timings)')
  const heapMB = await evalIn(sessionId, 'performance.memory.usedJSHeapSize / 1048576')
  const shot = async (name: string) => {
    const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, 'base64'))
  }
  const label = files.map((f) => f.split('/').pop()!.replace(/\.(wpilog|dslog)$/, '')).join('+').replace(/[^\w+.-]/g, '_')
  await shot(`chrome-${gi}-${label}-match`)
  await evalIn(sessionId, `[...document.querySelectorAll('.tabs button')].find(b => b.innerText === 'Power').click()`)
  await sleep(500)
  await shot(`chrome-${gi}-${label}-power`)
  const powerText = await evalIn(sessionId, `document.querySelector('main').innerText.slice(0, 400)`)
  results.push({ files: files.map((f) => f.split('/').pop()), heading: state, wallMs, timings: JSON.parse(timings), heapMB: Math.round(heapMB), rendererRssBeforeMB: Math.round(baseRss), rendererRssPeakMB: Math.round(peak), powerText })
  await send('Target.closeTarget', { targetId })
}
console.log(JSON.stringify({ page, chrome: execSync(`"${CHROME}" --version`).toString().trim(), results }, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
