/**
 * Did the robot run code that isn't committed?
 *
 * Checks: /RealMetadata/GitDirty says "Uncommitted changes" (older AdvantageKit spells it "Uncomitted changes").
 * Why: One 2026 match ran uncommitted code, so nobody can say exactly what was on the robot.
 */
import { isUncommitted } from '../../match/git-dirty.ts'
import { rule } from '../rule.ts'

export default rule({
  id: 'build/dirty',
  title: 'Uncommitted code on the robot',
  severity: 'warning',
  who: ['software'],
  meaning: 'The code on the robot had changes that were never saved to git, so nobody can say exactly what was running.',
  causes: [
    { id: 'quick-fix', cause: 'Code was deployed with edits that were not committed (a quick fix between matches)', look: 'run git status in the robot code folder on the laptop that deployed; the log key /RealMetadata/GitDirty' },
    { id: 'stray-files', cause: 'Files that should be ignored (build output, local settings) are showing up as changes', look: 'git status: which files are listed? Add generated ones to .gitignore' },
  ],
  nextStep: 'Commit and push what was deployed, then redeploy from the commit. At events, deploy only from a clean tree.',
  incident: 'One 2026 match: GitDirty = "Uncommitted changes" (hindsight-proposal.md, conclusion 4)',

  check(match) {
    const dirty = match.text('gitDirty').last()
    if (!isUncommitted(dirty)) return
    return {
      message: `Robot ran uncommitted changes on top of ${match.build.sha.slice(0, 7) || 'an unknown commit'}`,
      evidence: { GitDirty: dirty, 'git sha': match.build.sha, branch: match.build.branch, built: match.build.date },
    }
  },
})
