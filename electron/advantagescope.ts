/** Opens a log in AdvantageScope by running the attempts of src/hub/advantagescope.ts until one works. */
import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { launchPlan, NOT_INSTALLED, type Attempt } from '../src/hub/advantagescope.ts'

const listDir = (dir: string): string[] => {
  try { return readdirSync(dir) } catch { return [] }
}

const runOpen = (args: string[]) => new Promise<boolean>((resolve) => {
  execFile('open', args, (error) => resolve(!error))
})

/** A program that can't start reports it asynchronously, so wait for either event. */
const runSpawn = (file: string, args: string[]) => new Promise<boolean>((resolve) => {
  if (!existsSync(file)) return resolve(false)
  const child = spawn(file, args, { detached: true, stdio: 'ignore' })
  child.once('error', () => resolve(false))
  child.once('spawn', () => { child.unref(); resolve(true) })
})

async function attempt(a: Attempt, logPath: string): Promise<boolean> {
  if (a.kind === 'open') return runOpen(a.args)
  if (a.kind === 'spawn') return runSpawn(a.file, a.args)
  return (await shell.openPath(logPath)) === ''
}

/** Resolves when some attempt worked; throws NOT_INSTALLED when none did. */
export async function openInAdvantageScope(logPath: string): Promise<void> {
  const env = { home: app.getPath('home'), localAppData: process.env.LOCALAPPDATA, publicDir: process.env.PUBLIC }
  for (const a of launchPlan(process.platform, logPath, env, listDir)) {
    if (await attempt(a, logPath)) return
  }
  throw new Error(NOT_INSTALLED)
}
