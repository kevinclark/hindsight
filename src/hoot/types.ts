/**
 * What Hindsight keeps of a CTRE .hoot file: only what the device view draws, reduced from owlet's export (ADR 13).
 * Times are seconds on the .hoot file's own clock; src/hoot/align.ts lines them up with the robot log. No `node:` here:
 * the page reads these.
 */

/** One device's readings, binned so the extremes stay exact: the lowest voltage, the highest current and temperature. */
export interface HootDevice {
  /** As owlet names it: `TalonFX-11`, `CANcoder-3`, `Pigeon2-0`. */
  name: string
  /** Start of each bin of `volts` and `amps` (seconds); bins with no record are left out. */
  t: number[]
  /** Lowest supply voltage in each bin, or null when the device does not report it. */
  volts: number[] | null
  /** Highest supply current in each bin, or null when the device does not report it. */
  amps: number[] | null
  /** Highest temperature per TEMP_BIN_S, or null. */
  temp: { t: number[]; c: number[] } | null
  /** Stretches longer than GAP_S with no record from the device while the file has records: drawn as breaks. */
  gaps: { from: number; to: number }[]
  /** Each health fault turning on and off. */
  faults: { name: string; on: number; off: number | null }[]
  /** Times the device's ResetCount went up (it restarted). */
  resets: number[]
}

export interface HootReading {
  /** The .hoot's own file name. */
  file: string
  /** CANivore serial or `rio`, from the file name. */
  bus: string
  /** First and last record time. */
  start: number
  end: number
  /** RobotEnable as the .hoot recorded it: each change, with its new value. */
  enable: { t: number; on: boolean }[]
  /** RobotMode as the .hoot recorded it (`Disabled`, `Autonomous`, `Teleop`): each change. Empty when absent. */
  mode: { t: number; v: string }[]
  /** DS:IsFMSAttached: each change. Empty when the file has none. */
  fms: { t: number; on: boolean }[]
  /** Every TalonFX's supply current summed on Hindsight's 0.02 s grid from `start` to `end` (a device counts 0 A before its first record and inside its gaps), amps to 0.01. */
  totalAmps: { t: number[]; a: number[] }
  devices: HootDevice[]
  /** owlet said the file ends early (cut short, usually power off mid-write); what it held was still read. */
  cutShort: string | null
  /** The owlet that read it, `26.3.0-C19`. */
  owlet: string
}

/** Bin widths and the gap that breaks a line (seconds). */
export const BIN_S = 0.25
export const TEMP_BIN_S = 1
export const GAP_S = 0.5

/** A .hoot the Library attached to a robot log, as the Devices tab sees it. */
export interface HootFile {
  /** Library path. */
  path: string
  name: string
  bus: string
  size: number
  /** On this computer. */
  held: boolean
  /** The format byte (null when not held, or unreadable). */
  compliancy: number | null
  /** The owlet that would read it here, or null when none is on this computer. */
  owlet: { version: string; where: 'hindsight' | 'advantagescope' } | null
}

export interface HootStatus {
  files: HootFile[]
  /** Whether CTRE has a build for this computer at all (no download button otherwise). */
  canDownload: boolean
}

export interface HootReadReport {
  readings: HootReading[]
  /** A file that could not be read, in words. */
  /** `reget`: owlet could not even start (a damaged copy): getting it again may fix it. */
  problems: { file: string; why: string; reget?: boolean }[]
}

/** The readings of a log's .hoot files already in the cache (Match review's experimental checks, ADR 14). */
export interface HootCached {
  readings: HootReading[]
  /** Held files with no cached reading yet (owlet may not be on this computer yet): the Devices tab reads them or offers owlet. */
  unread: number
  /** Files of this log on the team Drive and not on this computer: the Devices tab downloads them. */
  away: number
}
