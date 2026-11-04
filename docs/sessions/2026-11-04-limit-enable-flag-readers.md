# 2026-11-04: the Limits tab, wizard and pair read a missing Enable flag as not known

Follow-up to `2026-11-03-limit-not-applied-fixes.md` (item 1): the other readers of a limit's Enable flag now agree
with limit-not-applied. One reader, `limitOn` in `src/limits/limits-report.ts`, gives on, off, or not known (null).

## What changed

- **Limits tab**: a number with no flag reads "60 A, on or off not known", with a note naming the Enable line that
  decides it. The cap is not known when the flag decides it, and known when both readings agree (a lower stator limit
  caps it either way). The share at the limit is measured against that number, as when it is on.
- **Wizard**: "40 A, on or off: the profile doesn't say"; a limit with neither number nor flag reads "not set:
  Phoenix's default 70 A" (it read "— A, switched off"). With its own supply flag missing, the pair still warns that
  a burst cap above the number may be a raise.
- **Pair**: a flagless group leaves the sustained sum and is named ("limits, or whether they are on, not known"); the
  pinned push is not worked out from a stator limit whose flag is missing.
- **Also fixed**: a limit switched off with no number (2025 offseason Climber pivot) read "not set: Phoenix's default
  70 A applies" with a 70 A cap. It reads switched off, and the group's cap is nothing.

## Data

- **Supply, real**: drafted from the robot code at every commit the 2025-26 and 2026-27 library logs ran, 45 of 126
  distinct commits could be drafted (the rest aren't in the two robot repos read). 152 groups got limits from code;
  16 had a supply number and no Enable flag: Flywheel and Hood, 8 commits, logs of 2026-01-20 to 02-04. Before this
  change each read "switched off in code" on the Limits tab and in the wizard.
- **Stator: no data covers it.** 0 of those 152 groups, and 0 of the 51 built-in groups, have a stator number with no
  flag. It is the symmetric branch of the same reader; splitting it would leave two readings again.
- **Built-in profiles, before and after** (every group, Limits tab and pair, no logged current): the only visible
  change is Climber pivot. `on` moved from false to null for groups whose limits aren't known, and from false to true
  for "not set" limits (Phoenix's default runs); their notes are unchanged.
- The rendered Limits tab (svelte/server, the team's log A with two groups' limits replaced) showed the new words and
  a "not known" cap; the share for a flagless Flywheel moved 2.4 % → 3.4 % (now against the 60 A supply number, not
  the 80 A stator limit).

## Left as is

- `src/snapshot/report.ts:157`, by design: the snapshot compares each missing profile field with Phoenix's default and
  labels it `Phoenix default`, so a robot with its supply limit off against a flagless profile honestly differs from
  the default, and stays red.
- `src/rules/power/limit-not-applied.ts` and `src/ui/ProfileBuilder.svelte` already treat a missing flag as its own
  state; routing them through `limitOn` would be cosmetic.
- Open: a limit switched off still has its current measured against its number, or 70 A when it has none, for the
  share at the limit (Climber pivot shows a share against a limit the tab says is gone). Pre-existing.

## Review

A Fable reviewer and `code-review` (high, all findings) reviewed 9036c68; Fable graded code-review's 15 findings.
Verdict: land with changes, no defect. Folded: the silent loss of the burst-cap warning, "— A, on" for an unset
limit, the "limits not known" wording for a flag-only gap, a latent `null` in the cap's combinations, a test that
claimed to compare currents but had none logged (now a bench log with logged current pins the share), a test over
every built-in profile for `on`, and the docs (`limitOn`, `LimitView.note`, AGENTS.md). Skipped as not real or
cosmetic: two word maps, routing the rule and builder through `limitOn`, moving `limitOn` to `src/profiles/`.

## Checks

8 tests were red on 07931f7 before the change. Whole suite, `npm run check`, and contract-check on the tip.
