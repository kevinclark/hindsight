/**
 * Ingest time per GB: brings every log in a folder into a throwaway library and prints seconds and seconds per GB, for the
 * first run and for a second run that finds everything already there.
 *
 *   node --experimental-strip-types scripts/ingest-bench.ts <log folder> [--copies N]
 *
 * With --copies N each log is brought in N times with a few bytes appended, so N times as many distinct logs reach the
 * library (a wpilog tolerates a cut-off last record, so they still read). The folder is only read.
 */
import { copyFile, mkdtemp, rm, appendFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ingest, localFolderFiles } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { describeFile } from '../src/hub/describe-file.ts'

const folder = resolve(process.argv[2] ?? '')
const copies = Number(process.argv[process.argv.indexOf('--copies') + 1]) || 1
const work = await mkdtemp(join(tmpdir(), 'hindsight-bench-'))
try {
  const source = join(work, 'source')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(source)
  for (const name of await readdir(folder)) {
    if (!/\.(wpilog|dslog|dsevents)$/i.test(name)) continue
    for (let i = 0; i < copies; i++) {
      const target = join(source, i === 0 ? name : `${i}-${name}`)
      await copyFile(join(folder, name), target)
      if (i > 0) await appendFile(target, Buffer.from(`copy ${i}`)) // distinct bytes, same log
    }
  }
  const files = await localFolderFiles(source)
  const gb = files.reduce((n, f) => n + f.size, 0) / 2 ** 30
  const lib = await LocalLibrary.open(join(work, 'library'), 'bench')
  const seen = new Map<string, string>()
  const run = async (cache?: Map<string, string>) => {
    const t = performance.now()
    const report = await ingest(lib, files, { describe: describeFile, seen: cache })
    const s = (performance.now() - t) / 1000
    return { seconds: +s.toFixed(2), secondsPerGB: +(s / gb).toFixed(2), added: report.added.length, already: report.already.length, unreadable: report.unreadable.length }
  }
  console.log(JSON.stringify({ files: files.length, gigabytes: +gb.toFixed(3), first: await run(seen), 'second, remembering each file (the app)': await run(seen), 'third, every file read again': await run() }, null, 1))
} finally { await rm(work, { recursive: true, force: true }) }
