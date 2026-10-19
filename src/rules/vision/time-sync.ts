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
  meaning: 'A vision coprocessor\'s clock is not synced with the roboRIO\'s, so vision poses can be stamped at the wrong moment and pull the robot\'s position estimate off.',
  causes: [
    { id: 'version', cause: 'PhotonVision on the coprocessor and PhotonLib in the robot code are different versions', look: 'the version in the PhotonVision dashboard against the PhotonLib version in the robot code\'s build file' },
    { id: 'server', cause: 'The time sync server is not running on the roboRIO, or the coprocessor cannot reach it', look: 'the PhotonVision dashboard: does the time sync status show connected? The network between the coprocessor and the roboRIO' },
    { id: 'boot-timing', cause: 'The coprocessor booted after the roboRIO, so the clocks had not synced yet', look: 'do the alerts only appear soon after boot and clear on their own? Alert times against the start of the log' },
  ],
  nextStep: 'Match PhotonVision versions between coprocessors and robot code, and confirm time sync connects after boot (PhotonVision dashboard).',
  incident: 'CalGames 2026: TimeSyncServer warnings at every boot; "Vision Data Coming from The Future" 1–3× per match (Q13 analysis)',

  check(match) {
    const syncAlerts = match.alerts().filter((a) => TIME_SYNC_ALERTS.some((pattern) => pattern.test(a.text)))
    if (syncAlerts.length === 0) return
    const times = (a: (typeof syncAlerts)[0]) => a.onsetsInMatch.length + a.onsetsOutsideMatch
    // Alerts only before the match are the usual "not synced yet at boot"; any during the match means it stayed broken.
    const inMatch = syncAlerts.reduce((n, a) => n + a.onsetsInMatch.length, 0)
    return {
      likely: inMatch === 0 ? ['boot-timing'] : ['version', 'server'],
      ruledOut: inMatch === 0 ? undefined : { 'boot-timing': 'the alerts came during the match, not just at boot' },
      message: `Camera time-sync problems: ${syncAlerts.reduce((n, a) => n + times(a), 0)} alerts`,
      measured: [{ label: 'time-sync alerts', value: syncAlerts.reduce((n, a) => n + times(a), 0), unit: '' }],
      evidence: Object.fromEntries(syncAlerts.map((a) => [a.text, `${times(a)}× (${a.onsetsInMatch.length} during the match)`])),
    }
  },
})
