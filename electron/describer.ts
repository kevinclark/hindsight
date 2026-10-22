/** Reads logs in a utility process, one at a time, so a 672 MB log never freezes the window or the main process. */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { Described } from '../src/hub/describe-file.ts'

export class Describer {
  private child: UtilityProcess | null = null
  private next = 0
  private waiting = new Map<number, { resolve: (d: Described) => void; reject: (e: Error) => void }>()

  describe = (path: string, name: string): Promise<Described> => {
    const child = this.start()
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      child.postMessage({ id, path, name })
    })
  }

  stop(): void { this.child?.kill(); this.child = null }

  private start(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(join(__dirname, 'describe-worker.cjs'))
    child.on('message', (m: { id: number; ok?: Described; error?: string }) => {
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if (m.ok) w.resolve(m.ok); else w.reject(new Error(m.error ?? 'unreadable'))
    })
    child.on('exit', () => {
      for (const w of this.waiting.values()) w.reject(new Error('the reader process stopped (the file may be too large)'))
      this.waiting.clear()
      this.child = null
    })
    this.child = child
    return child
  }
}
