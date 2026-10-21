/**
 * Rendered check of the Robot profile builder: a synthetic AdvantageKit-shaped log and a synthetic robot snapshot go
 * into the built page (file://, headless Chrome, the page's own file input); the script reads what the page shows,
 * keeps the profile, reloads, and saves profile.json through Chrome's download. Prints each check; exits 1 if any fails.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-builder-check.ts <out-dir> [page.html]
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { writeWpilog, type FixtureEntry } from '../tests/helpers/fixture-format.ts'
import { makeSnapshotJson, type FakeTalon } from '../tests/helpers/make-snapshot.ts'
import { parseProfileJson } from '../src/builder/json.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, page = 'hindsight.html'] = process.argv.slice(2)

// --- synthetic inputs -------------------------------------------------------------------------------------------
const work = mkdtempSync(`${tmpdir()}/hindsight-builder-`)
const downloads = mkdtempSync(`${tmpdir()}/hindsight-builder-dl-`)
const num = (name: string, v = 1): FixtureEntry => ({ name, type: 'double', records: [[1, v], [2, v + 1]] })
const bool = (name: string): FixtureEntry => ({ name, type: 'boolean', records: [[1, true]] })
/** The log's top folder for the swerve modules; HINDSIGHT_SWERVE_ROOT=Swerve shows the builder with a folder name that isn't also a motor word. */
const ROOT = process.env.HINDSIGHT_SWERVE_ROOT ?? 'Drive'
const CORNERS = ['FrontLeft', 'FrontRight', 'BackLeft', 'BackRight']
const entries: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [25, false], [28, true], [168, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false], [9.5, true], [28, false]] },
  { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, true]] },
  { name: '/RealMetadata/ProjectName', type: 'string', records: [[0, 'Example Robot']] },
  { name: '/RealMetadata/GitSHA', type: 'string', records: [[0, 'abc1234def']] },
  { name: '/RealMetadata/GitBranch', type: 'string', records: [[0, 'main']] },
  ...CORNERS.flatMap((m) => ['Drive', 'Turn'].flatMap((t) => [num(`/${ROOT}/${m}/${t}SupplyCurrentAmps`), num(`/${ROOT}/${m}/${t}StatorCurrentAmps`), bool(`/${ROOT}/${m}/${t}Connected`)])),
  ...['Leader', 'Follower 0'].flatMap((m) => [num(`/Shooter/Flywheel/${m}/SupplyCurrentAmps`), num(`/Shooter/Flywheel/${m}/VelocityRotPerSec`)]),
]
const logPath = `${work}/example-q1.wpilog`
writeFileSync(logPath, writeWpilog(entries))
const SHORT = ['FL', 'FR', 'BL', 'BR']
const talons: FakeTalon[] = [
  ...SHORT.map((c, i) => ({ id: 1 + i, name: `${c} Drive` })),
  ...SHORT.map((c, i) => ({ id: 5 + i, name: `${c} Steer` })),
  { id: 20, name: 'Shooter Leader' },
  { id: 21 }, // still Tuner X's default name
]
const snapshotPath = `${work}/snapshot.json`
writeFileSync(snapshotPath, makeSnapshotJson(talons, '2026-01-01T12:00:00Z'))
// Robot code where the shooter's IDs reach `new TalonFX` through a constructor, as most team code passes them.
const codeFiles = {
  'FlywheelIO.java': 'class FlywheelIO {\n  FlywheelIO(int motorID) {\n    talon = new TalonFX(motorID, "canivore");\n  }\n}\n',
  'Robot.java': 'class Robot extends LoggedRobot {\n  Robot() {\n    new FlywheelIO(20);\n    new FlywheelIO(21);\n  }\n}\n',
}
const codeFolder = `${work}/robot-code`
mkdirSync(codeFolder)
for (const [name, text] of Object.entries(codeFiles)) writeFileSync(`${codeFolder}/${name}`, text)

// --- Chrome -----------------------------------------------------------------------------------------------------
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
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
const consoleErrors: string[] = []
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception') })
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 2600, deviceScaleFactor: 1, mobile: false }, sessionId)
const url = `file://${resolve(page)}`
await send('Page.navigate', { url }, sessionId)
await sleep(1000)
const openMode = async () => { await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Robot profile').click()`); await sleep(200) }
await openMode()

const { result: { root } } = await send('DOM.getDocument', { depth: -1 }, sessionId)
const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][multiple][accept=".wpilog,.json"]' }, sessionId)
await send('DOM.setFileInputFiles', { nodeId, files: [logPath, snapshotPath] }, sessionId)
await sleep(1500)

const seen = await evalIn(sessionId, `(() => {
  const text = (el) => el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  const view = document.querySelector('section.drop[aria-label="Drop files"]').parentElement
  const rows = [...view.querySelectorAll('tr[data-motor]')]
  const flywheel = view.querySelector('section.group[data-group="Flywheel"]')
  const follower = view.querySelector('tr[data-motor="/Shooter/Flywheel/Follower 0"]')
  return {
    rows: rows.length,
    canIds: rows.map(r => ({ motor: r.dataset.motor, value: r.querySelector('select[data-canid]')?.value, label: r.querySelector('select[data-canid]')?.selectedOptions[0]?.innerText, from: text(r.querySelector('.tag')) })),
    groups: [...view.querySelectorAll('section.group')].map(g => g.dataset.group),
    flywheelSameLoop: flywheel?.querySelector('input[type=checkbox]')?.checked,
    flywheelText: text(flywheel),
    follower: { label: follower?.querySelector('select[data-canid]')?.selectedOptions[0]?.innerText, from: text(follower?.querySelector('.tag')) },
    notChecked: text(view.querySelector('.not-checked')),
    warnings: [...view.querySelectorAll('.warn')].map(text),
    head: text(view.querySelector('.head')),
    problems: [...document.querySelectorAll('.problem')].map(text),
    driveLimits: text(view.querySelector('section.group[data-group="Drive"] .limits-line')),
  }
})()`)

// The code folder: its hints label the CAN ID choices.
const { result: { root: page2 } } = await send('DOM.getDocument', {}, sessionId)
const { result: { nodeId: codeInput } } = await send('DOM.querySelector', { nodeId: page2.nodeId, selector: 'input[type=file][webkitdirectory]' }, sessionId)
await send('DOM.setFileInputFiles', { nodeId: codeInput, files: [codeFolder] }, sessionId)
await sleep(1500)
const hinted = await evalIn(sessionId, `(() => {
  const chip = [...document.querySelectorAll('.chip')].map(c => c.innerText).find(t => /Talon FX site/.test(t)) ?? null
  const options = [...document.querySelectorAll('tr[data-motor^="/Shooter/"] select[data-canid] option')].map(o => o.innerText)
  return { chip, options: [...new Set(options)].filter(o => /FlywheelIO/.test(o)) }
})()`)

async function shot(name: string) {
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, 'base64'))
}
await shot('profile-builder')

// Keep, reload, and look for it in the kept list.
await evalIn(sessionId, `[...document.querySelectorAll('button')].find(b => b.innerText === 'Keep in this browser').click()`)
await sleep(300)
const keptNote = await evalIn(sessionId, `document.querySelector('.actions [role=status]')?.innerText`)
await send('Page.navigate', { url }, sessionId)
await sleep(1000)
await openMode()
const keptList = await evalIn(sessionId, `[...document.querySelectorAll('.kept li')].map(li => li.innerText.replace(/\\s+/g, ' ').trim())`)

// Open it again from the list, then save profile.json through the download.
await evalIn(sessionId, `[...document.querySelectorAll('.kept button')].find(b => b.innerText === 'open').click()`)
await sleep(300)
await evalIn(sessionId, `[...document.querySelectorAll('button')].find(b => b.innerText === 'Save profile.json').click()`)
let saved: string[] = []
for (let i = 0; i < 25; i++) { saved = readdirSync(downloads).filter((f) => !f.endsWith('.crdownload')); if (saved.length) break; await sleep(200) }
let savedMotors = -1, savedError = ''
try { savedMotors = parseProfileJson(readFileSync(`${downloads}/${saved[0]}`, 'utf8')).motorGroups.reduce((n, g) => n + g.motors.length, 0) } catch (e) { savedError = String(e) }

// Rename the opened profile and keep it: it replaces itself. Then name a group like another: a warning says so.
const setInput = (selector: string, value: string) => evalIn(sessionId, `(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
await setInput('label:has(> input[type=text]) input', 'Renamed Robot')
await sleep(200)
await evalIn(sessionId, `[...document.querySelectorAll('button')].find(b => b.innerText === 'Keep in this browser').click()`)
await sleep(300)
const renamedNote = await evalIn(sessionId, `document.querySelector('.actions [role=status]')?.innerText`)
const renamedList = await evalIn(sessionId, `[...document.querySelectorAll('.kept li')].map(li => li.innerText.replace(/\\s+/g, ' ').trim())`)
await setInput('section.group[data-group="Turn"] label input[type=text]', 'drive')
await sleep(200)
const duplicateWarning = await evalIn(sessionId, `[...document.querySelectorAll('.warn')].map(w => w.innerText).find(t => /Two groups are called/.test(t)) ?? null`)

const allSelected = seen.canIds.every((c: any) => c.value && c.value !== '')
const checks: Record<string, boolean> = {
  'motor rows: 10': seen.rows === 10,
  'every CAN ID select has a value': seen.canIds.length === 10 && allSelected,
  'the default-named device (21) went to the remaining follower': /^21 /.test(seen.follower.label ?? '') && /snapshot/.test(seen.follower.from ?? ''),
  'groups Drive, Turn, Flywheel shown': JSON.stringify([...seen.groups].sort()) === JSON.stringify(['Drive', 'Flywheel', 'Turn']),
  'Flywheel same-loop checked, marked suggested': seen.flywheelSameLoop === true && /suggested/.test(seen.flywheelText ?? ''),
  'not-checked list names zeroing and cameras': /zeroing/.test(seen.notChecked ?? '') && /cameras/.test(seen.notChecked ?? ''),
  'no file errors shown': seen.problems.length === 0,
  'keep says "kept"': keptNote === 'kept',
  'kept list shows the profile after a reload': keptList.length === 1 && /Example Robot/.test(keptList[0]),
  'saved file is example-robot.profile.json': saved.length === 1 && saved[0] === 'example-robot.profile.json',
  'saved file parses with parseProfileJson': savedError === '',
  'saved file has 10 motors': savedMotors === 10,
  'renamed then kept: replaces the old one': renamedList.length === 1 && /Renamed Robot/.test(renamedList[0]) && /in place of "Example Robot"/.test(renamedNote ?? ''),
  'two groups named alike: warned': /"Drive"/.test(duplicateWarning ?? ''),
  'code folder: 2 Talon FX sites, IDs followed through the constructor': /code folder: 2 Talon FX sites/.test(hinted.chip ?? '')
    && ['20', '21'].every((id) => hinted.options.some((o: string) => o.startsWith(`${id} `) && o.endsWith('FlywheelIO.java:3 (motorID)'))),
  'no page errors': consoleErrors.length === 0,
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(JSON.stringify({ chrome: execSync(`"${CHROME}" --version`).toString().trim(), page, seen, hinted, keptNote, keptList, renamedNote, renamedList, duplicateWarning, saved, savedError, consoleErrors }, null, 1))
console.log(`${Object.values(checks).filter(Boolean).length} of ${Object.keys(checks).length} checks passed`)
ws.close()
chrome.kill()
await sleep(500)
for (const d of [profile, work, downloads]) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
