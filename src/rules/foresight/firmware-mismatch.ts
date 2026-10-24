/**
 * Do all CTRE devices of one model run the same firmware?
 *
 * Checks (Foresight, the live pit check, only): the firmware version of every device the robot code watches with the
 * Hindsight companion (HindsightDevices.watch, /Hindsight/Devices/<bus>/<model>/<id>/Version), right now, model by
 * model. Fires when one model has more than one version. Devices not answering, or not read, are left out.
 * Why: a device swapped in from the spares shelf keeps the firmware it shipped with, and Phoenix 6 behaves
 * differently across firmware years. The companion raises the same alert on the robot ("Firmware mismatch").
 * Amber only: no log of ours has this reading yet, so it has never fired for real (proven.ts).
 */
import { plural, rule } from '../rule.ts'
import { CTRE_DEVICE_LIST } from '../sources.ts'
import type { MatchView, WatchedDeviceView } from '../view.ts'
import { hex32, versionText } from '../../match/companion.ts'

export default rule({
  id: 'foresight/firmware-mismatch',
  title: 'Firmware differs within a model',
  severity: 'warning',
  judges: 'performance',
  foresightOnly: true,
  who: ['software', 'pit'],
  meaning: 'Devices of the same model run different firmware. One was probably swapped in and never updated, and it may not behave like the others.',
  causes: [
    { id: 'swapped', cause: 'A replacement device kept the firmware it came with', look: 'Phoenix Tuner X: the device with the odd version; was it replaced recently?' },
    { id: 'partial-update', cause: 'An update was run on some devices and not the others (one was off the bus then)', look: 'Phoenix Tuner X: update every device of that model to the same firmware' },
  ],
  nextStep: 'Update the odd devices to the firmware the others run, in Phoenix Tuner X (Batch Field Upgrade), then restart the robot code.',
  incident: 'Hindsight companion library (2026-10-20): it reads each device\'s firmware; the companion\'s own "Firmware mismatch" alert',
  sources: [
    { ...CTRE_DEVICE_LIST, says: 'Tuner X colours each device card by firmware: green is the latest, yellow a newer version available, purple an unexpected or beta version.' },
  ],

  check(match) {
    const byModel = versionsByModel(match)
    if (byModel.size === 0) return match.couldNotCheck('no watched device is answering with a firmware version')
    const mixed = [...byModel].filter(([, versions]) => versions.size > 1)
    if (mixed.length === 0) return
    const evidence: Record<string, string> = {}
    for (const [model, versions] of mixed) {
      for (const [version, names] of versions) evidence[`${model} ${version}`] = names.join(', ')
    }
    return {
      message: `Firmware differs within ${mixed.map(([model, versions]) => `${model} (${plural(versions.size, 'version')})`).join(' and ')}`,
      at: match.pitStretch.end,
      about: 'firmware',
      evidence,
    }
  },
})

/** For each model, the devices answering now by firmware version ("26.1.0.2" → names). */
function versionsByModel(match: MatchView): Map<string, Map<string, string[]>> {
  const now = match.pitStretch.end
  const byModel = new Map<string, Map<string, string[]>>()
  for (const device of match.watchedDevices().filter((d) => answering(d, now))) {
    // Shown with the raw value: the byte order is the companion's reading of Phoenix's docs, not checked on a device.
    const packed = device.version().at(now)
    const version = `${versionText(packed)} (${hex32(packed)})`
    const versions = byModel.get(device.model) ?? new Map<string, string[]>()
    versions.set(version, [...(versions.get(version) ?? []), device.name])
    byModel.set(device.model, versions)
  }
  return byModel
}

/** Answering now with a version read (0 is the companion's "not read"). */
function answering(device: WatchedDeviceView, now: number): boolean {
  return device.connected().at(now) >= 0.5 && device.version().at(now) > 0
}
