/**
 * Render Power -> Headroom on one log in headless Chrome from file://: 1366x768 and 390x844 (with #app.phone, as the
 * iPhone app mounts it), light and dark, each saved as a PNG of the section, with the page's scroll width.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-headroom-check.ts <out-dir> <log.wpilog> [<built html, default hindsight.html>]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, file, built = 'hindsight.html'] = process.argv.slice(2)
if (!outDir || !file) { console.error('usage: chrome-headroom-check.ts <out-dir> <log.wpilog> [built html]'); process.exit(2) }
mkdirSync(outDir, { recursive: true })
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
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = async (method: string, params: object = {}) => { const m = await send(method, params, sessionId); if (m.error) throw new Error(`${method}: ${m.error.message}`); return m.result }
const ev = async (expression: string) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
const view = (width: number, height: number) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 })

await call('Page.enable')
await view(1366, 768)
await call('Page.navigate', { url: `file://${resolve(built)}` })
await sleep(1000)
await ev(`[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Match review').click()`)
await sleep(300)
const { root } = await call('DOM.getDocument', {})
const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#app > div:not([hidden]) > section.drop input[type=file][accept]' })
await call('DOM.setFileInputFiles', { nodeId, files: [resolve(file)] })
for (let i = 0; i < 600; i++) { await sleep(100); if (await ev(`!!(document.querySelector('.match-head h2') || document.querySelector('.problem'))`)) break }
await ev(`[...document.querySelectorAll('.tabs button')].find(b => b.innerText === 'Power').click()`)
await sleep(800)
const out: Record<string, unknown> = {}
for (const [w, h] of [[1366, 768], [390, 844]]) {
  await view(w, h)
  await ev(`document.querySelector('#app').classList.toggle('phone', ${w < 500})`)
  for (const s of ['light', 'dark']) {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] })
    await sleep(300)
    const box = await ev(`(() => {
      const h = [...document.querySelectorAll('h3')].find(x => x.innerText.startsWith('Headroom'))
      if (!h) return null
      let end = h; while (end.nextElementSibling && end.nextElementSibling.tagName !== 'H3') end = end.nextElementSibling
      h.scrollIntoView({ block: 'start' })
      const a = h.getBoundingClientRect(), b = end.getBoundingClientRect(), t = document.querySelector('table.headroom').getBoundingClientRect()
      return { y: a.top + scrollY - 8, height: b.bottom - a.top + 16, tableWidth: t.width, pageWidth: document.documentElement.scrollWidth, innerWidth }
    })()`)
    if (!box) { out[`${w}-${s}`] = 'no Headroom section'; continue }
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: box.y, width: w, height: box.height, scale: 1 } })
    writeFileSync(join(outDir, `headroom-${w}-${s}.png`), Buffer.from(shot.data, 'base64'))
    out[`${w}-${s}`] = { tableWidthPx: Math.round(box.tableWidth), pageScrollWidthPx: box.pageWidth, innerWidth: box.innerWidth }
  }
}
out.text = await ev(`(() => { const h = [...document.querySelectorAll('h3')].find(x => x.innerText.startsWith('Headroom')); let t = '', e = h; while (e && (e === h || e.tagName !== 'H3')) { t += e.innerText + '\\n'; e = e.nextElementSibling } return t })()`)
console.log(JSON.stringify(out, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
