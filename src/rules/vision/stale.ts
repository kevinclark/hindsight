/**
 * Is each camera delivering fresh results, and did any drop out during the match?
 *
 * Checks: the share of the match each camera's Stale flag was on (fires above 15 %), and the camera's Connected
 * flag going false during the match.
 * Why: CalGames 2026: Back_Right was stale 18–23 % of the match against 5–8 % for Back_Left, and in Q21 it dropped
 * out for 6 s while its network connection stayed up (the coprocessor pipeline stalled).
 * Threshold: assumed from three logs.
 * Foresight (the live pit check, robot disabled): drop-outs only. A disabled robot sees whatever tags happen to be in
 * view, so its stale share says nothing: Back_Right was stale 37–40 % of the disabled field stretch in all three
 * CalGames logs, a working camera facing no tags.
 */
import { lengthOf, type CameraView, type Episode, type MatchView } from '../view.ts'
import { isFalse, isTrue, pct, plural, rule, round, totalSeconds, type Answer, type Problem } from '../rule.ts'

export default rule({
  id: 'vision/stale',
  title: 'Camera stale or dropped out',
  severity: 'warning',
  who: ['software', 'pit'],
  meaning: 'A camera stopped giving fresh results for a good part of the match, or dropped out completely. While it does, the robot is flying on odometry alone.',
  causes: [
    { id: 'coprocessor', cause: 'The vision coprocessor is overloaded or too hot (the pipeline stalls)', look: 'the coprocessor\'s CPU and temperature in the PhotonVision dashboard; the pipeline resolution and exposure settings' },
    { id: 'connection', cause: 'The camera or coprocessor lost its connection (loose USB or Ethernet cable, power to the coprocessor)', look: 'the camera\'s USB cable and the coprocessor\'s Ethernet and power connectors; wiggle-test them' },
    { id: 'view', cause: 'The camera is blocked or sees nothing useful (no tags in view, glare)', look: 'the camera image in the PhotonVision dashboard from the robot\'s usual positions' },
  ],
  nextStep: 'Check the coprocessor (CPU, temperature), the camera pipeline settings, and the camera\'s cable and power.',
  incident: 'CalGames 2026: Back_Right stale ~3× as often as Back_Left; dropped 6 s in Q21 (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 4)',
  forEach: 'camera',

  check(camera, match): Answer {
    // Foresight (robot disabled): drop-outs only.
    if (match.wholeMatch.length === 0) return dropoutsBeforeEnable(camera, match)

    const staleSeconds = totalSeconds(camera.stale().episodes(isTrue, { during: match.wholeMatch }))
    const staleShare = staleSeconds / lengthOf(match.wholeMatch)
    const drops = camera.connected().episodes(isFalse, { during: match.wholeMatch })
    if (staleShare <= 0.15 && drops.length === 0) return

    // The Connected flag going false points at the link; stale results with the camera still connected point at the coprocessor.
    let message = `${camera.name} was stale ${pct(staleShare)} of the match`
    let likely: string[] | undefined
    const ruledOut: Record<string, string> = {}
    if (drops.length > 0) {
      // Stale while connected fits a busy coprocessor and a camera seeing no tags equally, so name no favourite.
      likely = ['connection', 'coprocessor']
      message = dropoutMessage(camera.name, drops, 'during the match', match)
    } else {
      ruledOut.connection = 'the camera never reported disconnected'
    }
    return {
      likely,
      ruledOut,
      message,
      at: drops[0]?.start,
      measured: [{ label: 'stale share of the match', value: round(100 * staleShare, 1), unit: '%', threshold: 15 }],
      evidence: {
        'stale share of the match (%)': round(100 * staleShare, 1),
        'dropouts during the match': drops.length,
        'seconds disconnected': round(totalSeconds(drops), 1),
      },
    }
  },
})

/** The camera's drop-outs while the robot was disabled (Foresight); nothing when it was never enabled or never dropped. */
function dropoutsBeforeEnable(camera: CameraView, match: MatchView): Problem | undefined {
  if (match.beforeEnable.length === 0) return // never enabled: no match to measure
  const drops = camera.connected().episodes(isFalse, { during: match.beforeEnable })
  if (drops.length === 0) return
  return {
    likely: ['connection', 'coprocessor'],
    message: dropoutMessage(camera.name, drops, match.windowWords, match),
    at: drops[0].start,
    measured: [{ label: 'dropouts before enable', value: drops.length, unit: '' }],
    evidence: { 'dropouts before enable': drops.length, 'seconds disconnected': round(totalSeconds(drops), 1) },
  }
}

/** "Back_Right dropped out 2 times during the match (first at 1:23 for 6.0 s)". */
function dropoutMessage(camera: string, drops: Episode[], when: string, match: MatchView): string {
  const first = drops[0]
  return `${camera} dropped out ${plural(drops.length, 'time')} ${when} (first at ${match.when(first.start)} for ${first.seconds.toFixed(1)} s)`
}
