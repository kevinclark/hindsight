# 2026-11-17: LN-01 pins needsEnabled (focus 5c2e)

## Handoff
- leftovers:
  - focus add "Hindsight: triage limit-not-applied's LN-22 Stryker survivors (6 + 1 no-coverage)" --project makers --next "Run Stryker on the contract file alone (docs/sessions/2026-11-03-limit-not-applied-contract.md § Commands); per survivor at L72/81/121/140/144/151 and no-coverage L90 of src/rules/power/limit-not-applied.ts: a contract test naming the LN obligation it breaks, or a recorded equivalent proven by the run; behaviour no obligation states goes to Open for Kevin. Details: docs/sessions/2026-11-17-ln-needs-enabled.md" --session local_4eb3112e-f183-462a-b38d-42d052652876
- repos: none (this note is committed and pushed by the seat)
- lessons: none (the one at play, re-run a parked item's evidence before its next step, is already global)
- focus: done session:local_4eb3112e-f183-462a-b38d-42d052652876 --why "LN-01 needsEnabled contract test: landed on hindsight main 13fb631 2026-11-17 on Kevin's go; 5c2e closed"
- verified: origin/main is 13fb631 (merge of 14c2507 onto 941928c); focus 5c2e done; full suite on the merge's archive: 2983 passed, 4 skipped, svelte-check 0 errors, contract-check all met.

## What changed
`docs/contracts/limit-not-applied.md` LN-01 and its test now freeze `needsEnabled: true`. The Interface named it
since 28ad117 but no test proved it.

## Mutation (Stryker 9.6.1, contract file alone, 291 mutants)
- Before (941928c): 278 killed, 3 timeouts, 1 runtime error, 8 survived, 1 no coverage. `needsEnabled: false` (L51) survived.
- After: 279 killed; L51 killed by the LN-01 test. 7 survive, 1 no coverage.
- The 11-05 note called needsEnabled "the only real survivor": true on 11-05, stale since 7eece4d/3c9334c
  (LN-22, 2026-11-11) grew the file from 196 to 291 mutants. Survivors now: L72 basis `''`, L81 logsCommit string,
  L121 conditional → true, L140 and L144 `''` strings, L151 `'why' in compared.ran` → true, L177 `p.end >= p.start`
  (the recorded equivalent, was L154); no coverage: L90 nextStep string. Left as a focus item (Handoff).
