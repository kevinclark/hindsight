<!--
  Per-match trends as a verdict table (Tufte's sparkline table: word-sized graphics beside the numbers; NN/g "answer
  first"). One row per number, worst first: what is the verdict, the shape across matches, the latest value, the worst
  match, and what to do. Every verdict, order and worst match comes from trendRows (src/session/trends.ts), the same
  model the printed report uses. Grey points, a battery's by shape; the line is a hairline; one amber dot marks the worst match when it is past the line; in a row where
  only some matches are past the line, those dots also get an amber ring. No red, and no trend call: it flipped in
  4 of 5 metrics when one match was left out.
-->
<script lang="ts">
  import type { MatchSummary } from '../session/summary.ts'
  import { trendLabelLong, trendRows, type TrendRow } from '../session/trends.ts'

  // `labels` is still passed by SessionView; the table labels logs itself (a log with no match number from its MatchType).
  // onOpen: open a match in Match review (the worst match is a link when it is given).
  let { matches, typedBatteries, onOpen, unit = 'match' }: { matches: MatchSummary[]; typedBatteries: Record<string, string>; labels?: string[]; onOpen?: (m: MatchSummary) => void; unit?: 'match' | 'log' } = $props()

  // A battery is told apart by shape, never by colour: red and amber already mean error and warning here (ISA-101: colour for
  // the abnormal only). Five shapes, used only when battery IDs exist (logged, or typed by hand); no battery ID is a plain grey dot.
  const SHAPES = ['square', 'diamond', 'down', 'cross', 'hex'] as const
  const shapeOf = (i: number) => SHAPES[i % SHAPES.length]
  // Points of a shape's outline around (x, y); r is its half-size. 'cross' is drawn as a plus (a polygon too).
  function outline(shape: (typeof SHAPES)[number], x: number, y: number, r: number): string {
    const k = r * 1.25
    const pts: [number, number][] =
      shape === 'square' ? [[-r, -r], [r, -r], [r, r], [-r, r]]
      : shape === 'diamond' ? [[0, -k], [k, 0], [0, k], [-k, 0]]
      : shape === 'down' ? [[-k, -r], [k, -r], [0, k]]
      : shape === 'cross' ? [[-r / 3, -k], [r / 3, -k], [r / 3, -r / 3], [k, -r / 3], [k, r / 3], [r / 3, r / 3], [r / 3, k], [-r / 3, k], [-r / 3, r / 3], [-k, r / 3], [-k, -r / 3], [-r / 3, -r / 3]]
      : [[-r, -k * 0.55], [0, -k], [r, -k * 0.55], [r, k * 0.55], [0, k], [-r, k * 0.55]]
    return pts.map(([dx, dy]) => `${(x + dx).toFixed(2)},${(y + dy).toFixed(2)}`).join(' ')
  }
  const battery = (m: MatchSummary) => m.batteryId ?? typedBatteries[m.fileName] ?? ''
  const batteries = $derived([...new Set(matches.map(battery).filter(Boolean))])
  const shape = (m: MatchSummary) => (battery(m) ? shapeOf(batteries.indexOf(battery(m))) : null)

  const rows = $derived(trendRows(matches, unit))

  const W = 100, H = 20, PX = 6, PY = 5
  function spark(row: TrendRow) {
    const nums = row.values.filter((v): v is number => v !== null)
    const edge = row.lines.filter((l): l is number => l !== null)
    let lo = Math.min(...nums, ...edge), hi = Math.max(...nums, ...edge)
    if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
    const x = (i: number) => PX + (matches.length === 1 ? (W - 2 * PX) / 2 : (i * (W - 2 * PX)) / (matches.length - 1))
    const y = (v: number) => H - PY - ((v - lo) / (hi - lo)) * (H - 2 * PY)
    return { x, y }
  }
  const fmt = (row: TrendRow, v: number) => `${v.toFixed(row.metric.digits)} ${row.metric.unit}`
  const mixed = (row: TrendRow) => row.pastCount > 0 && row.pastCount < row.n
</script>

<table class="trends">
  <thead>
    <tr><th>Metric (unit)</th><th>Verdict</th><th>Per {unit}</th><th>Latest</th><th>Worst {unit}</th><th>What to do</th></tr>
  </thead>
  <tbody>
    {#each rows as row (row.metric.key)}
      {@const w = row.worstIndex}
      {@const low = row.lowestIndex}
      <tr>
        <th scope="row" class="metric">{row.metric.label} <span class="muted">({row.metric.unit})</span>{#if row.metric.sub}<div class="muted sub">{row.metric.sub}</div>{/if}</th>
        <td class="verdict">
          {row.verdict}
          {#if row.verdict2}<div class={row.pastCount > 0 ? 'latest-worst' : 'muted'}>{row.verdict2}</div>{/if}
        </td>
        <td class="spark">
          {#if row.n > 0}
            {@const p = spark(row)}
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${row.metric.label} per ${unit}: ${row.verdict}`}>
              {#if row.line !== null}<line class="ref" x1={PX} x2={W - PX} y1={p.y(row.line)} y2={p.y(row.line)} />{/if}
              {#each matches as m, i (m.fileName)}
                {@const v = row.values[i]}
                {#if v !== null}
                  {#if mixed(row) && row.past[i]}<circle class="ring" cx={p.x(i)} cy={p.y(v)} r="4" />{/if}
                  {@const sh = shape(m)}
                  {@const worstPast = i === w && row.past[i]}
                  {@const r = i === w || i === low ? 3 : 2.2}
                  {#if sh}<polygon class="bat" class:worst={worstPast} points={outline(sh, p.x(i), p.y(v), r)}><title>{trendLabelLong(m, i)}: {fmt(row, v)} · battery {battery(m)}</title></polygon>
                  {:else}<circle cx={p.x(i)} cy={p.y(v)} {r} fill={worstPast ? 'var(--warning)' : 'var(--muted)'}><title>{trendLabelLong(m, i)}: {fmt(row, v)}{battery(m) ? ` · battery ${battery(m)}` : ''}</title></circle>{/if}
                {/if}
              {/each}
            </svg>
          {:else}
            <span class="muted">not in these logs</span>
          {/if}
        </td>
        <td class="num" data-label="Latest">{row.latest !== null ? fmt(row, row.latest) : row.n > 0 ? (String(row.metric.key).startsWith('drag:') ? 'no steady run' : 'not logged') : ''}</td>
        <td class="worst" data-label={`Worst ${unit}`}>{#if w !== null}{row.worstWord === 'highest' ? 'highest: ' : ''}{#if onOpen}<button class="link" title={`Open ${trendLabelLong(matches[w], w)} in Match review`} onclick={() => onOpen(matches[w])}>{row.labels[w]}</button>{:else}<span title={trendLabelLong(matches[w], w)}>{row.labels[w]}</span>{/if} {fmt(row, row.values[w]!)}{#if low !== null}<div class="muted">lowest: {#if onOpen}<button class="link" title={`Open ${trendLabelLong(matches[low], low)} in Match review`} onclick={() => onOpen(matches[low])}>{row.labels[low]}</button>{:else}<span title={trendLabelLong(matches[low], low)}>{row.labels[low]}</span>{/if} {fmt(row, row.values[low]!)}</div>{/if}{/if}</td>
        <td class="todo" data-label="What to do">
          {#if row.next.source === 'rule' || row.next.source === 'match'}
            <q>{row.next.text}</q> <span class="muted rule">{row.next.ruleId}</span>
          {:else if row.next.text}
            <span class={row.next.source === 'no-rule' ? 'muted' : ''}>{row.next.text}</span>{#if row.next.source === 'within'} <span class="muted rule">{row.next.ruleId}</span>{/if}
          {/if}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
{#if batteries.length}
  <p class="key">{#each batteries as b, i (b)}<span><svg class="mk" viewBox="-6 -6 12 12" aria-hidden="true"><polygon class="bat" points={outline(shapeOf(i), 0, 0, 3.6)} /></svg>{batteries.length > SHAPES.length ? `${i + 1} ` : ''}{b}</span>{/each}<span><span class="dot" style="background:var(--muted)"></span>no battery ID</span><span><span class="dot" style="background:var(--warning)"></span>worst {unit} past the line</span><span><span class="ring"></span>past the line, where only some {unit === 'match' ? 'matches' : 'logs'} are</span></p>
{:else}
  <p class="key"><span><span class="dot" style="background:var(--warning)"></span>worst {unit} past the line</span><span><span class="ring"></span>past the line, where only some {unit === 'match' ? 'matches' : 'logs'} are</span><span>No battery IDs yet: type them in the list below to mark the points by battery.</span></p>
{/if}

<style>
  .trends { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .trends th, .trends td { text-align: left; vertical-align: top; padding: 0.4rem 0.6rem 0.4rem 0; border-bottom: 1px solid var(--border); font-weight: normal; }
  .trends thead th { font-size: 0.75rem; color: var(--muted); border-bottom-color: var(--fg); }
  .metric { font-weight: 600; max-width: 13rem; }
  .muted, .key { color: var(--muted); font-size: 0.75rem; }
  .sub { font-weight: normal; }
  .rule { font-family: ui-monospace, monospace; font-size: 0.7rem; margin-left: 0.35em; }
  .latest-worst { color: var(--warning); font-size: 0.75rem; }
  .verdict { min-width: 9rem; }
  .spark svg { width: 100px; height: 20px; display: block; }
  .num { white-space: nowrap; }
  .worst { white-space: nowrap; }
  .link { border: none; background: none; color: var(--focus); font: inherit; cursor: pointer; padding: 0 0.15rem; min-height: 24px; min-width: 24px; box-sizing: border-box; }
  .todo { max-width: 24rem; }
  q { quotes: "\201C" "\201D"; }
  .ref { stroke: var(--muted); stroke-width: 0.75; opacity: 0.8; }
  .ring { fill: none; stroke: var(--warning); stroke-width: 1.2; }
  span.ring { display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1.2px solid var(--warning); margin-right: 4px; vertical-align: middle; }
  .key { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
  .bat { fill: var(--muted); }
  .bat.worst { fill: var(--warning); }
  .mk { width: 10px; height: 10px; margin-right: 4px; vertical-align: middle; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }

  /* Under 640 px each row is a block: metric and verdict, then the sparkline, then the rest. */
  @media (max-width: 639px) {
    .trends thead { display: none; }
    .trends, .trends tbody, .trends tr, .trends th, .trends td { display: block; width: auto; max-width: none; }
    .trends tr { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    .trends th, .trends td { border: 0; padding: 0.1rem 0; }
    .num::before, .worst::before, .todo::before { content: attr(data-label) ': '; color: var(--muted); font-size: 0.75rem; }
    .num, .worst { white-space: normal; }
  }
</style>
