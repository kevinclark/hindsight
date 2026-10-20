/**
 * Short match names for column headers and chart axes: "Qualification 13" -> "Q13", "Practice 2" -> "Pr2".
 * Types are mapped explicitly so no two share a prefix (Practice and Playoff both start with P); a type that
 * isn't listed gets the first letters of its words. A log with no match label keeps its position, "#3".
 */
const TYPE_CODES: Record<string, string> = {
  qualification: 'Q', practice: 'Pr', playoff: 'Pl', quarterfinal: 'QF', semifinal: 'SF', final: 'F', elimination: 'E',
}

export function shortMatchLabel(matchLabel: string, index: number): string {
  const label = matchLabel.trim()
  if (!label) return `#${index + 1}`
  const m = /^(.*?)\s*(\d+)$/.exec(label)
  const type = (m ? m[1] : label).trim()
  const number = m ? m[2] : ''
  if (!type) return number
  const code = TYPE_CODES[type.toLowerCase()] ?? type.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join('')
  return code + number
}
