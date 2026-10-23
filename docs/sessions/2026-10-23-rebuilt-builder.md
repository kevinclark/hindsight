# 2026-10-23: the profile builder on a robot built two ways

Merged as bc58b93 (branch `claude/rebuilt-builder`). Motivated by 8033's 2026 competition robot (Rebuilt): its code
builds two robot versions (ALPHA and COMP) in the arms of a switch, and passes each IO as
`REAL ? new XIO(…) : new XIOSim(…)`. Against the hand profile, the builder got 3 of 17 CAN IDs from code.

## What changed

- `src/code/check/flow.ts`: `madeAlong` follows a ternary whose condition asks real, sim or replay and has exactly one
  arm that isn't simulation code. `inSimulation` moved here from `devices.ts`, which re-exports it.
- `src/builder/code-draft.ts`: a log key that several code motors claim is one motor when they agree on ID, bus, kind
  and leader. The motor gets the ID but no limits: a setting doesn't say which robot version applies it.
- `src/builder/code-draft.ts`: a motor whose keys are in the log is no longer listed as having "no current" there. A
  key that motors with different IDs claim gets a note telling the student to pick the ID.

## Evidence

- **Builder backtest** over 739 logs, before and after:
  - The 2026 competition robot's code IDs go from 3 to 9 of 17 on 48 logs. All 9 match the hand profile.
  - Two false "no current" notes go.
  - One 2026 offseason motor reached along two agreeing chains loses its false note.
  - No other robot changes.
- **code-check:** the backtest output and every repo's code-check output are identical to before.
- **Tests:** vitest 1046 pass; svelte-check 0 errors. Reviewed by Fable and by code-review.

## Left on purpose

- The 2026 competition robot's swerve IDs: `SWERVE_CONSTANTS` is a ternary on the robot version between two constants
  classes. The log records the version (`/RealMetadata/Robot Edition`), but reading that is one team's convention.
- A swerve module whose folder the builder can't resolve is still listed as having "no current in this log", though
  the log has it. Rewording that note is a follow-up.
