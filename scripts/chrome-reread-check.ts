/**
 * "New session" and "Read again", in headless Chrome on the built hindsight.html (file://):
 *  1. load logs, press New session: the page is empty, a reload is still empty, localStorage is untouched;
 *  2. load logs, rewrite the saved entries as if an older Hindsight made them (and change one entry's findings),
 *     reload: the summaries are shown with the older-Hindsight note;
 *  3. press Read again, choose the logs in the folder chooser: the note is gone and what changed is listed;
 *  4. press Read again with the logs already on the page: "no finding changed".
 * The logs must be the only files in their folder (the folder chooser reads the whole folder). Prints the page text it saw at each step and exits 1 if anything is not as expected.
 *
 *   npm run build
 *   node --experimental-strip-types scripts/chrome-reread-check.ts <log.wpilog> [...]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const files = process.argv.slice(2).map((f) => resolve(f))
// The folder chooser takes a folder: the logs' own folder (these logs should be alone in it).
const folder = files.length ? [resolve(files[0], '..')] : []
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
const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true })
const evalIn = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value
const click = (text: string) => evalIn(`[...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)}))?.click() ?? 'missing'`)
const failures: string[] = []
const expect = (ok: boolean, what: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }

/** The text a person would read on the Session page, piece by piece (not the whole grid). */
const pageText = () => evalIn(`(() => {
  const t = (sel) => [...document.querySelectorAll(sel)].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())
  return JSON.stringify({
    progress: t('.progress'), notes: t('.note'), problems: t('.problem'), staleNote: t('[data-stale-note]'),
    sessions: t('.sessions button'), changes: t('[data-reread-changes]'),
    buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter((x) => /^(New session|Read again|Clear saved copies|Dismiss)/.test(x)),
    readAgainProminent: document.querySelector('.button.prominent')?.innerText ?? null,
  }, null, 1)
})()`)
const idb = (js: string) => evalIn(`new Promise((res) => { const r = indexedDB.open('hindsight', 1); r.onsuccess = () => { const db = r.result; const tx = db.transaction('summaries', 'readwrite'); const s = tx.objectStore('summaries'); ${js}; tx.oncomplete = () => { db.close(); res(true) } } })`)
const savedEntries = async (): Promise<{ build: string; version?: string; shape?: number; name: string }[]> => JSON.parse(await evalIn(`new Promise((res) => { const r = indexedDB.open('hindsight', 1); r.onsuccess = () => { const q = r.result.transaction('summaries').objectStore('summaries').getAll(); q.onsuccess = () => { r.result.close(); res(JSON.stringify(q.result.map((c) => ({ build: c.build, version: c.version, shape: c.shape, name: c.summary.fileName })))) } } })`))
const localKeys = () => evalIn(`JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))`)
const waitFor = async (cond: string, what: string) => { for (let i = 0; i < 150; i++) { if (await evalIn(cond)) return; await sleep(200) } failures.push(`timed out waiting for ${what}`); console.log(`  FAIL timed out waiting for ${what}`) }
const chooseLogs = async (selector: string, paths = files) => {
  const { result: { root } } = await send('DOM.getDocument', {}, sid)
  const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid)
  await send('DOM.setFileInputFiles', { nodeId, files: paths }, sid)
}
const loaded = () => waitFor(`new RegExp('^${files.length} of ${files.length} logs').test(document.querySelector('.progress')?.innerText ?? '')`, 'the logs to load')
const reload = async () => { await send('Page.reload', {}, sid); await sleep(2500); await click('Session'); await sleep(800) }
const step = async (title: string) => { console.log(`\n== ${title}`); console.log(await pageText()) }

await send('Page.enable', {}, sid)
await send('Page.navigate', { url: `file://${resolve('hindsight.html')}` }, sid)
await sleep(1000)
await click('Session')
await evalIn(`window.confirm = (m) => { window.__confirm = m; return true }`)

// 1. New session.
await chooseLogs('input[type=file][accept=".wpilog"]')
await loaded()
await evalIn(`localStorage.setItem('hindsight.sessionRenames', '{"x":"My name"}'); localStorage.setItem('hindsight.typedBatteries', '{"a.wpilog":"B7"}'); localStorage.setItem('hindsight.sessionOverrides', '{"a.wpilog":"Moved"}')`)
const keptBefore = await localKeys()
await step('1a. logs loaded')
expect((await savedEntries()).length === files.length, `${files.length} summaries saved`)
await click('New session')
await sleep(800)
await step('1b. after New session')
console.log('  confirm said:', await evalIn(`window.__confirm`))
expect((await savedEntries()).length === 0, 'IndexedDB empty')
expect(await evalIn(`document.querySelectorAll('.sessions button').length === 0 && !document.querySelector('.progress')`), 'page has no sessions and no progress')
await reload()
await step('1c. after reload')
expect((await savedEntries()).length === 0, 'IndexedDB still empty after reload')
expect(await evalIn(`document.querySelectorAll('.sessions button').length === 0`), 'page still empty after reload')
expect((await localKeys()) === keptBefore, 'localStorage keys and values untouched')

// 2. Saved by an older Hindsight.
await evalIn(`window.confirm = (m) => { window.__confirm = m; return true }`)
await chooseLogs('input[type=file][accept=".wpilog"]')
await loaded()
await sleep(1500)
await idb(`const q = s.getAll(); q.onsuccess = () => { let first = true; for (const c of q.result) { c.build = 'older0build0000'; c.version = '0.0.1-older'; if (first) { first = false; for (const r of Object.values(c.summary.rules)) { if (r.findings.some((f) => f.severity !== 'info')) { r.findings = []; r.status = 'quiet'; break } } } s.put(c) } }`)
await sleep(500)
expect((await savedEntries()).every((e) => e.build === 'older0build0000'), 'saved entries rewritten to an older build')
await reload()
await step('2. reload with entries from an older build')
expect(await evalIn(`/read with an older Hindsight \\(version 0\\.0\\.1-older/.test(document.querySelector('[data-stale-note]')?.innerText ?? '')`), 'older-Hindsight note shown')
expect(await evalIn(`document.querySelectorAll('.sessions button').length > 0`), 'summaries are shown')
expect((await savedEntries()).length === files.length, 'older entries were not deleted')

// 3. Read again, logs chosen in the folder chooser.
await click('Read again')
await sleep(500)
console.log('  (pending: waiting for the folder chooser; choosing the logs on the hidden input)')
await chooseLogs('input[data-reread-input]', folder)
await loaded()
await sleep(1500)
await step('3. after Read again (logs chosen)')
expect(await evalIn(`!document.querySelector('[data-stale-note]')`), 'older-Hindsight note gone')
expect(await evalIn(`!!document.querySelector('[data-reread-changes]')`), 'what-changed section shown')
expect(await evalIn(`/^New: /m.test(document.querySelector('[data-reread-changes]')?.innerText ?? '') || /Changed: /.test(document.querySelector('[data-reread-changes]')?.innerText ?? '')`), 'the change made in step 2 is listed')
const after = await savedEntries()
expect(after.length === files.length && after.every((e) => e.build !== 'older0build0000' && e.version && e.shape), 'saved entries replaced by this build\'s, with version and shape')

// 4. Read again with the logs on the page: no picker, nothing changed.
await click('Read again')
await sleep(300)
await loaded()
await sleep(1500)
await step('4. Read again, logs already on the page')
expect(await evalIn(`/no finding changed/.test(document.querySelector('[data-reread-changes]')?.innerText ?? '')`), '"no finding changed" shown')
expect((await localKeys()) === keptBefore, 'localStorage still untouched')

console.log(failures.length ? `\nFAILED:\n - ${failures.join('\n - ')}` : '\nall checks passed')
ws.close(); chrome.kill(); await sleep(500); rmSync(profile, { recursive: true, force: true })
process.exit(failures.length ? 1 : 0)
