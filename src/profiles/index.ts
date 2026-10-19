/**
 * Every robot profile the page knows. Each log is matched to one by the code's own name for itself (Codebase) and
 * the branch it ran; see choose.ts. To add a robot, add its profile file here.
 */
import { offseason2026, offseason2026Event } from './2026-offseason.ts'
import { offseason2025 } from './2025-offseason.ts'
import type { RobotProfile } from './types.ts'

export const PROFILES: RobotProfile[] = [offseason2026, offseason2026Event, offseason2025]

/** A short, stable name for a profile: the robot and the branch its code is pinned to. */
export function profileId(p: RobotProfile): string {
  return `${p.name} @ ${p.code.branch}`
}
