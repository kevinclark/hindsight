# limit-not-applied contract (`src/rules/power/limit-not-applied.ts`)

Intent: the rule `power/limit-not-applied` tells the software students that a motor group drew far more current than
the current limit the robot profile says its code configures: the limit is switched off, or it is on and not reaching
the motors. It runs once per motor group of the robot profile, on one match log, and returns at most one finding per
kind of limit (supply, stator). It reads the profile's limits and the log's currents; it does **not** read robot code
itself (the comparison of current-limit lines between commits is `src/code/limit-lines.ts`, put on the match before
the rules run), does not judge brownouts or battery margin (other `power/` rules), and does not decide what a finding
looks like beyond the `Problem` it returns (the runner, `src/rules/run.ts`, makes the finding). Readers: students
in the app (the finding's title, evidence, causes, next step and plot), session summaries and the issue board (the
finding's `key`), and whoever rebuilds it. Spec: the rule's own header and `thresholds`, `src/rules/rule.ts` (the
rule format) and ADR 8 (faults are kept however short the run).

Suite: `npx vitest run tests/limit-not-applied.contract.test.ts --reporter=junit --outputFile={junit}`

## Interface
- `export default rule({...})` from `src/rules/power/limit-not-applied.ts`: a `Rule` (`src/rules/rule.ts`) with
  `forEach: 'motorGroup'` and `check(group: GroupView, match: MatchView): Problem[] | void`. Its descriptor
  (`meaning`, `causes`, `nextStep`, `incident`, `sources`, `thresholds`) is registered in `src/rules/index.ts`.
- Collaborators it uses and must not reimplement:
  - `GroupView` (`src/rules/view.ts`): `name`, `motors` (in profile order), `limits` (`supplyA`, `supplyEnabled`,
    `statorA`, `statorEnabled`, `where`). A motor's `supply()`, `stator()` and `connected()` return a `Signal` or
    throw `MissingSignal` when the profile or the log lacks the key.
  - `Signal.episodes(test, { during, longerThan })`: the stretches where the test holds, clipped to `during`;
    `longerThan` keeps only stretches strictly longer. Each has `start`, `seconds` and `peak` (the largest absolute
    value, the value held at its start included).
  - `MatchView`: `enabled` (a `Window`), `profile.code` (`branch`, `sha`), `build.sha`, `ranPinnedCommit()` (the
    log's commit starts with the profile's), `limitLinesVsProfile(group)` (a `LimitLines` answer or `null`, from
    `match.limitLines`), `couldNotCheck(reason)`.
  - From `src/rules/rule.ts`: `beyond`, `isFalse`, `amps`, `round`, `totalSeconds`; `lengthOf` from `view.ts`.
- Tests may also build the views the runner builds (`new MatchView(match)`, `motorGroup(profileGroup, view)` from
  `run.ts`) and call `check` directly.
- The runner turns each `Problem` into a finding: `title` is the message, `about` gives the `key`
  (`power/limit-not-applied · <about>`), severity is the problem's or the rule's, `likely`/`ruledOut` rank the causes,
  `plot` becomes `lines` and `threshold`. A `MissingSignal` thrown from `check` makes the whole group "not checked".

## Obligations

### Compatibility: what is already live
- **LN-01** The descriptor has `id: 'power/limit-not-applied'`, `title: 'Current limit not holding'`, `severity:
  'error'`, `judges: 'fault'`, `who: ['software']`, `forEach: 'motorGroup'`, and causes with ids `limit-off`,
  `not-saved`, `default-limit`, `wrong-value` in that order; a finding's `about` is `<group> <kind>`, so its key is
  `power/limit-not-applied · Roller supply`. Why: the id and the key are what saved session summaries, the issue
  board and known issues match on; `likely` and `ruledOut` name the cause ids. Kind: compatibility. Proof: frozen
  value.

### Behaviour: when it fires
- **LN-02** A group whose profile gives neither a supply nor a stator limit (no number for either) is not checked:
  `match.couldNotCheck('the robot profile has no current limits for <group> (<where>)')`, and no finding. Why: a
  quiet match counts as clean in a session (`src/session/stopped.ts`), so "no limits to compare with" must not read
  as "the limits held" (AGENTS.md, rules). Kind: failure mode.
- **LN-03** Supply and stator are checked independently, each only when the profile gives its number: a kind with no
  number gives no finding and no "not checked" line, and its currents are not read (missing from the log, they
  change nothing). A group can have one finding of each kind. Why: Phoenix has
  two separate limits, each with its own enable flag (the rule's sources). Kind: behaviour.
- **LN-04** A kind fires when some motor of the group has a stretch where the size of its current is strictly above
  120 % of the limit (`limit × 1.2`; 48 A for a 40 A limit is not over) lasting strictly longer than 0.2 s; stretches
  are not added together, and how far over the line it goes doesn't matter. Why: at the 2026 offseason event the
  limiter catching up made bursts of 0.21 s or less above the limit, 154–233 per motor per match with a median of
  0.02 s (the rule's thresholds); a limit that is not applied holds the current over it for seconds (78–94 A for a
  40 A limit during spin-up). Kind: behaviour.
- **LN-05** Only time while the robot was enabled counts: a stretch is clipped to the enabled window, and is judged
  by the length left. Why: a disabled motor draws nothing; a value held in the log across a disable is not current.
  Kind: behaviour.
- **LN-06** Time after a motor's Connected flag goes false (below 0.5), until it goes true again, does not count for
  that motor. A motor with no Connected flag, in the profile or in the log, counts all its enabled time, and that is
  not a "not checked" line. Why: a controller that dropped off CAN logs no more currents, so its last value is held
  in the log for the rest of the match; that is not the motor drawing it (`tests/power-rules.test.ts`). Kind: failure
  mode.
- **LN-07** One finding per kind, for the worst motor: the motor whose qualifying stretch (LN-04) has the highest
  peak; on a tie, the first such motor in the profile's order. The finding's time is the start of that stretch, the
  peak is that stretch's peak, and the seconds over are the total length of all that motor's qualifying stretches.
  Why: one line per group and kind keeps a four-motor flywheel from filling the report with the same fault; the
  highest peak is what the student compares with the limit. Kind: behaviour.

### Behaviour: what the finding says
- **LN-08** The title is, word for word, `<group> <kind> current reached <peak> against a <limit> A limit<off><code>`:
  `<peak>` is `amps(peak)` (whole amps, `toFixed(0)`, then ` A`), `<limit>` is the profile's number as JavaScript
  prints it (`40`, `37.5`), `<off>` is ` that is switched off in code (deliberate?)` when the profile's enable flag
  for that kind is not `true`, else empty, and `<code>` is from LN-11. Why: the title is what a student reads first;
  the wording is fixed so it reads the same in every report. Kind: behaviour.
- **LN-09** Severity: amber (`warning`) when the limit is switched off and the log ran the profile's code (it ran the
  profile's commit, or another commit whose current-limit lines are `same`); otherwise the rule's red (`error`): a
  limit switched on and still exceeded, or switched off in code the profile wasn't copied from (lines `different`,
  `unknown`, or no comparison). The log ran the profile's commit when its commit starts with the profile's short
  hash. Why: switched off in the code this log ran may be deliberate (the mechanism may not need a limit); when the
  log ran other code, "off" isn't known for it. Kind: behaviour.
- **LN-10** Causes and next step:
  - switched off (whatever code the log ran): `likely: ['limit-off']`, nothing ruled out, and the next step, word for
    word, `The <kind> limit is switched off in <where>. On purpose? Mark it as a known issue. If not, switch it on and
    measure the mechanism before and after.`
  - switched on, and the log ran the profile's code (LN-09): `likely: ['not-saved', 'default-limit']`, `limit-off`
    ruled out with `the limit is switched on in the code`, and the rule's own next step.
  - switched on, other code: no cause marked likely, none ruled out, the rule's own next step.
  Why: off in code is the cause when it is off; on in the very code the log ran means the config probably didn't
  reach the motor. Kind: behaviour.
- **LN-11** How the code the log ran is described, with `<branch>` and `<pin>` the profile's `code.branch` and
  `code.sha`, and `<ran>` the first 7 characters of the log's commit, or `unknown code` when the log has none:
  - the log ran the profile's commit: `<code>` is empty, and the comparison is neither read nor shown;
  - another commit, lines `same`: `<code>` is ` (same current-limit lines as <branch> <pin>; this log ran <ran>)`,
    lines evidence `the same as <pin> in <files, joined by ", "> (read from the robot code)`;
  - lines `different`: `<code>` is ` (as of <branch> <pin>; this log ran <ran>)`, lines evidence
    `different from <pin>: <lines, joined by "; ">`;
  - lines `unknown`: the same `<code>`, lines evidence `not compared: <why>`;
  - no comparison (no code folder): the same `<code>`, and no lines evidence.
  Why: a student must see which code the "switched on/off" claim was read from (`tests/limit-lines.test.ts`).
  Kind: behaviour.
- **LN-12** The evidence, keys in this order: `worst motor` (its name); `peak <kind> current (A)` (the peak, 1
  decimal); `seconds over 120 % of the limit (worst motor)` (1 decimal); `share of enabled time over 110 % of the
  limit (worst motor) (%)` (LN-13, 1 decimal; left out when no motor was over 110 %); `configured limit (A)` (the
  profile's number); `limit switched on in code` (`yes` or `no`, followed by `<code>` from LN-11); `set in` (the
  profile's `where`); `current-limit lines vs the profile's commit` (LN-11; left out when there is none). Why: the
  evidence is the student's proof list, and its labels are read by people, so they are fixed. Kind: behaviour.
- **LN-13** The share is evidence only: the largest, over the group's motors, of `100 ×` the seconds that motor's
  current was strictly above 110 % of the limit while enabled and connected (LN-05, LN-06; stretches of any length,
  one sample included), divided by all the enabled seconds, whichever motor in the profile's order has it. It may come
  from another motor than `worst motor`. It never makes a finding on its own. Why: at the 2026 offseason event the
  time over 110 % was 154–233 bursts per motor per match, median 0.02 s (one 50 Hz sample), longest 0.26 s: the
  limiter catching up at each acceleration, so on its own it does not mean the limit is failing (the rule's
  thresholds). Kind: behaviour.
- **LN-14** `measured` is one entry: `{ label: 'peak <kind> current', value: <peak rounded to whole amps>, unit: 'A',
  threshold: <limit × 1.2 rounded to whole amps> }`. Why: a session compares how far past the line each match went
  (`Problem.measured` in `rule.ts`). Kind: behaviour.
- **LN-15** The plot: the current of that kind of every motor in the group, in profile order, in amps, from 2 s
  before the finding's time to 4 s after, with a horizontal line at the limit labelled `<limit> A limit`. Why: the
  student sees the whole group against the line, not only the worst motor. Kind: behaviour.

### Failure modes and edges
- **LN-16** When a motor's current for a kind being checked is not in the log (or the profile names no key for it),
  the group is not checked, and the line names the key: `<group>: missing <key>`. Why: a group can't be called clean
  from part of its motors (AGENTS.md, rules). Kind: failure mode.
- **LN-17** The size of the current is judged, either sign: a stator current of −95.5 A is over a 60 A limit, and its
  peak is 95.5 A. Why: a TalonFX logs stator current signed by direction; a limit caps its size. Kind: behaviour.
- **LN-18** The rule judges a fault: a finding in a run shorter than 10 s is kept. Why: ADR 8: a fault is an event
  with its own duration, kept however short the run; a performance finding would be dropped. Kind: behaviour.
- **LN-19** The descriptor follows the rule format (`rule.ts`, CONTRIBUTING.md): `meaning`, `nextStep`, `incident`
  and each cause's `cause` and `look` are said (not empty); `thresholds` has two entries, the 120 %/0.2 s line and
  the 110 % share, both `basis: 'measured'`, each with a `name`, `value` and `how`; `sources` cites at least one page
  of `src/rules/sources.ts` unchanged (CTRE's current-limit pages, on ctr-electronics.com), each with what it
  `says`. Why: the app shows these to students as the finding's explanation and "Further reading"; a rule cites
  public pages and says where each number came from (`rule.ts`). The words themselves are free (Output wording).
  Kind: compatibility.
- **LN-20** An error from a signal read other than `MissingSignal` is not caught: it leaves `check`, so the runner
  lists the rule as crashed. Why: a crash is shown so a bug in a rule isn't silent (`run.ts`); only a missing
  Connected flag means "count all the enabled time" (LN-06). Kind: failure mode.

## Output wording
Fixed, word for word: the title (LN-08, LN-11), the switched-off next step (LN-10), the ruled-out reason
`the limit is switched on in the code` (LN-10), the "not checked" reason (LN-02), the evidence labels and value
formats (LN-11, LN-12), `measured`'s label (LN-14) and the plot's line label (LN-15).
Free: the words of the descriptor's prose (`meaning`, each cause's `cause` and `look`, the rule's `nextStep`,
`incident`, the sources' `says`, the thresholds' text), as long as each is said (LN-19). It follows CONTRIBUTING.md
"How a rule should read".

## Unspecified by design
- The order of a group's supply and stator findings in the report (the runner sorts by severity, then time).
- How the rule computes stretches internally (it must use `Signal.episodes`, but in what order it walks motors and
  stretches is free as long as LN-07's choice comes out).

## Open for the maintainer
These are today's behaviour, measured on the live code (2026-11-03), and no contract test pins them, because each
may be a defect. Each waits for a ruling; until then, a rebuild may do either.
1. **An enable flag the profile leaves out reads as switched off.** A group with `supplyA: 40` and no
   `supplyEnabled` gets an amber "switched off in code (deliberate?)" finding. AGENTS.md says Phoenix 6 defaults both
   Enable flags to true, so such a limit runs; the profile builder (`src/builder/code-draft.ts`) leaves the flag out
   when the code has no Enable line. The Limits tab reads it the same way (`src/limits/limits-report.ts`). None of
   the 51 motor groups in the 8 built-in profiles has a limit without its flag (2026-11-03); profiles kept in a
   browser weren't checked.
2. **A missing key for one kind hides a finding of the other kind.** A group whose supply current is over the limit
   but whose stator current isn't logged for one motor gives no finding, only `missing <stator key>`.
3. **The share's motor is labelled "(worst motor)"** but is the motor with the largest share, which can be another
   motor than `worst motor` (LN-13's test shows one).
4. **The 0.2 s line is shorter than the longest burst it was set from**: the thresholds say the limiter's bursts
   lasted "0.21 s or less" above the limit. If any of those were above 120 % for more than 0.2 s, the rule fires on
   them. The measurement itself is not in this repository.

## Ruled out
- Judging from the share of time over 110 % (an earlier evidence line). Why: at the 2026 offseason event it was made
  of the limiter catching up at every acceleration (LN-13). Scope: this rule.
- Counting a held value after a controller dropped off CAN. Why: it read as the motor drawing its last current for
  the rest of the match (LN-06). Scope: every rule reading motor currents.
- Treating "switched off" in a log that ran other code as known. Why: the profile copies the limits from one commit;
  other code may differ (LN-09, LN-11). Scope: this rule.

## Equivalent mutants
From Stryker 9.6.1 on this file at `1f77fad` (218 mutants); line numbers are that file's. These 16 survive the
contract file and the whole suite (final run, below); each changes nothing observable.
- L146 the `.filter((p) => p.end > p.start)` removed, L149 its test → `true`, and L149 `>` → `>=`: they keep empty
  or reversed pieces of the enabled-and-connected window, and `Signal.episodes` drops any clip with no length.
- L163 `worst = {}` (no starting share): `percent <= undefined` is false, so the first motor over 110 % is taken,
  as it is against 0; if no motor is, the share is `undefined` and its evidence line is left out, as with `null`.
- L163 starting motor `''` → `"Stryker was here!"`; L171 the whole test → `false`, `worst.motor === ''` → `false`,
  `||` → `&&`, its `''` → `"Stryker was here!"`, and `enabledSeconds === 0` → `false` (6 mutants): they only change
  what is returned when no motor was over 110 % or the robot was never enabled, and the share is only asked for when
  a motor was above 120 % for more than 0.2 s while enabled and connected, which is also over 110 % in that window.
- L167 `over.length === 0` → `false`: a motor with no stretch over 110 % has share 0, which `percent <=
  worst.percent` already skips (the share is never below 0).
- L167 `<=` → `<`: on a tie the later motor's share is kept, and only the share's percent is used, which is equal.
- L168 the four mutants of `b.peak > a.peak ? b : a` (`true`, `false`, `>=`, `<=`): they choose which of the
  share motor's stretches gives `peak` and `start`, which the rule never reads (only `percent` is used).
