/**
 * One-command screenshot set of every Hindsight view, for a UX review that re-rates the same views each round on
 * identical inputs. The built hindsight.html is opened from file:// in headless Google Chrome (the same approach as
 * the other scripts/chrome-*-check.ts), and each view is captured at a 1366x768 laptop viewport, above the fold and
 * full page, in light and dark (prefers-color-scheme emulated). Nothing is uploaded anywhere.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/ux-shots.ts <out-dir> --logs <folder of .wpilog> --dslog <file.dslog> [--compare <previous out-dir>]
 *
 * --logs    folder holding the match logs. Matches are picked by file-name suffix: _q13 (loaded together with --dslog),
 *           _p0 (the newest by name if there are two) and _q21. The Session view loads every .wpilog in the folder.
 *           The Foresight views replay those same three logs as the robot's NT4 stream.
 * --dslog   the Driver Station log that goes with the _q13 match.
 * --compare an earlier run's out-dir: index.html then shows its shot of the same name beside each new one, marked
 *           "changed" or "same" by a byte compare (PDFs: the creation/modification dates are masked first).
 *
 * Writes <NN>-<view>-<input>-<viewport>-<scheme>.png (PDFs and phone cards have their own viewport/scheme words),
 * index.json (one entry per artifact, console errors per view) and index.html (a contact sheet that works from file://).
 * The file names and the set of shots depend only on the inputs. Where the page shows a wall-clock time or a timing
 * (the footer's milliseconds, Foresight's live readings), it is left as the page drew it, so those shots can differ
 * between runs; --compare says which.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startReplayServer } from '../tests/helpers/nt4-replay-server.ts'
import { writeWpilog, type FixtureEntry } from '../tests/helpers/fixture-format.ts'
import { makeSnapshotJson, type FakeTalon } from '../tests/helpers/make-snapshot.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WIDTH = 1366
const HEIGHT = 768
const MAX_FULL_HEIGHT = 16000 // Chrome cannot capture a taller texture than this
const SCHEMES = ['light', 'dark'] as const
type Scheme = (typeof SCHEMES)[number]

// --- arguments ------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const flagNames = ['--logs', '--dslog', '--compare']
const positional = argv.filter((a, i) => !a.startsWith('--') && !flagNames.includes(argv[i - 1]))
const usage = 'usage: ux-shots.ts <out-dir> --logs <folder of .wpilog> --dslog <file.dslog> [--compare <previous out-dir>]'
if (positional.length !== 1 || !flag('--logs') || !flag('--dslog')) { console.error(usage); process.exit(2) }
const outDir = resolve(positional[0])
const logsDir = resolve(flag('--logs')!)
const dslogPath = resolve(flag('--dslog')!)
const compareDir = flag('--compare') ? resolve(flag('--compare')!) : null
const pageFile = join(ROOT, 'hindsight.html')
if (!existsSync(pageFile)) { console.error('hindsight.html is missing: run `npm run build` first'); process.exit(2) }
if (compareDir && !existsSync(compareDir)) { console.error(`--compare folder not found: ${compareDir}`); process.exit(2) }
const page = `file://${pageFile}`

const allLogs = readdirSync(logsDir).filter((f) => f.endsWith('.wpilog')).sort()
const pick = (suffix: string) => allLogs.filter((f) => f.endsWith(`_${suffix}.wpilog`)).at(-1) // newest by name (names carry the date)
const MATCHES = [
  { id: 'q13', file: pick('q13'), withDs: true },
  { id: 'p0', file: pick('p0'), withDs: false },
  { id: 'q21', file: pick('q21'), withDs: false },
]
for (const m of MATCHES) if (!m.file) { console.error(`no *_${m.id}.wpilog in ${logsDir}`); process.exit(2) }
if (!existsSync(dslogPath)) { console.error(`--dslog file not found: ${dslogPath}`); process.exit(2) }
const logPath = (f: string) => join(logsDir, f)

// --- Chrome / CDP ---------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true })
const profile = mkdtempSync(`${tmpdir()}/hindsight-uxshots-`)
const scratch = mkdtempSync(`${tmpdir()}/hindsight-uxshots-in-`)
const port = 9300 + Math.floor(Math.random() * 500)
let chrome: ChildProcess | undefined
let ws!: WebSocket
let nextId = 1
const pending = new Map<number, (v: any) => void>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Console errors collected for the page (CDP session) each view is currently using. */
const errorSinks = new Map<string, string[]>()

async function start() {
  chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'], { stdio: 'ignore' })
  let url = ''
  for (let i = 0; i < 100 && !url; i++) {
    try { url = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl } catch { await sleep(200) }
  }
  if (!url) throw new Error('Chrome did not start')
  ws = new WebSocket(url)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return }
    const sink = errorSinks.get(m.sessionId)
    if (!sink) return
    if (m.method === 'Runtime.exceptionThrown') sink.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '?'}`.split('\n')[0])
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') sink.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300))
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') sink.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`.slice(0, 300))
  })
}
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })

class Tab {
  readonly targetId: string
  readonly sid: string
  readonly errors: string[]
  constructor(targetId: string, sid: string, errors: string[]) { this.targetId = targetId; this.sid = sid; this.errors = errors }
  call(method: string, params: object = {}) { return send(method, params, this.sid).then((m) => { if (m.error) throw new Error(`${method}: ${m.error.message}`); return m.result }) }
  async eval(expression: string) {
    const r = (await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result?.value
  }
  async scheme(s: Scheme) { await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] }); await sleep(150) }
  async setFiles(selector: string, files: string[]) {
    const { root } = await this.call('DOM.getDocument', { depth: -1 })
    const { nodeId } = await this.call('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`no element matches ${selector}`)
    await this.call('DOM.setFileInputFiles', { nodeId, files })
  }
  async clickText(selector: string, text: string) {
    const ok = await this.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
    if (!ok) throw new Error(`no ${selector} with text "${text}"`)
    await sleep(300)
  }
  /** Poll `expression` until it is truthy, up to `seconds`. */
  async waitFor(expression: string, seconds: number, what: string) {
    for (let i = 0; i < seconds * 10; i++) { if (await this.eval(expression)) return; await sleep(100) }
    throw new Error(`timed out after ${seconds} s waiting for ${what}`)
  }
  close() { errorSinks.delete(this.sid); return send('Target.closeTarget', { targetId: this.targetId }) }
}

async function openTab(): Promise<Tab> {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  const errors: string[] = []
  errorSinks.set(sessionId, errors)
  const tab = new Tab(targetId, sessionId, errors)
  for (const d of ['Page', 'DOM', 'Runtime', 'Log']) await tab.call(`${d}.enable`)
  await tab.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await tab.scheme('light')
  return tab
}
async function freshPage(): Promise<Tab> {
  const tab = await openTab()
  await tab.call('Page.navigate', { url: page })
  await tab.waitFor(`document.querySelector('.modes') !== null`, 20, 'the page to render')
  await sleep(300)
  return tab
}

// --- artifacts ------------------------------------------------------------------------------------------------
interface Entry {
  file: string
  view: string
  input: string
  viewport: string
  scheme: string
  kind: 'png' | 'pdf'
  pages?: number
  truncated?: boolean
  consoleErrors: string[]
}
const entries: Entry[] = []
const failures: { view: string; error: string }[] = []
const viewErrors = new Map<string, string[]>()
const viewTitles = new Map<string, string>() // group heading in the contact sheet, by "NN-view"
const pad = (n: number) => String(n).padStart(2, '0')

/** Save one artifact and add it to the index. `view` is the slug part of the file name, `slot` the NN. */
function save(slot: number, view: string, title: string, input: string, viewport: string, scheme: string, ext: 'png' | 'pdf', data: Buffer, errors: string[], extra: Partial<Entry> = {}) {
  const file = `${pad(slot)}-${view}-${input}-${viewport}-${scheme}.${ext}`
  writeFileSync(join(outDir, file), data)
  viewTitles.set(`${pad(slot)}-${view}`, title)
  viewErrors.set(`${pad(slot)}-${view}`, errors)
  entries.push({ file, view: `${pad(slot)}-${view}`, input, viewport, scheme, kind: ext, consoleErrors: errors, ...extra })
}

/** Light and dark, viewport and full page, of what the tab shows now. `focus` limits the full-page shot to one element. */
async function shootBoth(tab: Tab, slot: number, view: string, title: string, input: string, focus?: string) {
  for (const scheme of SCHEMES) {
    await tab.scheme(scheme)
    await tab.eval(focus ? `document.querySelector(${JSON.stringify(focus)}).scrollIntoView({ block: 'start' })` : 'window.scrollTo(0, 0)')
    await sleep(150)
    const fold = await tab.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    save(slot, view, title, input, `${WIDTH}x${HEIGHT}`, scheme, 'png', Buffer.from(fold.data, 'base64'), tab.errors)
    const clip = await tab.eval(focus
      ? `(() => { const r = document.querySelector(${JSON.stringify(focus)}).getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top + scrollY - 8), width: ${WIDTH}, height: r.height + 16 } })()`
      : `({ x: 0, y: 0, width: ${WIDTH}, height: Math.max(${HEIGHT}, document.documentElement.scrollHeight) })`)
    const truncated = clip.height > MAX_FULL_HEIGHT
    const full = await tab.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, height: Math.min(clip.height, MAX_FULL_HEIGHT), scale: 1 } })
    save(slot, view, title, input, `${WIDTH}xfull`, scheme, 'png', Buffer.from(full.data, 'base64'), tab.errors, truncated ? { truncated } : {})
  }
  await tab.scheme('light')
}

/** Page count of a Chrome-printed PDF: its page objects (`/Type /Page`, not `/Type /Pages`). */
function pdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}
async function printPdf(tab: Tab): Promise<Buffer> {
  const pdf = await tab.call('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 })
  return Buffer.from(pdf.data, 'base64')
}
function savePdf(slot: number, view: string, title: string, input: string, pdf: Buffer, tab: Tab) {
  save(slot, view, title, input, 'letter', 'print', 'pdf', pdf, tab.errors, { pages: pdfPages(pdf) })
}
function saveCard(slot: number, view: string, title: string, input: string, dataUrl: string, tab: Tab) {
  save(slot, view, title, input, '1080w', 'any', 'png', Buffer.from(dataUrl.split(',')[1], 'base64'), tab.errors)
}

/** Run one view; a failure is recorded and the rest still run. */
async function view(name: string, body: () => Promise<void>) {
  const t = Date.now()
  const before = entries.length
  try { await body(); console.log(`ok    ${name}: ${entries.length - before} artifacts, ${((Date.now() - t) / 1000).toFixed(1)} s`) } catch (e) {
    failures.push({ view: name, error: e instanceof Error ? e.message : String(e) })
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

// --- the views ------------------------------------------------------------------------------------------------
const LOG_INPUT = 'input[type=file][accept=".wpilog,.dslog,.jsonl"]' // a bare input[type=file] would hit the Snapshot view's .json input
const FIXTURES = join(ROOT, 'fixtures', 'robot-snapshot')

async function emptyScreen() {
  const tab = await freshPage()
  try { await shootBoth(tab, 1, 'empty', 'Empty first screen (nothing loaded)', 'none') } finally { await tab.close() }
}

/** Match review for one match: Match tab with the linked-finding groups closed and open, Power, Limits; then the report. */
async function matchReview(index: number, m: (typeof MATCHES)[number]) {
  const base = 2 + index * 4
  const label = m.id.toUpperCase()
  const tab = await freshPage()
  try {
    await tab.setFiles(LOG_INPUT, m.withDs ? [logPath(m.file!), dslogPath] : [logPath(m.file!)])
    await tab.waitFor(`document.querySelector('.match-head h2') !== null || document.querySelector('.problem') !== null`, 90, 'the match heading')
    if (await tab.eval(`document.querySelector('.match-head h2') === null`)) throw new Error(`log did not load: ${await tab.eval(`document.querySelector('.problem').innerText`)}`)
    await sleep(500)
    // As links-check does: close every finding body (headlines only) with the "Explains N more" groups closed, then open them all.
    await tab.eval(`document.querySelectorAll('.findings details[open]').forEach((d) => (d.open = false))`)
    await sleep(300)
    await shootBoth(tab, base, 'match-groups-closed', `Match review ${label}${m.withDs ? ' (with .dslog)' : ''}: Match tab, linked-finding groups closed`, m.id)
    await tab.eval(`document.querySelectorAll('details.explains').forEach((d) => (d.open = true))`)
    await sleep(300)
    await shootBoth(tab, base + 1, 'match-groups-open', `Match review ${label}: Match tab, linked-finding groups open`, m.id)
    await tab.clickText('.tabs button', 'Power')
    await sleep(300)
    await shootBoth(tab, base + 2, 'power', `Match review ${label}: Power tab`, m.id)
    await tab.clickText('.tabs button', 'Limits')
    await sleep(300)
    await shootBoth(tab, base + 3, 'limits', `Match review ${label}: Limits tab`, m.id)
    // The printed report and the phone card (the Match tab is what prints; light whatever the screen is).
    await tab.clickText('.tabs button', 'Match')
    await sleep(300)
    const reportSlot = 23 + index * 2
    savePdf(reportSlot, 'report', `Printed report (PDF) and phone card (PNG): ${label}`, m.id, await printPdf(tab), tab)
    const png: string | null = await tab.eval('hindsight.reviewCardPng()')
    if (!png) throw new Error('hindsight.reviewCardPng() returned nothing')
    saveCard(reportSlot + 1, 'card', `Phone card (PNG): ${label}`, m.id, png, tab)
  } finally { await tab.close() }
}

async function sessionView() {
  const tab = await freshPage()
  try {
    await tab.clickText('.modes button', 'Session')
    const files = allLogs.map(logPath)
    await tab.setFiles('input[type=file][accept=".wpilog"][multiple]:not([webkitdirectory])', files)
    await tab.waitFor(`/^${files.length} of ${files.length} logs/.test(document.querySelector('.progress')?.innerText ?? '')`, 300, 'every log to be read')
    await sleep(800)
    await shootBoth(tab, 14, 'session', `Session view, ${files.length} logs`, 'all-logs')
    await shootBoth(tab, 15, 'session-trends', 'Session view: Per match trends', 'all-logs', '.multiples')
  } finally { await tab.close() }
}

async function wizardView() {
  const tab = await freshPage()
  try {
    await tab.clickText('.modes button', 'Limits wizard')
    await shootBoth(tab, 16, 'wizard', 'Limits wizard (first step)', 'none')
  } finally { await tab.close() }
}

async function snapshotView() {
  const tab = await freshPage()
  try {
    await tab.clickText('.modes button', 'Robot snapshot')
    const input = 'input[type=file][accept=".json"][multiple]'
    await tab.setFiles(input, [join(FIXTURES, 'example-profile.json'), join(FIXTURES, 'snapshot-before.json')])
    await sleep(800)
    await shootBoth(tab, 17, 'snapshot-before', 'Robot snapshot: before', 'fixture-before')
    await tab.setFiles(input, [join(FIXTURES, 'snapshot-after.json')])
    await sleep(800)
    await shootBoth(tab, 18, 'snapshot-diff', 'Robot snapshot: before to after diff', 'fixture-diff')
  } finally { await tab.close() }
}

/** Synthetic inputs exactly as chrome-builder-check.ts makes them (an AdvantageKit-shaped log and a snapshot). */
function builderInputs(): string[] {
  const num = (name: string, v = 1): FixtureEntry => ({ name, type: 'double', records: [[1, v], [2, v + 1]] })
  const bool = (name: string): FixtureEntry => ({ name, type: 'boolean', records: [[1, true]] })
  const corners = ['FrontLeft', 'FrontRight', 'BackLeft', 'BackRight']
  const entries: FixtureEntry[] = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [25, false], [28, true], [168, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false], [9.5, true], [28, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, true]] },
    { name: '/RealMetadata/ProjectName', type: 'string', records: [[0, 'Example Robot']] },
    { name: '/RealMetadata/GitSHA', type: 'string', records: [[0, 'abc1234def']] },
    { name: '/RealMetadata/GitBranch', type: 'string', records: [[0, 'main']] },
    ...corners.flatMap((m) => ['Drive', 'Turn'].flatMap((t) => [num(`/Drive/${m}/${t}SupplyCurrentAmps`), num(`/Drive/${m}/${t}StatorCurrentAmps`), bool(`/Drive/${m}/${t}Connected`)])),
    ...['Leader', 'Follower 0'].flatMap((m) => [num(`/Shooter/Flywheel/${m}/SupplyCurrentAmps`), num(`/Shooter/Flywheel/${m}/VelocityRotPerSec`)]),
  ]
  const logFile = join(scratch, 'example-q1.wpilog')
  writeFileSync(logFile, writeWpilog(entries))
  const short = ['FL', 'FR', 'BL', 'BR']
  const talons: FakeTalon[] = [
    ...short.map((c, i) => ({ id: 1 + i, name: `${c} Drive` })),
    ...short.map((c, i) => ({ id: 5 + i, name: `${c} Steer` })),
    { id: 20, name: 'Shooter Leader' },
    { id: 21 },
  ]
  const snapFile = join(scratch, 'snapshot.json')
  writeFileSync(snapFile, makeSnapshotJson(talons, '2026-01-01T12:00:00Z'))
  return [logFile, snapFile]
}

async function builderView() {
  const tab = await freshPage()
  try {
    await tab.clickText('.modes button', 'Robot profile')
    await tab.setFiles('input[type=file][multiple][accept=".wpilog,.json"]', builderInputs())
    await tab.waitFor(`document.querySelectorAll('tr[data-motor]').length > 0`, 20, 'the builder to list motors')
    await sleep(500)
    await shootBoth(tab, 19, 'profile-builder', 'Robot profile builder (synthetic log and snapshot)', 'synthetic')
  } finally { await tab.close() }
}

const FORESIGHT = [
  { id: 'p0', slot: 20, file: MATCHES[1].file!, pit: true, speed: 10, mode: 'tethered in the pit' },
  { id: 'q13', slot: 21, file: MATCHES[0].file!, pit: true, speed: 30, mode: 'tethered in the pit' },
  { id: 'q21-field', slot: 22, file: MATCHES[2].file!, pit: false, speed: 5, mode: 'field' },
]

/** Foresight: the log replayed as the robot's NT4 stream; shots once there is a verdict (pit) or the field view. */
async function foresightView(c: (typeof FORESIGHT)[number]) {
  const server = await startReplayServer({ bytes: new Uint8Array(readFileSync(logPath(c.file))), pit: c.pit, speed: c.speed })
  const tab = await freshPage()
  try {
    await tab.clickText('.modes button', 'Foresight')
    await tab.eval(`(() => { const i = document.querySelector('.connect input'); i.value = ${JSON.stringify(`127.0.0.1:${server.port}`)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await tab.clickText('.connect button', 'Connect')
    const ready = c.pit ? `['GO', 'NO-GO'].includes(document.querySelector('.verdict .big')?.innerText ?? '')` : `document.querySelector('.field') !== null`
    await tab.waitFor(ready, 60, 'a Foresight verdict')
    await sleep(1200) // as chrome-foresight-report-check.ts: one more second of updates, so the readings have settled
    await shootBoth(tab, c.slot, 'foresight', `Foresight live view, ${c.id.replace('-field', '').toUpperCase()} replayed as NT4, ${c.mode}`, c.id)
    if (c.pit) {
      const slot = 25 + (c.id === 'p0' ? 0 : 2) + 4 // 29-32: after the three review reports and cards (23-28)
      savePdf(slot, 'foresight-report', `Foresight printed report (PDF) and phone card (PNG): ${c.id.toUpperCase()}`, c.id, await printPdf(tab), tab)
      const png: string | null = await tab.eval('hindsight.foresightCardPng()')
      if (!png) throw new Error('hindsight.foresightCardPng() returned nothing')
      saveCard(slot + 1, 'foresight-card', `Foresight phone card (PNG): ${c.id.toUpperCase()}`, c.id, png, tab)
    }
  } finally { await tab.close(); await server.close() }
}

// --- run ------------------------------------------------------------------------------------------------------
const startedAt = Date.now()
try {
  await start()
  const chromeVersion = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json().then((v: any) => v.Browser as string)
  await view('empty', emptyScreen)
  for (const [i, m] of MATCHES.entries()) await view(`match-review ${m.id}`, () => matchReview(i, m))
  await view('session', sessionView)
  await view('wizard', wizardView)
  await view('snapshot', snapshotView)
  await view('profile-builder', builderView)
  for (const c of FORESIGHT) await view(`foresight ${c.id}`, () => foresightView(c))

  // --- compare, index.json, index.html ------------------------------------------------------------------------
  const maskPdf = (b: Buffer) => Buffer.from(b.toString('latin1').replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, ''), 'latin1')
  const compared = new Map<string, 'same' | 'changed' | 'new'>()
  if (compareDir) {
    for (const e of entries) {
      const prev = join(compareDir, e.file)
      if (!existsSync(prev)) { compared.set(e.file, 'new'); continue }
      const a = readFileSync(join(outDir, e.file)), b = readFileSync(prev)
      compared.set(e.file, (e.kind === 'pdf' ? maskPdf(a).equals(maskPdf(b)) : a.equals(b)) ? 'same' : 'changed')
    }
  }
  entries.sort((a, b) => (a.file < b.file ? -1 : 1))
  const summary = {
    chrome: chromeVersion,
    viewport: `${WIDTH}x${HEIGHT}`,
    inputs: { matches: MATCHES.map((m) => ({ id: m.id, file: m.file, withDslog: m.withDs })), sessionLogs: allLogs.length },
    compare: compareDir ? { with: relative(outDir, compareDir), same: [...compared.values()].filter((v) => v === 'same').length, changed: [...compared.values()].filter((v) => v === 'changed').length, new: [...compared.values()].filter((v) => v === 'new').length } : null,
    failures,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    artifacts: entries.map((e) => ({ ...e, ...(compareDir ? { compared: compared.get(e.file) } : {}) })),
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(summary, null, 1) + '\n')

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const groups = [...new Set(entries.map((e) => e.view))].sort()
  const figure = (e: Entry) => {
    const mark = compareDir ? compared.get(e.file) : undefined
    const cap = `${esc(e.viewport)} · ${esc(e.scheme)}${e.pages ? ` · ${e.pages} page${e.pages === 1 ? '' : 's'}` : ''}${e.truncated ? ' · cut at 16000 px' : ''}${mark ? ` · <b class="${mark}">${mark}</b>` : ''}`
    const thumb = (dir: string, label: string) => e.kind === 'png'
      ? `<a href="${esc(dir + e.file)}"><img loading="lazy" src="${esc(dir + e.file)}" alt="${label} ${esc(e.file)}"></a>`
      : `<a class="pdf" href="${esc(dir + e.file)}">${label}: open ${esc(e.file)}</a>`
    const prevDir = compareDir ? relative(outDir, compareDir) + '/' : ''
    const prev = compareDir && mark !== 'new' ? `<div><small>previous</small>${thumb(prevDir, 'previous')}</div>` : compareDir ? '<div><small>previous</small><p class="none">no previous shot of this name</p></div>' : ''
    return `<figure class="${compareDir ? 'pair' : 'one'}"><figcaption>${cap}${e.consoleErrors.length ? ' · <span class="err">console errors</span>' : ''}</figcaption><div class="row"><div>${compareDir ? '<small>now</small>' : ''}${thumb('', 'now')}</div>${prev}</div></figure>`
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hindsight UX shots</title>
<style>
body{font:15px/1.4 system-ui,sans-serif;margin:1rem 1.5rem;background:#fff;color:#1d1d1f}
nav a{margin-right:.8rem;white-space:nowrap} h1{font-size:1.3rem} h2{margin:2rem 0 .3rem;font-size:1.1rem;border-bottom:1px solid #ccc}
.grid{display:flex;flex-wrap:wrap;gap:1rem} figure{margin:0;padding:.4rem;border:1px solid #ddd;border-radius:6px}
figure.one{width:calc(50% - 1.2rem)} figure.pair{width:100%} .row{display:flex;gap:.6rem} .row>div{flex:1;min-width:0}
img{display:block;width:100%;height:auto;border:1px solid #eee} figcaption{font-size:.85rem;color:#444;margin-bottom:.25rem}
small{color:#666} b.same{color:#188038} b.changed{color:#c5221f} b.new{color:#1a73e8} .err{color:#c5221f} .none{color:#888}
a.pdf{display:block;padding:1rem;border:1px dashed #aaa}
</style></head><body>
<h1>Hindsight UX shots</h1>
<p>${entries.length} artifacts · ${esc(chromeVersion)} · ${WIDTH}x${HEIGHT} · ${summary.seconds} s${compareDir ? ` · compared with ${esc(relative(outDir, compareDir))}: ${summary.compare!.same} same, ${summary.compare!.changed} changed, ${summary.compare!.new} new` : ''}${failures.length ? ` · <span class="err">${failures.length} view(s) failed: ${esc(failures.map((f) => f.view).join(', '))}</span>` : ''}</p>
<nav>${groups.map((g) => `<a href="#${esc(g)}">${esc(g)}</a>`).join('')}</nav>
${groups.map((g) => `<h2 id="${esc(g)}">${esc(g)}: ${esc(viewTitles.get(g) ?? '')}</h2><div class="grid">${entries.filter((e) => e.view === g).map(figure).join('\n')}</div>`).join('\n')}
</body></html>
`
  writeFileSync(join(outDir, 'index.html'), html)
  console.log(`${entries.length} artifacts in ${summary.seconds} s; ${failures.length} failed views${compareDir ? `; vs previous: ${summary.compare!.same} same, ${summary.compare!.changed} changed, ${summary.compare!.new} new` : ''}`)
  if (failures.length) process.exitCode = 1
} finally {
  ws?.close()
  chrome?.kill()
  await sleep(500)
  for (const d of [profile, scratch]) rmSync(d, { recursive: true, force: true })
}
