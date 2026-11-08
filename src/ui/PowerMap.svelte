<!--
  The power map: which breaker is in each slot of the robot's CTRE PDP 2.0, and what each slot feeds. Two choices on one line
  (the main breaker, and "every motor is on"), the board drawn as it looks, and under it what doesn't add up. A team that runs
  one breaker on every motor is done after the two choices; placing a motor on its slot only adds the slot to the warnings.
  Each change writes one whole-map history line at once (no Save button) with a toast to undo it for ~10 s. The numbering of
  the slots is read from CTRE's drawing and not yet checked against a board: the screen says so (src/power/power-map-view.ts).
-->
<script lang="ts">
  import { tick } from 'svelte'
  import { PROFILES, profileId } from '../profiles/index.ts'
  import type { RobotProfile } from '../profiles/types.ts'
  import { robotChoices } from './robot-list.ts'
  import { profilesNow } from './kept-profiles.svelte.ts'
  import { teamNow } from './team-setting.svelte.ts'
  import { powerMapAt, type Feed, type MainFamily, type MapBreaker, type PdpFamily, type PowerMap } from '../power/power-map.ts'
  import {
    applyToAll, breakerColourName, breakerFill, breakerText, emptyMap, FAMILY_LABEL, feedLabel, feedParts, mapProblems, MAIN_LABEL, MPM_SLOTS, mpmAt, nextEmptySlot, onlyFromNow, planFromFinding, stampAll,
    PDP_ID, ratingsFor, readRotated, savedLine, writeRotated, slotEntries, slotRows, slotsKeeping, unplacedMotors, withExtraFeed, withSlot, type MapProblem,
  } from '../power/power-map-view.ts'
  import { clearMapFocus, LAST_ROBOT_KEY, lastMapRobot, mapFocus, mapHistory, writeMapLine } from './power-map-bridge.svelte.ts'

  const LATEST = '9999-12-31T23:59:59.999Z'
  const stored = $derived(profilesNow())
  const focus = $derived(mapFocus())
  const history = $derived(mapHistory())

  // Which robot: the one a finding or strip named, else the one last used here, else the team's newest.
  const LAST = LAST_ROBOT_KEY
  const lastRobot = lastMapRobot
  let chosen = $state<string | null>(null)
  const groups = $derived(robotChoices(PROFILES, stored, teamNow(), focus?.robot ? [focus.robot] : []))
  const all = $derived(groups.flatMap((g) => g.profiles))
  const robot = $derived.by(() => {
    const ids = all.map(profileId)
    const want = [focus?.robot, chosen, lastRobot()].find((id) => id && ids.includes(id))
    return all.find((p) => profileId(p) === want) ?? all.at(-1) ?? PROFILES[0]
  })
  // A named robot from a finding or strip wins once, then the select takes over.
  $effect(() => { if (focus?.robot) chosen = focus.robot })
  const robotId = $derived(profileId(robot as RobotProfile))
  const motors = $derived(robot.motorGroups.flatMap((g) => g.motors.map((m) => ({ name: m.name, canId: m.canId }))))

  // The map being edited: the one in effect (at the match's start when opened from a finding).
  const at = $derived(focus?.from?.iso ?? LATEST)
  const map = $derived(powerMapAt(history, robotId, at) ?? emptyMap(robotId, new Date().toISOString()))
  const problems = $derived(mapProblems(map, motors))
  const unplaced = $derived(unplacedMotors(map, motors))

  // The numbering of the slots as drawn, turned 180° for a board mounted the other way (remembered per robot).
  let rotations = $state<Record<string, boolean>>({})
  const rotated = $derived(rotations[robotId] ?? readRotated(localStorage, robotId))
  function rotate() {
    rotations[robotId] = !rotated
    writeRotated(localStorage, robotId, rotations[robotId])
  }
  const rows = $derived(slotRows(rotated))

  // ---- Writing -----------------------------------------------------------------------------------------------------
  let toast = $state<{ text: string; undo: () => void; onlyFromNow?: () => void } | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  function say(t: NonNullable<typeof toast>) {
    toast = t
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast = null }, 10_000)
  }
  /**
   * Write `next` as the robot's map and offer to take it back. From the strip or Tools it is one line, in effect from now. From a
   * finding it applies from that match onward (planFromFinding): written from the match's start and again on every later line of the
   * robot, so a later edit doesn't hide it; the toast says when it did.
   */
  function commit(next: PowerMap, act: string) {
    const fromFinding = !!focus?.from
    const nowIso = new Date().toISOString()
    const from = focus?.from?.iso ?? nowIso
    const before = powerMapAt(history, robotId, at)
    const plan = fromFinding
      ? planFromFinding(history, robotId, from, before, next)
      : { forward: [{ ...next, from }], undo: [{ ...(before ?? emptyMap(robotId, from)), from }], laterDates: [] as string[] }
    const write = (maps: PowerMap[]) => writeMapLine((device, h, role) => stampAll(h, maps, { device, role }, new Date()))
    write(plan.forward)
    const days = [...new Set(plan.laterDates.map(today))]
    const also = days.length ? ` · also applied to the map${plan.laterDates.length > 1 ? 's' : ''} from ${days.join(', ')}${plan.laterDates.length > 1 ? ` (${plan.laterDates.length} lines)` : ''}` : ''
    say({
      text: `${act}${also}`,
      undo: () => { write(plan.undo); toast = null },
      ...(fromFinding ? { onlyFromNow: () => { write(onlyFromNow(plan, plan.forward.at(-1)!, new Date().toISOString())); toast = null } } : {}),
    })
  }

  // ---- The two choices -----------------------------------------------------------------------------------------------
  const MAINS: MainFamily[] = ['bussmann', 'optifuse']
  const PDP_CHOICES: PdpFamily[] = ['rev-ato', 'ctre-ato', 'snap-action']
  const setMain = (m: MainFamily) => commit({ ...map, main: m }, `Main breaker → ${MAIN_LABEL[m]}`)
  function setUsual(family: PdpFamily, ratingA: number) {
    const rating = ratingsFor(family).includes(ratingA) ? ratingA : 40
    commit({ ...map, usual: { family, ratingA: rating } }, `Every motor → ${breakerText({ family, ratingA: rating })}`)
  }
  const usualFamily = $derived<PdpFamily>(map.usual?.family ?? 'rev-ato')
  const keeping = $derived(map.usual ? slotsKeeping(map, map.usual) : 0)
  const keepingText = $derived.by(() => {
    if (!map.usual || keeping === 0) return ''
    const other = (map.boards.find((b) => b.id === PDP_ID)?.slots ?? []).find((s) => s.feeds?.kind === 'motor' && s.breaker && (s.breaker.family !== map.usual!.family || s.breaker.ratingA !== map.usual!.ratingA))
    return `${keeping} placed slot${keeping === 1 ? ' keeps' : 's keep'} ${other?.breaker ? breakerText(other.breaker) : 'their own breaker'}`
  })

  // ---- The popover ---------------------------------------------------------------------------------------------------
  let sel = $state<{ board: string; slot: number } | null>(null)
  let override = $state<MapBreaker | null>(null)
  let nextNote = $state('')
  let otherLabel = $state<string | null>(null)
  let pop = $state<HTMLDivElement | undefined>()
  let tiles = $state<Record<string, HTMLButtonElement>>({})
  const tileKey = (board: string, slot: number) => `${board}:${slot}`

  function open(board: string, slot: number) {
    sel = { board, slot }
    override = null
    otherLabel = null
    nextNote = ''
  }
  function close() {
    const back = sel
    sel = null
    nextNote = ''
    if (back) void tick().then(() => tiles[tileKey(back.board, back.slot)]?.focus())
  }
  // An opening from a finding or the strip lands on its slot.
  $effect(() => {
    if (focus?.slot !== undefined) { open(PDP_ID, focus.slot) }
  })
  $effect(() => {
    if (sel) void tick().then(() => pop?.querySelector<HTMLElement>('button')?.focus())
  })

  const defaultBreaker = (kind: Feed['kind'], board: string): MapBreaker => {
    if (board !== PDP_ID) return { family: 'atm', ratingA: 10 }
    const family = usualFamily
    return kind === 'motor' ? map.usual ?? { family, ratingA: 40 } : kind === 'mpm' ? { family, ratingA: 40 } : { family, ratingA: 20 }
  }
  const slotNow = $derived(sel ? slotEntries(map, sel.board, sel.slot) : [])
  const draft = $derived<MapBreaker>(override ?? slotNow[0]?.breaker ?? defaultBreaker('motor', sel?.board ?? PDP_ID))
  const chipFamilies = $derived(sel?.board === PDP_ID ? PDP_CHOICES : ['atm'])

  function choose(feed: Feed | null, extra = false) {
    if (!sel) return
    const { board, slot } = sel
    const breaker = override ?? (feed ? defaultBreaker(feed.kind, board) : null)
    let next: PowerMap
    let act: string
    if (feed === null) {
      next = withSlot(map, board, slot, null)
      act = `Slot ${slot} → empty`
    } else if (extra) {
      next = withExtraFeed(map, board, slot, { breaker, feeds: feed })
      act = `Slot ${slot} also → ${feedLabel(feed)}`
    } else {
      next = withSlot(map, board, slot, { breaker, feeds: feed })
      act = `Slot ${slot} → ${feedLabel(feed)}`
    }
    commit(next, board === PDP_ID ? act : `${board.replace('mpm-', 'MPM ')} ${act}`)
    override = null
    otherLabel = null
    const to = extra ? null : nextEmptySlot(next, board, slot)
    if (to === null) { sel = null; nextNote = ''; return }
    sel = { board, slot: to }
    nextNote = `Next: slot ${to}`
  }
  function pickBreaker(family: string, ratingA: number) {
    const rating = ratingsFor(family).includes(ratingA) ? ratingA : ratingsFor(family).at(-1)!
    const b = { family, ratingA: rating }
    if (!sel || slotNow.length === 0) { override = b; return }
    // A filled slot: the breaker changes at once.
    const entry = slotNow[0]
    const next: PowerMap = { ...map, boards: map.boards.map((x) => (x.id === sel!.board ? { ...x, slots: x.slots.map((s) => (s === entry ? { ...s, breaker: b } : s)) } : x)) }
    commit(next, `Slot ${sel.slot} breaker → ${breakerText(b)}`)
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape' && sel) { e.stopPropagation(); close() }
  }

  // ---- Lit slots (hovering a problem) ------------------------------------------------------------------------------------
  let lit = $state<number[]>([])
  const badSlots = $derived(new Set(problems.filter((p) => p.kind !== 'unplaced' && !p.board).flatMap((p) => p.slots)))
  const badMpm = (id: string, n: number) => problems.some((p) => p.board === id && p.slots.includes(n))
  const mpms = $derived(map.boards.filter((b) => b.kind === 'rev-mpm'))
  const label = (p: MapProblem) => p.text

  const title = (board: string, n: number) => {
    const es = slotEntries(map, board, n)
    const first = es[0]
    const what = es.length ? es.map((e) => feedLabel(e.feeds)).filter(Boolean).join(' + ') : ''
    return `${board === PDP_ID ? 'PDP slot' : `${board.replace('mpm-', 'MPM ')} slot`} ${n}: ${first?.breaker ? breakerText(first.breaker) : es.length ? 'no breaker set' : 'empty'}${what ? `, ${what}` : ''}`
  }
  const today = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
</script>

<svelte:window onkeydown={key} />

<section class="map" aria-label="Power map">
  <h2>Power map</h2>

  <div class="choices">
    <label class="robot">Robot
      <select value={robotId} onchange={(e) => { chosen = (e.currentTarget as HTMLSelectElement).value; try { localStorage.setItem(LAST, chosen) } catch { /* not remembered */ } clearMapFocus(); sel = null }}>
        {#each groups as g (g.label ?? '')}
          {#if g.label}<optgroup label={g.label}>{#each g.profiles as p (profileId(p))}<option value={profileId(p)}>{profileId(p)}</option>{/each}</optgroup>
          {:else}{#each g.profiles as p (profileId(p))}<option value={profileId(p)}>{profileId(p)}</option>{/each}{/if}
        {/each}
      </select>
    </label>
    <div class="group" role="group" aria-label="Main breaker">
      <span class="lbl">Main breaker</span>
      {#each MAINS as m (m)}<button type="button" class="chip" class:on={map.main === m} aria-pressed={map.main === m} onclick={() => setMain(m)}>{MAIN_LABEL[m]}</button>{/each}
    </div>
    <div class="group" role="group" aria-label="Every motor is on">
      <span class="lbl">Every motor is on</span>
      {#each PDP_CHOICES as f (f)}<button type="button" class="chip" class:on={map.usual?.family === f} aria-pressed={map.usual?.family === f} onclick={() => setUsual(f, map.usual?.ratingA ?? 40)}>{FAMILY_LABEL[f]}</button>{/each}
      <span class="sep" aria-hidden="true">·</span>
      {#each ratingsFor(usualFamily) as a (a)}<button type="button" class="chip rate" class:on={map.usual?.ratingA === a} aria-pressed={map.usual?.ratingA === a} aria-label={`${a} amps`} onclick={() => setUsual(usualFamily, a)}>{a} A</button>{/each}
    </div>
  </div>
  {#if keepingText}
    <p class="keeping" data-keeping>{keepingText} · <button type="button" class="link" onclick={() => map.usual && commit(applyToAll(map, map.usual), `All motor slots → ${breakerText(map.usual)}`)}>Apply to all</button></p>
  {/if}
  {#if focus?.from}<p class="from">Opened from {focus.from.label}: a change here counts from that match.</p>{/if}

  <div class="board" role="group" aria-label="CTRE PDP 2.0">
    <div class="pdp">
      <div class="rows">
        {#each rows as row, r (r)}
          <div class="row">
            {#each row as n (n)}
              {@const es = slotEntries(map, PDP_ID, n)}
              {@const b = es[0]?.breaker}
              {@const parts = es.map((e) => feedParts(e.feeds, true, e.feeds?.kind === 'mpm' ? mpmAt(map, n)?.id : undefined))}
              <button type="button" class="tile" class:filled={!!b} class:empty={es.length === 0} class:bad={badSlots.has(n)} class:lit={lit.includes(n)} class:sel={sel?.board === PDP_ID && sel.slot === n}
                style={b ? `background:${breakerFill(b.ratingA)}` : ''} bind:this={tiles[tileKey(PDP_ID, n)]}
                aria-label={title(PDP_ID, n)} aria-haspopup="dialog" aria-expanded={sel?.board === PDP_ID && sel.slot === n} title={title(PDP_ID, n)} onclick={() => open(PDP_ID, n)}>
                <span class="num">{n}</span>
                <span class="rating">{b ? b.ratingA : ''}</span>
                <span class="feed">{parts.map((x) => x.name).filter(Boolean).join(' + ')}</span>
                <span class="can">{parts.map((x) => x.can).filter(Boolean).join(' ')}</span>
                {#if badSlots.has(n)}<span class="bang" aria-hidden="true">!</span>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
      <div class="studs" aria-hidden="true"><span class="stud plus">+</span><span class="stud minus">−</span></div>
    </div>

    {#each mpms as m (m.id)}
      <div class="mpm">
        <p class="mpm-title">REV MPM {m.id.replace('mpm-', '')} · fed from PDP slot {m.fedFrom?.slot}</p>
        <div class="row">
          {#each Array.from({ length: MPM_SLOTS }, (_, i) => i) as n (n)}
            {@const es = slotEntries(map, m.id, n)}
            {@const b = es[0]?.breaker}
            {@const parts = es.map((e) => feedParts(e.feeds, true))}
            <button type="button" class="tile" class:filled={!!b} class:empty={es.length === 0} class:bad={badMpm(m.id, n)} class:sel={sel?.board === m.id && sel.slot === n}
              style={b ? `background:${breakerFill(b.ratingA)}` : ''} bind:this={tiles[tileKey(m.id, n)]}
              aria-label={title(m.id, n)} aria-haspopup="dialog" aria-expanded={sel?.board === m.id && sel.slot === n} title={title(m.id, n)} onclick={() => open(m.id, n)}>
              <span class="num">{n}</span>
              <span class="rating">{b ? b.ratingA : ''}</span>
              <span class="feed">{parts.map((x) => x.name).filter(Boolean).join(' + ')}</span>
              <span class="can">{parts.map((x) => x.can).filter(Boolean).join(' ')}</span>
              {#if badMpm(m.id, n)}<span class="bang" aria-hidden="true">!</span>{/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}

    {#if sel}
      {@const entry = slotNow[0]}
      <div class="pop" role="dialog" aria-label={`${sel.board === PDP_ID ? 'PDP' : sel.board.replace('mpm-', 'MPM ')} slot ${sel.slot}`} bind:this={pop}
        style={tiles[tileKey(sel.board, sel.slot)] ? `left:${Math.min(tiles[tileKey(sel.board, sel.slot)].offsetLeft, 300)}px;top:${tiles[tileKey(sel.board, sel.slot)].offsetTop + tiles[tileKey(sel.board, sel.slot)].offsetHeight + 4}px` : ''}>
        <p class="pop-head"><strong>{sel.board === PDP_ID ? 'PDP' : sel.board.replace('mpm-', 'MPM ')} slot {sel.slot}</strong>{#if nextNote}<span class="next" data-next> · {nextNote}</span>{/if}<button type="button" class="x" aria-label="Close (Esc)" onclick={close}>✕</button></p>
        {#if entry?.feeds?.kind === 'motor'}
          <p class="cur">Now: {feedLabel(entry.feeds)}</p>
        {/if}
        <ul class="opts">
          {#each unplaced as m (m.name + m.canId)}
            <li><button type="button" onclick={() => choose({ kind: 'motor', name: m.name, ...(m.canId !== undefined ? { canId: m.canId } : {}) })}>{feedLabel({ kind: 'motor', name: m.name, canId: m.canId })}</button></li>
          {/each}
          {#if sel.board === PDP_ID}
            <li><button type="button" onclick={() => choose({ kind: 'radio' })}>Radio</button></li>
            <li><button type="button" onclick={() => choose({ kind: 'roborio' })}>roboRIO</button></li>
            <li><button type="button" onclick={() => choose({ kind: 'mpm' })}>MPM</button></li>
          {/if}
          <li>{#if otherLabel === null}<button type="button" onclick={() => (otherLabel = '')}>Other…</button>
            {:else}<form onsubmit={(e) => { e.preventDefault(); choose({ kind: 'other', label: otherLabel!.trim() || undefined }) }}><input aria-label="What this slot feeds" bind:value={otherLabel} placeholder="what it feeds" /> <button type="submit">OK</button></form>{/if}</li>
          {#if slotNow.length}<li><button type="button" onclick={() => choose(null)}>Empty</button></li>{/if}
        </ul>
        {#if entry?.feeds?.kind === 'motor' && unplaced.length}
          <details class="also"><summary>Also feeds another motor (the rules allow one)</summary>
            <ul class="opts">{#each unplaced as m (m.name + m.canId)}<li><button type="button" onclick={() => choose({ kind: 'motor', name: m.name, ...(m.canId !== undefined ? { canId: m.canId } : {}) }, true)}>{feedLabel({ kind: 'motor', name: m.name, canId: m.canId })}</button></li>{/each}</ul>
          </details>
        {/if}
        <div class="brk" role="group" aria-label="Breaker in this slot">
          <span class="lbl">Breaker</span>
          {#if sel.board === PDP_ID}{#each chipFamilies as f (f)}<button type="button" class="chip" class:on={draft.family === f} aria-pressed={draft.family === f} onclick={() => pickBreaker(f, draft.ratingA)}>{FAMILY_LABEL[f]}</button>{/each}{:else}<span class="chip on">ATM</span>{/if}
          <span class="sep" aria-hidden="true">·</span>
          {#each ratingsFor(draft.family) as a (a)}<button type="button" class="chip rate" class:on={draft.ratingA === a} aria-pressed={draft.ratingA === a} aria-label={`${a} amps, ${breakerColourName(a)}`} style={`border-left:0.6rem solid ${breakerFill(a)}`} onclick={() => pickBreaker(draft.family, a)}>{a}</button>{/each}
        </div>
      </div>
    {/if}
  </div>

  <p class="note">
    Slot numbers from CTRE's drawing; check one against your board.
    <button type="button" class="rot" onclick={rotate} aria-pressed={rotated} title="Rotate the drawing 180° (a board mounted the other way round; remembered for this robot)" aria-label="Rotate the drawing 180 degrees">↻ 180°</button>
  </p>

  <ul class="problems" aria-label="What doesn't add up">
    {#each problems as p (p.text)}
      <li class={p.kind} onmouseenter={() => (lit = p.slots)} onmouseleave={() => (lit = [])} onfocusin={() => (lit = p.slots)} onfocusout={() => (lit = [])}>
        {#if p.kind !== 'unplaced'}<span class="mark" aria-hidden="true">!</span>{/if}{label(p)}
      </li>
    {/each}
  </ul>
  {#if map.seq > 0}<p class="saved" data-saved>{savedLine(map)}</p>{/if}

  {#if toast}
    <div class="toast" role="status">{toast.text} · <button type="button" class="link" onclick={toast.undo}>Undo</button>{#if toast.onlyFromNow} · <button type="button" class="link" onclick={toast.onlyFromNow}>Only from now</button>{/if}</div>
  {/if}
</section>

<style>
  .map { position: relative; max-width: 62rem; }
  h2 { font-size: 1.1rem; margin: 0.5rem 0; }
  .choices { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: center; margin: 0.5rem 0; }
  .group { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .lbl { font-size: 0.8rem; color: var(--muted); margin-right: 0.15rem; }
  .sep { color: var(--muted); }
  .robot select { font: inherit; padding: 0.2rem 0.35rem; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; max-width: 18rem; }
  .chip { padding: 0.25rem 0.6rem; min-height: 28px; border: 1px solid var(--border); border-radius: 14px; background: none; color: var(--fg); font: inherit; font-size: 0.85rem; cursor: pointer; }
  .chip.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .chip.rate { padding-left: 0.5rem; }
  .link { background: none; border: none; padding: 0; color: var(--link, var(--fg)); text-decoration: underline; cursor: pointer; font: inherit; min-height: 24px; }
  .keeping, .from, .note, .saved { font-size: 0.85rem; color: var(--muted); margin: 0.25rem 0; }
  .keeping { color: var(--fg); }
  .board { position: relative; margin: 0.75rem 0; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-start; }
  .pdp { display: flex; gap: 0.5rem; align-items: stretch; }
  .rows { display: flex; flex-direction: column; gap: 6px; }
  .row { display: grid; grid-template-columns: repeat(12, minmax(3.2rem, 4.6rem)); gap: 6px; }
  .mpm .row { grid-template-columns: repeat(6, minmax(3.2rem, 4.6rem)); }
  .studs { display: flex; flex-direction: column; justify-content: space-around; gap: 6px; }
  .stud { display: grid; place-items: center; width: 1.6rem; height: 2.4rem; border-radius: 4px; font-weight: 700; border: 1px solid var(--border); }
  .stud.plus { background: #e8736c; color: #1a1a1a; }
  .stud.minus { background: #444; color: #fff; }
  .tile { position: relative; width: 100%; height: 4.9rem; padding: 0.15rem; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; border: 2px solid var(--border); border-radius: 6px; background: none; color: #1a1a1a; font: inherit; cursor: pointer; overflow: hidden; }
  .tile.empty { color: var(--fg); border-style: solid; }
  .tile .num { position: absolute; top: 1px; left: 4px; font-size: 0.65rem; opacity: 0.75; }
  .tile .rating { font-size: 1.25rem; font-weight: 800; line-height: 1.5rem; margin-top: 0.35rem; min-height: 1.5rem; }
  .tile .feed { font-size: 0.68rem; line-height: 0.85rem; text-align: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile .can { font-size: 0.68rem; line-height: 0.85rem; font-weight: 700; white-space: nowrap; }
  .tile.sel { outline: 3px solid var(--fg); outline-offset: 1px; }
  .tile.lit { outline: 3px solid var(--warning); outline-offset: 1px; }
  .tile.bad { outline: 3px dashed var(--error); outline-offset: 1px; background-image: repeating-linear-gradient(45deg, transparent 0 6px, rgba(160, 0, 0, 0.28) 6px 8px); }
  .tile .bang { position: absolute; top: 0; right: 3px; font-weight: 900; color: #a00000; font-size: 1rem; }
  .mpm { border-left: 3px solid var(--border); padding-left: 0.75rem; }
  .mpm-title { margin: 0 0 0.35rem; font-size: 0.8rem; color: var(--muted); }
  .pop { position: absolute; z-index: 5; width: 21rem; max-width: calc(100% - 1rem); padding: 0.6rem 0.75rem; background: var(--bg); border: 1px solid var(--fg); border-radius: 8px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3); }
  .pop-head { margin: 0 0 0.35rem; display: flex; align-items: baseline; gap: 0.25rem; }
  .pop-head .next { color: var(--muted); flex: 1; font-size: 0.85rem; }
  .pop-head .x { margin-left: auto; background: none; border: none; color: var(--fg); cursor: pointer; font: inherit; min-width: 28px; min-height: 28px; }
  .cur { margin: 0 0 0.35rem; font-size: 0.85rem; color: var(--muted); }
  .opts { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; max-height: 11rem; overflow: auto; }
  .opts button, .opts input { font: inherit; font-size: 0.85rem; padding: 0.25rem 0.55rem; min-height: 28px; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); cursor: pointer; }
  .opts input { cursor: text; background: var(--bg); width: 9rem; }
  .also { margin: 0.35rem 0; font-size: 0.8rem; color: var(--muted); }
  .brk { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }
  .rot { font: inherit; font-size: 0.8rem; padding: 0.1rem 0.45rem; border: 1px solid var(--border); border-radius: 12px; background: none; color: var(--fg); cursor: pointer; min-height: 24px; }
  .rot[aria-pressed='true'] { background: var(--hover); }
  .problems { list-style: none; padding: 0; margin: 0.5rem 0; display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.88rem; }
  .problems li { padding: 0.3rem 0.6rem; border-left: 4px solid var(--border); }
  .problems li.two-motors, .problems li.motor-twice, .problems li.illegal-breaker { border-left: 4px dashed var(--error); }
  .problems .mark { display: inline-block; width: 1.1rem; font-weight: 900; color: var(--error); }
  .toast { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 0.5rem 1rem; border-radius: 8px; z-index: 20; }
  .toast .link { color: var(--bg); }
</style>
