/**
 * build/dirty — did the robot run code that isn't committed?
 *
 * Checks: /RealMetadata/GitDirty says "Uncommitted changes".
 * Why: CalGames 2026 P0 ran uncommitted code, so nobody can say exactly what was on the robot.
 * When it fires: commit (and push) what was deployed, and deploy only from a clean tree at events.
 */
import { values, type Match } from '../../match/match.ts'
import type { Finding, Rule } from '../types.ts'

export const dirty: Rule = {
  id: 'build/dirty',
  title: 'Uncommitted code on the robot',
  fix: 'Commit and push what was deployed, then redeploy from the commit. At events, deploy only from a clean tree.',
  incident: 'CalGames 2026 P0: GitDirty = "Uncommitted changes" (hindsight-proposal.md, conclusion 4)',
  needs: (m: Match) => [m.profile.signals.gitDirty],
  run(m: Match): Finding[] {
    const dirtyValues = values<string>(m, m.profile.signals.gitDirty)!.v
    if (!dirtyValues.some((v) => /uncommitted/i.test(v))) return []
    return [{
      rule: this.id,
      severity: 'warning',
      title: `Robot ran uncommitted changes on top of ${m.build.sha.slice(0, 7) || 'an unknown commit'}`,
      time: null,
      evidence: { GitDirty: dirtyValues.at(-1) ?? '', 'git sha': m.build.sha, branch: m.build.branch, 'built': m.build.date },
    }]
  },
}
