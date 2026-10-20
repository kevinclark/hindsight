/** Finding titles shortened for tight places: the phone card, the bottom line, a note under a finding. */

/** The card's title without its asides, then cut at a stop (", first at ", "(median …") and at 70 characters on a word boundary. */
export function shortTitle(title: string): string {
  const cut = cardTitle(title).split(/, first at |\s*\((?:median|worst) /)[0].trim()
  if (cut.length <= 70) return cut
  const words = cut.slice(0, 69).split(' ')
  if (words.length > 1 && cut[69] !== ' ') words.pop()
  return `${words.join(' ').replace(/[\s,;:]+$/, '')}…`
}

/** A finding's title for the card: without the "(teleop; robot time 417.4 s)" aside, which the PDF keeps (card space is tight). */
export function cardTitle(title: string): string {
  return title.replace(/\s*\([^()]*robot time [\d.]+ s\)/g, '').replace(/\s*\(as of [^()]*\)/g, '').replace(/\s+/g, ' ').trim()
}
