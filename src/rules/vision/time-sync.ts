/**
 * Are the camera clocks synced to the roboRIO?
 *
 * Checks: alerts saying a coprocessor isn't time-synced ("not connected to the TimeSyncServer") or that vision data
 * has a timestamp in the future, anywhere in the log.
 * Why: CalGames 2026: every boot reported "not connected to the TimeSyncServer", and "Vision Data Coming from The
 * Future" fired 1–3 times per match. Unsynced timestamps put vision poses at the wrong moment.
 */
import { rule } from '../rule.ts'

/** Alert texts this rule owns; alerts/passthrough leaves them to this rule so they aren't listed twice. */
export const TIME_SYNC_ALERTS = [/TimeSyncServer/i, /Coming from .*Future/i]

export default rule({
  id: 'vision/time-sync',
  title: 'Camera clocks not synced',
  severity: 'warning',
  who: ['software'],
  fix: 'Match PhotonVision versions between coprocessors and robot code; confirm time sync connects after boot (PhotonVision dashboard).',
  incident: 'CalGames 2026: TimeSyncServer warnings at every boot; "Vision Data Coming from The Future" 1–3× per match (Q13 analysis)',

  check(match) {
    const syncAlerts = match.alerts().filter((a) => TIME_SYNC_ALERTS.some((pattern) => pattern.test(a.text)))
    if (syncAlerts.length === 0) return
    const times = (a: (typeof syncAlerts)[0]) => a.onsetsInMatch.length + a.onsetsOutsideMatch
    return {
      message: `Camera time-sync problems: ${syncAlerts.reduce((n, a) => n + times(a), 0)} alerts`,
      measured: [{ label: 'time-sync alerts', value: syncAlerts.reduce((n, a) => n + times(a), 0), unit: '' }],
      evidence: Object.fromEntries(syncAlerts.map((a) => [a.text, `${times(a)}× (${a.onsetsInMatch.length} during the match)`])),
    }
  },
})
