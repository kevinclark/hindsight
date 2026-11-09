/**
 * How well .hoot files line up with their robot logs on real logs: for every .hoot the library attached to a robot log
 * and holds, read it with an owlet already on this computer and line its enable edges up with the log's.
 *
 *   node --experimental-strip-types scripts/hoot-align-survey.ts <library folder> <cache folder> [owlet folder]
 *
 * The owlet folder defaults to AdvantageScope's cache (it must hold an owlet whose CTRE licence the user accepted).
 * Prints one line per file: bus, edges in each file, edges matched, offset, spread. Reads only; the cache folder gets the
 * reduced readings (reused on the next run).
 */
import { readdirSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { advantageScopeOwletFolder, compliancyOf, findOwlet } from '../src/hoot/owlet.ts'
import { readHoot } from '../src/hoot/read-hoot.ts'
import { align, edgesOf } from '../src/hoot/align.ts'
import { openWpilog, readNumbers } from '../src/readers/wpilog.ts'
import { changes } from '../src/hoot/reduce.ts'

const [libraryDir, cacheDir, owletDir] = process.argv.slice(2)
if (!libraryDir || !cacheDir) { console.error('usage: hoot-align-survey.ts <library folder> <cache folder> [owlet folder]'); process.exit(2) }
const folder = owletDir ?? advantageScopeOwletFolder(process.platform, { home: homedir(), appData: process.env.APPDATA, xdgConfig: process.env.XDG_CONFIG_HOME })!
const list = (d: string) => { try { return readdirSync(d) } catch { return [] } }

const lib = await LocalLibrary.open(libraryDir, 'probe')
const robots = lib.catalog.all().filter((r) => r.kind === 'wpilog' && r.wall)
const enabledOf = new Map<string, { t: number; on: boolean }[]>()
async function logEdges(path: string) {
  if (!enabledOf.has(path)) {
    const log = openWpilog(new Uint8Array(await readFile(lib.store.at(path))))
    enabledOf.set(path, edgesOf(changes(readNumbers(log, '/DriverStation/Enabled')).map((x) => ({ t: x.t, on: x.v !== 0 }))))
  }
  return enabledOf.get(path)!
}
const attachedTo = new Map(lib.catalog.entries().flatMap((e) => e.attached.hoot.map((h) => [h.path, e.record.path] as const)))
const SLACK = 5 * 60e3
for (const h of lib.catalog.all().filter((r) => r.kind === 'hoot')) {
  const path = lib.store.at(h.path)
  const head = new Uint8Array(80)
  const fh = await open(path).catch(() => null)
  if (!fh) continue
  await fh.read(head, 0, 80, 0); await fh.close()
  const c = compliancyOf(head)
  const owlet = c === null ? null : findOwlet(c, [{ dir: folder, where: 'advantagescope' }], list)
  const name = h.path.split('/').pop()!
  if (!owlet) { console.log(`${name}\tno owlet for format ${c}`); continue }
  try {
    const r = await readHoot({ owlet, argv: [owlet.path], hootPath: path, fileName: name, sha256: h.sha256, cacheDir, tempRoot: tmpdir() })
    const at = h.wall?.start ?? h.playedAt
    if (r.devices.length === 0 || at === null) { console.log(`${name}\t${r.bus}\tno devices`); continue }
    // Median record period of each device's densest series is not kept; the bin count says how dense the strip is.
    const he = edgesOf(r.enable)
    console.log(`${name}\t${r.bus}\t${r.devices.length} devices\thoot edges ${he.length}\t${r.cutShort ? 'cut short' : ''}\tattached to ${attachedTo.get(h.path)?.split('/').pop() ?? 'none'}`)
    for (const robot of robots.filter((x) => at >= x.wall!.start - SLACK && at <= x.wall!.end + SLACK)) {
      const le = await logEdges(robot.path)
      const a = align(he, le)
      let drift = ''
      if (a.offset !== null) {
        // Each matched edge's difference against its time: a slope says the clocks drift apart.
        const pairs = he.flatMap((e) => { const m = le.find((l) => l.on === e.on && Math.abs(l.t - e.t - a.offset!) <= 0.5); return m ? [[e.t, m.t - e.t, e.on ? 1 : 0]] : [] })
        const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n
        const slope = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / (pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0) || 1)
        const rise = pairs.filter((p) => p[2] === 1).map((p) => p[1]), fall = pairs.filter((p) => p[2] === 0).map((p) => p[1])
        const med = (x: number[]) => x.length ? [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)].toFixed(3) : '-'
        drift = ` slope ${(slope * 1e6).toFixed(0)} ppm over ${(pairs[n - 1][0] - pairs[0][0]).toFixed(0)} s, rise median ${med(rise)} fall median ${med(fall)}`
      }
      console.log(`    ${robot.path.split('/').pop()}\twall start ${((robot.wall!.start - at) / 1000).toFixed(1)} s end ${((robot.wall!.end - at) / 1000).toFixed(1)} s\tlog edges ${le.length}\t${a.offset === null ? `not aligned: ${a.why}` : `matched ${a.matched} offset ${a.offset.toFixed(3)} spread ${a.spread.toFixed(3)}${drift}`}`)
    }
  } catch (err) { console.log(`${name}\terror: ${err instanceof Error ? err.message : String(err)}`) }
}
