// Fix patches (ADR 2): a code rule's fix as a git-format diff the student applies. Invented Java only.
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkCode, CODE_RULES } from '../src/code/check/index.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'
import limitSwitchedOff from '../src/code/check/rules/limit-switched-off.ts'
import { patchOf, patchFileName, changedLines, fixesClash } from '../src/code/check/fix-patch.ts'

beforeAll(loadJavaFromDisk)

const robot = (build: string) => `class Robot extends LoggedRobot { Robot() { ${build} } }`
const find = (java: Record<string, string>) => checkCode(Object.entries(java).map(([path, text]) => ({ path, text })), [limitSwitchedOff]).findings

/** A throwaway git repo holding these files; `git apply --check` / apply run in it, as a student would. */
function inRepo<T>(java: Record<string, string>, use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hindsight-fix-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const [path, text] of Object.entries(java)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text) }
    return use(dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const gitApply = (dir: string, patch: string, ...flags: string[]) => {
  writeFileSync(join(dir, '.fix.patch'), patch)
  return execFileSync('git', ['apply', ...flags, '.fix.patch'], { cwd: dir, encoding: 'utf8' })
}

const drum = {
  'src/main/java/Drum.java': `class Drum {
  TalonFX a; TalonFX b;
  Drum(int first, int second) {
    a = new TalonFX(first); b = new TalonFX(second);
    var config = new TalonFXConfiguration();
    config.CurrentLimits.SupplyCurrentLimit = 40.0;
    config.CurrentLimits.SupplyCurrentLimitEnable = false;
    config.CurrentLimits.StatorCurrentLimit = 80.0;
    config.CurrentLimits.StatorCurrentLimitEnable = true;
    a.getConfigurator().apply(config); b.getConfigurator().apply(config);
  }
}
`,
  'src/main/java/Robot.java': robot('new Drum(15, 16);'),
}

describe('code/limit-switched-off fix', () => {
  it('turns the flag the finding names on: one exact diff', () => {
    const [finding] = find(drum)
    expect(finding.fix?.patch).toBe(`diff --git a/src/main/java/Drum.java b/src/main/java/Drum.java
--- a/src/main/java/Drum.java
+++ b/src/main/java/Drum.java
@@ -4,7 +4,7 @@
     a = new TalonFX(first); b = new TalonFX(second);
     var config = new TalonFXConfiguration();
     config.CurrentLimits.SupplyCurrentLimit = 40.0;
-    config.CurrentLimits.SupplyCurrentLimitEnable = false;
+    config.CurrentLimits.SupplyCurrentLimitEnable = true;
     config.CurrentLimits.StatorCurrentLimit = 80.0;
     config.CurrentLimits.StatorCurrentLimitEnable = true;
     a.getConfigurator().apply(config); b.getConfigurator().apply(config);
`)
  })

  it('git apply --check passes on a copy of the project, and applying it ends the finding', () => {
    const [finding] = find(drum)
    inRepo(drum, (dir) => {
      gitApply(dir, finding.fix!.patch, '--check')
      gitApply(dir, finding.fix!.patch)
      const after = { ...drum, 'src/main/java/Drum.java': readFileSync(join(dir, 'src/main/java/Drum.java'), 'utf8') }
      expect(after['src/main/java/Drum.java']).toBe(drum['src/main/java/Drum.java'].replace('SupplyCurrentLimitEnable = false', 'SupplyCurrentLimitEnable = true'))
      expect(find(after)).toEqual([])
    })
  })

  it('every write of the flag in the configuration is turned on, in one patch', () => {
    const java = {
      'Roller.java': `class Roller {
  TalonFX m;
  Roller(int id) {
    m = new TalonFX(id);
    var c = new TalonFXConfiguration();
    c.CurrentLimits.SupplyCurrentLimit = 30.0;
    c.CurrentLimits.SupplyCurrentLimitEnable = false;
    c.CurrentLimits.SupplyCurrentLimitEnable = false;
    m.getConfigurator().apply(c);
  }
}
`,
      'Robot.java': robot('new Roller(5);'),
    }
    const [finding] = find(java)
    expect(finding.fix!.patch.match(/^\+.*= true;$/gm)).toHaveLength(2)
    expect(finding.fix!.patch.match(/^-.*= false;$/gm)).toHaveLength(2)
    expect(finding.fix!.patch.match(/^@@/gm)).toHaveLength(1)
    inRepo(java, (dir) => gitApply(dir, finding.fix!.patch, '--check'))
  })

  it('findings in different files give separate patches, each applying on its own and together', () => {
    const java = {
      'Elevator.java': `class Elevator {
  TalonFX m = new TalonFX(7);
  Elevator() { m.getConfigurator().apply(new TalonFXConfiguration().withCurrentLimits(new CurrentLimitsConfigs().withStatorCurrentLimit(60.0).withStatorCurrentLimitEnable(false))); }
}`, // no newline at the end of the file
      'Roller.java': `class Roller {
  TalonFX m;
  Roller(int id, boolean on) { m = new TalonFX(id); var c = new TalonFXConfiguration(); c.CurrentLimits.SupplyCurrentLimit = 30.0; c.CurrentLimits.SupplyCurrentLimitEnable = on; m.getConfigurator().apply(c); }
}
`,
      'Robot.java': 'class Robot extends LoggedRobot {\n  Robot() {\n    new Elevator();\n    new Roller(9, false);\n    new Roller(10, true);\n  }\n}\n',
    }
    const found = find(java)
    expect(found.map((f) => f.file)).toEqual(['Elevator.java', 'Robot.java'])
    expect(found[0].fix!.patch).toContain('withStatorCurrentLimitEnable(true)')
    expect(found[0].fix!.patch).toContain('\\ No newline at end of file')
    // The passed-in flag is changed where it is passed: the call, not the helper.
    expect(found[1].fix!.patch).toContain('+    new Roller(9, true);')
    expect(found[1].fix!.doesNotFix).toContain('passed in')
    inRepo(java, (dir) => {
      for (const f of found) gitApply(dir, f.fix!.patch, '--check')
      gitApply(dir, found.map((f) => f.fix!.patch).join(''))
      const after = Object.fromEntries(Object.keys(java).map((p) => [p, readFileSync(join(dir, p), 'utf8')]))
      expect(find(after)).toEqual([])
      expect(after['Elevator.java'].endsWith('withStatorCurrentLimitEnable(true))); }\n}')).toBe(true)
    })
  })

  it('offers no fix when the flag is a constant or any other expression, even if the finding stands', () => {
    const java = {
      'Arm.java': `class Arm {
  static final boolean LIMIT_ON = false;
  TalonFX a = new TalonFX(1);
  Arm() { var c = new TalonFXConfiguration(); c.CurrentLimits.SupplyCurrentLimit = 40.0; c.CurrentLimits.SupplyCurrentLimitEnable = LIMIT_ON; a.getConfigurator().apply(c); }
}`,
      'Wrist.java': `class Wrist {
  TalonFX a = new TalonFX(2);
  Wrist() { var c = new TalonFXConfiguration(); c.CurrentLimits.SupplyCurrentLimit = 40.0; c.CurrentLimits.SupplyCurrentLimitEnable = 1 > 2; a.getConfigurator().apply(c); }
}`,
      'Robot.java': robot('new Arm(); new Wrist();'),
    }
    const found = find(java)
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(f.fix).toBeUndefined()
  })

  it('offers no fix where the rule says nothing: flag on, never written, simulation', () => {
    const java = {
      'Arm.java': `class Arm {
  TalonFX a = new TalonFX(1);
  Arm() { var on = new TalonFXConfiguration(); on.CurrentLimits.SupplyCurrentLimit = 40.0; on.CurrentLimits.SupplyCurrentLimitEnable = true; a.getConfigurator().apply(on); }
}`,
      'Robot.java': robot('new Arm();'),
    }
    expect(find(java)).toEqual([])
  })

  it('says what it does not fix, always with a fix', () => {
    for (const f of find(drum)) {
      expect(f.fix?.doesNotFix).toContain("supply limit's value is right for the motor")
      expect(f.fix?.doesNotFix).toContain('turned off again later')
      expect(f.fix?.doesNotFix).toContain('shared constant')
      expect(f.fix?.doesNotFix).toContain('stator limit, which it does not touch')
    }
    // For a stator finding the limit left alone is the supply one.
    const stator = find({
      'E.java': 'class E { TalonFX m = new TalonFX(7); E() { var c = new TalonFXConfiguration(); c.CurrentLimits.StatorCurrentLimit = 60.0; c.CurrentLimits.StatorCurrentLimitEnable = false; m.getConfigurator().apply(c); } }',
      'Robot.java': robot('new E();'),
    })[0]
    expect(stator.fix?.doesNotFix).toContain('supply limit, which it does not touch')
  })

  it('reads positions right after text that is not ASCII, and keeps CRLF line ends', () => {
    const text = drum['src/main/java/Drum.java'].replace('class Drum {', 'class Drum { // résumé \u{1F527} — half-turn½').replaceAll('\n', '\r\n')
    const java = { ...drum, 'src/main/java/Drum.java': text }
    const [finding] = find(java)
    expect(finding.fix!.patch).toContain('+    config.CurrentLimits.SupplyCurrentLimitEnable = true;\r\n')
    inRepo(java, (dir) => {
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
      gitApply(dir, finding.fix!.patch, '--check')
      gitApply(dir, finding.fix!.patch)
      expect(readFileSync(join(dir, 'src/main/java/Drum.java'), 'utf8')).toBe(text.replace('SupplyCurrentLimitEnable = false', 'SupplyCurrentLimitEnable = true'))
    })
  })

  it('the command line output is unchanged: no fix in what it prints', () => {
    const [finding] = find(drum)
    expect(finding.fix).toBeDefined()
    // github-format and the CLI print named fields (file, line, rule, message, evidence); none reads `fix`.
    for (const file of ['src/code/check/github-format.ts', 'src/code/check/comment-text.ts', 'scripts/code-check.ts']) expect(readFileSync(file, 'utf8')).not.toMatch(/\.fix\b|\bfix\b\s*[:,}]/)
  })

  it('only limit-switched-off offers a fix so far', () => {
    const report = checkCode(Object.entries(drum).map(([path, text]) => ({ path, text })), CODE_RULES)
    expect(report.findings.filter((f) => f.fix).map((f) => f.rule)).toEqual(['code/limit-switched-off'])
  })
})

describe('fix pass', () => {
  it('doesNotFix is one point to a line', () => {
    const [finding] = find(drum)
    expect(finding.fix!.doesNotFix.split('\n')).toHaveLength(3)
  })
  it('changedLines names the old-file lines a patch removes, so two fixes on one line are seen', () => {
    const java = {
      'Roller.java': `class Roller {
  TalonFX m;
  Roller(int id, double amps, double stator) {
    m = new TalonFX(id);
    var c = new TalonFXConfiguration();
    c.CurrentLimits.SupplyCurrentLimit = amps;
    c.CurrentLimits.SupplyCurrentLimitEnable = false;
    c.CurrentLimits.StatorCurrentLimit = stator;
    c.CurrentLimits.StatorCurrentLimitEnable = true;
    m.getConfigurator().apply(c);
  }
}
`,
      'Robot.java': robot('new Roller(9, 30.0, 80.0); new Roller(10, 60.0, 20.0);'),
    }
    const found = find(java)
    expect(found).toHaveLength(2)
    expect(changedLines(found[0].fix!.patch)).toEqual(['Roller.java:7'])
    expect(changedLines(found[1].fix!.patch)).toEqual(['Roller.java:7'])
    expect(changedLines(find(drum)[0].fix!.patch)).toEqual(['src/main/java/Drum.java:7'])
  })
  it('fixes on neighbouring lines clash (git rejects the second through the shared context), far ones do not', () => {
    const java = {
      'Roller.java': `class Roller {
  TalonFX m;
  Roller(int id) {
    m = new TalonFX(id);
    var c = new TalonFXConfiguration();
    c.CurrentLimits.SupplyCurrentLimit = 40;
    c.CurrentLimits.SupplyCurrentLimitEnable = false;
    c.CurrentLimits.StatorCurrentLimit = 80;
    c.CurrentLimits.StatorCurrentLimitEnable = false;
    m.getConfigurator().apply(c);
  }
}
`,
      'Robot.java': robot('new Roller(9);'),
    }
    const found = find(java)
    expect(found).toHaveLength(2)
    expect(changedLines(found[0].fix!.patch)).not.toEqual(changedLines(found[1].fix!.patch))
    expect(fixesClash(found[0].fix!.patch, found[1].fix!.patch)).toBe(true)
    inRepo({ 'Roller.java': java['Roller.java'] }, (dir) => {
      gitApply(dir, found[0].fix!.patch)
      expect(() => gitApply(dir, found[1].fix!.patch, '--check')).toThrow()
    })
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const at = (n: number) => ({ file: 'A.java', start: text.indexOf(`line ${n}\n`), end: text.indexOf(`line ${n}\n`) + `line ${n}`.length, replacement: 'X' })
    expect(fixesClash(patchOf([at(5)], new Map([['A.java', text]])), patchOf([at(30)], new Map([['A.java', text]])))).toBe(false)
  })
})

describe('patchOf', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  const edit = (text: string, at: string, replacement: string, file = 'A.java') => ({ file, start: text.indexOf(at), end: text.indexOf(at) + at.length, replacement })

  it('edits far apart are separate hunks with the right counts; near ones share one', () => {
    const text = lines(40).join('\n') + '\n'
    const far = patchOf([edit(text, 'line 5\n', 'FIVE\n'), edit(text, 'line 30\n', 'THIRTY\n')], new Map([['A.java', text]]))
    expect(far.match(/^@@.*@@$/gm)).toEqual(['@@ -2,7 +2,7 @@', '@@ -27,7 +27,7 @@'])
    const near = patchOf([edit(text, 'line 5\n', 'FIVE\n'), edit(text, 'line 9\n', 'NINE\n')], new Map([['A.java', text]]))
    expect(near.match(/^@@.*@@$/gm)).toEqual(['@@ -2,11 +2,11 @@'])
    inRepo({ 'A.java': text }, (dir) => { gitApply(dir, far, '--check'); gitApply(dir, near, '--check') })
  })

  it('a replacement that changes the number of lines moves the later hunks', () => {
    const text = lines(40).join('\n') + '\n'
    const patch = patchOf([edit(text, 'line 5\n', 'five a\nfive b\nfive c\n'), edit(text, 'line 30\n', 'THIRTY\n')], new Map([['A.java', text]]))
    expect(patch.match(/^@@.*@@$/gm)).toEqual(['@@ -2,7 +2,9 @@', '@@ -27,7 +29,7 @@'])
    inRepo({ 'A.java': text }, (dir) => {
      gitApply(dir, patch)
      expect(readFileSync(join(dir, 'A.java'), 'utf8')).toBe(text.replace('line 5\n', 'five a\nfive b\nfive c\n').replace('line 30\n', 'THIRTY\n'))
    })
  })

  it('edits at the first and last line of a file', () => {
    const text = lines(4).join('\n')
    const patch = patchOf([edit(text, 'line 1', 'ONE'), edit(text, 'line 4', 'FOUR')], new Map([['A.java', text]]))
    inRepo({ 'A.java': text }, (dir) => { gitApply(dir, patch); expect(readFileSync(join(dir, 'A.java'), 'utf8')).toBe('ONE\nline 2\nline 3\nFOUR') })
  })

  it('files in path order, no change gives an empty patch, overlapping edits throw', () => {
    const a = 'x = false;\n'
    const patch = patchOf([edit(a, 'false', 'true', 'B.java'), edit(a, 'false', 'true', 'A.java')], new Map([['A.java', a], ['B.java', a]]))
    expect(patch.match(/^diff --git a\/(\S+)/gm)).toEqual(['diff --git a/A.java', 'diff --git a/B.java'])
    expect(patchOf([edit(a, 'false', 'false')], new Map([['A.java', a]]))).toBe('')
    expect(() => patchOf([{ file: 'A.java', start: 0, end: 5, replacement: 'q' }, { file: 'A.java', start: 3, end: 6, replacement: 'q' }], new Map([['A.java', a]]))).toThrow(/overlap/)
  })

  it('names the file from the rule', () => {
    expect(patchFileName('code/limit-switched-off')).toBe('fix-code-limit-switched-off.patch')
  })
})
