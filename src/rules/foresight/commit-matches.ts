/**
 * Is the robot running the same code as at the last pit check that passed?
 *
 * Checks (Foresight, the live pit check, only): the robot's GitSHA against the code of the last GO pit check on
 * record (hindsight-history.jsonl, kept in this browser and saved with the known issues).
 * Why: code changed between matches is the change nobody re-checked; the pit check that passed was for other code.
 */
import { rule } from '../rule.ts'
import { WPILIB_DEPLOY_GIT } from '../sources.ts'

export default rule({
  id: 'foresight/commit-matches',
  title: 'Code changed since the last passing pit check',
  severity: 'warning',
  foresightOnly: true,
  who: ['software'],
  meaning: 'The robot is running different code from the last pit check that passed. That can be on purpose (a fix between matches), but it is the change nothing has checked yet.',
  causes: [
    { id: 'deployed', cause: 'Someone deployed new code since the last check', look: 'git log between the two commits on the laptop that deployed' },
    { id: 'other-laptop', cause: 'Code was deployed from another laptop or branch', look: 'the branch in the readings above, and who deployed last' },
  ],
  nextStep: 'Confirm the change was meant (git log between the two commits); if not, redeploy the commit that passed.',
  incident: 'Foresight phase 1 brief: "GitSHA the same as the last passing pit check"',
  sources: [
    { ...WPILIB_DEPLOY_GIT, says: 'GradleRIO can write the commit hash and a DIRTY flag into BuildConstants so robot code can log which revision is on the robot.' },
  ],

  check(match) {
    const sha = match.text('gitSha').last()
    if (!sha) return match.couldNotCheck('the robot did not report its GitSHA')
    const last = match.lastPassingSha
    if (!last) return match.couldNotCheck('no earlier passing pit check on record (save and reload hindsight-history.jsonl to keep them)')
    if (sha === last) return
    return {
      message: `Code changed since the last passing pit check: ${last.slice(0, 7)} → ${sha.slice(0, 7)}`,
      evidence: { 'last passing pit check': last, 'running now': sha, branch: match.build.branch },
    }
  },
})
