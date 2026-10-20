/**
 * Foresight end to end in a real browser: the built hindsight.html opened from file:// in headless Google Chrome,
 * connected to a CalGames log replayed as the robot's NT4 stream (tests/helpers/nt4-replay-server.ts), or to any
 * NT4 server given with --address (e.g. a pyntcore server, to cross-check against the real ntcore).
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-foresight-check.ts <out-dir>                 # the CalGames scenarios
 *   node --experimental-strip-types scripts/chrome-foresight-check.ts <out-dir> --address 127.0.0.1:5810 --seconds 40
 *
 * Every request the page makes is recorded: it must be the page itself (file://) or the NT4 socket, nothing else.
 * The pit cases also drop a synthetic robot snapshot on the page once it has a verdict (healthy, one CANcoder offset
 * off, or one taken an hour before the robot code started) and record the checklist's snapshot lines, the "Log stick
 * in" line (the CalGames logs have no companion keys, so "not checked") and the wanted checks (grey: their mark's
 * colour is the "By eye" lines').
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startReplayServer } from '../tests/helpers/nt4-replay-server.ts'
import { makeDevicesSnapshotJson, profileSnapshot } from '../tests/helpers/make-snapshot.ts'
import { offseason2026Event } from '../src/profiles/2026-offseason.ts'

type SnapshotCase = 'healthy' | 'offset-off' | 'stale'
/** Write the snapshot file at the moment it is dropped, so a fresh one is from after the robot code started. */
function snapshotFile(kind: SnapshotCase): string {
  const devices = profileSnapshot(offseason2026Event)
  if (kind === 'offset-off') devices.find((d) => d.model.startsWith('CANCoder') && d.id === 1)!.configs!.CANCoder_MagnetOffset = 0.3
  const taken = kind === 'stale' ? Date.now() - 3600_000 : Date.now()
  const path = `${outDir}/snapshot-${kind}.json`
  writeFileSync(path, makeDevicesSnapshotJson(devices, new Date(taken).toISOString()))
  return resolve(path)
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, ...rest] = process.argv.slice(2)
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null }
const page = `file://${resolve('hindsight.html')}`
const profile = mkdtempSync(`${tmpdir()}/foresight-chrome-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1000,1400', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (p: string) => `${homedir()}/Downloads/${p}`

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
const requests: string[] = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
  if (m.method === 'Network.webSocketCreated') requests.push(m.params.url)
})
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
const evalIn = async (sessionId: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value

/** Open the page, switch to Foresight, connect to `address`, and sample the verdict until `done` or `seconds`. */
async function scenario(name: string, address: string, seconds: number, done: (s: { verdict: string; items: string[]; field: boolean }) => boolean, snapshot?: SnapshotCase) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Network.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send('Page.navigate', { url: page }, sessionId)
  await sleep(800)
  await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Foresight').click()`)
  await sleep(200)
  await evalIn(sessionId, `(() => { const i = document.querySelector('.connect input'); i.value = ${JSON.stringify(address)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evalIn(sessionId, `[...document.querySelectorAll('.connect button')].find(b => b.innerText === 'Connect').click()`)
  const samples: { t: number; verdict: string; why: string; items: string[]; field: boolean; snapshotLines: string[]; checklist: { live: number; folded: number; liveNames: string[] }; snapshotStatus: string; logStickLine: string; wanted: { text: string; markColor: string }[]; byEyeColor: string }[] = []
  let droppedAt: number | null = null
  const started = Date.now()
  while (Date.now() - started < seconds * 1000) {
    await sleep(500)
    const s = await evalIn(sessionId, `({ verdict: document.querySelector('.verdict .big')?.innerText ?? '', why: document.querySelector('.verdict p:nth-child(2)')?.innerText ?? '', items: [...document.querySelectorAll('.item')].map(li => li.querySelector('.chip').innerText + ': ' + li.querySelector('.title').innerText), field: !!document.querySelector('.field'), status: document.querySelector('.status')?.innerText ?? '', readings: document.querySelector('.readings')?.innerText ?? '', checklist: { live: document.querySelectorAll('.onchecks > ul > .oc').length, folded: document.querySelectorAll('.onchecks details.inert:first-of-type .oc').length, liveNames: [...document.querySelectorAll('.onchecks > ul > .oc .line')].map(e => e.innerText) }, snapshotStatus: document.querySelector('section[aria-label="Robot snapshot"] .status')?.innerText ?? '', snapshotLines: [...document.querySelectorAll('.oc')].map(li => li.innerText.replace(/\\s+/g, ' ')).filter(t => /Robot snapshot matches the code/.test(t)), logStickLine: [...document.querySelectorAll('.oc')].map(li => li.innerText.replace(/\\s+/g, ' ')).find(t => /Log stick in/.test(t)) ?? '', wanted: [...document.querySelectorAll('.oc.wanted')].map(li => { const m = getComputedStyle(li.querySelector('.mark')).color; return { text: li.textContent.replace(/\\s+/g, ' '), markColor: m } }), byEyeColor: (() => { const m = document.querySelector('.oc.by-eye .mark'); return m ? getComputedStyle(m).color : '' })() })`)
    samples.push({ t: (Date.now() - started) / 1000, ...s })
    // Once there is a verdict, drop the snapshot, as a student would after the page settles.
    if (snapshot && droppedAt === null && /^(NO-)?GO$/.test(s.verdict)) {
      droppedAt = Date.now()
      const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
      const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'section[aria-label="Robot snapshot"] input[type=file]' }, sessionId)
      await send('DOM.setFileInputFiles', { files: [snapshotFile(snapshot)], nodeId }, sessionId)
    }
    if (done(s) || (droppedAt !== null && Date.now() - droppedAt > 2500)) break
  }
  const { result } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(`${outDir}/foresight-${name}.png`, Buffer.from(result.data, 'base64'))
  const last = samples.at(-1)!
  await send('Target.closeTarget', { targetId })
  return { name, snapshot, snapshotStatus: last.snapshotStatus, snapshotLines: last.snapshotLines, checklist: last.checklist, logStickLine: last.logStickLine, wanted: last.wanted, wantedGrey: last.wanted.length > 0 && last.wanted.every((w: { markColor: string }) => w.markColor === last.byEyeColor), last: { ...last, checklist: undefined, snapshotLines: undefined, snapshotStatus: undefined, logStickLine: undefined, wanted: undefined, byEyeColor: undefined }, verdicts: [...new Set(samples.map((s) => `${s.verdict} (${s.why.replace(/\d+ s$/, 'n s')})`))], everItems: [...new Set(samples.flatMap((s) => s.items))] }
}

const results: object[] = []
const address = flag('--address')
if (address) {
  results.push(await scenario('ntcore', address, Number(flag('--seconds') ?? 40), () => false))
} else {
  const cases = [
    { name: 'p0-pit', file: 'akit_26-10-18_16-31-52_cacg_p0.wpilog', pit: true, speed: 10, seconds: 20, snapshot: 'healthy' as const },
    { name: 'q21-pit', file: 'akit_26-10-17_21-24-40_cacg_q21.wpilog', pit: true, speed: 10, seconds: 20, snapshot: 'offset-off' as const },
    { name: 'q13-pit', file: 'akit_26-10-17_20-07-34_cacg_q13.wpilog', pit: true, speed: 30, seconds: 25, snapshot: 'stale' as const },
    { name: 'q21-field', file: 'akit_26-10-17_21-24-40_cacg_q21.wpilog', pit: false, speed: 5, seconds: 15 },
  ]
  for (const c of cases) {
    const server = await startReplayServer({ bytes: new Uint8Array(readFileSync(log(c.file))), pit: c.pit, speed: c.speed })
    results.push({ ...(await scenario(c.name, `127.0.0.1:${server.port}`, c.seconds, (s) => s.field, 'snapshot' in c ? c.snapshot : undefined)), framesFromPage: server.received.map((f) => (f.kind === 'binary' ? 'BINARY' : (f.data as { method: string }[]).map((m) => m.method).join('+'))) })
    await server.close()
  }
}
const foreign = requests.filter((u) => !u.startsWith('file://') && !/^ws:\/\/(127\.0\.0\.1|localhost):\d+\/nt\//.test(u) && !u.startsWith('data:'))
console.log(JSON.stringify({ page, chrome: execSync(`"${CHROME}" --version`).toString().trim(), requests: requests.length, foreignRequests: foreign, results }, null, 1))
ws.close()
chrome.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
