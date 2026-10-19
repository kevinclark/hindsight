/**
 * vision/time-sync — are the camera clocks synced to the roboRIO?
 *
 * Checks: alert texts that say the coprocessor isn't time-synced ("not connected to the TimeSyncServer") or that
 * vision data has a timestamp in the future, anywhere in the log.
 * Why: CalGames 2026: every boot reported "not connected to the TimeSyncServer", and "Vision Data Coming from The
 * Future" fired 1–3 times per match. Unsynced timestamps put vision poses at the wrong moment in the pose estimator.
 * When it fires: check the coprocessors' PhotonVision version matches the robot's, and that they reach the roboRIO's
 * time server after boot.
 */
import { values, type Match } from '../../match/match.ts'
import { minOf } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

/** Alert texts this rule owns; alerts/passthrough leaves them to this rule so they aren't listed twice. */
export const TIME_SYNC_PATTERNS = [/TimeSyncServer/i, /Coming from .*Future/i]

export const visionTimeSync: Rule = {
  id: 'vision/time-sync',
  title: 'Camera clocks not synced',
  audience: ['software'],
  fix: 'Match PhotonVision versions between coprocessors and robot code; confirm time sync connects after boot (PhotonVision dashboard).',
  incident: 'CalGames 2026: TimeSyncServer warnings at every boot; "Vision Data Coming from The Future" 1–3× per match (Q13 analysis)',
  needs: (m: Match) => m.profile.signals.alertGroups.map((g) => `${g}/warnings`),
  run(m: Match): Finding[] {
    const counts = new Map<string, { n: number; first: number }>()
    for (const group of m.profile.signals.alertGroups) {
      for (const kind of ['errors', 'warnings', 'infos']) {
        const a = values<string[]>(m, `${group}/${kind}`)
        if (!a) continue
        for (let i = 0; i < a.t.length; i++) {
          const previous = new Set(i > 0 ? a.v[i - 1] : [])
          for (const text of a.v[i]) {
            if (previous.has(text) || !TIME_SYNC_PATTERNS.some((p) => p.test(text))) continue
            const key = text.replace(/It's been .*$/, '').trim()
            const c = counts.get(key) ?? { n: 0, first: a.t[i] }
            c.n++
            counts.set(key, c)
          }
        }
      }
    }
    if (counts.size === 0) return []
    const first = minOf([...counts.values()].map((c) => c.first))
    return [{
      rule: this.id,
      severity: 'warning',
      title: `Camera time-sync problems: ${[...counts.values()].reduce((s, c) => s + c.n, 0)} alerts`,
      time: first,
      evidence: Object.fromEntries([...counts.entries()].map(([text, c]) => [text, `${c.n}× (first at ${c.first.toFixed(1)} s)`])),
    }]
  },
}
