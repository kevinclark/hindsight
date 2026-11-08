# breaker-heat contract (`src/power/breakers.ts`)

Intent: the unit tells a rule how close a breaker came to tripping, by the maker's own trip curve. It turns a current
history (amps every `dt` seconds) into a heat share per band edge, where 1.0 (100 %) means that edge trips. The band's
`fast` edge is the earliest an in-spec breaker may trip, its `slow` edge the latest (the datasheets' two curves). It
reads the curve table `src/power/breaker-curves.json` (datasheet points, fitted heating stages and the fit's error per
edge); it does **not** know which breaker a motor is on (`src/power/power-map.ts`), does not judge anything (the rules
`power/main-breaker-margin` and `power/pdp-breaker-margin` do), and does not model ambient temperature, a breaker
that has already tripped or loose lugs. Readers: those two rules, and whoever regenerates the fits
(`scripts/fit-breakers.ts`).

Suite: `npx vitest run tests/breakers.contract.test.ts --reporter=junit --outputFile={junit}`

## Interface
- `BREAKERS`: the five families of the JSON (`bussmann`, `optifuse` main; `rev-ato`, `ctre-ato`, `snap-action` PDP),
  each with `parts`, `ratingsA`, `datasheets` and per edge `taus`, `weights`, `tripRatio`, `points`, `fitError`.
  `breakerFamily(id)` returns one, or `undefined`.
- `heat(amps, dt, ratingA, edge)`: a `Float64Array` the length of `amps`.
- `tripSeconds(percent, edge)`: seconds from cold to trip at a constant current, `percent` of the rating.
- `steadyAmps(seconds, ratingA, edge)`: the constant current that just reaches 100 % in `seconds` from cold.

## Obligations

### Compatibility: what is already live
- **BH-01** The curve table is frozen: each family's id, kind, parts, ratings, and each edge's `taus`, `weights`,
  `tripRatio`, `fitError` and datasheet `points` are exactly the published values, and the five families and their
  edges are the only ones. Why: the numbers are the behaviour users see; a change moves every finding, so it needs
  a new decision, not a silent edit of the JSON. Kind: compatibility.

### Behaviour
- **BH-02** A constant current from cold reproduces every datasheet point of every edge: the current whose trip time
  (`tripSeconds`) equals the point's time is within that edge's recorded `fitError.currentWorst` of the point's current.
  Why: the warning acts on current, and the fit error is what the finding quotes as its uncertainty. Kind: behaviour.
- **BH-03** Heat is a share of the trip: `heat` of a constant current whose `tripSeconds` is T reaches 1.0 (within 1e-3)
  at T, is below 1.0 just before, and scales with (amps / `ratingA`)²: the same percent of another rating gives the
  same heat. The first sample starts cold. Why: 100 % must mean "this edge trips", at any rating. Kind: behaviour.
- **BH-04** Heat cools when the current drops: after a pulse then zero current, heat falls (never rises) toward 0.
  Why: a breaker that has rested is not as close to tripping as when the push ended. Kind: behaviour.
- **BH-05** Under a constant current, heat never decreases, on every edge. Why: a warm body only gets warmer under a
  steady load. Kind: behaviour.
- **BH-06** The step is exact, not Euler: a stage whose time constant is shorter than `dt` stays between 0 and its
  steady value (heat of a constant current never exceeds x² / `tripRatio`²). Why: Optifuse's fast edge has a 0.88 s
  stage, and a 1 s or 0.04 s sample step diverged under an Euler step. Kind: failure mode.
- **BH-07** The peak heat of one current history sampled at `dt` and at 2·`dt` (a 25 Hz log against a 50 Hz one)
  differs by less than 2 %. Why: logs come at different rates and the finding's number must not depend on it.
  Kind: behaviour.
- **BH-08** `tripSeconds` is `Infinity` at or below the edge's long-run limit (a current whose heat never reaches 1)
  and finite above it, falling as current rises. Why: a breaker that can carry a current forever must not get a time.
  Kind: edge.
- **BH-09** `steadyAmps(s, rating, edge)` is the constant current whose heat is 1.0 at s seconds: heat of that current
  is 1.0 (within 1e-3) at s and below 1.0 at s − 1 second; it never rises as `seconds` grows (it stops falling once every stage has settled). Why: the finding says what a
  steady current can be without reaching the fast edge for a match. Kind: behaviour.
- **BH-10** `breakerFamily` finds each of the five ids, and returns `undefined` for any other. Kind: behaviour.
