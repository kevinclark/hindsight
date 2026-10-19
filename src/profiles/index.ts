/**
 * Every robot profile the page knows. Each log is matched to one by the code's own name for itself (Codebase) and
 * the branch it ran; see choose.ts. To add a robot, add its profile file here.
 */
import { offseason2026, offseason2026Event } from './2026-offseason.ts'
import { offseason2025 } from './2025-offseason.ts'
import { frc340Daly2026, frc340Nyro2026 } from './frc340-2026.ts'
import { frc3602_2026 } from './frc3602-2026.ts'
import type { RobotProfile } from './types.ts'

/** 8033's robots, then other teams' robots read from their public logs (worked examples of non-AdvantageKit logs). */
export const PROFILES: RobotProfile[] = [offseason2026, offseason2026Event, offseason2025, frc340Nyro2026, frc340Daly2026, frc3602_2026]

/** A short, stable name for a profile: the robot and the branch its code is pinned to. */
export function profileId(p: RobotProfile): string {
  return `${p.name} @ ${p.code.branch}`
}
