/**
 * Render the Session view's Trends table on the real logs, in headless Chrome from file://, and report its height:
 * 1366x768 and 375 px wide, light and dark, each saved as a PNG of the table; then the printed Session report (print
 * media, letter) as a PNG and a PDF, with the PDF's page count (page 1 plus the grid page = 2; more means page 1 overflowed).
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-trends-check.ts <out-dir> <folder-of-wpilogs> [<built html, default hindsight.html>]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, folder, built = 'hindsight.html'] = process.argv.slice(2)
if (!outDir || !folder) { console.error('usage: chrome-trends-check.ts <out-dir> <folder-of-wpilogs> [built html]'); process.exit(2) }
mkdirSync(outDir, { recursive: true })
const files = readdirSync(folder).filter((f) => f.endsWith('.wpilog')).sort().map((f) => resolve(join(folder, f)))
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
const scheme = (s: string) => call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] })
const view = async (width: number, height: number) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 })

await call('Page.enable')
await view(1366, 768)
await call('Page.navigate', { url: `file://${resolve(built)}` })
await sleep(1000)
await ev(`[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Session').click()`)
await sleep(300)
const { root } = await call('DOM.getDocument', {})
const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".wpilog"][multiple]:not([webkitdirectory])' })
await call('DOM.setFileInputFiles', { nodeId, files })
for (let i = 0; i < 1500; i++) { await sleep(200); if (new RegExp(`^${files.length} of ${files.length} logs`).test(await ev(`document.querySelector('.progress')?.innerText ?? ''`))) break }
await sleep(800)

const out: Record<string, unknown> = { logs: files.length }
for (const [w, h] of [[1366, 768], [375, 812]]) {
  await view(w, h)
  for (const s of ['light', 'dark']) {
    await scheme(s)
    await sleep(300)
    const box = await ev(`(() => { const t = document.querySelector('table.trends'); t.scrollIntoView({ block: 'start' }); const r = t.getBoundingClientRect(); const top = r.top + scrollY; const k = t.nextElementSibling?.getBoundingClientRect(); return { x: 0, y: Math.max(0, top - 8), width: ${w}, height: r.height + 16 + (k ? k.height : 0), table: r.height, tableTopFromPageTop: top, tableWidth: r.width, pageWidth: document.documentElement.scrollWidth } })()`)
    const { table, tableTopFromPageTop, tableWidth, pageWidth, ...clip } = box
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } })
    writeFileSync(join(outDir, `trends-${w}-${s}.png`), Buffer.from(shot.data, 'base64'))
    out[`${w}-${s}`] = { tableHeightPx: Math.round(table * 10) / 10, tableTopFromPageTopPx: Math.round(tableTopFromPageTop), tableWidthPx: Math.round(tableWidth), pageScrollWidthPx: pageWidth }
  }
}
await scheme('light')
await view(816, 1056)
await call('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await sleep(300)
const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(join(outDir, 'report-print-media.png'), Buffer.from(shot.data, 'base64'))
await call('Emulation.setEmulatedMedia', { media: '' })
const pdf = Buffer.from((await call('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 })).data, 'base64')
writeFileSync(join(outDir, 'report.pdf'), pdf)
out.reportPdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
// Last, since it leaves the Session view: the first row's worst match opens that match in Match review.
await call('Emulation.setEmulatedMedia', { media: '' })
await view(1366, 768)
await sleep(300)
out.worstLink = await ev(`(() => { const b = document.querySelector('table.trends td.worst button'); if (!b) return { clicked: null }; const label = b.innerText, title = b.title; b.click(); return { clicked: label, title } })()`)
await sleep(1500)
out.afterClick = await ev(`({ mode: [...document.querySelectorAll('.modes button')].find(b => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('active') || b.getAttribute('aria-current'))?.innerText ?? null, text: document.querySelector('main')?.innerText.slice(0, 300) ?? document.body.innerText.slice(0, 300) })`)
writeFileSync(join(outDir, 'after-worst-click.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
console.log(JSON.stringify(out, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
