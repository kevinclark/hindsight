/**
 * Drives the running desktop app through Chrome's DevTools protocol (start it with `electron . --remote-debugging-port=N`).
 * Used by scripts/electron-check.ts; no extra dependency (the `ws` package is already a dev dependency).
 */
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

export interface Page {
  eval<T = unknown>(expression: string): Promise<T>
  screenshot(path: string): Promise<void>
  close(): void
}

export async function connect(port: number, timeoutMs = 20000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  let target: { webSocketDebuggerUrl: string } | undefined
  while (!target && Date.now() < deadline) {
    try { target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page') } catch { /* not up yet */ }
    if (!target) await new Promise((r) => setTimeout(r, 300))
  }
  if (!target) throw new Error(`no page on port ${port}`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let next = 0
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result)
  })
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const id = ++next
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  return {
    async eval<T>(expression: string) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value as T
    },
    async screenshot(path: string) {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(r.data, 'base64'))
    },
    close: () => ws.close(),
  }
}
