/**
 * Reader for FRC Driver Station .dsevents files (the DS laptop's event log, version 4), and the few facts Hindsight
 * takes from it.
 *
 * Layout (big-endian, LabVIEW style, as .dslog): a 20-byte header (int32 version 4, int64 seconds since 1904-01-01
 * UTC, uint64 fraction), then records: int64 seconds, uint64 fraction, int32 length, that many bytes of text. One
 * record can hold several messages, each starting "<TagVersion>". Source: the bytes of team 334's public 2026 files
 * (E3, E6, Q26), and AdvantageScope's DSEventsReader for the layout.
 *
 * Facts, read from those three files only:
 *  - "FMS Connected:   Elimination - 6:1": the match type, number and replay.
 *  - "Input Voltage Brownouts: 47": the DS's own running brownout count, reported about once a second while it rises.
 *  - Kernel lines from the roboRIO, "[  425.095288] usb 1-1.2.4: USB disconnect, …", stamped with the roboRIO's
 *    uptime. The DS logs some again later (1.1–1.2 s later in one match; 34.7 s later, at the next USB event, in
 *    another), so each line counts once by its uptime and text, at the time the DS first logged it.
 */

export interface DseventsMessage {
  /** When the DS logged it, seconds since the Unix epoch. */
  epochSeconds: number
  text: string
}

export interface DseventsFile {
  startEpochSeconds: number
  messages: DseventsMessage[]
}

/** A kernel line: the roboRIO's uptime when it was written, and when the DS first logged it. */
export interface KernelLine { uptime: number; epochSeconds: number; text: string }

const LABVIEW_TO_UNIX = 2082844800
const HEADER_BYTES = 20
const RECORD_HEADER_BYTES = 20

export function readDsevents(bytes: Uint8Array): DseventsFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < HEADER_BYTES) throw new Error('File too short to be a .dsevents')
  const version = view.getInt32(0, false)
  if (version !== 4) throw new Error(`Unsupported .dsevents version ${version} (only version 4 is supported)`)
  const messages: DseventsMessage[] = []
  const decoder = new TextDecoder()
  let pos = HEADER_BYTES
  while (pos + RECORD_HEADER_BYTES <= bytes.length) {
    const epochSeconds = labviewTime(view, pos)
    const length = view.getInt32(pos + 16, false)
    if (length < 0 || pos + RECORD_HEADER_BYTES + length > bytes.length) break
    const text = decoder.decode(bytes.subarray(pos + RECORD_HEADER_BYTES, pos + RECORD_HEADER_BYTES + length))
    for (const part of text.split('<TagVersion>')) if (part.trim()) messages.push({ epochSeconds, text: part.trim() })
    pos += RECORD_HEADER_BYTES + length
  }
  return { startEpochSeconds: labviewTime(view, 4), messages }
}

function labviewTime(view: DataView, at: number): number {
  return Number(view.getBigInt64(at, false)) - LABVIEW_TO_UNIX + Number(view.getBigUint64(at + 8, false)) / 2 ** 64
}

/** The last message's time: where the file ends. */
export function dseventsEndEpoch(file: DseventsFile): number {
  return file.messages.at(-1)?.epochSeconds ?? file.startEpochSeconds
}

/** Match types by the FMS's own numbers (0: none), as the FMS line names them; match.ts labels matches with them. */
export const MATCH_TYPES = ['None', 'Practice', 'Qualification', 'Elimination']

/** Each match the FMS said this was, in file order (one per FMS connection). */
export function fmsMatches(file: DseventsFile): { type: number; number: number; replay: number; epochSeconds: number }[] {
  return file.messages.flatMap((m) => {
    const found = /FMS Connected:\s+(\w+) - (\d+):(\d+)/.exec(m.text)
    if (!found) return []
    return [{ type: MATCH_TYPES.indexOf(found[1]), number: Number(found[2]), replay: Number(found[3]), epochSeconds: m.epochSeconds }]
  })
}

/** The DS's running brownout count, each time it logged it. */
export function brownoutCounts(file: DseventsFile): { epochSeconds: number; count: number }[] {
  return file.messages.flatMap((m) => {
    const found = /Input Voltage Brownouts: (\d+)/.exec(m.text)
    return found ? [{ epochSeconds: m.epochSeconds, count: Number(found[1]) }] : []
  })
}

/** Every kernel line once (by uptime and text), in uptime order, with the time the DS first logged it. */
export function kernelLines(file: DseventsFile): KernelLine[] {
  const first = new Map<string, KernelLine>()
  for (const m of file.messages) {
    const found = /^(?:.*?<message>\s*)?\[\s*(\d+\.\d+)\]\s*(.*)$/s.exec(m.text)
    if (!found) continue
    const line = { uptime: Number(found[1]), epochSeconds: m.epochSeconds, text: found[2].trim() }
    const key = `${line.uptime} ${line.text}`
    if (!first.has(key) || first.get(key)!.epochSeconds > line.epochSeconds) first.set(key, line)
  }
  return [...first.values()].sort((a, b) => a.uptime - b.uptime)
}

/**
 * Kernel events the rules read, each a test on a kernel line. A USB disconnect counts for the CANivore when a
 * canivore_usb line in the same file names the same USB port (e.g. 1-1.2.4).
 */
export const KERNEL_EVENTS = {
  canivoreUsbDisconnects: (line: KernelLine, canivorePorts: Set<string>) => {
    const port = /^usb (\S+): USB disconnect/.exec(line.text)?.[1]
    return port !== undefined && canivorePorts.has(port)
  },
  canivoreTxFails: (line: KernelLine) => /^canivore_usb \S+ \S+ usb tx fail/.test(line.text),
  usbPortDisabled: (line: KernelLine) => /^usb \S+: disabled by hub/.test(line.text),
} satisfies Record<string, (line: KernelLine, canivorePorts: Set<string>) => boolean>

/** The USB ports a CANivore was on, from its kernel lines ("canivore_usb 1-1.2.4:1.1 can1: …" → 1-1.2.4). */
export function canivorePorts(lines: KernelLine[]): Set<string> {
  return new Set(lines.flatMap((l) => /^canivore_usb (\S+?):/.exec(l.text)?.[1] ?? []))
}
