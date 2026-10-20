/**
 * Write the shareable report for each log: the same files the "Save for Slack" and "Download for Claude" buttons make,
 * from the built hindsight.html opened from file:// in headless Google Chrome. Nothing is uploaded anywhere.
 *
 *   node --experimental-strip-types scripts/report.ts <out-dir> <log> [<dslog>] [-- <log> [<dslog>] …] [--no-build] [--dark]
 *
 * Runs `npm run build` first (hindsight.html is gitignored) unless --no-build. Each group separated by "--" is
 * loaded on a fresh page. Per group it writes, named from the .wpilog:
 *   <log>.report.pdf      Page.printToPDF with the print stylesheet (Letter)
 *   <log>.card.png        the phone card, from the page's own card code
 *   <log>.findings.json   the same builder as "Download for Claude"
 * --dark emulates a dark colour scheme first, to check that print stays light.
 * The log input is selected by its accept list: input[type=file] alone also matches the Snapshot view's .json input.
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2)
const flags = new Set<string>(args.filter((a) => a === '--no-build' || a === '--dark'))
const [outDir, ...rest] = args.filter((a) => !flags.has(a))
if (!outDir || rest.length === 0) { console.error('usage: report.ts <out-dir> <log> [<dslog>] [-- <log> …] [--no-build] [--dark]'); process.exit(2) }
const groups: string[][] = [[]]
for (const a of rest) { if (a === '--') groups.push([]); else groups.at(-1)!.push(resolve(a)) }
mkdirSync(outDir, { recursive: true })
if (!flags.has('--no-build')) execSync('npm run build', { stdio: 'inherit' })

const page = `file://${resolve('hindsight.html')}`
const profile = mkdtempSync(`${tmpdir()}/hindsight-report-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try { return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl } catch { await sleep(200) }
  }
  throw new Error('Chrome did not start')
}
const ws = new WebSocket(await cdp())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const evalIn = async (sessionId: string, expression: string) => {
  const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result
  if (r?.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r?.result?.value
}

const written: string[] = []
const summaries: object[] = []
try {
  for (const files of groups) {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('DOM.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId)
    if (flags.has('--dark')) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId)
    await send('Page.navigate', { url: page }, sessionId)
    await sleep(1000)
    const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
    const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".wpilog,.dslog,.jsonl"]' }, sessionId)
    if (!nodeId) throw new Error('the log file input was not found in hindsight.html')
    await send('DOM.setFileInputFiles', { nodeId, files }, sessionId)
    let state = ''
    for (let i = 0; i < 600 && !state; i++) { await sleep(100); state = await evalIn(sessionId, `document.querySelector('.match-head h2')?.innerText || document.querySelector('.problem')?.innerText || ''`) }
    if (!(await evalIn(sessionId, `!!document.querySelector('.match-head h2')`))) throw new Error(`${files.join(' ')}: ${state || 'timed out'}`)
    await sleep(300)
    const jsonName: string = await evalIn(sessionId, 'hindsight.findingsFile()')
    const base = jsonName.replace(/\.findings\.json$/, '')
    writeFileSync(`${outDir}/${jsonName}`, await evalIn(sessionId, 'hindsight.findingsJson()'))
    const png: string = await evalIn(sessionId, 'hindsight.reviewCardPng()')
    writeFileSync(`${outDir}/${base}.card.png`, Buffer.from(png.split(',')[1], 'base64'))
    const { result: pdf } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 }, sessionId)
    writeFileSync(`${outDir}/${base}.report.pdf`, Buffer.from(pdf.data, 'base64'))
    // What the Match tab itself lists (audience "Everyone"), so the report can be checked against the screen.
    const listed: string[] = await evalIn(sessionId, `[...document.querySelectorAll('.findings > li.finding')].filter(li => !li.closest('.known-section')).map(li => li.querySelector('.title').innerText.trim())`)
    summaries.push({ base, listed: listed.length, titles: listed })
    written.push(`${base}.report.pdf`, `${base}.card.png`, jsonName)
    await send('Target.closeTarget', { targetId })
  }
  console.log(written.map((w) => `${outDir}/${w}`).join('\n'))
  console.log(JSON.stringify(summaries))
} finally {
  ws.close()
  chrome.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
