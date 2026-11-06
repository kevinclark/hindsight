/**
 * A team's own list of CAN IDs, kept with its code (notes/canids.md): a Markdown table of device names and IDs. It fills
 * a draft's CAN IDs that neither the log nor the code gave, when there is no snapshot, and each says it came from the
 * notes: people write this file, so it can be out of date.
 *
 * Only names that match clearly fill an ID (matchByName, the same rule as a snapshot's Tuner X names). Encoders, gyros
 * and other devices number their IDs apart from the motors, so they are read and left out of the matching. A file with a
 * table per robot version ("# Alpha", "# Comp") gives the table the log's metadata names, else all of them; a name with
 * two IDs across those tables then fills nothing.
 */
import { firstText } from '../profiles/formats.ts'
import type { WpilogFile } from '../readers/wpilog.ts'
import { allMotors } from './draft.ts'
import type { ProfileJson } from './json.ts'
import { matchByName, nameWords } from './snapshot.ts'

export interface CanNote { id: number; name: string; isMotor: boolean; section: string }

export const isCanNotesPath = (path: string): boolean => /(^|\/)notes\/(can|motor)[ _-]?ids?\.md$/i.test(path)

const NOT_A_MOTOR = /cancoder|encoder|throughbore|through bore|pigeon|gyro|canrange|beam ?break|canivore|candle|candi\b/i
const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const isRule = (line: string) => line.includes('-') && /^[\s|:-]+$/.test(line)
const column = (header: string[], want: RegExp, not: RegExp = /$^/) => header.findIndex((c) => want.test(c) && !not.test(c))

/** Every row of every table in the file with a whole-number ID and a name. */
export function parseCanNotes(text: string): CanNote[] {
  const lines = text.split(/\r?\n/)
  const notes: CanNote[] = []
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    const heading = /^#+\s*(.*)$/.exec(lines[i])
    if (heading) { section = heading[1].trim(); continue }
    if (!isRule(lines[i + 1] ?? '') || !lines[i].includes('|')) continue
    const header = cellsOf(lines[i])
    const canId = column(header, /can ?id/i)
    const idColumn = canId >= 0 ? canId : column(header, /^id$/i)
    const nameColumn = column(header, /device|name|use|motor/i, /type|inventory|\bid\b/i)
    if (idColumn < 0 || nameColumn < 0) continue
    const typeColumn = column(header, /type|model/i)
    for (i += 2; i < lines.length && lines[i].includes('|'); i++) {
      const cells = cellsOf(lines[i])
      const name = cells[nameColumn] ?? ''
      if (!name || !/^\d+$/.test(cells[idColumn] ?? '')) continue
      notes.push({ id: Number(cells[idColumn]), name, isMotor: !NOT_A_MOTOR.test(`${name} ${cells[typeColumn] ?? ''}`), section })
    }
    i--
  }
  return notes
}

/** The robot version's table when the log's metadata names one ("Robot Edition" COMP and "# Comp (26 devices)"), else every table. */
function notesForLog(notes: CanNote[], log: WpilogFile): CanNote[] {
  const said = new Set([...log.entries.keys()].filter((k) => k.startsWith('/RealMetadata/')).map((k) => firstText(log, k).trim().toLowerCase()).filter(Boolean))
  const named = notes.filter((n) => said.has(n.section.split(/\s+/)[0]?.toLowerCase() ?? ''))
  return named.length ? named : notes
}

/** Fill the IDs still open from the notes, by name. Returns how many it filled. */
export function applyCanNotes(json: ProfileJson, notes: CanNote[], log: WpilogFile): number {
  const motors = allMotors(json).map((x) => x.motor)
  const used = new Set(motors.map((m) => m.canId))
  const open = motors.filter((m) => m.canId === undefined)
  // The same motor in two tables with one ID is one device; with two IDs it stays two, and the tie fills nothing.
  const devices = new Map<string, { key: string; id: number; name: string; isMotor: true; count: number }>()
  for (const n of notesForLog(notes, log)) {
    const key = `${n.id}|${[...nameWords(n.name)].sort().join(' ')}`
    if (n.isMotor && !used.has(n.id)) devices.set(key, { key, id: n.id, name: n.name, isMotor: true, count: 1 })
  }
  const matches = matchByName(open.map((m) => m.logPath ?? m.name), { devices: [...devices.values()] })
  for (const { path, device } of matches) {
    const motor = open.find((m) => (m.logPath ?? m.name) === path)!
    motor.canId = device.id
    motor.canIdFrom = 'notes'
  }
  return matches.length
}
