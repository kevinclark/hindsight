/**
 * Linked findings as a student sees them: the built hindsight.html opened from file:// in headless Google Chrome, logs
 * loaded through the page's own file input, then the Match tab screenshotted with every "Explains N more" group closed
 * and again with them all open, the printed report saved as a PDF and the phone card as a PNG. Nothing is uploaded.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-links-check.ts <out-dir> <log> [<log> ...] [-- <log> ...]
 *
 * Each group separated by "--" is loaded on a fresh page (e.g. log A's .wpilog with its .dslog, then log C). Prints, per
 * group, each headline on the Match tab with the findings nested under it, read back from the page.
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [outDir, ...rest] = process.argv.slice(2)
if (!outDir || rest.length === 0) { console.error('usage: chrome-links-check.ts <out-dir> <log> [<log> ...] [-- <log> ...]'); process.exit(2) }
mkdirSync(outDir, { recursive: true })
const groups: string[][] = [[]]
for (const a of rest) { if (a === '--') groups.push([]); else groups.at(-1)!.push(resolve(a)) }
const page = `file://${resolve('hindsight.html')}`
const profile = mkdtempSync(`${tmpdir()}/hindsight-links-`)
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try { return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl } catch { await sleep(200) }
  }
  throw new Error('Chrome did not start')
}

// The headlines and what is nested under each, read from the page (depth by how many "explains" groups hold it).
const READ_TREE = `(() => {
  const title = (li) => li.querySelector(':scope > details > summary .title').innerText.trim().replace(/\\s+/g, ' ')
  const depth = (li) => { let k = 0; for (let p = li.parentElement.closest('.explains'); p; p = p.parentElement.closest('.explains')) k++; return k }
  return [...document.querySelectorAll('.findings > li.finding')].map((li) => ({
    headline: title(li),
    nested: [...li.querySelectorAll('.explains li.finding')].map((c) => '  '.repeat(depth(c)) + title(c)),
  }))
})()`

let ws!: WebSocket
try {
  ws = new WebSocket(await cdp())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let nextId = 1
  const pending = new Map<number, (v: any) => void>()
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })) })
  const evalIn = async (sessionId: string, expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value

  const results: object[] = []
  for (const files of groups) {
    const label = files.map((f) => f.split('/').pop()!.replace(/\.(wpilog|dslog)$/, '')).join('+').replace(/[^\w+.-]/g, '_')
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('DOM.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId)
    await send('Page.navigate', { url: page }, sessionId)
    await sleep(1000)
    const { result: { root } } = await send('DOM.getDocument', {}, sessionId)
    const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".wpilog,.dslog,.jsonl"]' }, sessionId)
    await send('DOM.setFileInputFiles', { nodeId, files }, sessionId)
    let heading = ''
    for (let i = 0; i < 600 && !heading; i++) { await sleep(100); heading = await evalIn(sessionId, `document.querySelector('.match-head h2')?.innerText || ''`) }
    await sleep(500)
    const shot = async (name: string) => {
      const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
      writeFileSync(`${outDir}/${label}-${name}.png`, Buffer.from(result.data, 'base64'))
    }
    // As it opens: errors open, every "Explains N more" closed. Close the finding bodies too, to see the headlines.
    await evalIn(sessionId, `document.querySelectorAll('.findings details[open]').forEach(d => d.open = false)`)
    await sleep(300)
    await shot('match-headlines')
    await evalIn(sessionId, `document.querySelectorAll('details.explains').forEach(d => d.open = true)`)
    await sleep(300)
    await shot('match-nested')
    const tree = await evalIn(sessionId, READ_TREE)
    const { result: pdf } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, paperWidth: 8.5, paperHeight: 11 }, sessionId)
    writeFileSync(`${outDir}/${label}.report.pdf`, Buffer.from(pdf.data, 'base64'))
    const png: string | null = await evalIn(sessionId, 'hindsight.reviewCardPng()')
    if (png) writeFileSync(`${outDir}/${label}.card.png`, Buffer.from(png.split(',')[1], 'base64'))
    const counts = await evalIn(sessionId, `document.querySelector('.counts')?.innerText`)
    results.push({ files: files.map((f) => f.split('/').pop()), heading, counts, tree })
    await send('Target.closeTarget', { targetId })
  }
  console.log(JSON.stringify({ page, chrome: execSync(`"${CHROME}" --version`).toString().trim(), results }, null, 1))
} finally {
  ws?.close()
  chrome.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
