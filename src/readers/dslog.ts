/**
 * Reader for FRC Driver Station .dslog files (the DS laptop's own 50 Hz log, version 4).
 *
 * Layout (big-endian, LabVIEW style):
 *   header, 20 bytes: int32 version (4), int64 seconds since 1904-01-01 UTC, uint64 fraction of a second
 *   then one record every 20 ms:
 *     uint8  trip time, ×0.5 ms
 *     int8   lost packets, ×4 %
 *     uint16 battery voltage, ÷256 V (0xFFFF = no robot)
 *     uint8  roboRIO CPU, ×0.5 %
 *     uint8  status bits, ACTIVE LOW (0 means true):
 *            bit7 brownout, bit6 watchdog, bit5 DS teleop, bit4 DS auto,
 *            bit3 DS disabled, bit2 robot teleop, bit1 robot auto, bit0 robot disabled
 *     uint8  CAN utilization, ×0.5 %
 *     uint8  Wi-Fi signal, ×0.5 dB
 *     uint16 bandwidth, ÷256 Mb/s
 *     4 bytes power-distribution header; byte 3 is its type, then that type's data:
 *            33 = REV PDH: 33 more bytes; 25 = CTRE PDP: 25 more bytes; anything else: none
 * Sources: the 2026-10-17 Q13 analysis ("How this was produced") and AdvantageScope's DSLogReader.ts (PD sizes).
 * The power-distribution currents are skipped, not decoded: the robot log has better current data.
 */

export interface DslogRecord {
  /** Seconds since the Unix epoch (UTC). */
  epochSeconds: number
  tripTimeMs: number
  lostPacketsPct: number
  /** null when the DS saw no robot. */
  voltage: number | null
  cpuPct: number
  canPct: number
  wifiDb: number
  bandwidthMbps: number
  brownout: boolean
  watchdog: boolean
  dsTeleop: boolean
  dsAuto: boolean
  dsDisabled: boolean
  robotTeleop: boolean
  robotAuto: boolean
  robotDisabled: boolean
}

export interface DslogFile {
  version: number
  /** Start time, seconds since the Unix epoch (UTC). */
  startEpochSeconds: number
  records: DslogRecord[]
}

/** Seconds from the LabVIEW epoch (1904-01-01) to the Unix epoch (1970-01-01). */
const LABVIEW_TO_UNIX = 2082844800
const RECORD_PERIOD_S = 0.02
const FIXED_BYTES = 10
const PD_HEADER_BYTES = 4
/** Extra bytes after the PD header, by PD type (AdvantageScope DSLogReader.ts). */
const PD_DATA_BYTES: Record<number, number> = { 33: 33, 25: 25 }

export function readDslog(bytes: Uint8Array): DslogFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 20) throw new Error('File too short to be a .dslog')
  const version = view.getInt32(0, false)
  if (version !== 4) throw new Error(`Unsupported .dslog version ${version} (only version 4 is supported)`)
  const seconds = Number(view.getBigInt64(4, false))
  const fraction = Number(view.getBigUint64(12, false)) / 2 ** 64
  const startEpochSeconds = seconds - LABVIEW_TO_UNIX + fraction

  const records: DslogRecord[] = []
  let pos = 20
  while (pos + FIXED_BYTES + PD_HEADER_BYTES <= bytes.length) {
    const pdType = bytes[pos + FIXED_BYTES + 3]
    const recordBytes = FIXED_BYTES + PD_HEADER_BYTES + (PD_DATA_BYTES[pdType] ?? 0)
    if (pos + recordBytes > bytes.length) break
    const rawVoltage = view.getUint16(pos + 2, false)
    const status = bytes[pos + 5]
    const bit = (b: number) => (status & (1 << b)) === 0 // active low
    records.push({
      epochSeconds: startEpochSeconds + records.length * RECORD_PERIOD_S,
      tripTimeMs: bytes[pos] * 0.5,
      lostPacketsPct: Math.max(0, view.getInt8(pos + 1) * 4),
      voltage: rawVoltage === 0xffff ? null : rawVoltage / 256,
      cpuPct: bytes[pos + 4] * 0.5,
      canPct: bytes[pos + 6] * 0.5,
      wifiDb: bytes[pos + 7] * 0.5,
      bandwidthMbps: view.getUint16(pos + 8, false) / 256,
      brownout: bit(7),
      watchdog: bit(6),
      dsTeleop: bit(5),
      dsAuto: bit(4),
      dsDisabled: bit(3),
      robotTeleop: bit(2),
      robotAuto: bit(1),
      robotDisabled: bit(0),
    })
    pos += recordBytes
  }
  return { version, startEpochSeconds, records }
}

/** Time of the last record, seconds since the Unix epoch. */
export function dslogEndEpoch(log: DslogFile): number {
  return log.startEpochSeconds + Math.max(0, log.records.length - 1) * RECORD_PERIOD_S
}
