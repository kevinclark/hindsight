/**
 * The phone card: one portrait image for a Slack message, drawn as pure SVG (rect, path, text; no foreignObject,
 * system fonts only, light palette). Slack shows an image at about 360 px wide on a phone, so the card is 1080 px
 * wide (3x) and its smallest type is 32 px (10.7 px at 360). Tall enough for the content: at most 4:5, and taller only when a single item needs it (never clipped).
 *
 * Severity is always a word, never colour alone (WCAG 2.2 SC 1.4.1). Text is wrapped by an estimated width (there is
 * no font to measure in Node), deliberately on the wide side, so a line may end early but never runs off the card.
 */

export const CARD_WIDTH = 1080
export const CARD_MAX_HEIGHT = 1350 // 4:5
export const CARD_MIN_TYPE = 32

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const COLOR = { fg: '#1d1d1f', muted: '#5f6368', error: '#c5221f', warning: '#a35200', ok: '#188038', line: '#c9c9ce', bg: '#ffffff' }
const MARGIN = 48
const INNER = CARD_WIDTH - 2 * MARGIN

export type Tone = 'error' | 'warning' | 'ok' | 'muted'

export interface CardItem {
  /** The severity as a word: "ERROR", "WARNING", "FIX", "LOOK AT". */
  word: string
  tone: Tone
  title: string
  /** The one decisive number, with its label: "brownout onsets: 53". */
  number: string
  /** A short name ("roboRIO brownout (Qualification 42)"): an error left off the card is still named by it, in one line. */
  short?: string
}

export interface CardModel {
  /** Small line above the verdict: match label, event, date. */
  context: string
  /** The verdict or the counts, large: "NO-GO", "5 errors". */
  heading: string
  headingTone: Tone
  /** Under the heading: the reason, or the other counts. */
  subheading: string
  items: CardItem[]
  /** Said when the list is empty. */
  emptyText: string
  /** Footer lines (build, version), each wrapped. */
  footer: string[]
  /** Draws a boxed warning above the footer. */
  uncommitted: boolean
  /** The words in that box. */
  uncommittedText?: string
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** Estimated advance per character, as a fraction of the font size (wide: bold capitals and digits included). */
const ADVANCE = 0.5
const ADVANCE_BOLD = 0.54

/** Word-wrap `text` into at most `maxLines` lines that fit `width` px at `size` px; the last line ends in "…" if cut. */
export function wrap(text: string, size: number, width: number, maxLines: number, bold = false): string[] {
  const perLine = Math.max(4, Math.floor(width / (size * (bold ? ADVANCE_BOLD : ADVANCE))))
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let w of words) {
    while (w.length > perLine) { // one long token (a file name): break it
      if (cur) { lines.push(cur); cur = '' }
      lines.push(w.slice(0, perLine)); w = w.slice(perLine)
    }
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= perLine) cur += ` ${w}`
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]
  kept[maxLines - 1] = `${last.length >= perLine ? last.slice(0, perLine - 1) : last}…`.replace(/[\s,;:]+…$/, '…')
  return kept
}

interface Drawn { svg: string; height: number }

function text(x: number, top: number, size: number, content: string, fill: string, bold = false): string {
  // top is the top of the line box; the baseline sits 0.85 of the font size below it.
  return `<text x="${x}" y="${(top + size * 0.85).toFixed(0)}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${fill}">${esc(content)}</text>`
}

function block(lines: string[], x: number, top: number, size: number, fill: string, bold = false, lead = 1.25): Drawn {
  return { svg: lines.map((l, i) => text(x, top + i * size * lead, size, l, fill, bold)).join(''), height: lines.length * size * lead }
}

export interface Card { svg: string; width: number; height: number; shown: number; hidden: number }

export function buildCard(model: CardModel): Card {
  const parts: string[] = []
  let y = MARGIN
  const add = (d: Drawn) => { parts.push(d.svg); y += d.height }

  const ctx = block(wrap(model.context, 32, INNER, 2), MARGIN, y, 32, COLOR.muted)
  add(ctx); y += 10
  add(block(wrap(model.heading, 88, INNER, 1, true), MARGIN, y, 88, COLOR[model.headingTone], true, 1.1))
  add(block(wrap(model.subheading, 36, INNER, 3), MARGIN, y, 36, COLOR.fg))
  y += 18

  // Footer first, to know how much room the list has.
  let footerHeight = 24
  const flagLines = model.uncommitted ? wrap(model.uncommittedText ?? 'UNCOMMITTED CODE', 36, INNER - 48, 2, true) : []
  const flagHeight = flagLines.length ? flagLines.length * 36 * 1.25 + 28 : 0
  const foot = model.footer.map((f) => wrap(f, 32, INNER, 2))
  const footLines = foot.reduce((n, l) => n + l.length, 0)
  footerHeight += flagHeight + (flagHeight ? 16 : 0) + footLines * 32 * 1.25 + MARGIN

  const itemBlocks: { drawn: (top: number) => string; height: number }[] = model.items.map((it) => {
    const title = wrap(it.title, 36, INNER, 2)
    const num = it.number ? wrap(it.number, 32, INNER, 2) : []
    const height = 18 + 32 * 1.25 + title.length * 36 * 1.25 + num.length * 32 * 1.25 + 14
    return {
      height,
      drawn: (top) => {
        const rule = `<rect x="${MARGIN}" y="${top}" width="${INNER}" height="2" fill="${COLOR.line}"/>`
        const word = text(MARGIN, top + 18, 32, it.word, COLOR[it.tone], true)
        const t = block(title, MARGIN, top + 18 + 40, 36, COLOR.fg, true).svg
        const n = block(num, MARGIN, top + 18 + 40 + title.length * 45, 32, COLOR.muted).svg
        return rule + word + t + n
      },
    }
  })

  const moreHeight = 36 * 1.25 + 14
  const fit = (room: number) => {
    let shown = 0, used = 0
    for (const b of itemBlocks) {
      const remaining = itemBlocks.length - shown - 1
      if (used + b.height + (remaining > 0 ? moreHeight : 0) > room) break
      used += b.height
      shown++
    }
    // Never an empty list when there are findings: one item is shown even if that pushes the card past 4:5.
    return shown === 0 && itemBlocks.length ? 1 : shown
  }
  // Errors that don't fit are still named, in one line under "+N more" (an error that happened once can still lose a match).
  const alsoLines = (shown: number) => {
    const names = new Map<string, number>()
    for (const it of model.items.slice(shown)) if (it.tone === 'error' && it.short) names.set(it.short, (names.get(it.short) ?? 0) + 1)
    if (names.size === 0) return []
    const n = [...names.values()].reduce((a, b) => a + b, 0)
    const parts = [...names].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name))
    return wrap(`Also ${n} error${n === 1 ? '' : 's'}: ${parts.join('; ')}`, 32, INNER, 2)
  }
  // The line adds height rather than taking an item's place: the card may run up to two lines past 4:5.
  const shown = fit(CARD_MAX_HEIGHT - y - footerHeight)
  const also = alsoLines(shown)
  if (itemBlocks.length === 0) {
    add(block(wrap(model.emptyText, 36, INNER, 3), MARGIN, y, 36, COLOR.muted))
  } else {
    for (let i = 0; i < shown; i++) { parts.push(itemBlocks[i].drawn(y)); y += itemBlocks[i].height }
    const hidden = itemBlocks.length - shown
    if (hidden > 0) {
      parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER}" height="2" fill="${COLOR.line}"/>`)
      add(block([`+${hidden} more in the PDF`], MARGIN, y + 14, 36, COLOR.fg, true))
      y += 14
      if (also.length) { y += 8; add(block(also, MARGIN, y, 32, COLOR.error)) }
    }
  }

  y += 24
  if (flagLines.length) {
    const h = flagHeight
    parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER}" height="${h}" fill="none" stroke="${COLOR.warning}" stroke-width="4"/>`)
    parts.push(block(flagLines, MARGIN + 24, y + 14, 36, COLOR.warning, true).svg)
    y += h + 16
  }
  for (const lines of foot) add(block(lines, MARGIN, y, 32, COLOR.muted))
  y += MARGIN
  const height = Math.ceil(y) // never clamped: clipped text is worse than a taller card
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" font-family="${esc(FONT)}">` +
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${COLOR.bg}"/>` + parts.join('') + '</svg>'
  return { svg, width: CARD_WIDTH, height, shown, hidden: itemBlocks.length - shown }
}

export const cardSvg = (model: CardModel): string => buildCard(model).svg
