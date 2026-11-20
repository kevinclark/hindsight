/**
 * The Logging tab as a student sees it: open the built hindsight.html from file:// in headless Chrome, load one match
 * log through the page's own file input, open the Logging tab (desktop and phone width), then load a set of logs into
 * the Session view and read its "Logging across the session" section. Saves screenshots and prints what the page shows.
 * Nothing is uploaded anywhere.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-logging-check.ts <out-dir> <match.wpilog> -- <session logs ...>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, matchLog, sep, ...sessionLogs] = process.argv.slice(2)
if (!outDir || !matchLog || (sep && sep !== '--')) throw new Error('usage: chrome-logging-check.ts <out-dir> <match.wpilog> -- <session logs ...>')
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
const evalIn = async (sid: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sid)
await send('DOM.enable', {}, sid)
const size = (width: number, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 1, mobile }, sid)
const shot = async (name: string) => {
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid)
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, 'base64'))
}
const fileInput = async (selector: string) => {
  const { result: { root } } = await send('DOM.getDocument', {}, sid)
  return (await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid)).result.nodeId
}
const click = (container: string, text: string) => evalIn(sid, `[...document.querySelectorAll('${container}')].find(b => b.innerText.trim() === ${JSON.stringify(text)}).click()`)
// The page is wider than the screen when anything sticks out sideways (the phone check).
const overflow = () => evalIn(sid, 'document.documentElement.scrollWidth - document.documentElement.clientWidth')

await size(1000)
await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sid)
await sleep(1000)
// The app opens on Now: go to Match review first, then use its own drop input (the visible view's: the accept list has
// grown, and input[type=file] alone also matches other views' inputs).
await click('.modes button', 'Match review')
await sleep(300)
const logInput = await fileInput('#app > div:not([hidden]) > section.drop input[type=file][accept]')
if (!logInput) throw new Error('the Match review log input was not found in hindsight.html')
await send('DOM.setFileInputFiles', { nodeId: logInput, files: [resolve(matchLog)] }, sid)
let heading = ''
for (let i = 0; i < 600 && !heading; i++) { await sleep(100); heading = await evalIn(sid, `document.querySelector('.match-head h2')?.innerText || document.querySelector('#app > div:not([hidden]) .problem')?.innerText || ''`) }
if (!(await evalIn(sid, `!!document.querySelector('.match-head h2')`))) throw new Error(`${matchLog}: ${heading || 'timed out'}`)
await click('.tabs button', 'Logging')
await sleep(500)
if (!(await evalIn(sid, `document.querySelector('.tabs button.active')?.innerText.trim() === 'Logging'`))) throw new Error('the Logging tab did not open')
const name = matchLog.split('/').pop()!.replace(/\.wpilog$/, '')
await shot(`logging-${name}`)
const tab = await evalIn(sid, `document.querySelector('main').innerText`)
await size(375, true)
await sleep(300)
const phoneOverflowPx = await overflow()
await shot(`logging-${name}-phone`)

let session = null
if (sessionLogs.length) {
  await size(1100)
  await click('.modes button', 'Session')
  await sleep(300)
  const files = sessionLogs.map((f) => resolve(f))
  const sessionInput = await fileInput('[data-session-view] input[type=file][multiple][accept=".wpilog"]')
  if (!sessionInput) throw new Error('the Session view log input was not found in hindsight.html')
  await send('DOM.setFileInputFiles', { nodeId: sessionInput, files }, sid)
  // Done when the progress line says "N of N logs", or, at an event, when the log chooser (progress line and all) has
  // folded away to its one line, which it does only once nothing is loading (SessionView's `folded`).
  let ready = false
  for (let i = 0; i < 3000 && !ready; i++) {
    await sleep(200)
    ready = await evalIn(sid, `new RegExp(${JSON.stringify(`^${files.length} of ${files.length} logs`)}).test(document.querySelector('.progress')?.innerText ?? '') || !!document.querySelector('[data-folded]')`)
  }
  if (!ready) throw new Error(`the Session view did not finish loading: ${await evalIn(sid, `document.querySelector('.progress')?.innerText || document.querySelector('#app > div:not([hidden]) .problem')?.innerText || 'nothing'`)}`)
  await sleep(800)
  // An event session opens on its Board; "Logging across the session" is on the other tab.
  await evalIn(sid, `[...document.querySelectorAll('[data-session-view] [role=tab]')].find(b => b.innerText.trim() === 'Findings, grid and trends')?.click()`)
  await sleep(500)
  const section = await evalIn(sid, `(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => x.innerText === 'Logging across the session')
    const out = []
    for (let n = h?.nextElementSibling; n && n.tagName !== 'H3'; n = n.nextElementSibling) out.push(n.innerText)
    return out.join('\\n')
  })()`)
  if (!section) throw new Error('the Session view shows no "Logging across the session" section')
  await evalIn(sid, `[...document.querySelectorAll('h3')].find((x) => x.innerText === 'Logging across the session')?.scrollIntoView()`)
  await shot(`logging-session-${files.length}`)
  session = { logs: files.length, section }
}

console.log(JSON.stringify({ heading, tab, phoneOverflowPx, session }, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
