import { describe, expect, it } from 'vitest'
import { launchPlan, opensInAdvantageScope } from '../src/hub/advantagescope.ts'

const folders = (tree: Record<string, string[]>) => (dir: string) => tree[dir] ?? []
const LOG = '/Users/test/logs/match.wpilog'
const WIN_LOG = 'C:\\Users\\test\\logs\\match.wpilog'

describe('opensInAdvantageScope', () => {
  it('accepts AdvantageScope file types in any letter case', () => {
    for (const name of ['a.wpilog', 'a.WPILOG', 'a.wpilogxz', 'a.rlog', 'a.hoot', 'a.revlog', 'a.dslog', 'a.DsEvents']) expect(opensInAdvantageScope(name)).toBe(true)
  })
  it('rejects other types', () => {
    for (const name of ['a.json', 'a.log', 'a.csv', 'wpilog', 'a.wpilog.txt']) expect(opensInAdvantageScope(name)).toBe(false)
  })
})

describe('launchPlan on macOS', () => {
  const env = { home: '/Users/test' }
  it('tries the bundle id first, then WPILib years newest first, ignoring folders that are not years', () => {
    const plan = launchPlan('darwin', LOG, env, folders({ '/Users/test/wpilib': ['2025', 'tools', '2027', '2026', 'maven'] }))
    expect(plan).toEqual([
      { kind: 'open', args: ['-b', 'org.littletonrobotics.advantagescope', LOG] },
      { kind: 'open', args: ['-a', '/Users/test/wpilib/2027/advantagescope/AdvantageScope (WPILib).app', LOG] },
      { kind: 'open', args: ['-a', '/Users/test/wpilib/2026/advantagescope/AdvantageScope (WPILib).app', LOG] },
      { kind: 'open', args: ['-a', '/Users/test/wpilib/2025/advantagescope/AdvantageScope (WPILib).app', LOG] },
    ])
  })
  it('sorts years as numbers, not text', () => {
    const plan = launchPlan('darwin', LOG, env, folders({ '/Users/test/wpilib': ['999', '2026'] }))
    expect(plan[1].kind === 'open' && plan[1].args[1]).toContain('/2026/')
  })
  it('without a wpilib folder only the bundle id is tried', () => {
    expect(launchPlan('darwin', LOG, env, folders({}))).toEqual([{ kind: 'open', args: ['-b', 'org.littletonrobotics.advantagescope', LOG] }])
  })
})

describe('launchPlan on Windows', () => {
  const exe = (year: string) => `C:\\Users\\Public\\wpilib\\${year}\\advantagescope\\AdvantageScope (WPILib).exe`
  it('tries the per-user install, then WPILib years newest first, then the file association', () => {
    const env = { home: 'C:\\Users\\test', localAppData: 'C:\\Users\\test\\AppData\\Local', publicDir: 'C:\\Users\\Public' }
    const plan = launchPlan('win32', WIN_LOG, env, folders({ 'C:\\Users\\Public\\wpilib': ['2026', 'x', '2027'] }))
    expect(plan).toEqual([
      { kind: 'spawn', file: 'C:\\Users\\test\\AppData\\Local\\Programs\\advantagescope\\AdvantageScope.exe', args: [WIN_LOG] },
      { kind: 'spawn', file: exe('2027'), args: [WIN_LOG] },
      { kind: 'spawn', file: exe('2026'), args: [WIN_LOG] },
      { kind: 'default' },
    ])
  })
  it('skips the per-user install without LOCALAPPDATA and defaults the public folder', () => {
    const plan = launchPlan('win32', WIN_LOG, { home: 'C:\\Users\\test' }, folders({ 'C:\\Users\\Public\\wpilib': ['2026'] }))
    expect(plan).toEqual([{ kind: 'spawn', file: exe('2026'), args: [WIN_LOG] }, { kind: 'default' }])
  })
  it('with nothing installed leaves only the file association', () => {
    expect(launchPlan('win32', WIN_LOG, { home: 'C:\\Users\\test' }, folders({}))).toEqual([{ kind: 'default' }])
  })
})

describe('launchPlan on Linux', () => {
  it('tries WPILib years newest first, then the file association', () => {
    const plan = launchPlan('linux', LOG, { home: '/home/test' }, folders({ '/home/test/wpilib': ['2026', 'x', '2027'] }))
    expect(plan).toEqual([
      { kind: 'spawn', file: '/home/test/wpilib/2027/advantagescope/advantagescope-wpilib', args: [LOG] },
      { kind: 'spawn', file: '/home/test/wpilib/2026/advantagescope/advantagescope-wpilib', args: [LOG] },
      { kind: 'default' },
    ])
  })
  it('without WPILib uses only the file association', () => {
    expect(launchPlan('linux', LOG, { home: '/home/test' }, folders({}))).toEqual([{ kind: 'default' }])
  })
})
