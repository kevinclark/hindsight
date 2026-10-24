/**
 * Launches the built desktop app (npm run build:app first) on a throwaway library, ingests a folder of logs through the
 * page, then filters and opens the Session view, saving screenshots. Prints what it saw as JSON.
 *
 *   node --experimental-strip-types scripts/electron-check.ts <log folder> <screenshot folder> [--keep <user-data folder>]
 *
 * The folder is never written to; the library and settings go to a temp folder (or the one named). Do not point it at
 * logs that must not sync: it does not sync, but the library it makes is a copy.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { connect, type Page } from './electron-cdp.ts'

const [folder, shots] = process.argv.slice(2).map((p) => resolve(p))
if (!folder || !shots) throw new Error('usage: electron-check.ts <log folder> <screenshot folder>')
mkdirSync(shots, { recursive: true })
const userData = process.argv.includes('--keep') ? resolve(process.argv[process.argv.indexOf('--keep') + 1]) : mkdtempSync(join(tmpdir(), 'hindsight-app-'))
// HINDSIGHT_APP: a packaged app's executable (release/mac-arm64/Hindsight.app/Contents/MacOS/Hindsight) instead of `electron .`.
const packaged = process.env.HINDSIGHT_APP
const electron = packaged ?? (createRequire(import.meta.url)('electron') as unknown as string)
const port = 9400 + Math.floor(Math.random() * 400)

const app = spawn(electron, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`], {
  env: { ...process.env, HINDSIGHT_USER_DATA: userData, HINDSIGHT_PICK_FOLDER: folder }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
app.stdout.on('data', (d) => { log += d }); app.stderr.on('data', (d) => { log += d })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(page: Page, expression: string, what: string, ms = 120000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await page.eval<boolean>(expression)) return; await sleep(300) }
  throw new Error(`timed out waiting for ${what}`)
}

try {
  const page = await connect(port)
  await page.eval(`new Promise((r) => { const t = () => (window.hub ? r(true) : setTimeout(t, 100)); t() })`)
  await sleep(500)
  const started = Date.now()
  await page.eval(`[...document.querySelectorAll('button')].find((b) => /Add logs from a folder/.test(b.textContent)).click()`)
  await until(page, `!!document.querySelector('.report[aria-label="What was added"]')`, 'the ingest report')
  const ingestSeconds = (Date.now() - started) / 1000
  await sleep(500)
  await page.screenshot(join(shots, '1-library-report.png'))
  const report = await page.eval<string>(`document.querySelector('.report[aria-label="What was added"] h2').textContent + ' | ' + document.querySelector('.summary').textContent.replace(/\\s+/g, ' ')`)
  // The Team Drive panel as a build with no Google client shows it.
  await page.eval(`[...document.querySelectorAll('button')].find((b) => /^This laptop/.test(b.textContent.trim())).click()`)
  await sleep(300)
  await page.eval(`document.querySelector('details.team').open = true`)
  await sleep(300)
  await page.screenshot(join(shots, '1b-library-team-drive-panel.png'))
  await page.eval(`document.querySelector('details.team').open = false`)
  await page.eval(`[...document.querySelectorAll('button')].find((b) => /^This laptop/.test(b.textContent.trim())).click()`)
  // Type a driver on one log and a place on its day (tags are saved to the manifest), then filter to that driver.
  await page.eval(`(() => { const i = document.querySelector('input.driver'); i.value = 'driver one'; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await until(page, `[...document.querySelectorAll('aside fieldset')].some((f) => /Driver/.test(f.querySelector('legend').textContent) && /driver one/.test(f.textContent))`, 'the driver facet to list the tag', 20000)
  await page.eval(`[...[...document.querySelectorAll('aside fieldset')].find((f) => /Driver/.test(f.querySelector('legend').textContent)).querySelectorAll('label')].find((l) => /driver one/.test(l.textContent)).querySelector('input').click()`)
  await sleep(500)
  await page.screenshot(join(shots, '2-library-filtered.png'))
  const filtered = await page.eval<string>(`document.querySelector('.summary').textContent.replace(/\\s+/g, ' ')`)
  // Open the filtered set in the Session view and wait for it to read.
  await page.eval(`[...document.querySelectorAll('button')].find((b) => /Open in Session view/.test(b.textContent)).click()`)
  await until(page, `!!document.querySelector('[role=tab], .grid, table.grid, .findings, h2')`, 'the Session view')
  await sleep(4000)
  await page.screenshot(join(shots, '3-session.png'))
  const sessionText = await page.eval<string>(`document.body.innerText.slice(0, 1500)`)
  console.log(JSON.stringify({ ingestSeconds, report, filtered, sessionText }, null, 1))
  page.close()
} finally {
  app.kill()
  await sleep(500)
  if (!process.argv.includes('--keep')) rmSync(userData, { recursive: true, force: true })
  if (process.env.SHOW_LOG) console.error(log)
}
