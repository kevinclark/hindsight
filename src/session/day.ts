/** Local calendar date, YYYY-MM-DD: the day a log was played, as sessions and the mode line count days. */
export function dateText(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
