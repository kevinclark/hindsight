/**
 * Does a loaded session survive switching views, and a page reload? Headless Chrome on the built hindsight.html
 * (file://): load logs in Session, open one in Match review, come back, then reload the page.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-persist-check.ts <log.wpilog> [...]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const files = process.argv.slice(2).map((f) => resolve(f))
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
const click = (text: string) => evalIn(`[...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)}))?.click() ?? 'missing'`)
const sessionText = () => evalIn(`(document.querySelector('.sessions')?.innerText ?? '') + ' | ' + ([...document.querySelectorAll('.note')].map(n => n.innerText).find(t => t.startsWith('Restored')) ?? '')`)
await send('Page.enable', {}, sid)
await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sid)
await sleep(1000)
await click('Session')
const { result: { root } } = await send('DOM.getDocument', {}, sid)
const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".wpilog"]' }, sid)
await send('DOM.setFileInputFiles', { nodeId, files }, sid)
for (let i = 0; i < 100; i++) { await sleep(200); if (new RegExp(`^${files.length} of ${files.length} logs`).test(await evalIn(`document.querySelector('.progress')?.innerText ?? ''`))) break }
const out: Record<string, unknown> = { loaded: await sessionText() }
// Open the first match from the grid, which switches to Match review, then come back.
await evalIn(`document.querySelector('.grid th.match button')?.click()`)
await sleep(1500)
out.inReview = await evalIn(`document.querySelector('.match-head h2')?.innerText ?? 'no match'`)
await click('Session')
await sleep(300)
out.backInSession = await sessionText()
await click('Limits wizard'); await sleep(200); await click('Match review'); await sleep(200)
out.reviewStillLoaded = await evalIn(`document.querySelector('.match-head h2')?.innerText ?? 'no match'`)
await send('Page.reload', {}, sid)
await sleep(2500)
await click('Session')
await sleep(500)
out.afterReload = await sessionText()
console.log(JSON.stringify(out, null, 1))
ws.close(); chrome.kill(); await sleep(500); rmSync(profile, { recursive: true, force: true })
