/**
 * Where to find AdvantageScope on this computer and in what order to try, as plain data. No Electron here, so the
 * order is testable; electron/advantagescope.ts runs the attempts.
 */
import { posix, win32 } from 'node:path'

/** The file types AdvantageScope's own file filter accepts, less .log and .csv (too generic to hand it blindly). */
export const ASCOPE_EXTENSIONS = ['.wpilog', '.wpilogxz', '.rlog', '.hoot', '.revlog', '.dslog', '.dsevents'] as const

export const NOT_INSTALLED = "Hindsight couldn't find AdvantageScope on this computer. Install it from github.com/Mechanical-Advantage/AdvantageScope/releases or with WPILib, then try again."

/** The standalone app and the copy WPILib bundles share this macOS bundle id. */
const MAC_BUNDLE_ID = 'org.littletonrobotics.advantagescope'

export type Attempt =
  | { kind: 'open'; args: string[] }
  | { kind: 'spawn'; file: string; args: string[] }
  | { kind: 'default' }

export interface LaunchEnv { home: string; localAppData?: string; publicDir?: string }

export function opensInAdvantageScope(path: string): boolean {
  const lower = path.toLowerCase()
  return ASCOPE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** WPILib installs one folder per season (2026, 2027, ...); the newest is the one a student most likely just updated. */
function wpilibYears(dir: string, listDir: (dir: string) => string[]): string[] {
  return listDir(dir).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))
}

function macPlan(logPath: string, env: LaunchEnv, listDir: (dir: string) => string[]): Attempt[] {
  const root = posix.join(env.home, 'wpilib')
  const bundled = wpilibYears(root, listDir).map((year): Attempt => ({
    kind: 'open',
    args: ['-a', posix.join(root, year, 'advantagescope', 'AdvantageScope (WPILib).app'), logPath],
  }))
  return [{ kind: 'open', args: ['-b', MAC_BUNDLE_ID, logPath] }, ...bundled]
}

function windowsPlan(logPath: string, env: LaunchEnv, listDir: (dir: string) => string[]): Attempt[] {
  const spawns: string[] = []
  // electron-builder's per-user install location.
  if (env.localAppData) spawns.push(win32.join(env.localAppData, 'Programs', 'advantagescope', 'AdvantageScope.exe'))
  const root = win32.join(env.publicDir ?? 'C:\\Users\\Public', 'wpilib')
  for (const year of wpilibYears(root, listDir)) spawns.push(win32.join(root, year, 'advantagescope', 'AdvantageScope (WPILib).exe'))
  return [...spawns.map((file): Attempt => ({ kind: 'spawn', file, args: [logPath] })), { kind: 'default' }]
}

/** WPILib's Linux installer puts the program at ~/wpilib/<year>/advantagescope/advantagescope-wpilib (its ShortcutService). */
function linuxPlan(logPath: string, env: LaunchEnv, listDir: (dir: string) => string[]): Attempt[] {
  const root = posix.join(env.home, 'wpilib')
  const bundled = wpilibYears(root, listDir).map((year): Attempt => ({ kind: 'spawn', file: posix.join(root, year, 'advantagescope', 'advantagescope-wpilib'), args: [logPath] }))
  return [...bundled, { kind: 'default' }]
}

/** The ways to open `logPath`, most likely first; the caller stops at the first that works. */
export function launchPlan(platform: string, logPath: string, env: LaunchEnv, listDir: (dir: string) => string[]): Attempt[] {
  if (platform === 'darwin') return macPlan(logPath, env, listDir)
  if (platform === 'win32') return windowsPlan(logPath, env, listDir)
  return linuxPlan(logPath, env, listDir)
}
