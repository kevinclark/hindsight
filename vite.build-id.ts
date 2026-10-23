import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A hash of the app's source (src/): a build that reads logs the same way has the same id. The page and the desktop app's main process both use it. */
export function sourceHash(dir = 'src'): string {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (name.name.startsWith('.')) continue // .DS_Store and the like aren't code
      const path = join(d, name.name)
      if (name.isDirectory()) walk(path)
      else { hash.update(path); hash.update(readFileSync(path)) }
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 16)
}

/**
 * A hash of the source files describing a log can depend on: every file reachable by relative imports from the describer
 * (the library's file reader and describe.ts), so a change to the Library view or the rules' UI does not make every log
 * read again, while a change to a reader, the match model, a profile or the describer does.
 */
export function describerHash(entries = ['src/hub/describe-file.ts', 'src/hub/describe.ts']): string {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)) {
      const target = join(dirname(file), m[1])
      try { visit(target) } catch { /* a name that is not a file (a directory import) is not source */ }
    }
  }
  for (const e of entries) visit(e)
  const hash = createHash('sha256')
  for (const file of [...seen].sort()) { hash.update(file); hash.update(readFileSync(file)) }
  return hash.digest('hex').slice(0, 16)
}
