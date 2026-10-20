/**
 * The builder's motors and groups against a hand-written profile on the same log: the measure of the log inference
 * (scripts/builder-backtest.ts, tests/builder.test.ts).
 */
import type { WpilogFile } from '../readers/wpilog.ts'
import { chooseProfile } from '../profiles/choose.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { motorsFromLog } from './motors.ts'
import { groupMotors } from './groups.ts'
import { draftWarnings } from './draft.ts'

const currentKeys = (m: { supplyCurrent?: string; statorCurrent?: string; current?: string }) => [m.supplyCurrent, m.statorCurrent, m.current].filter((k): k is string => !!k)

export interface Backtest {
  /** The hand profile chooseProfile picked, or null when none fits the log. */
  hand: string | null
  handMotors: number
  found: number
  missed: string[]
  falsePositives: string[]
  confirmKind: string[]
  notUsed: { key: string; why: string }[]
  limits: string[]
  warnings: string[]
  handGroups: { name: string; size: number; built: string[]; exact: boolean }[]
  builtGroups: { name: string; size: number; evidence: string }[]
}

export function backtestLog(log: WpilogFile, profiles: RobotProfile[]): Backtest {
  const { profile, choice } = chooseProfile(log, profiles)
  const handGroups = choice.misfit ? [] : profile.motorGroups
  const hand = handGroups.flatMap((g) => g.motors.map((m) => ({ group: g.name, motor: m })))
  const { motors, notUsed, limits } = motorsFromLog(log)
  const groups = groupMotors(motors)
  const shares = (a: string[], b: string[]) => a.some((k) => b.includes(k))
  const found = motors.filter((m) => hand.some((h) => shares(currentKeys(h.motor), currentKeys(m))))
  const builtGroupOf = new Map<string, string>()
  for (const g of groups) for (const { motor } of g.motors) for (const k of currentKeys(motor)) builtGroupOf.set(k, g.name)
  return {
    hand: choice.misfit ? null : `${profile.name} @ ${profile.code.branch}`,
    handMotors: hand.length,
    found: found.length,
    missed: hand.filter((h) => !motors.some((m) => shares(currentKeys(h.motor), currentKeys(m)))).map((h) => `${h.group}: ${h.motor.name}`),
    falsePositives: motors.filter((m) => !found.includes(m)).map((m) => m.path),
    confirmKind: motors.filter((m) => m.current).map((m) => m.current!),
    notUsed, limits,
    warnings: draftWarnings(groups.map((g) => ({ name: g.name, groupedBy: g.evidence, motors: g.motors.map((x) => x.motor) }))),
    handGroups: handGroups.map((g) => {
      const built = [...new Set(g.motors.map((m) => currentKeys(m).map((k) => builtGroupOf.get(k)).find(Boolean) ?? '(not found)'))]
      const one = built.length === 1 ? groups.find((x) => x.name === built[0]) : undefined
      return { name: g.name, size: g.motors.length, built, exact: !!one && one.motors.length === g.motors.length }
    }),
    builtGroups: groups.map((g) => ({ name: g.name, size: g.motors.length, evidence: g.evidence })),
  }
}
