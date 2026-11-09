/**
 * CTRE's owlet, the only reader of .hoot files (ADR 13). Hindsight never ships, hosts or copies owlet and never parses a
 * .hoot itself: it runs an owlet the user already has (Hindsight's own folder, then AdvantageScope's cache) or one the user
 * downloads from CTRE's server after accepting CTRE's licence. Main process only (`node:` imports); the pure parts are
 * exported for the tests.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { hootName } from '../hub/dates.ts'

/** The .hoot's format version is the byte at this offset; owlet reads only its own compliancy. */
export const COMPLIANCY_OFFSET = 70
export const INDEX_URL = 'https://redist.ctr-electronics.com/index.json'
const CTRE_HOST = 'https://redist.ctr-electronics.com/'
export const LICENSE_URL = 'https://raw.githubusercontent.com/CrossTheRoadElec/Phoenix-Releases/refs/heads/master/CTRE_LICENSE.txt'

/** `owlet-26.3.0-C19` (`.exe` on Windows): the name AdvantageScope gives a cached owlet, and Hindsight too. */
const OWLET_NAME = /^owlet-(\d+(?:\.\d+)*)-C(\d+)(\.exe)?$/
/** The phrase owlet prints when a .hoot ends early; what came before it was still read. */
export const CUT_SHORT = 'Could not read to end of input file'

export function compliancyOf(head: Uint8Array): number | null {
  return head.length > COMPLIANCY_OFFSET ? head[COMPLIANCY_OFFSET] : null
}

export const owletFileName = (version: string, compliancy: number, platform: string) => `owlet-${version}-C${compliancy}${platform === 'win32' ? '.exe' : ''}`

/** Where AdvantageScope keeps its owlet copies (its Electron userData folder). */
export function advantageScopeOwletFolder(platform: string, env: { home: string; appData?: string; xdgConfig?: string }): string | null {
  if (platform === 'darwin') return join(env.home, 'Library', 'Application Support', 'AdvantageScope', 'owlet')
  if (platform === 'win32') return env.appData ? join(env.appData, 'AdvantageScope', 'owlet') : null
  return join(env.xdgConfig || join(env.home, '.config'), 'AdvantageScope', 'owlet')
}

export interface FoundOwlet { path: string; version: string; compliancy: number; where: 'hindsight' | 'advantagescope' }

/** The owlet for this compliancy: Hindsight's own folder first, then AdvantageScope's; the highest version within a folder. */
export function findOwlet(compliancy: number, folders: { dir: string; where: FoundOwlet['where'] }[], list: (dir: string) => string[]): FoundOwlet | null {
  for (const { dir, where } of folders) {
    const fits = list(dir).flatMap((name) => {
      const m = OWLET_NAME.exec(name)
      return m && Number(m[2]) === compliancy ? [{ path: join(dir, name), version: m[1], compliancy, where }] : []
    })
    if (fits.length) return fits.sort((a, b) => compareVersions(b.version, a.version))[0]
  }
  return null
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** CTRE's name for this computer's build, as AdvantageScope maps it: every Mac takes the universal build, Windows on Arm the x64 one. */
export function platformKey(platform: string, arch: string): string | null {
  if (platform === 'darwin') return 'macosuniversal'
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'windowsx86-64' : null
  if (platform === 'linux') return arch === 'x64' ? 'linuxx86-64' : arch === 'arm64' ? 'linuxarm64' : null
  return null
}

export interface OwletDownload { version: string; compliancy: number; url: string; sha1: string }

/** The newest owlet in CTRE's index for this compliancy with a build for this platform, or why there is none. */
export function pickDownload(index: unknown, compliancy: number, key: string | null): OwletDownload | { problem: string } {
  const tools = (index as { Tools?: { Name?: string; Items?: unknown[] }[] } | null)?.Tools
  const items = Array.isArray(tools) ? tools.find((t) => t?.Name === 'owlet')?.Items : undefined
  if (!Array.isArray(items)) return { problem: "CTRE's download list has no owlet in it." }
  if (!key) return { problem: 'CTRE has no owlet for this kind of computer.' }
  const fits = items.flatMap((raw) => {
    const it = raw as { Version?: unknown; Compliancy?: unknown; Urls?: Record<string, unknown> }
    const url = it.Urls?.[key]
    const sha1 = it.Urls?.[`${key}-sha1`]
    const ok = typeof it.Version === 'string' && /^\d+(\.\d+)*$/.test(it.Version) && it.Compliancy === compliancy
      && typeof url === 'string' && url.startsWith(CTRE_HOST) && typeof sha1 === 'string' && /^[0-9a-f]{40}$/.test(sha1)
    return ok ? [{ version: it.Version as string, compliancy, url: url as string, sha1: sha1 as string }] : []
  })
  if (fits.length === 0) return { problem: `CTRE lists no owlet for this computer that reads these .hoot files (format ${compliancy}).` }
  return fits.sort((a, b) => compareVersions(b.version, a.version))[0]
}

/** `--scan` output: signal name to id. Lines that are not a signal (owlet's own messages, a cut-short first line) are skipped. */
export function parseScan(text: string): { ids: Map<string, string>; cutShort: string | null } {
  const ids = new Map<string, string>()
  let cutShort: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(CUT_SHORT)) cutShort ??= line.trim()
    const m = /^([^\s:][^:]*):\s+([0-9a-fA-F]+)\s*$/.exec(line)
    if (m) ids.set(m[1], m[2])
  }
  return { ids, cutShort }
}

/** The health faults the view marks: power, temperature, hardware and restarts. Limit faults are normal operation and left out. */
export const HEALTH_FAULTS = ['Hardware', 'ProcTemp', 'DeviceTemp', 'Undervoltage', 'BootDuringEnable', 'BridgeBrownout', 'OverSupplyV', 'UnstableSupplyV',
  'BadMagnet', 'Thermal', 'ShortCircuit', 'SoftwareFuse', '5VTooLow', '5VTooHigh', 'Overvoltage']
const WANTED = new RegExp(`^(RobotEnable|[A-Za-z0-9]+-\\d+/(SupplyVoltage|SupplyCurrent|DeviceTemp|Temperature|Fault_(${HEALTH_FAULTS.join('|')})))$`)
/** Names the cache key on: a change to what is read rebuilds every cached reading. */
export const SIGNAL_SET = createHash('sha1').update(WANTED.source).digest('hex').slice(0, 8)

/** The ids of the signals the view draws, by name (ids differ between Phoenix versions; never hard-code one). */
export const wantedIds = (ids: Map<string, string>): string[] => [...ids].filter(([name]) => WANTED.test(name)).map(([, id]) => id)

/** The bus a .hoot is from, by its name: `<CANivore serial>_<date>_<time>.hoot` or `rio_…`, with any prefix (`_Q7_`) before it. */
export const busOf = (fileName: string): string => hootName(fileName)?.hardwareId ?? fileName.replace(/\.hoot$/i, '')

/** owlet could not be started at all (a damaged or unexecutable file): offered for download again. */
export class OwletWontStart extends Error {
  constructor(why: string) { super(`owlet could not start (${why}): get CTRE's converter again.`) }
}

export interface RunResult { code: number | null; out: string; err: string }

/**
 * Run owlet (no shell). `onPercent` gets each "Progress: [ NN%]" it prints. It is stopped and the promise rejects, in
 * words, when it prints no progress for `stallMs` (a conversion) or has not exited by `deadlineMs` (a scan prints nothing).
 */
export function runOwlet(argv: string[], opts: { stallMs?: number; deadlineMs?: number; onPercent?: (p: number) => void; what: string; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    let percent = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let failed: string | null = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      const ms = opts.stallMs ?? opts.deadlineMs
      if (ms !== undefined) {
        timer = setTimeout(() => {
          failed = opts.stallMs !== undefined ? `owlet stopped making progress at ${percent}% of ${opts.what} (nothing for ${Math.round(ms / 1000)} s)` : `owlet gave no answer for ${opts.what} within ${Math.round(ms / 1000)} s`
          child.kill()
        }, ms)
      }
    }
    arm()
    // Stop (or quitting the app) ends owlet at once; the caller removes what it had written.
    const stop = () => { failed = `Stopped while reading ${opts.what}.`; child.kill() }
    if (opts.signal?.aborted) stop()
    opts.signal?.addEventListener('abort', stop, { once: true })
    // A scan lists every signal (130 KB for 26 devices): keep it all, up to a bound no listing comes near.
    const keep = (text: string, add: string) => (text + add).slice(-16 * 2 ** 20)
    // The end of the last piece: a progress print can be split between two pieces of output.
    let tail = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      out = keep(out, text)
      const all = [...(tail + text).matchAll(/Progress:\s*\[\s*(\d+)%\]/g)]
      tail = (tail + text).slice(-24)
      if (all.length) {
        const p = Number(all[all.length - 1][1])
        // Only a new percentage is progress: an owlet printing the same one over and over is stuck.
        if (p !== percent && opts.stallMs !== undefined) arm()
        percent = p
        opts.onPercent?.(p)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { err = keep(err, chunk.toString()) })
    child.once('error', (e) => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener('abort', stop); reject(new OwletWontStart(e.message)) })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', stop)
      if (failed) reject(new Error(failed))
      else resolve({ code, out, err })
    })
  })
}

/** Whether a run counts: exit 0, or exit 1 with the cut-short phrase and an output (the file ended early, what it held was read). */
export function runOutcome(r: RunResult, wroteOutput: boolean): { ok: true; cutShort: string | null } | { ok: false; why: string } {
  const said = `${r.out}\n${r.err}`
  const cut = said.split(/\r?\n/).find((l) => l.includes(CUT_SHORT))?.trim() ?? null
  if (r.code === 0) return { ok: true, cutShort: cut }
  if (r.code === 1 && cut && wroteOutput) return { ok: true, cutShort: cut }
  return { ok: false, why: `owlet exited with ${r.code ?? 'no code'}: ${lastWords(r)}` }
}

/** owlet's last line of its own words (progress bars left out), or 'no message'. */
export const lastWords = (r: RunResult): string =>
  `${r.out}\n${r.err}`.split(/\r?\n/).map((l) => l.replace(/Progress:.*$/, '').trim()).filter(Boolean).at(-1) ?? 'no message'

export const sha1Of = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex')
