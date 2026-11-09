/**
 * A build of the iPhone app that measures reading whole logs on the phone (PHONE_BUILD=measure): for each log listed in
 * the app's own `measure/list.json` (copied into the gitignored ios/App/App/public/measure/ for the run, never committed),
 * the time to load its bytes and to parse it and run the rules as Match review does. Logs run smallest first; before
 * each one the page notes it in localStorage, so if iOS kills the web view (out of memory) and the page reloads, the log
 * that killed it is reported and skipped rather than retried. One line per step, on the page and to the console.
 */
import { analyzeFiles } from '../analyze.ts'

interface Entry { label: string; file: string; bytes: number }
const KEY = 'hindsight.measure'

export async function runMeasure(target: HTMLElement): Promise<void> {
  const list = document.createElement('ol')
  target.replaceChildren(Object.assign(document.createElement('h1'), { textContent: 'Hindsight log-reading measurement' }), list)
  const say = (text: string) => { list.append(Object.assign(document.createElement('li'), { textContent: text })); console.log(`HINDSIGHT-MEASURE ${text}`) }
  const state = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { running?: string; done?: string[] }
  const done = new Set(state.done ?? [])
  if (state.running) { say(`${state.running}: the web view was killed while reading it (reloaded)`); done.add(state.running) }
  const entries = ((await (await fetch('measure/list.json')).json()) as Entry[]).sort((a, b) => a.bytes - b.bytes)
  for (const e of entries) {
    if (done.has(e.label)) continue
    localStorage.setItem(KEY, JSON.stringify({ running: e.label, done: [...done] }))
    const mb = (e.bytes / 1048576).toFixed(1)
    const t0 = performance.now()
    const bytes = new Uint8Array(await (await fetch(`measure/${e.file}`)).arrayBuffer())
    const t1 = performance.now()
    const result = analyzeFiles([{ name: e.file, bytes }])
    const t2 = performance.now()
    const a = result.analyses[0]
    const findings = a ? a.report.findings.length : 0
    say(`${e.label} ${mb} MB: load ${(t1 - t0).toFixed(0)} ms, parse+rules ${(t2 - t1).toFixed(0)} ms (parse ${a?.timing.parseMs.toFixed(0)} ms, rules ${a?.timing.rulesMs.toFixed(0)} ms), ${findings} findings${result.problems.length ? `, problems: ${result.problems.join('; ')}` : ''}`)
    done.add(e.label)
    localStorage.setItem(KEY, JSON.stringify({ done: [...done] }))
    await new Promise((r) => setTimeout(r, 500))
  }
  localStorage.removeItem(KEY)
  say('done')
}
