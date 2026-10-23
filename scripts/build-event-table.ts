/**
 * Write src/hub/events/<year>.json from The Blue Alliance (API v3 `/events/{year}/simple`): event code (lowercase, without
 * the year) -> event name. Needs a TBA read key in the environment; the app itself never does.
 *
 *   TBA_READ_KEY=<key> node --experimental-strip-types scripts/build-event-table.ts 2026 [2025 ...]
 */
import { writeFile } from 'node:fs/promises'

const key = process.env.TBA_READ_KEY
if (!key) {
  console.error('TBA_READ_KEY is not set. Get a read key from https://www.thebluealliance.com/account (Read API keys) and run again with TBA_READ_KEY set.')
  process.exit(1)
}
const years = process.argv.slice(2).map(Number)
if (years.length === 0 || years.some((y) => !Number.isInteger(y) || y < 1992)) {
  console.error('Give one or more years: node --experimental-strip-types scripts/build-event-table.ts 2026')
  process.exit(1)
}

for (const year of years) {
  const res = await fetch(`https://www.thebluealliance.com/api/v3/events/${year}/simple`, { headers: { 'X-TBA-Auth-Key': key } })
  if (!res.ok) {
    console.error(`TBA answered ${res.status} for ${year}; nothing written for it.`)
    process.exit(1)
  }
  const events = (await res.json()) as { key: string; name: string }[]
  const table: Record<string, string> = { _source: `The Blue Alliance API v3 /events/${year}/simple` }
  for (const e of [...events].sort((a, b) => a.key.localeCompare(b.key))) table[e.key.replace(/^\d{4}/, '').toLowerCase()] = e.name
  const out = new URL(`../src/hub/events/${year}.json`, import.meta.url)
  await writeFile(out, `${JSON.stringify(table, null, 2)}\n`)
  console.log(`${year}: ${events.length} events -> ${out.pathname}`)
}
