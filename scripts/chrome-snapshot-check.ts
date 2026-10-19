/**
 * Rendered check of the Robot snapshot view: load the example profile and the synthetic "before" snapshot into the
 * built page (file://, headless Chrome, the page's own file input), read what the page shows, then add the "after"
 * snapshot and read the diff. Prints the numbers and screenshots; exits 1 if any check fails.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-snapshot-check.ts <out-dir> [page.html]
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, page = 'hindsight.html'] = process.argv.slice(2)
const fixture = (name: string) => resolve('fixtures/robot-snapshot', name)
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
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
const consoleErrors: string[] = []
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception') })
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 2400, deviceScaleFactor: 1, mobile: false }, sessionId)
await send('Page.navigate', { url: `file://${resolve(page)}` }, sessionId)
await sleep(1000)
await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Robot snapshot').click()`)
await sleep(200)

async function setFiles(files: string[]) {
  const { result: { root } } = await send('DOM.getDocument', { depth: -1 }, sessionId)
  const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".json"][multiple]' }, sessionId)
  await send('DOM.setFileInputFiles', { nodeId, files }, sessionId)
  await sleep(600)
}
async function shot(name: string) {
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, 'base64'))
}

await setFiles([fixture('example-profile.json'), fixture('snapshot-before.json')])
const seen = await evalIn(sessionId, `(() => {
  const text = (el) => el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  const groups = [...document.querySelectorAll('.limits .group')].map(g => ({ group: g.dataset.group, status: g.dataset.status,
    differs: [...g.querySelectorAll('tr[data-status="differs"]')].map(r => ({ motor: r.dataset.motor, badCells: [...r.querySelectorAll('td.bad')].map(text) })) }))
  return {
    profile: document.querySelector('select[aria-label="Robot profile"]')?.selectedOptions[0]?.innerText,
    groups,
    missing: [...document.querySelectorAll('.inventory tr[data-status="missing"]')].map(text),
    statusCounts: [...document.querySelectorAll('.inventory tr[data-status]')].reduce((m, r) => (m[r.dataset.status] = (m[r.dataset.status] || 0) + 1, m), {}),
    faults: [...document.querySelectorAll('.faults tr[data-device]')].map(text),
    banner: text(document.querySelector('.faults .banner')),
    alerts: [...document.querySelectorAll('.limits [role=alert]')].map(text),
  }
})()`)
await shot('snapshot-before')

await setFiles([fixture('snapshot-after.json')])
const diff = await evalIn(sessionId, `({ note: document.querySelector('.diff .note')?.innerText, rows: [...document.querySelectorAll('.diff tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()) })`)
await shot('snapshot-diff')

// Phone width: nothing may push the page sideways (wide tables scroll inside their own box).
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sessionId)
await sleep(300)
const phone = await evalIn(sessionId, `({ scrollWidth: document.documentElement.scrollWidth, innerWidth })`)
await shot('snapshot-phone')

const shooter = seen.groups.find((g: any) => g.group === 'Shooter')
const checks: Record<string, boolean> = {
  'profile chosen automatically': /Example robot/.test(seen.profile ?? ''),
  'limit mismatch on exactly one follower (12), supply limit 60 A': shooter?.status === 'differs' && shooter.differs.length === 1 && shooter.differs[0].motor === 'Shooter follower 12' && shooter.differs[0].badCells.join() === '60 A',
  'missing device (Intake roller, CAN 20)': seen.missing.length === 1 && /Intake roller/.test(seen.missing[0]) && /20/.test(seen.missing[0]),
  'sticky Undervoltage on exactly one motor (follower 11)': seen.faults.length === 1 && /Shooter follower 11/.test(seen.faults[0]) && /Undervoltage/.test(seen.faults[0]),
  'a clean group (Drive)': seen.groups.some((g: any) => g.group === 'Drive' && g.status === 'clean' && g.differs.length === 0),
  'clear-faults banner shown': /Clear faults only after you've saved this snapshot/.test(seen.banner ?? ''),
  'diff: exactly one change, follower 12 supply limit 60 → 40': diff.rows.length === 1 && /Talon FX vers\. C 12/.test(diff.rows[0]) && /Supply Current Limit/.test(diff.rows[0]) && /60\s+40$/.test(diff.rows[0]),
  'no horizontal scroll at 375 px': phone.scrollWidth <= phone.innerWidth,
  'no page errors': consoleErrors.length === 0,
}
console.log(JSON.stringify({ chrome: execSync(`"${CHROME}" --version`).toString().trim(), page, seen, diff, phone, consoleErrors, checks, passed: Object.values(checks).filter(Boolean).length, of: Object.keys(checks).length }, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
