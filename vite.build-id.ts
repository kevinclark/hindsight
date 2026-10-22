import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
