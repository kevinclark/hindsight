/**
 * Builds a team's robot code and starts it in desktop simulation, never touching the team's own folder: the code is
 * copied (the working tree, or one commit with `git archive`) into a folder of its own, and built there. The build
 * runs GradleRIO's `simulateExternalJavaRelease`, which writes where the native libraries and the main class are;
 * sim-run then starts the jar itself, with tools/sim-run/SimRunHarness.java as the main class and no HAL extension
 * (so no simulator window), and kills it if it runs past its deadline.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, platform, arch } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Built {
  /** The copy that was built. */
  folder: string
  jar: string
  libraryDir: string
  mainClass: string
  javaHome: string
  harnessDir: string
  gradleRio: string
  buildSeconds: number
}

export interface Source { robot: string; commit: string | null }

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '../../tools/sim-run/SimRunHarness.java')
/**
 * WPILib's copy of artifacts that left the internet with JCenter (grgit 3.0.0, which GradleRIO 2022 needs):
 * measured 2026-10-21, a 2022 robot builds with it and fails without.
 */
const JCENTER_MIRROR = 'https://frcmaven.wpi.edu/artifactory/ex-mvn-ajoberstarbintraybackup-remote'
/** Gradle's words for "not in the local cache" when run offline (measured on 7 of 9 history builds, 2026-10-21). */
const NOT_DOWNLOADED = /offline mode|No cached version|Could not resolve|Could not find|Could not download/
/** Measured: a run's robot program is ready 2–2.5 s after its JVM starts; Phoenix's first start can take 11 s. */
const START_ALLOWANCE_SECONDS = 45

/** Copies the robot code into `work` (keeping an earlier build there, so a second run builds in seconds). */
export function copyRobot(source: Source, work: string): string {
  const folder = join(work, 'robot')
  mkdirSync(folder, { recursive: true })
  for (const name of readdirSync(folder)) {
    if (name !== 'build' && name !== '.gradle') rmSync(join(folder, name), { recursive: true, force: true })
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', source.robot, ...args], { maxBuffer: 1 << 30 })
  if (source.commit) {
    execFileSync('tar', ['-x', '-C', folder], { input: git('archive', '--format=tar', source.commit) })
  } else {
    // Tracked and untracked files, not ignored ones: what the student would commit, including uncommitted edits.
    const files = git('ls-files', '-co', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean)
    for (const f of files) {
      if (!existsSync(join(source.robot, f))) continue // deleted in the working tree, not yet committed
      mkdirSync(dirname(join(folder, f)), { recursive: true })
      copyFileSync(join(source.robot, f), join(folder, f))
    }
  }
  if (platform() !== 'win32') chmodSync(join(folder, 'gradlew'), 0o755) // git archive keeps a 644 gradlew as 644
  return folder
}

/** Builds the copy and compiles the harness against its jar. Throws with the build's own error lines. */
export function build(folder: string, work: string, javaHomeOverride: string | null): Built {
  const buildGradle = readFileSync(join(folder, 'build.gradle'), 'utf8')
  const gradleRio = /edu\.wpi\.first\.GradleRIO"?\s+version\s+"([^"]+)"/.exec(buildGradle)?.[1] ?? 'unknown'
  const year = Number(gradleRio.slice(0, 4))
  const javaHome = javaHomeOverride ?? findJava(year)
  if (year < 2023 && platform() === 'darwin' && arch() === 'arm64' && !isIntelJava(javaHome)) {
    throw new Error(`This robot uses WPILib ${year}, which has no build for Apple-silicon Macs. `
      + 'Run sim-run with --java <an Intel (x64) JDK 17 folder>; it runs under Rosetta.')
  }
  const initScript = join(work, 'sim-run.init.gradle')
  const mirror = `settingsEvaluated { s -> s.pluginManagement.repositories { gradlePluginPortal(); maven { url '${JCENTER_MIRROR}' } } }`
  writeFileSync(initScript, `${mirror}\n`)
  const tasks = [...(year < 2023 ? ['--init-script', initScript] : []), 'simulateExternalJavaRelease', '--console=plain']
  const gradlew = join(folder, platform() === 'win32' ? 'gradlew.bat' : 'gradlew')
  const gradle = (extra: string[]) => {
    // Windows runs gradlew.bat through cmd.exe, which splits unquoted paths at spaces ("C:\Users\First Last").
    const windows = platform() === 'win32'
    const quote = (a: string) => (windows ? `"${a}"` : a)
    const options = { cwd: folder, env: { ...process.env, JAVA_HOME: javaHome }, encoding: 'utf8' as const, shell: windows, maxBuffer: 1 << 28 }
    const result = spawnSync(quote(gradlew), [...tasks, ...extra].map(quote), options)
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
  }
  const started = Date.now()
  // Offline first (seconds, when Gradle has everything); online only when something isn't downloaded yet.
  let result = gradle(['--offline'])
  if (!result.ok && NOT_DOWNLOADED.test(result.output)) result = gradle([])
  if (!result.ok) throw new Error(`The robot code didn't build:\n${buildErrors(result.output)}`)
  const sim = JSON.parse(readFileSync(join(folder, 'build/sim/release_java.json'), 'utf8'))[0]
  const jar = readdirSync(join(folder, 'build/libs')).find((f) => f.endsWith('.jar') && !/-(sources|javadoc)\.jar$/.test(f))
  if (!jar) throw new Error('The build made no jar in build/libs.')
  const harnessDir = join(work, 'harness')
  rmSync(harnessDir, { recursive: true, force: true })
  const jarPath = join(folder, 'build/libs', jar)
  execFileSync(join(javaHome, 'bin', 'javac'), ['--release', '11', '-Xlint:-options', '-nowarn', '-cp', jarPath, '-d', harnessDir, HARNESS])
  const buildSeconds = (Date.now() - started) / 1000
  return { folder, jar: jarPath, libraryDir: sim.libraryDir, mainClass: sim.mainClassName, javaHome, harnessDir, gradleRio, buildSeconds }
}

/** Gradle's "What went wrong" block, or the last lines when it has none. */
function buildErrors(output: string): string {
  const wrong = /\* What went wrong:\n([\s\S]*?)\n\* Try:/.exec(output)?.[1]
  return (wrong ?? output.trim().split('\n').slice(-12).join('\n')).trim()
}

/** WPILib's own JDK for the robot's year, else JAVA_HOME. */
function findJava(year: number): string {
  const home = platform() === 'win32' ? (process.env.PUBLIC ?? 'C:\\Users\\Public') : homedir()
  const wpilib = join(home, 'wpilib', String(year), 'jdk')
  if (existsSync(wpilib)) return wpilib
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME
  throw new Error(`No Java found: install WPILib ${year} (it brings its own JDK) or set JAVA_HOME.`)
}

function isIntelJava(javaHome: string): boolean {
  const release = join(javaHome, 'release')
  return existsSync(release) && /OS_ARCH="(x86_64|amd64)"/.test(readFileSync(release, 'utf8'))
}

/**
 * Plays one timeline. Everything the JVM prints, its own lines and native (C++) ones, goes through one file
 * descriptor into `<log>.out`, so lines keep the order they were printed in. Resolves with that text and whether the
 * run had to be killed at its deadline.
 */
export function runTimeline(built: Built, timeline: string[], seconds: number, logFile: string): Promise<{ output: string; killed: boolean; wallSeconds: number }> {
  const timelineFile = `${logFile}.timeline`
  const outFile = `${logFile}.out`
  writeFileSync(timelineFile, timeline.join('\n') + '\n')
  rmSync(logFile, { force: true })
  const lib = built.libraryDir
  const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: lib, DYLD_LIBRARY_PATH: lib, DYLD_FALLBACK_LIBRARY_PATH: lib }
  // Windows finds native libraries on the path; its key is "Path", and a second "PATH" key would be ambiguous.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${env[pathKey] ?? ''}${delimiter}${lib}`
  delete env.HALSIM_EXTENSIONS // no HAL extension: no simulator window, no WebSocket server
  const classpath = [built.harnessDir, built.jar].join(delimiter)
  const args = [`-Djava.library.path=${lib}`, '-cp', classpath, 'SimRunHarness', timelineFile, resolve(logFile), built.mainClass]
  const out = openSync(outFile, 'w')
  const java = spawn(join(built.javaHome, 'bin', 'java'), args, { cwd: built.folder, env, stdio: ['ignore', out, out] })
  const started = Date.now()
  return new Promise((done, fail) => {
    java.on('error', (error) => {
      closeSync(out)
      fail(new Error(`Couldn't start Java from ${built.javaHome}: ${error.message}`))
    })
    let killed = false
    const deadline = setTimeout(() => {
      killed = true
      java.kill('SIGKILL')
    }, (seconds + START_ALLOWANCE_SECONDS) * 1000)
    java.on('close', () => {
      clearTimeout(deadline)
      closeSync(out)
      done({ output: readFileSync(outFile, 'utf8'), killed, wallSeconds: (Date.now() - started) / 1000 })
    })
  })
}

/**
 * A folder for this robot's copy and runs, outside the robot's own folder: one per robot folder (by its full path)
 * and commit, so a second run reuses the build. A lock file stops two sim-runs at once from wiping each other's copy.
 */
export function workFolder(cache: string, source: Source): string {
  const robot = resolve(source.robot)
  const pathHash = createHash('sha1').update(robot).digest('hex').slice(0, 8)
  const name = `${basename(robot)}-${pathHash}${source.commit ? `-${source.commit.slice(0, 10)}` : ''}`
  const folder = join(cache, name)
  mkdirSync(folder, { recursive: true })
  const lock = join(folder, 'sim-run.lock')
  const holder = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : null
  if (holder && holder !== process.pid && isRunning(holder)) {
    throw new Error(`Another sim-run (process ${holder}) is using ${folder}; wait for it to finish.`)
  }
  writeFileSync(lock, String(process.pid))
  process.on('exit', () => rmSync(lock, { force: true }))
  return folder
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
