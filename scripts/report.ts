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
 *
 *   node --experimental-strip-types scripts/report.ts --session <out-dir> <log|folder> [<log|folder> …] [--no-build] [--dark]
 *
 * loads all of them into the Session view (`[data-session-view] input[type=file][multiple][accept=".wpilog"]`) and, for each session found, writes
 *   <label>.session-report.pdf, <label>.session-card.png, <label>.session-findings.json   (the label made file-safe)
 * and prints what the view itself lists, so the PDF can be checked against the screen.
 * --dark emulates a dark colour scheme first, to check that print stays light.
 * --code <robot-code folder> chooses that folder on the page ("Choose code folder…"), so power/limit-not-applied can
 * compare each log's commit with its profile's (src/code/limit-lines.ts). The page's kept answers are seeded from and
 * saved back to --code-cache (default ~/.cache/hindsight/limit-lines.json), as golden.ts keeps them.
 * The log input is selected by its accept list: input[type=file] alone also matches the Snapshot view's .json input.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DEFAULT_CACHE } from '../src/code/node-git-dir.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const codeDir = option('--code')
const cacheFile = option('--code-cache') ?? DEFAULT_CACHE
const ANSWERS = 'hindsight.limitLines'
let answers: Record<string, unknown> = {}
try { answers = JSON.parse(readFileSync(cacheFile, 'utf8')).answers ?? {} } catch { /* no cache file yet */ }
const flags = new Set<string>(args.filter((a) => a === '--no-build' || a === '--dark' || a === '--session'))
const [outDir, ...rest] = args.filter((a) => !flags.has(a))
if (!outDir || rest.length === 0) { console.error('usage: report.ts [--session] <out-dir> <log> [<dslog>] [-- <log> …] [--no-build] [--dark] [--code <folder>] [--code-cache <file>]'); process.exit(2) }
const groups: string[][] = [[]]
for (const a of rest) { if (a === '--') groups.push([]); else groups.at(-1)!.push(resolve(a)) }
/** A folder given to --session stands for the .wpilog files in it. */
const expand = (paths: string[]) => paths.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.wpilog$/i.test(f)).sort().map((f) => `${p}/${f}`) : [p]))
mkdirSync(outDir, { recursive: true })
if (!flags.has('--no-build')) execSync('npm run build', { stdio: 'inherit' })

const page = `file://${resolve('hindsight.html')}`
const profile = mkdtempSync(`${tmpdir()}/hindsight-report-`)
const port = 9300 + Math.floor(Math.random() * 500)
let chrome: ChildProcess | undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' })
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

/** --code: seed the page's kept limit-line answers, choose the folder, and wait until the page shows it. */
async function useCodeFolder(sessionId: string) {
  if (!codeDir) return
  await evalIn(sessionId, `localStorage.setItem(${JSON.stringify(ANSWERS)}, ${JSON.stringify(JSON.stringify(answers))})`)
  const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
  const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-code-folder]' }, sessionId)
  if (!nodeId) throw new Error('the code folder input was not found in hindsight.html')
  await send('DOM.setFileInputFiles', { nodeId, files: [resolve(codeDir)] }, sessionId)
  let shown = ''
  for (let i = 0; i < 300 && !shown; i++) { await sleep(100); shown = await evalIn(sessionId, `[...document.querySelectorAll('.code-folder .chip, .code-folder ~ .problem')].map(e => e.innerText).join(' ')`) }
  if (!shown.startsWith('code: ')) throw new Error(`the page did not take the code folder: ${shown || 'timed out'}`)
}
/** --code: keep what the page worked out, for the next run. */
async function keepAnswers(sessionId: string) {
  if (!codeDir) return
  answers = { ...answers, ...JSON.parse((await evalIn(sessionId, `localStorage.getItem(${JSON.stringify(ANSWERS)})`)) ?? '{}') }
}

const written: string[] = []
const summaries: object[] = []
try {
  await start()
  if (flags.has('--session')) {
    const files = expand(groups.flat())
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('DOM.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId)
    if (flags.has('--dark')) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId)
    await send('Page.navigate', { url: page }, sessionId)
    await sleep(1000)
    await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText.trim() === 'Session').click()`)
    await useCodeFolder(sessionId)
    const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
    const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-session-view] input[type=file][multiple][accept=".wpilog"]' }, sessionId)
    if (!nodeId) throw new Error('the Session view log input was not found in hindsight.html')
    await send('DOM.setFileInputFiles', { nodeId, files }, sessionId)
    // Done when the progress line says "N of N logs" and a session is listed.
    let ready = false
    for (let i = 0; i < 1800 && !ready; i++) {
      await sleep(100)
      ready = await evalIn(sessionId, `(() => { const m = /^\\s*(\\d+) of (\\d+) logs/.exec(document.querySelector('.progress')?.innerText || ''); return !!m && m[1] === m[2] && !!document.querySelector('.sessions button') })()`)
    }
    if (!ready) throw new Error(`the Session view did not finish loading: ${await evalIn(sessionId, `document.querySelector('.progress')?.innerText || document.querySelector('.problem')?.innerText || 'nothing'`)}`)
    const sessions: { id: string; label: string; matches: number }[] = await evalIn(sessionId, 'hindsight.sessionList()')
    for (const s of sessions) {
      await evalIn(sessionId, `hindsight.selectSession(${JSON.stringify(s.id)})`)
      await sleep(300)
      const base: string = await evalIn(sessionId, 'hindsight.sessionBase()')
      if (!(await evalIn(sessionId, `document.querySelector('.head h2')?.innerText.startsWith(${JSON.stringify(s.label)})`))) throw new Error(`session "${s.label}" did not come up on screen`)
      writeFileSync(`${outDir}/${base}.session-findings.json`, await evalIn(sessionId, 'hindsight.sessionFindingsJson()'))
      const png: string = await evalIn(sessionId, 'hindsight.sessionCardPng()')
      writeFileSync(`${outDir}/${base}.session-card.png`, Buffer.from(png.split(',')[1], 'base64'))
      const { result: pdf } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 }, sessionId)
      writeFileSync(`${outDir}/${base}.session-report.pdf`, Buffer.from(pdf.data, 'base64'))
      // What the Session view itself lists (the merged findings), and what the report lists, for checking against each other.
      const listed: string[] = await evalIn(sessionId, `[...document.querySelectorAll('ul.merged > li')].map(li => li.querySelector('.title').innerText.trim())`)
      const reported: number = await evalIn(sessionId, `document.querySelectorAll('.sr-find').length`)
      const model = await evalIn(sessionId, 'hindsight.sessionReport()')
      summaries.push({ base, matches: s.matches, viewMerged: listed.length, reportRows: reported, foldedOnce: model.onceFold?.count ?? 0, reportFindings: model.findings.length, bottomLine: model.bottomLine })
      written.push(`${base}.session-report.pdf`, `${base}.session-card.png`, `${base}.session-findings.json`)
    }
    await keepAnswers(sessionId)
    await send('Target.closeTarget', { targetId })
  } else for (const files of groups) {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('DOM.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId)
    if (flags.has('--dark')) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId)
    await send('Page.navigate', { url: page }, sessionId)
    await sleep(1000)
    await useCodeFolder(sessionId)
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
    await keepAnswers(sessionId)
    await send('Target.closeTarget', { targetId })
  }
  if (codeDir) {
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ version: 1, answers }, null, 1))
  }
  console.log(written.map((w) => `${outDir}/${w}`).join('\n'))
  console.log(JSON.stringify(summaries))
} finally {
  ws?.close()
  chrome?.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
