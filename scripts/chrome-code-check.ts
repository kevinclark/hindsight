/**
 * Foresight's Code panel in a real browser: the built hindsight.html opened from file:// in headless Google Chrome,
 * the robot code chosen through the folder input (as a browser without the folder picker does) or typed into
 * "Use GitHub…", and the panel's text read back once the check has run. No robot is connected, so it checks the
 * folder's HEAD, or the GitHub ref typed.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-code-check.ts <robot-code folder> [File.java:50 ...]
 *   node --experimental-strip-types scripts/chrome-code-check.ts --github owner/repo@ref [File.java:50 ...]
 *
 * Each File.java:line given must be on the panel. Every request the page makes must be the page itself (file://),
 * or GitHub with --github: the parser's .wasm is inlined, never fetched. Prints the panel and PASS or FAIL; exits 1
 * on FAIL.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** How long the check may take in the page (s): measured ~0.3 s on a 49-file robot. */
const MOST_SECONDS = 30
const args = process.argv.slice(2)
const github = args[0] === '--github' ? args[1] : null
const [folder, ...expected] = github ? args.slice(1) : args
if (!folder) throw new Error('usage: chrome-code-check.ts <robot-code folder> | --github owner/repo@ref [File.java:50 ...]')
/** The hosts the page may ask, beside itself: GitHub's API and raw files, only when reading from GitHub. */
const ALLOWED = github ? /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\// : /^$/

const profile = mkdtempSync(`${tmpdir()}/code-check-chrome-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1000,1400', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const failures: string[] = []
try {
  const ws = new WebSocket(await debuggerUrl())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let nextId = 1
  const pending = new Map<number, (v: { result?: any }) => void>()
  const requests: string[] = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    pending.get(m.id)?.(m)
    pending.delete(m.id)
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
  })
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<{ result?: any }>((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
  const evalIn = async (sessionId: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Network.enable', {}, sessionId)
  await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sessionId)
  await sleep(800)
  await evalIn(sessionId, `[...document.querySelectorAll('.modes button')].find(b => b.innerText === 'Foresight').click()`)
  await sleep(300)
  if (github) {
    await evalIn(sessionId, `[...document.querySelectorAll('.code-check button')].find(b => b.innerText === 'Use GitHub…').click()`)
    await sleep(200)
    await evalIn(sessionId, `(() => { const i = document.querySelector('.code-check input[data-code-github]'); i.value = ${JSON.stringify(github)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit() })()`)
  } else {
    const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
    const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.code-check input[data-code-folder]' }, sessionId)
    await send('DOM.setFileInputFiles', { nodeId, files: [resolve(folder)] }, sessionId)
  }

  const started = Date.now()
  let panel = ''
  while (Date.now() - started < MOST_SECONDS * 1000) {
    panel = (await evalIn(sessionId, `document.querySelector('.code-check')?.innerText ?? ''`)) ?? ''
    if (/Checked .*?[0-9a-f]{7}|Couldn't check/.test(panel)) break
    await sleep(250)
  }
  const seconds = (Date.now() - started) / 1000
  const findings: string[] = await evalIn(sessionId, `[...document.querySelectorAll('.code-finding summary')].map(s => s.innerText)`)
  console.log(panel)
  console.log(`\n${findings.length} findings on the panel, shown ${seconds.toFixed(1)} s after the folder was chosen`)
  if (!/Checked .*?[0-9a-f]{7}/.test(panel)) failures.push('the panel never said what it checked')
  for (const site of expected) if (!findings.some((f) => f.startsWith(site))) failures.push(`${site} isn't on the panel`)
  const foreign = requests.filter((u) => !u.startsWith('file://') && !ALLOWED.test(u))
  if (github) console.log(`${requests.filter((u) => u.startsWith('https://api.github.com/')).length} GitHub API calls, ${requests.filter((u) => u.startsWith('https://raw.')).length} raw reads`)
  if (foreign.length) failures.push(`the page asked for ${foreign.join(', ')}`)
  await send('Target.closeTarget', { targetId })
} finally {
  chrome.kill()
}
console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'PASS')
process.exitCode = failures.length ? 1 : 0

async function debuggerUrl(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
    } catch {
      await sleep(200)
    }
  }
  throw new Error('Chrome did not start')
}
