/**
 * What the Driver Station's own files say about every robot, whatever its robot log: the facts from its event log
 * (.dsevents, readers/dsevents.ts). Each log type's signal map spreads this, so a rule asks for them by name.
 * Read from team 334's three public 2026 event logs only.
 */
import type { DseventsFact } from '../match/other-logs.ts'
import { DSEVENTS } from './sources.ts'
import type { SignalKeys } from './types.ts'

export const DRIVER_STATION_SIGNALS = {
  dsBrownoutCount: `${DSEVENTS}brownoutCount`,
  canivoreUsbDisconnects: `${DSEVENTS}canivoreUsbDisconnects`,
  canivoreTxFails: `${DSEVENTS}canivoreTxFails`,
  usbPortDisabled: `${DSEVENTS}usbPortDisabled`,
} satisfies Partial<Record<keyof SignalKeys, `${typeof DSEVENTS}${DseventsFact}`>>
