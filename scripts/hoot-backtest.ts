/**
 * Same robot run, rule inputs from the .hoot or from AdvantageKit: do the inputs agree, and do the rules that read them
 * reach the same findings? Read-only on the library.
 *
 *   node --experimental-strip-types --max-old-space-size=4096 scripts/hoot-backtest.ts <library folder> <owlet folder> <out.json>
 *
 * A pair is an AdvantageKit robot log and a CANivore .hoot the catalog attached to it whose enable edges line up
 * (src/hoot/align.ts). For each pair the 2026 competition profile is pinned and three copies of the robot log go through
 * `analyzeFiles`:
 *   AK      the robot log as it is;
 *   H-full  each mapped key's records replaced by every .hoot record, shifted onto the robot log's clock;
 *   H-rate  the same, with the .hoot sampled (hold-last) at the robot log's own record times for that key.
 * Everything else in the log (metadata, Driver Station, unmapped keys) stays the robot log's, so the build identity, the match
 * windows and every rule that reads no mapped key are identical by construction.
 *
 * How a replaced log is built: the original file's bytes are spliced, not re-encoded. Every record of a replaced entry is
 * left out, every other record is copied as it is, and the new records of the replaced entries are appended (the control
 * record that announces each entry stays, so its name and type are kept). The reader indexes each entry's records on their
 * own and does not need the file in global time order. A re-encode of the whole log through src/readers/wpilog-writer.ts
 * would move every record's payload through memory for nothing and could change something the proof below could not see.
 *
 * Nothing here is written under the library. owlet's exports go to a folder made with mkdtemp and removed in `finally`.
 * Prints at run time only: the JSON names the files, the printed tables use pair numbers.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { compliancyOf, findOwlet, parseScan, runOutcome, runOwlet } from '../src/hoot/owlet.ts'
import { align, edgesOf } from '../src/hoot/align.ts'
import { changes } from '../src/hoot/reduce.ts'
import { openWpilog, readNumbers, type WpilogFile } from '../src/readers/wpilog.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { RULES } from '../src/rules/index.ts'
import { runRules } from '../src/rules/run.ts'
import { competition2026 } from '../src/profiles/2026-competition.ts'
import type { Report } from '../src/rules/run.ts'
import type { Finding } from '../src/rules/types.ts'
import type { Match } from '../src/match/match.ts'

const [libraryDir, owletDir, outPath] = process.argv.slice(2)
if (!libraryDir || !owletDir || !outPath) { console.error('usage: hoot-backtest.ts <library folder> <owlet folder> <out.json>'); process.exit(2) }
// Development only: stop after this many pairs (a full run is the default).
const PAIR_LIMIT = process.env.HOOT_BACKTEST_PAIRS ? Number(process.env.HOOT_BACKTEST_PAIRS) : Infinity

const profile = competition2026
const list = (d: string) => { try { return readdirSync(d) } catch { return [] } }

// ---------------------------------------------------------------- small numeric helpers

interface Ser { t: Float64Array; v: Float64Array }
const sorted = (x: ArrayLike<number>) => Float64Array.from(x).sort()
const quantile = (x: ArrayLike<number>, q: number) => { if (!x.length) return NaN; const s = sorted(x); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
const median = (x: ArrayLike<number>) => quantile(x, 0.5)
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '-')

/** Index of the last record at or before t, or -1. */
function indexAt(t: ArrayLike<number>, x: number, from = 0): number {
  let lo = from, hi = t.length - 1, ans = from - 1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= x) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

/** Hold-last sample of a series at ascending times; NaN before the first record or after `until`. */
function sampleAt(s: Ser, times: ArrayLike<number>, until = Infinity): Float64Array {
  const out = new Float64Array(times.length)
  let j = -1
  for (let i = 0; i < times.length; i++) {
    const x = times[i]
    while (j + 1 < s.t.length && s.t[j + 1] <= x) j++
    out[i] = j < 0 || x > until ? NaN : s.v[j]
  }
  return out
}

const shifted = (s: Ser, offset: number, scale = 1): Ser => ({ t: s.t.map((x) => x + offset), v: scale === 1 ? s.v : s.v.map((x) => x * scale) })

// ---------------------------------------------------------------- owlet export of a .hoot

const SIGNALS = /^(RobotEnable|RobotMode|TalonFX-\d+\/(SupplyVoltage|SupplyCurrent|StatorCurrent|MotorVoltage|Velocity|DeviceTemp)|Pigeon2-\d+\/(Pitch|Roll))$/

interface Export { log: WpilogFile; cutShort: string | null; seconds: number }

async function exportHoot(owletPath: string, hootPath: string, tmp: string): Promise<Export> {
  const started = Date.now()
  const scanned = await runOwlet([owletPath, '--scan', '-F', hootPath], { what: 'scan', deadlineMs: 120_000 })
  const scan = parseScan(scanned.out)
  if (!runOutcome(scanned, scan.ids.size > 0).ok) throw new Error('owlet scan failed')
  const ids = [...scan.ids].filter(([name]) => SIGNALS.test(name)).map(([, id]) => id)
  const out = join(tmp, 'export.wpilog')
  const run = await runOwlet([owletPath, hootPath, out, '-f', 'wpilog', '-s', ids.join(',')], { what: 'export', stallMs: 60_000 })
  const wrote = ((await stat(out).catch(() => null))?.size ?? 0) > 0
  const outcome = runOutcome(run, wrote)
  if (!outcome.ok) throw new Error(outcome.why)
  const log = openWpilog(new Uint8Array(await readFile(out)))
  await rm(out, { force: true })
  return { log, cutShort: outcome.cutShort ?? scan.cutShort, seconds: (Date.now() - started) / 1000 }
}

// ---------------------------------------------------------------- replacing records in a wpilog

interface Replacement { key: string; type: string; t: ArrayLike<number>; v: ArrayLike<number> }

/** The record headers of a log: where each record starts and ends, and its entry id. */
function* records(bytes: Uint8Array): Generator<{ pos: number; end: number; id: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 12 + view.getUint32(8, true)
  while (pos < bytes.length) {
    const b = bytes[pos]
    const idLen = (b & 3) + 1, sizeLen = ((b >> 2) & 3) + 1, tsLen = ((b >> 4) & 7) + 1
    let p = pos + 1
    if (p + idLen + sizeLen + tsLen > bytes.length) return
    let id = 0, size = 0
    for (let i = idLen - 1; i >= 0; i--) id = id * 256 + bytes[p + i]
    p += idLen
    for (let i = sizeLen - 1; i >= 0; i--) size = size * 256 + bytes[p + i]
    p += sizeLen + tsLen
    if (p + size > bytes.length) return
    yield { pos, end: p + size, id }
    pos = p + size
  }
}

/** The log with each replacement's entry emptied and refilled. No replacements: the same bytes. */
function replaceKeys(bytes: Uint8Array, log: WpilogFile, replacements: Replacement[]): Uint8Array {
  if (!replacements.length) return bytes
  const dropped = new Set(replacements.map((r) => {
    const e = log.entries.get(r.key)
    if (!e) throw new Error(`no entry ${r.key}`)
    return e.id
  }))
  const width = (type: string) => (type === 'float' ? 4 : 8)
  const extra = replacements.reduce((n, r) => n + r.t.length * (17 + width(r.type)), 0)
  const out = new Uint8Array(bytes.length + extra)
  const view = new DataView(out.buffer)
  let o = 0
  let runStart = -1, runEnd = -1
  const flush = () => { if (runStart >= 0) { out.set(bytes.subarray(runStart, runEnd), o); o += runEnd - runStart; runStart = -1 } }
  // The file header (and any extra header text) is copied first.
  const firstRecord = 12 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true)
  out.set(bytes.subarray(0, firstRecord), 0); o = firstRecord
  for (const r of records(bytes)) {
    if (dropped.has(r.id)) { flush(); continue }
    if (runStart >= 0 && r.pos === runEnd) runEnd = r.end
    else { flush(); runStart = r.pos; runEnd = r.end }
  }
  flush()
  for (const r of replacements) {
    const id = log.entries.get(r.key)!.id
    const w = width(r.type)
    for (let k = 0; k < r.t.length; k++) {
      const us = Math.max(0, Math.round(r.t[k] * 1e6))
      view.setUint8(o, 0x3 | (0x3 << 2) | (0x7 << 4))
      view.setUint32(o + 1, id, true)
      view.setUint32(o + 5, w, true)
      view.setUint32(o + 9, us % 4294967296, true)
      view.setUint32(o + 13, Math.floor(us / 4294967296), true)
      if (w === 4) view.setFloat32(o + 17, r.v[k], true)
      else view.setFloat64(o + 17, r.v[k], true)
      o += 17 + w
    }
  }
  return out.subarray(0, o)
}

// ---------------------------------------------------------------- the mapping

type Cls = 'supply current' | 'stator current' | 'velocity' | 'temperature' | 'applied volts' | 'battery' | 'pitch' | 'roll'
/** Samples with |AdvantageKit value| under this are left out of the slope (it is through the origin). */
const FLOOR: Record<Cls, number> = { 'supply current': 1, 'stator current': 1, velocity: 0.5, temperature: 1, 'applied volts': 0.5, battery: 1, pitch: 0.005, roll: 0.005 }

interface Mapped { key: string; cls: Cls; from: string; type: string; ak: Ser; hoot: Ser }

interface PairInput { n: number; akName: string; hootName: string; akBytes: Uint8Array; akLog: WpilogFile; offset: number; ex: Export; hootSeconds: { start: number; end: number } }

// A Rotation2d struct is one double (radians), which is how the gyro keys are logged.
const numericTypes = new Set(['double', 'float', 'struct:Rotation2d'])

function buildMapping(p: PairInput): { mapped: Mapped[]; notes: string[]; talonMedian: Ser; unmapped: string[] } {
  const notes: string[] = []
  const unmapped: string[] = []
  const mapped: Mapped[] = []
  const seen = new Set<string>()
  const hootSeries = (name: string, scale = 1): Ser | null => { const s = readNumbers(p.ex.log, name); return s && s.t.length ? shifted(s, p.offset, scale) : null }
  const add = (key: string | undefined, cls: Cls, from: string, hoot: Ser | null) => {
    if (!key || seen.has(key)) return
    if (!hoot) { unmapped.push(`${key}: hoot has no ${from}`); return }
    const e = p.akLog.entries.get(key)
    if (!e) { unmapped.push(`${key}: not in the AdvantageKit log`); return }
    if (!numericTypes.has(e.type)) { unmapped.push(`${key}: type ${e.type}`); return }
    const ak = readNumbers(p.akLog, key)
    if (!ak || !ak.t.length) { unmapped.push(`${key}: no records`); return }
    seen.add(key)
    mapped.push({ key, cls, from, type: e.type, ak, hoot })
  }
  for (const g of profile.motorGroups) {
    g.motors.forEach((m, i) => {
      if (m.canId === undefined) return
      const dev = `TalonFX-${m.canId}`
      const h = (sig: string) => hootSeries(`Phoenix6/${dev}/${sig}`)
      add(m.supplyCurrent, 'supply current', `${dev}/SupplyCurrent`, h('SupplyCurrent'))
      add(m.statorCurrent, 'stator current', `${dev}/StatorCurrent`, h('StatorCurrent'))
      add(m.velocity, 'velocity', `${dev}/Velocity`, h('Velocity'))
      add(m.temperature, 'temperature', `${dev}/DeviceTemp`, h('DeviceTemp'))
      // The leader (first motor) is the one whose applied voltage the group logs.
      if (i === 0) add(g.spinUp?.appliedVolts, 'applied volts', `${dev}/MotorVoltage`, h('MotorVoltage'))
    })
  }
  // Battery: median over the TalonFX supply voltages, a device counting while its last record is under 0.1 s old.
  const volts: Ser[] = []
  for (const name of p.ex.log.entries.keys()) {
    const m = /^Phoenix6\/(TalonFX-\d+)\/SupplyVoltage$/.exec(name)
    if (m) { const s = hootSeries(name); if (s) volts.push(s) }
  }
  const talonMedian = medianOf(volts)
  add(profile.signals.batteryVoltage as string, 'battery', 'median of TalonFX SupplyVoltage', talonMedian.t.length ? talonMedian : null)
  // Gyro: degrees to radians (AdvantageKit's are radians).
  const pigeons = [...p.ex.log.entries.keys()].map((n) => /^Phoenix6\/(Pigeon2-\d+)\//.exec(n)?.[1]).filter((x): x is string => !!x)
  const pigeon = [...new Set(pigeons)][0]
  if (new Set(pigeons).size > 1) notes.push(`several Pigeons in the .hoot (${[...new Set(pigeons)].join(', ')}); the first is used`)
  if (pigeon) {
    add(profile.signals.gyroPitch as string, 'pitch', `${pigeon}/Pitch x pi/180`, hootSeries(`Phoenix6/${pigeon}/Pitch`, Math.PI / 180))
    add(profile.signals.gyroRoll as string, 'roll', `${pigeon}/Roll x pi/180`, hootSeries(`Phoenix6/${pigeon}/Roll`, Math.PI / 180))
  } else notes.push('no Pigeon2 in the .hoot')
  return { mapped, notes, talonMedian, unmapped }
}

/** At every record time of any series: the median of the series whose last record is under 0.1 s old. */
function medianOf(series: Ser[]): Ser {
  if (!series.length) return { t: new Float64Array(0), v: new Float64Array(0) }
  const all = Float64Array.from(series.flatMap((s) => Array.from(s.t))).sort()
  const times: number[] = []
  const vals: number[] = []
  const at = series.map(() => -1)
  let last = -Infinity
  for (const x of all) {
    if (x === last) continue
    last = x
    const live: number[] = []
    series.forEach((s, i) => {
      while (at[i] + 1 < s.t.length && s.t[at[i] + 1] <= x) at[i]++
      if (at[i] >= 0 && x - s.t[at[i]] < 0.1) live.push(s.v[at[i]])
    })
    if (live.length) { times.push(x); vals.push(median(live)) }
  }
  return { t: Float64Array.from(times), v: Float64Array.from(vals) }
}

// ---------------------------------------------------------------- the three logs

/** What replaces a key in H-full (every .hoot record inside the log's window) and in H-rate (sampled at the log's record times). */
function replacementsFor(m: Mapped, window: [number, number], mode: 'full' | 'rate' | 'identity'): Replacement {
  if (mode === 'identity') return { key: m.key, type: m.type, t: m.ak.t, v: m.ak.v }
  if (mode === 'full') {
    const t: number[] = [], v: number[] = []
    for (let i = 0; i < m.hoot.t.length; i++) if (m.hoot.t[i] >= window[0] && m.hoot.t[i] <= window[1]) { t.push(m.hoot.t[i]); v.push(m.hoot.v[i]) }
    return { key: m.key, type: m.type, t, v }
  }
  const sampled = sampleAt(m.hoot, m.ak.t, m.hoot.t[m.hoot.t.length - 1])
  const t: number[] = [], v: number[] = []
  for (let i = 0; i < sampled.length; i++) if (Number.isFinite(sampled[i])) { t.push(m.ak.t[i]); v.push(sampled[i]) }
  return { key: m.key, type: m.type, t, v }
}

function analyse(name: string, bytes: Uint8Array) {
  const r = analyzeFiles([{ name, bytes }], profile)
  if (r.analyses.length !== 1) throw new Error(`analyzeFiles gave ${r.analyses.length} analyses (${r.problems.join('; ')})`)
  return r.analyses[0]
}

/** What identifies a finding, minus times and prose that can only be the same by accident. */
const essence = (r: Report) => JSON.stringify({
  findings: r.findings.map((x) => [x.rule, x.severity, x.about, x.time, x.title, x.evidence, x.measured?.map((m) => [m.label, m.value, m.threshold])]),
  skipped: r.skipped, crashed: r.crashed, dropped: r.droppedInShortRuns ?? [],
})

/** Which log keys each rule reads, found by running it alone on the match with a Map that notes every key asked for. */
function readSets(match: Match): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const origCache = match.cache
  const origResolved = match.log.resolved
  class Watch<K, V> extends Map<K, V> {
    seen: Set<string>
    constructor(from: Map<K, V>, seen: Set<string>) { super(from); this.seen = seen }
    get(k: K) { this.seen.add(String(k)); return super.get(k) }
    has(k: K) { this.seen.add(String(k)); return super.has(k) }
  }
  try {
    for (const rule of RULES) {
      const seen = new Set<string>()
      match.cache = new Watch(origCache, seen)
      match.log.resolved = new Watch(origResolved, seen)
      try { runRules(match, [rule]) } catch { /* the rule's own crash is reported by the real run */ }
      out.set(rule.id, new Set([...seen].map((k) => k.replace(/^values:/, ''))))
    }
  } finally { match.cache = origCache; match.log.resolved = origResolved }
  return out
}

// ---------------------------------------------------------------- comparing findings

interface Item { rule: string; about: string; severity: string; time: number | null; judged: number | null; title: string }
const itemsOf = (r: Report): Item[] => r.findings.filter((x) => x.rule !== 'meta/not-checked').map((x: Finding) => ({
  rule: x.rule, about: x.about ?? '', severity: x.severity, time: x.time, title: x.title,
  judged: x.measured?.[0]?.value ?? (Object.values(x.evidence).find((e) => typeof e === 'number') as number | undefined) ?? null,
}))

/** Rules whose several findings in one log are told apart by time (within 1 s); every other rule has one per item. */
const BY_TIME = new Set(['collision/tilt'])

interface Match1 { ak: Item; hoot: Item }
function matchItems(ak: Item[], hoot: Item[]): { both: Match1[]; akOnly: Item[]; hootOnly: Item[] } {
  const both: Match1[] = []
  const akOnly: Item[] = []
  const left = [...hoot]
  const byItem = (a: Item, b: Item) => a.about === b.about
  for (const a of ak) {
    const i = left.findIndex((h) => h.rule === a.rule && byItem(a, h) && (!BY_TIME.has(a.rule) || (a.time !== null && h.time !== null && Math.abs(a.time - h.time) <= 1)))
    if (i >= 0) { both.push({ ak: a, hoot: left[i] }); left.splice(i, 1) } else akOnly.push(a)
  }
  return { both, akOnly, hootOnly: left }
}

// ---------------------------------------------------------------- the run

function enabledWindows(en: Ser, end: number): [number, number][] {
  const w: [number, number][] = []
  let on = -1
  for (let i = 0; i < en.t.length; i++) {
    if (en.v[i] !== 0 && on < 0) on = en.t[i]
    else if (en.v[i] === 0 && on >= 0) { w.push([on, en.t[i]]); on = -1 }
  }
  if (on >= 0) w.push([on, end])
  return w
}
const inWindows = (w: [number, number][], x: number) => w.some(([a, b]) => x >= a && x < b)
const secondsIn = (w: [number, number][]) => w.reduce((n, [a, b]) => n + (b - a), 0)

interface KeyStat { pair: number; key: string; cls: Cls; from: string; n: number; sumHA: number; sumAA: number; absDiff: Float64Array; akPeak: number; hootPeak: number; akRecords: number; hootRecords: number; enabledS: number }

function keyStat(pair: number, m: Mapped, w: [number, number][]): KeyStat {
  const idx: number[] = []
  for (let i = 0; i < m.ak.t.length; i++) if (inWindows(w, m.ak.t[i])) idx.push(i)
  const times = Float64Array.from(idx, (i) => m.ak.t[i])
  const h = sampleAt(m.hoot, times, m.hoot.t[m.hoot.t.length - 1])
  const diffs: number[] = []
  let sumHA = 0, sumAA = 0
  idx.forEach((i, k) => {
    if (!Number.isFinite(h[k])) return
    diffs.push(Math.abs(h[k] - m.ak.v[i]))
    if (Math.abs(m.ak.v[i]) >= FLOOR[m.cls]) { sumHA += h[k] * m.ak.v[i]; sumAA += m.ak.v[i] ** 2 }
  })
  const akVals = idx.map((i) => Math.abs(m.ak.v[i]))
  let hootPeak = 0, hootRecords = 0
  for (let i = 0; i < m.hoot.t.length; i++) if (inWindows(w, m.hoot.t[i])) { hootRecords++; if (Math.abs(m.hoot.v[i]) > hootPeak) hootPeak = Math.abs(m.hoot.v[i]) }
  return { pair, key: m.key, cls: m.cls, from: m.from, n: diffs.length, sumHA, sumAA, absDiff: Float64Array.from(diffs), akPeak: akVals.length ? Math.max(...akVals) : NaN, hootPeak: hootRecords ? hootPeak : NaN, akRecords: idx.length, hootRecords, enabledS: secondsIn(w) }
}

const lib = await LocalLibrary.open(libraryDir, 'probe')
const tmp = await mkdtemp(join(tmpdir(), 'hindsight-hoot-backtest-'))
try {
  // ---- candidate pairs
  const robots = lib.catalog.entries().filter((e) => e.record.kind === 'wpilog')
  const candidates = robots.flatMap((e) => e.attached.hoot.filter((h) => !/(^|_)rio_/.test(h.path.split('/').pop()!)).map((h) => ({ robot: e.record, hoot: h })))
  console.log(`candidate pairs (robot log + attached CANivore .hoot, no rio_ file): ${candidates.length}`)

  const pairs: PairInput[] = []
  const excluded: { akName: string; hootName: string; why: string; enabledS: number }[] = []
  // Enabled time is counted once per robot log (a log can have two .hoot files attached).
  const enabledOfLog = new Map<string, number>()
  for (const c of candidates) {
    if (pairs.length >= PAIR_LIMIT) break
    const akName = c.robot.path.split('/').pop()!
    const hootName = c.hoot.path.split('/').pop()!
    const akBytes = new Uint8Array(await readFile(lib.store.at(c.robot.path)))
    const akLog = openWpilog(akBytes)
    const en = readNumbers(akLog, '/DriverStation/Enabled')
    const logEdges = edgesOf(changes(en).map((x) => ({ t: x.t, on: x.v !== 0 })))
    const enabledS = en ? secondsIn(enabledWindows(en, akLog.lastTime)) : 0
    enabledOfLog.set(akName, enabledS)
    const hootPath = lib.store.at(c.hoot.path)
    const fh = await open(hootPath).catch(() => null)
    if (!fh) { excluded.push({ akName, hootName, why: 'the .hoot is not on this computer', enabledS }); continue }
    const head = new Uint8Array(80); await fh.read(head, 0, 80, 0); await fh.close()
    const compliancy = compliancyOf(head)
    const owlet = compliancy === null ? null : findOwlet(compliancy, [{ dir: owletDir, where: 'hindsight' }], list)
    if (!owlet) { excluded.push({ akName, hootName, why: `no owlet for format ${compliancy}`, enabledS }); continue }
    let ex: Export
    try { ex = await exportHoot(owlet.path, hootPath, tmp) } catch (err) { excluded.push({ akName, hootName, why: `owlet: ${err instanceof Error ? err.message : String(err)}`, enabledS }); continue }
    const he = edgesOf(changes(readNumbers(ex.log, 'RobotEnable')).map((x) => ({ t: x.t, on: x.v !== 0 })))
    const a = align(he, logEdges)
    if (a.offset === null) { excluded.push({ akName, hootName, why: a.why, enabledS }); continue }
    pairs.push({ n: pairs.length + 1, akName, hootName, akBytes, akLog, offset: a.offset, ex, hootSeconds: { start: ex.log.firstTime, end: ex.log.lastTime } })
    console.log(`  exported pair ${pairs.length}: ${ex.seconds.toFixed(0)} s, offset ${a.offset.toFixed(3)} s, ${a.matched} edges${ex.cutShort ? ', hoot cut short' : ''}`)
  }

  const pairedLogs = new Set(pairs.map((x) => x.akName))
  const enabledPaired = [...pairedLogs].reduce((n, k) => n + (enabledOfLog.get(k) ?? 0), 0)
  const enabledLeft = [...enabledOfLog].filter(([k]) => !pairedLogs.has(k)).reduce((n, [, s]) => n + s, 0)
  console.log('')
  console.log(`=== ${pairs.length} of ${candidates.length} candidate .hoot files paired, on ${pairedLogs.size} robot logs, ${f(enabledPaired, 0)} s enabled; ${excluded.length} candidates excluded; robot logs with no pair: ${f(enabledLeft, 0)} s enabled (${f(100 * enabledLeft / ((enabledPaired + enabledLeft) || 1), 0)} % of the enabled time of all candidate logs)`)
  excluded.forEach((x, i) => console.log(`  excluded ${i + 1}: ${f(x.enabledS, 0)} s enabled, ${x.why}`))

  // ---- per pair
  const stats: KeyStat[] = []
  const batteryRows: { pair: number; restMedianDiff: number; restN: number; akMin: number; hootMin: number; bins: Record<string, number[]> }[] = []
  const pairReports: Record<string, unknown>[] = []
  type Arm = 'full' | 'rate'
  const cmp: Record<Arm, Map<string, { both: (Match1 & { pair: number })[]; akOnly: (Item & { pair: number })[]; hootOnly: (Item & { pair: number })[]; notChecked: { pair: number; ak: string | null; hoot: string | null }[] }>> = { full: new Map(), rate: new Map() }
  const compared = new Map<string, Set<number>>()
  const unflagged: string[] = []
  const noop: { pair: number; zeroKeysSameBytes: boolean; zeroKeysSameFindings: boolean; identitySameFindings: boolean; identityKeys: number }[] = []

  for (const p of pairs) {
    console.log(`\n--- pair ${p.n}`)
    const { mapped, notes, talonMedian, unmapped } = buildMapping(p)
    const akEn = readNumbers(p.akLog, '/DriverStation/Enabled')!
    const w = enabledWindows(akEn, p.akLog.lastTime)
    const window: [number, number] = [p.akLog.firstTime, p.akLog.lastTime]
    const hootEndsBy = p.akLog.lastTime - (p.hootSeconds.end + p.offset)
    console.log(`  mapped ${mapped.length} keys; unmapped ${unmapped.length}; log end minus hoot end ${f(hootEndsBy, 1)} s (positive: the .hoot stops early); ${f(secondsIn(w), 0)} s enabled`)
    notes.forEach((n) => console.log(`  note: ${n}`))

    for (const m of mapped) stats.push(keyStat(p.n, m, w))

    // Battery detail.
    const bat = mapped.find((m) => m.cls === 'battery')
    if (bat) {
      const firstOn = akEn.t.find((_, i) => akEn.v[i] !== 0) ?? NaN
      const restIdx = Array.from(bat.ak.t.keys()).filter((i) => bat.ak.t[i] >= firstOn - 2 && bat.ak.t[i] < firstOn)
      const restDiff = (() => { const h = sampleAt(bat.hoot, restIdx.map((i) => bat.ak.t[i]), bat.hoot.t[bat.hoot.t.length - 1]); return restIdx.map((i, k) => h[k] - bat.ak.v[i]).filter(Number.isFinite) })()
      const supplyKeys = mapped.filter((m) => m.cls === 'supply current')
      // Σ AdvantageKit supply current over every profile motor the log has, not only the mapped ones.
      const allSupply: Ser[] = []
      for (const g of profile.motorGroups) for (const mo of g.motors) if (mo.supplyCurrent) { const s = readNumbers(p.akLog, mo.supplyCurrent); if (s && s.t.length) allSupply.push(s) }
      void supplyKeys
      const enIdx = Array.from(bat.ak.t.keys()).filter((i) => inWindows(w, bat.ak.t[i]))
      const times = Float64Array.from(enIdx, (i) => bat.ak.t[i])
      const hs = sampleAt(bat.hoot, times, bat.hoot.t[bat.hoot.t.length - 1])
      const sums = new Float64Array(times.length)
      for (const s of allSupply) { const x = sampleAt(s, times); for (let k = 0; k < x.length; k++) if (Number.isFinite(x[k])) sums[k] += x[k] }
      const bins: Record<string, number[]> = { '0-50': [], '50-150': [], '150-300': [], '>300': [] }
      enIdx.forEach((i, k) => {
        if (!Number.isFinite(hs[k])) return
        const b = sums[k] < 50 ? '0-50' : sums[k] < 150 ? '50-150' : sums[k] < 300 ? '150-300' : '>300'
        bins[b].push(hs[k] - bat.ak.v[i])
      })
      let hootMin = Infinity
      for (let i = 0; i < talonMedian.t.length; i++) if (inWindows(w, talonMedian.t[i]) && talonMedian.v[i] < hootMin) hootMin = talonMedian.v[i]
      let akMin = Infinity
      for (const i of enIdx) if (bat.ak.v[i] < akMin) akMin = bat.ak.v[i]
      batteryRows.push({ pair: p.n, restMedianDiff: median(restDiff), restN: restDiff.length, akMin, hootMin, bins })
    }

    // ---- three logs + no-op proofs
    const akAnalysis = analyse(p.akName, p.akBytes)
    const akEssence = essence(akAnalysis.report)
    const noopBytes = replaceKeys(p.akBytes, p.akLog, [])
    const zeroSame = noopBytes === p.akBytes || Buffer.compare(noopBytes, p.akBytes) === 0
    const zeroFindings = essence(analyse(p.akName, noopBytes).report) === akEssence
    const idBytes = replaceKeys(p.akBytes, p.akLog, mapped.map((m) => replacementsFor(m, window, 'identity')))
    const idFindings = essence(analyse(p.akName, idBytes).report) === akEssence
    noop.push({ pair: p.n, zeroKeysSameBytes: zeroSame, zeroKeysSameFindings: zeroFindings, identitySameFindings: idFindings, identityKeys: mapped.length })
    console.log(`  no-op: zero keys replaced -> bytes ${zeroSame ? 'identical' : 'DIFFER'}, findings ${zeroFindings ? 'identical' : 'DIFFER'}; each mapped key replaced by its own AK records (${mapped.length} keys) -> findings ${idFindings ? 'identical' : 'DIFFER'}`)

    const reads = readSets(akAnalysis.match)
    const replacedKeys = new Set(mapped.map((m) => m.key))
    const readsReplaced = (rule: string) => [...(reads.get(rule) ?? [])].some((k) => replacedKeys.has(k))
    const akItems = itemsOf(akAnalysis.report)
    const akSkipped = new Map(akAnalysis.report.skipped.map((s) => [s.rule, s.reason]))

    const arms: Record<Arm, Report> = { full: null as unknown as Report, rate: null as unknown as Report }
    for (const arm of ['full', 'rate'] as Arm[]) {
      const bytes = replaceKeys(p.akBytes, p.akLog, mapped.map((m) => replacementsFor(m, window, arm)))
      arms[arm] = analyse(p.akName, bytes).report
      const hItems = itemsOf(arms[arm])
      const hSkipped = new Map(arms[arm].skipped.map((s) => [s.rule, s.reason]))
      for (const rule of RULES) {
        const reads1 = readsReplaced(rule.id)
        const a = akItems.filter((x) => x.rule === rule.id), h = hItems.filter((x) => x.rule === rule.id)
        const r = matchItems(a, h)
        const differs = r.akOnly.length + r.hootOnly.length > 0 || r.both.some((b) => b.ak.severity !== b.hoot.severity || b.ak.judged !== b.hoot.judged) || akSkipped.get(rule.id) !== hSkipped.get(rule.id)
        if (!reads1) { if (differs) unflagged.push(`pair ${p.n} ${arm} ${rule.id}`); continue }
        compared.set(rule.id, (compared.get(rule.id) ?? new Set()).add(p.n))
        const slot = cmp[arm].get(rule.id) ?? { both: [], akOnly: [], hootOnly: [], notChecked: [] }
        slot.both.push(...r.both.map((b) => ({ ...b, pair: p.n })))
        slot.akOnly.push(...r.akOnly.map((x) => ({ ...x, pair: p.n })))
        slot.hootOnly.push(...r.hootOnly.map((x) => ({ ...x, pair: p.n })))
        if ((akSkipped.get(rule.id) ?? null) !== (hSkipped.get(rule.id) ?? null) || akSkipped.has(rule.id)) slot.notChecked.push({ pair: p.n, ak: akSkipped.get(rule.id) ?? null, hoot: hSkipped.get(rule.id) ?? null })
        cmp[arm].set(rule.id, slot)
      }
    }
    pairReports.push({ pair: p.n, akFile: p.akName, hootFile: p.hootName, offset: p.offset, hootEndsBeforeLogEnd: hootEndsBy, mapped: mapped.map((m) => ({ key: m.key, cls: m.cls, from: m.from })), unmapped, notes })
  }

  // ---------------------------------------------------------------- the report
  console.log('\n\n=== NO-OP PROOF (the replaced-log builder changes nothing when it replaces nothing)')
  for (const x of noop) console.log(`  pair ${x.pair}: zero keys: bytes ${x.zeroKeysSameBytes ? 'identical' : 'DIFFER'}, findings ${x.zeroKeysSameFindings ? 'identical' : 'DIFFER'}; own-records replacement of ${x.identityKeys} keys: findings ${x.identitySameFindings ? 'identical' : 'DIFFER'}`)
  const noopOk = noop.every((x) => x.zeroKeysSameBytes && x.zeroKeysSameFindings && x.identitySameFindings)
  console.log(`  ${noopOk ? 'PASS' : 'FAIL'}: ${noop.length} pairs`)

  console.log('\n=== INPUT SERIES, per mapped key over all pairs (enabled time; hoot held at the AdvantageKit record times)')
  console.log('slope = sum(hoot*AK)/sum(AK^2) through the origin over samples with |AK| >= floor; |diff| median / p95; peaks: AK over its records, hoot over ALL its records; Hz = records per enabled second (median over pairs)')
  console.log(['key', 'cls', 'pairs', 'samples', 'slope', 'med|d|', 'p95|d|', 'AK peak', 'hoot peak', 'AK Hz', 'hoot Hz'].join('\t'))
  const byKey = new Map<string, KeyStat[]>()
  for (const s of stats) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s])
  const rows = (group: KeyStat[]) => {
    const all = Float64Array.from(group.flatMap((s) => Array.from(s.absDiff)))
    const sumHA = group.reduce((n, s) => n + s.sumHA, 0), sumAA = group.reduce((n, s) => n + s.sumAA, 0)
    return {
      pairs: group.length, samples: all.length, slope: sumAA ? sumHA / sumAA : NaN, med: median(all), p95: quantile(all, 0.95),
      akPeak: Math.max(...group.map((s) => s.akPeak).filter(Number.isFinite)), hootPeak: Math.max(...group.map((s) => s.hootPeak).filter(Number.isFinite)),
      akHz: median(group.map((s) => s.akRecords / (s.enabledS || NaN))), hootHz: median(group.map((s) => s.hootRecords / (s.enabledS || NaN))),
    }
  }
  const line = (label: string, cls: string, r: ReturnType<typeof rows>) => console.log([label, cls, r.pairs, r.samples, f(r.slope), f(r.med), f(r.p95), f(r.akPeak, 2), f(r.hootPeak, 2), f(r.akHz, 1), f(r.hootHz, 1)].join('\t'))
  const inputTable: Record<string, ReturnType<typeof rows>> = {}
  for (const [key, group] of byKey) { inputTable[key] = rows(group); line(key, group[0].cls, inputTable[key]) }
  console.log('-- pooled by kind')
  for (const cls of ['supply current', 'stator current', 'velocity', 'temperature', 'applied volts', 'battery', 'pitch', 'roll'] as Cls[]) {
    const g = stats.filter((s) => s.cls === cls)
    if (g.length) { inputTable[`kind: ${cls}`] = rows(g); line(`(all ${cls} keys)`, cls, inputTable[`kind: ${cls}`]) }
  }

  console.log('\n=== GYRO AXIS AND SIGN CHECK (hoot Pigeon x pi/180 against each AdvantageKit axis; slope through the origin, |AK| >= floor)')
  for (const p of pairs) {
    const { mapped } = buildMapping(p)
    const w = enabledWindows(readNumbers(p.akLog, '/DriverStation/Enabled')!, p.akLog.lastTime)
    const pitch = mapped.find((m) => m.cls === 'pitch'), roll = mapped.find((m) => m.cls === 'roll')
    if (!pitch || !roll) { console.log(`  pair ${p.n}: gyro not mapped`); continue }
    const slope = (h: Ser, a: Ser) => {
      const idx = Array.from(a.t.keys()).filter((i) => inWindows(w, a.t[i]))
      const hv = sampleAt(h, Float64Array.from(idx, (i) => a.t[i]), h.t[h.t.length - 1])
      let ha = 0, aa = 0, hh = 0
      idx.forEach((i, k) => { if (Number.isFinite(hv[k]) && Math.abs(a.v[i]) >= FLOOR.pitch) { ha += hv[k] * a.v[i]; aa += a.v[i] ** 2; hh += hv[k] ** 2 } })
      return { slope: aa ? ha / aa : NaN, corr: aa && hh ? ha / Math.sqrt(aa * hh) : NaN }
    }
    const pp = slope(pitch.hoot, pitch.ak), rr = slope(roll.hoot, roll.ak), pr = slope(pitch.hoot, roll.ak), rp = slope(roll.hoot, pitch.ak)
    console.log(`  pair ${p.n}: pitch~pitch slope ${f(pp.slope)} corr ${f(pp.corr)} | roll~roll ${f(rr.slope)} corr ${f(rr.corr)} | pitch~roll(AK) ${f(pr.slope)} corr ${f(pr.corr)} | roll~pitch(AK) ${f(rp.slope)} corr ${f(rp.corr)}`)
  }

  console.log('\n=== BATTERY: hoot median of TalonFX SupplyVoltage minus /SystemStats/BatteryVoltage')
  console.log('pair\trest n\trest median(hoot-AK) V\tenabled min AK V\tenabled min hoot V')
  for (const b of batteryRows) console.log([b.pair, b.restN, f(b.restMedianDiff), f(b.akMin, 2), f(b.hootMin, 2)].join('\t'))
  console.log('by AdvantageKit total supply current (all pairs pooled): n, median(hoot-AK) V, p5 V, p95 V')
  const binTable: Record<string, { n: number; median: number; p5: number; p95: number } | null> = {}
  for (const bin of ['0-50', '50-150', '150-300', '>300']) {
    const all = batteryRows.flatMap((b) => b.bins[bin])
    binTable[bin] = all.length ? { n: all.length, median: median(all), p5: quantile(all, 0.05), p95: quantile(all, 0.95) } : null
    console.log(`  ${bin} A\t${all.length ? `${all.length}\t${f(median(all))}\t${f(quantile(all, 0.05))}\t${f(quantile(all, 0.95))}` : 'no data'}`)
  }

  console.log('\n=== HOW "READS A REPLACED KEY" WAS DECIDED')
  console.log('Each rule was run alone on the AdvantageKit match with a Map that notes every key asked for (the match\'s signal cache and the log\'s key resolver); a rule is compared when it asked for a key replaced in that pair.')
  console.log(`Self-check: a rule that asked for no replaced key but whose findings or not-checked line differ on either arm: ${unflagged.length ? unflagged.join('; ') : 'none'}`)

  const verdictOf = (arm: Arm, rule: string) => {
    const c = cmp[arm].get(rule)
    if (!c) return { verdict: 'no data covers this', both: 0, akOnly: 0, hootOnly: 0, sev: 0 }
    const sev = c.both.filter((b) => b.ak.severity !== b.hoot.severity).length
    const total = c.both.length + c.akOnly.length + c.hootOnly.length
    const verdict = total === 0 ? 'no data covers this' : c.akOnly.length + c.hootOnly.length + sev > 0 ? 'disagrees' : `agrees on ${c.both.length} case${c.both.length === 1 ? '' : 's'}`
    return { verdict, both: c.both.length, akOnly: c.akOnly.length, hootOnly: c.hootOnly.length, sev }
  }
  const verdicts: Record<string, Record<Arm, ReturnType<typeof verdictOf>>> = {}
  console.log('\n=== RULES THAT READ A REPLACED KEY: findings, AdvantageKit vs .hoot')
  console.log(['rule', 'pairs reading', 'H-full both/AK only/hoot only', 'H-full verdict', 'H-rate both/AK only/hoot only', 'H-rate verdict'].join('\t'))
  for (const rule of RULES.map((r) => r.id).filter((id) => compared.has(id))) {
    verdicts[rule] = { full: verdictOf('full', rule), rate: verdictOf('rate', rule) }
    const a = verdicts[rule].full, b = verdictOf('rate', rule)
    console.log([rule, compared.get(rule)!.size, `${a.both}/${a.akOnly}/${a.hootOnly}`, a.verdict, `${b.both}/${b.akOnly}/${b.hootOnly}`, b.verdict].join('\t'))
  }

  console.log('\n=== MATCHED FINDINGS: judged number and severity (AK -> hoot)')
  for (const arm of ['full', 'rate'] as Arm[]) for (const [rule, c] of cmp[arm]) for (const b of c.both) {
    console.log(`  H-${arm} ${rule} pair ${b.pair} ${b.ak.about || '(match)'}${BY_TIME.has(rule) ? ` t ${f(b.ak.time ?? NaN, 1)}/${f(b.hoot.time ?? NaN, 1)}` : ''}: ${b.ak.severity}${b.ak.severity !== b.hoot.severity ? ` -> ${b.hoot.severity} (SEVERITY DIFFERS)` : ''}, judged ${b.ak.judged} -> ${b.hoot.judged}`)
  }
  console.log('\n=== DISAGREEMENTS (every one) and NOT-CHECKED STATUS')
  let disagreements = 0
  for (const arm of ['full', 'rate'] as Arm[]) for (const [rule, c] of cmp[arm]) {
    for (const x of c.akOnly) { disagreements++; console.log(`  H-${arm} ${rule} pair ${x.pair} ${x.about || '(match)'}${x.time !== null ? ` t ${f(x.time, 1)}` : ''}: AK only (${x.severity}, judged ${x.judged})`) }
    for (const x of c.hootOnly) { disagreements++; console.log(`  H-${arm} ${rule} pair ${x.pair} ${x.about || '(match)'}${x.time !== null ? ` t ${f(x.time, 1)}` : ''}: hoot only (${x.severity}, judged ${x.judged})`) }
    for (const n of c.notChecked) console.log(`  H-${arm} ${rule} pair ${n.pair} not-checked: AK ${n.ak ?? 'checked'} | hoot ${n.hoot ?? 'checked'}`)
  }
  if (!disagreements) console.log('  (no finding-level disagreement)')

  await writeFile(outPath, JSON.stringify({
    pairs: pairReports, excluded, noop, inputTable, batteryRows, binTable, unflagged, verdicts,
    findings: Object.fromEntries((['full', 'rate'] as Arm[]).map((arm) => [arm, Object.fromEntries([...cmp[arm]])])),
  }, null, 1))
  console.log(`\nJSON written to ${outPath}`)
  if (!noopOk) { console.log('NO-OP PROOF FAILED: do not trust any comparison above.'); process.exitCode = 1 }
} finally {
  await rm(tmp, { recursive: true, force: true })
}
