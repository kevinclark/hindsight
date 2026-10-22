/** The utility process behind electron/describer.ts: describe one file per message. */
import { describeFile } from '../src/hub/describe-file.ts'

const port = (process as unknown as { parentPort: { on(e: 'message', f: (m: { data: { id: number; path: string; name: string } }) => void): void; postMessage(m: unknown): void } }).parentPort

port.on('message', async ({ data }) => {
  try {
    port.postMessage({ id: data.id, ok: await describeFile(data.path, data.name) })
  } catch (e) {
    port.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) })
  }
})
