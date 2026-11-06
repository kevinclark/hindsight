import { describe, expect, it } from 'vitest'
import { applyCanNotes, isCanNotesPath, parseCanNotes } from '../src/builder/can-notes.ts'
import { applySnapshot } from '../src/builder/draft.ts'
import type { ProfileJson } from '../src/builder/json.ts'
import { openWpilog, type WpilogFile } from '../src/readers/wpilog.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

const noMeta = { entries: new Map() } as unknown as WpilogFile
const draft = (...paths: string[]) => ({ motorGroups: [{ name: 'g', motors: paths.map((logPath) => ({ name: logPath, logPath })) }] }) as unknown as ProfileJson
const ids = (json: ProfileJson) => json.motorGroups[0].motors.map((m) => [m.canId, m.canIdFrom])

const COLUMNS = `| CAN ID | Device Name | Device Type | Inventory ID |
| ------ | ----------- | ----------- | ------------ |
| 3 | Front Right Turn | X44 | ~~X44-901~~ X44-902 |
| 15 | Drum Leader | X60 | X60-903 |
| 0 | Gyro | Pigeon 2.0 | PGN-904 |
| 4 | Intake CANcoder | WCP Throughbore | THB-905 |
`
const BARE = `Device | CAN ID
------ | ------
Arm Rollers (X60) | 8
Arm Pivot Encoder (CANcoder) | 4
`

describe('parseCanNotes', () => {
  it('reads a table with type and inventory columns, and tells motors from other devices', () => {
    expect(parseCanNotes(COLUMNS).map((n) => [n.id, n.name, n.isMotor])).toEqual([[3, 'Front Right Turn', true], [15, 'Drum Leader', true], [0, 'Gyro', false], [4, 'Intake CANcoder', false]])
  })
  it('reads a table with no outer pipes and the type in the name', () => {
    expect(parseCanNotes(BARE).map((n) => [n.id, n.isMotor])).toEqual([[8, true], [4, false]])
  })
  it('reads an ID-first table headed ID and Use', () => {
    expect(parseCanNotes('| ID | Use |\n|---|---|\n| 10 | Manipulator Roller |\n').map((n) => [n.id, n.name])).toEqual([[10, 'Manipulator Roller']])
  })
})

describe('isCanNotesPath', () => {
  it('takes the spellings teams use, in any folder, and nothing else', () => {
    for (const p of ['notes/canids.md', 'repo/notes/canIDs.md', 'notes/motorIds.md']) expect(isCanNotesPath(p)).toBe(true)
    for (const p of ['notes/superstructure.md', 'canids.md', 'notes/canids.txt']) expect(isCanNotesPath(p)).toBe(false)
  })
})

describe('applyCanNotes', () => {
  it('fills open IDs by name, marked as from the notes, and never overwrites one or reuses its ID', () => {
    const json = draft('/Shooter/Drum/Leader', '/Drive/FrontRight/Turn')
    json.motorGroups[0].motors[1].canId = 15
    json.motorGroups[0].motors[1].canIdFrom = 'code'
    expect(applyCanNotes(json, parseCanNotes(COLUMNS), noMeta)).toBe(0)
    expect(ids(json)).toEqual([[undefined, undefined], [15, 'code']])
    const open = draft('/Shooter/Drum/Leader', '/Drive/FrontRight/Turn')
    expect(applyCanNotes(open, parseCanNotes(COLUMNS), noMeta)).toBe(2)
    expect(ids(open)).toEqual([[15, 'notes'], [3, 'notes']])
  })
  it('does not give a motor the ID of an encoder or gyro', () => {
    const json = draft('/Intake/Pivot')
    applyCanNotes(json, parseCanNotes('| ID | Device |\n|---|---|\n| 4 | Intake Pivot Encoder (CANcoder) |\n'), noMeta)
    expect(ids(json)).toEqual([[undefined, undefined]])
  })
  const TWO = '# Alpha (21)\nDevice | CAN ID\n---|---\nClimber | 20\nHood | 11\n\n# Comp (26)\nDevice | CAN ID\n---|---\nClimber | 16\nHood | 11\n'
  it('fills nothing for a name with two IDs across robot versions, and one ID when they agree', () => {
    const json = draft('/Climber/Motor', '/Hood/Motor')
    applyCanNotes(json, parseCanNotes(TWO), noMeta)
    expect(ids(json)).toEqual([[undefined, undefined], [11, 'notes']])
  })
  it("uses the table the log's metadata names", () => {
    const log = openWpilog(writeWpilog([{ name: '/RealMetadata/Robot Edition', type: 'string', records: [[1, 'COMP']] }]))
    const json = draft('/Climber/Motor', '/Hood/Motor')
    applyCanNotes(json, parseCanNotes(TWO), log)
    expect(ids(json)).toEqual([[16, 'notes'], [11, 'notes']])
  })
  it('gives way to a snapshot', () => {
    const json = draft('/Hood/Motor')
    applyCanNotes(json, parseCanNotes('| ID | Device |\n|---|---|\n| 11 | Hood |\n'), noMeta)
    applySnapshot(json, { devices: [], takenAt: '', takenAtLocal: '' } as never)
    expect(ids(json)).toEqual([[undefined, undefined]])
  })
})
