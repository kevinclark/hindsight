// The code checks (src/code/check/) on small made-up Java: each must fire on its bug and stay quiet on the fix.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { checkCode } from '../src/code/check/index.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'
import integerDivision from '../src/code/check/rules/integer-division.ts'
import neverSet from '../src/code/check/rules/never-set.ts'
import optionalEquals from '../src/code/check/rules/optional-equals.ts'
import discardedResult from '../src/code/check/rules/discarded-result.ts'
import impossibleRange from '../src/code/check/rules/impossible-range.ts'
import duplicateCanId from '../src/code/check/rules/duplicate-can-id.ts'
import neverEndingStep from '../src/code/check/rules/never-ending-step.ts'
import staleSignal from '../src/code/check/rules/stale-signal.ts'
import unusedConfig from '../src/code/check/rules/unused-config.ts'
import { codeRule, type CodeRule } from '../src/code/check/rule.ts'
import { Project } from '../src/code/check/project.ts'
import { isSubsystem } from '../src/code/check/types.ts'
import { deviceSettings } from '../src/code/check/device-settings.ts'

beforeAll(loadJavaFromDisk)

/** One rule on made-up files: one file, or several as { 'A.java': '…' }. */
const run = (rule: CodeRule, java: string | Record<string, string>) =>
  checkCode(Object.entries(typeof java === 'string' ? { 'Made.java': java } : java).map(([path, text]) => ({ path, text })), [rule])
const messages = (rule: CodeRule, java: string | Record<string, string>) => run(rule, java).findings.map((f) => f.message)
const notJudged = (rule: CodeRule, java: string) => run(rule, java).notJudged.map((n) => n.why)

describe('code/integer-division', () => {
  it('fires on a whole-number division into a double, with the numbers', () => {
    expect(messages(integerDivision, 'class A { static final double GEAR_RATIO = 50 / 12; }')).toEqual(['50 / 12 is 4 in Java, not 4.1667 (-4.0 %)'])
  })
  it('reports the whole calculation once, through constants and parentheses', () => {
    const java = 'class A { static final int TEETH = 34; static final double R = 27 * (TEETH / 28); static final double S = (12 / 42) * (16 / 32); }'
    expect(messages(integerDivision, java)).toEqual(['27 * (TEETH / 28) is 27 in Java, not 32.7857 (-17.6 %)', '(12 / 42) * (16 / 32) is 0 in Java, not 0.1429 (-100.0 %)'])
  })
  it('fires on a return in a double method, a cast, a Phoenix field and arithmetic with a decimal', () => {
    const java = `class A {
      double ratio() { return 287 / 11; }
      void f() { double a = (double) (1 / 2048); c.MotionMagic.MotionMagicCruiseVelocity = (7368 / 60) / ratio(); g((7368 / 60) / 0.5); }
    }`
    expect(messages(integerDivision, java)).toEqual([
      '287 / 11 is 26 in Java, not 26.0909 (-0.3 %)',
      '1 / 2048 is 0 in Java, not 0.0005 (-100.0 %)',
      '7368 / 60 is 122 in Java, not 122.8 (-0.7 %)',
      '(7368 / 60) / 0.5 is 244 in Java, not 245.6 (-0.7 %)',
    ])
  })
  it('stays quiet on the fix, exact divisions, decimal constants and whole-number destinations', () => {
    const java = `class A {
      static final double TICKS = 2048;
      static final double A = 50.0 / 12, B = 8 / 2, C = TICKS / 600;
      int half = 7 / 2;
      int ratio() { return 287 / 11; }
    }`
    expect(messages(integerDivision, java)).toEqual([])
  })
  it('lists a division it cannot work out as not judged, never as a finding', () => {
    const java = 'class A { double f(int n) { return n / 2; } double g() { return time() / 1e6; } }'
    expect(messages(integerDivision, java)).toEqual([])
    expect(notJudged(integerDivision, java)).toEqual(["a value in n / 2 it can't work out"])
  })
})

describe('code/never-set', () => {
  it('fires on a private flag never set, read in a lambda', () => {
    const java = 'class R { private boolean hoodZeroed = false; void init() { t.and(() -> !hoodZeroed).onTrue(zero()); } }'
    expect(messages(neverSet, java)).toEqual(['hoodZeroed starts as false and nothing changes it, but !hoodZeroed on line 1 reads it'])
  })
  it('fires on a local never updated in the loop that compares it', () => {
    const java = `class F { Pose2d closest(Pose2d p) {
      double minDistance = Double.MAX_VALUE; Pose2d best = null;
      for (Pose2d t : POSES) { if (t.minus(p).getNorm() < minDistance) { best = t; } }
      return best; } }`
    expect(messages(neverSet, java)).toEqual(['minDistance starts as Double.MAX_VALUE and nothing changes it, but t.minus(p).getNorm() < minDistance on line 3 reads it'])
  })
  it('stays quiet once it is set, and on locals, finals, annotated, public and UPPER_SNAKE fields', () => {
    const java = `class F {
      private boolean zeroed = false; void done() { this.zeroed = true; } boolean ok() { return !zeroed; }
      private final boolean a = false; @Tunable private boolean b = false; public boolean c = false; private boolean DEBUG = false;
      void f() { if (a || b || c || DEBUG) {} }
      Pose2d closest(Pose2d p) { double min = Double.MAX_VALUE; for (Pose2d t : POSES) { double d = t.getNorm(); if (d < min) { min = d; } } return null; }
      void g() { boolean ready = check(); if (ready) {} }
      int count(List<Pose2d> all) { int n = all.size(); int k = 0; for (int i = 0; i < n; i++) { k++; } return k; }
    }`
    expect(messages(neverSet, java)).toEqual([])
  })
  it('keeps to its own class: a same-named field in another class neither fires nor silences it', () => {
    const java = 'class A { private boolean ready = false; boolean ok() { return !ready; } } class B { private boolean ready = false; void set() { ready = true; } boolean ok() { return !ready; } }'
    expect(messages(neverSet, java)).toEqual(['ready starts as false and nothing changes it, but !ready on line 1 reads it'])
  })
})

describe('code/optional-equals', () => {
  it('fires on getAlliance() equals an Alliance, either way round', () => {
    const java = 'class R { void f() { a = DriverStation.getAlliance().equals(Alliance.Blue); b = Alliance.Red.equals(DriverStation.getAlliance()); } }'
    expect(messages(optionalEquals, java)).toEqual([
      "DriverStation.getAlliance().equals(Alliance.Blue) is always false: DriverStation.getAlliance() is an Optional and Alliance.Blue isn't",
      "Alliance.Red.equals(DriverStation.getAlliance()) is always false: DriverStation.getAlliance() is an Optional and Alliance.Red isn't",
    ])
  })
  it('stays quiet on the fix and on two Optionals', () => {
    const java = 'class R { void f() { a = DriverStation.getAlliance().orElse(Alliance.Blue).equals(Alliance.Blue); b = !DriverStation.getAlliance().equals(lastAlliance); } }'
    expect(messages(optionalEquals, java)).toEqual([])
  })
})

describe('code/discarded-result', () => {
  it('fires on an unchanging WPILib value whose new value is dropped, and on a Command never run', () => {
    const java = `class Camera extends SubsystemBase {
      Matrix<N3, N1> scale(Matrix<N3, N1> deviations) { deviations.times(2.0); return deviations; }
      Command forceState(int s) { return runOnce(() -> {}); }
      void bind() { Commands.run(() -> { this.forceState(1); }); runOnce(() -> {}).withTimeout(1); }
    }`
    expect(messages(discardedResult, java)).toEqual([
      'deviations.times(…) makes a new Matrix and nothing uses it: deviations is unchanged',
      'Commands.run(() -> { this.forceState(1); }) builds a Command that is never run',
      'this.forceState(1) builds a Command that is never run',
      'runOnce(() -> {}).withTimeout(1) builds a Command that is never run',
    ])
  })
  it('stays quiet when the answer is used, on a type it can\'t see, and on a class\'s own void method', () => {
    const java = `class I extends SubsystemBase {
      private void run() {} void f(Matrix<N3, N1> d, Object o) { d = d.times(2.0); o.times(2); this.run(); CommandScheduler.getInstance().run(); }
    }`
    expect(messages(discardedResult, java)).toEqual([])
  })
})

describe('code/impossible-range', () => {
  it('fires on a range with no values, through constants and either way round', () => {
    const java = 'class R { boolean f(double r) { return r >= Math.PI / 2 && r < -(Math.PI / 2); } boolean g(double x) { return 12.7 < x && x < 11.2; } }'
    expect(messages(impossibleRange, java)).toEqual([
      'r >= Math.PI / 2 && r < -(Math.PI / 2) is never true: nothing is >= 1.571 and < -1.571',
      '12.7 < x && x < 11.2 is never true: nothing is > 12.7 and < 11.2',
    ])
  })
  it('stays quiet on a real range, a single point, and two different values', () => {
    const java = 'class R { void f(double x, double y) { a = x >= 1 && x < 2; b = x >= 1 && x <= 1; c = x > 2 && y < 1; } }'
    expect(messages(impossibleRange, java)).toEqual([])
  })
})

describe('code/duplicate-can-id', () => {
  const follower = 'class FollowerIO { TalonFX m; FollowerIO(int id, CANBus bus) { m = new TalonFX(id, bus); } }'
  it('fires at each device given one ID on one bus, through a constructor and a field set once', () => {
    const robot = 'class Robot extends TimedRobot {\n private CANBus bus = new CANBus("*");\n FollowerIO a = new FollowerIO(0, bus);\n FollowerIO b = new FollowerIO(0, bus); }'
    expect(messages(duplicateCanId, { 'FollowerIO.java': follower, 'Robot.java': robot })).toEqual([
      'TalonFX 0 on the CANivore ("*") is also built at Robot.java:4',
      'TalonFX 0 on the CANivore ("*") is also built at Robot.java:3',
    ])
  })
  it('stays quiet on sim and real arms, two kinds of device, two buses, and different IDs', () => {
    const robot = `class Robot extends TimedRobot {
      FollowerIO a = isReal() ? new FollowerIO(1, CANIVORE) : null;
      FollowerIO b = isReal() ? null : new FollowerIO(1, CANIVORE);
      CANcoder c = new CANcoder(1, "canivore"); TalonFX d = new TalonFX(2); TalonFX e = new TalonFX(2, "canivore"); TalonFX f = new TalonFX(3);
      static final CANBus CANIVORE = new CANBus("canivore");
    }`
    expect(messages(duplicateCanId, { 'FollowerIO.java': follower, 'Robot.java': robot })).toEqual([])
  })
  describe('a constructor reached through an implicit super()', () => {
    const files = (robot: string, real = 'public class IndexerIOReal extends IndexerIOTalonFX {}') => ({
      'TestTalonFX.java': 'public class TestTalonFX extends TalonFX { public TestTalonFX(int deviceId, String name) { super(deviceId); } }',
      'IndexerIOTalonFX.java': 'public abstract class IndexerIOTalonFX implements IndexerIO { private TestTalonFX m; public IndexerIOTalonFX() { m = new TestTalonFX(Ids.INDEXER, "indexer"); } }',
      'IndexerIOSim.java': 'public class IndexerIOSim implements IndexerIO { private TestTalonFX m; public IndexerIOSim() { m = new TestTalonFX(Ids.INDEXER, "indexer"); } }',
      'IndexerIOReal.java': real,
      'Ids.java': 'public class Ids { public static final int INDEXER = 7; }',
      'Robot.java': robot,
    })
    const switched = `class Robot extends TimedRobot { IndexerIO io; Robot() { switch (Constants.mode) {
      case REAL: io = new IndexerIOReal(); break;
      case SIM: io = new IndexerIOSim(); break;
      default: io = new IndexerIO() {}; } } }`
    it('keeps the switch arm of the subclass that builds it', () => {
      expect(messages(duplicateCanId, files(switched))).toEqual([])
    })
    it('keeps it through a subclass constructor that never calls super(…)', () => {
      const real = 'public class IndexerIOReal extends IndexerIOTalonFX { private int n; public IndexerIOReal() { n = 1; } }'
      expect(messages(duplicateCanId, files(switched, real))).toEqual([])
    })
    it('still fires when both are built in one run', () => {
      const robot = 'class Robot extends TimedRobot { IndexerIO a = new IndexerIOReal(); IndexerIO b = new IndexerIOSim(); }'
      expect(messages(duplicateCanId, files(robot))).toEqual([
        'TalonFX 7 on the roboRIO bus is also built at IndexerIOTalonFX.java:1',
        'TalonFX 7 on the roboRIO bus is also built at IndexerIOSim.java:1',
      ])
    })
    const clash = ['TalonFX 7 on the roboRIO bus is also built at IndexerIOTalonFX.java:1', 'TalonFX 7 on the roboRIO bus is also built at IndexerIOSim.java:1']
    it('still fires through a subclass constructor that hands on with this(…)', () => {
      const real = 'public class IndexerIOReal extends IndexerIOTalonFX { private int n; public IndexerIOReal(int a) { this(); } public IndexerIOReal() { n = 1; } }'
      const robot = 'class Robot extends TimedRobot { IndexerIO a = new IndexerIOReal(5); IndexerIO b = new IndexerIOSim(); }'
      expect(messages(duplicateCanId, files(robot, real))).toEqual(clash)
    })
    it('still fires when a subclass is built by reference and its sibling with new', () => {
      const java = {
        ...files('class Robot extends TimedRobot { Supplier<IndexerIO> s = IndexerIOReal::new; IndexerIO a = isReal() ? new IndexerIOSpare() : null; IndexerIO b = isReal() ? null : new IndexerIOSim(); }'),
        'IndexerIOSpare.java': 'public class IndexerIOSpare extends IndexerIOTalonFX {}',
      }
      expect(messages(duplicateCanId, java)).toEqual(clash)
    })
    it('builds nothing from a base whose subclasses nothing builds, with or without a constructor', () => {
      const robot = 'class Robot extends TimedRobot { TalonFX b = new TalonFX(7); }'
      const withConstructor = 'public class IndexerIOReal extends IndexerIOTalonFX { private int n; public IndexerIOReal() { n = 1; } }'
      expect(messages(duplicateCanId, files(robot))).toEqual([])
      expect(messages(duplicateCanId, files(robot, withConstructor))).toEqual([])
    })
    it('keeps the arm of a field set in the base, two subclasses down', () => {
      const java = {
        ...files(switched, 'public class IndexerIOReal extends IndexerIOMiddle {}'),
        'IndexerIOMiddle.java': 'public abstract class IndexerIOMiddle extends IndexerIOTalonFX {}',
        'IndexerIOTalonFX.java': 'public abstract class IndexerIOTalonFX implements IndexerIO { private TestTalonFX m = new TestTalonFX(Ids.INDEXER, "indexer"); }',
      }
      expect(messages(duplicateCanId, java)).toEqual([])
    })
  })
  it('lists a device whose ID it can\'t follow as not judged', () => {
    expect(run(duplicateCanId, 'class M { TalonFX m; void make(Constants c) { m = new TalonFX(c.driveId()); } }').notJudged.map((n) => n.why))
      .toEqual(["can't work out the ID or bus of this TalonFX"])
  })
})

describe('the code-check framework', () => {
  const quiet = { title: 't', meaning: 'm', nextStep: 'n', incident: 'i' }
  it('files a whole-project check\'s "couldn\'t judge" under that check, where it says', () => {
    const rule = codeRule({ ...quiet, id: 'code/test', check: (project) => (project.couldNotJudge('why', project.nodes('class_declaration')[0]), []) })
    expect(checkCode([{ path: 'A.java', text: '\nclass A {}' }], [rule]).notJudged).toEqual([{ rule: 'code/test', file: 'A.java', line: 2, why: 'why' }])
  })
  it('lists a check that throws as crashed and runs the rest', () => {
    const broken = codeRule({ ...quiet, id: 'code/broken', check: () => { throw new Error('bug in the check') } })
    const report = checkCode([{ path: 'A.java', text: 'class A { static final double R = 50 / 12; }' }], [broken, integerDivision])
    expect(report.crashed).toEqual([{ rule: 'code/broken', why: 'bug in the check' }])
    expect(report.findings).toHaveLength(1)
  })
  it('sees a for-each variable before a constant of the same name, comments in calls, and a minus sign', () => {
    const java = `class A { static final int t = 7; static final double M = -(50 / 12);
      void f(double[] xs) { for (double t : xs) { double d = t / 2; } } }`
    expect(messages(integerDivision, java)).toEqual(['50 / 12 is 4 in Java, not 4.1667 (-4.0 %)'])
    const robot = 'class Robot extends TimedRobot { TalonFX a = new TalonFX(/* left */ 1); TalonFX b = new TalonFX(1); }'
    expect(messages(duplicateCanId, robot)).toHaveLength(2)
  })
  it('drops a crashed check\'s "couldn\'t judge" notes instead of filing them under the next check', () => {
    const leaky = codeRule({ title: 't', meaning: 'm', nextStep: 'n', incident: 'i', id: 'code/leaky', check: (project) => { project.couldNotJudge('leak', project.nodes('class_declaration')[0]); throw new Error('boom') } })
    expect(checkCode([{ path: 'A.java', text: 'class A {}' }], [leaky, integerDivision]).notJudged).toEqual([])
  })
  it('sees a lambda\'s own parameter before a constant of the same name', () => {
    const java = 'class A { static final int x = 50; Supplier<Double> f = () -> 1.0; DoubleUnaryOperator g = x -> { double y = x / 12; return y; }; }'
    expect(messages(integerDivision, java)).toEqual([])
  })
})

describe('fixes from the review of 2026-10-20 (Fable + code-review high)', () => {
  it('tries again after a load that failed', async () => {
    vi.resetModules()
    const fresh = await import('../src/code/check/java.ts')
    await expect(fresh.loadJava(() => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    const require = createRequire(import.meta.url)
    const read = (module: string) => new Uint8Array(readFileSync(require.resolve(module)))
    await fresh.loadJava(async () => [read('web-tree-sitter/web-tree-sitter.wasm'), read('tree-sitter-java-orchard/tree-sitter-java_orchard.wasm')])
    expect(fresh.parseJava('A.java', 'class A {}').tree.rootNode.type).toBe('program')
  })
  it('loads tree-sitter once when several checks start together', async () => {
    await Promise.all([loadJavaFromDisk(), loadJavaFromDisk(), loadJavaFromDisk()])
    expect(messages(integerDivision, 'class A { static final double R = 50 / 12; }')).toHaveLength(1)
  })
  it('duplicate-can-id: a class nothing builds builds no devices', () => {
    const java = { 'Robot.java': 'class Robot extends TimedRobot { TalonFX a = new TalonFX(5); }', 'OldShooterIO.java': 'class OldShooterIO { TalonFX m = new TalonFX(5); }' }
    expect(messages(duplicateCanId, java)).toEqual([])
  })
  it('duplicate-can-id: a field set in the constructor isn\'t read from a method call\'s arguments', () => {
    const java = {
      'IO.java': 'class IO { private final int id; TalonFX m; IO(int id, CANBus b) { this.id = id; } void build(int x, int y) { m = new TalonFX(this.id); } }',
      'Robot.java': 'class Robot extends TimedRobot { IO a = new IO(5, bus); IO b = new IO(6, bus); void f() { a.build(5, 5); b.build(5, 5); } }',
    }
    expect(messages(duplicateCanId, java)).toEqual([])
  })
  it('duplicate-can-id: `if (x)` and `if (!x)` are the two arms of one fork', () => {
    const java = 'class Robot extends TimedRobot { TalonFX a, b; Robot() { if (Robot.isReal()) { a = new TalonFX(1); } if (!Robot.isReal()) { b = new TalonFX(1); } } }'
    expect(messages(duplicateCanId, java)).toEqual([])
  })
  it('optional-equals: a static Optional field is an Optional, not an Alliance', () => {
    expect(messages(optionalEquals, 'class R { void f() { a = DriverStation.getAlliance().equals(RobotState.lastAlliance); } }')).toEqual([])
  })
  it('never-set: a write through another object of the class counts', () => {
    expect(messages(neverSet, 'class Pair { private boolean ready = false; void link(Pair other) { other.ready = true; } boolean ok() { return !ready; } }')).toEqual([])
  })
  it('impossible-range: through parentheses and inside a longer && chain', () => {
    const java = 'class R { void f(double x, boolean a) { b = (x >= 1) && (x < 0); c = a && x >= 1 && x < 0; } }'
    expect(messages(impossibleRange, java)).toEqual([
      '(x >= 1) && (x < 0) is never true: nothing is >= 1 and < 0',
      'a && x >= 1 && x < 0 is never true: nothing is >= 1 and < 0',
    ])
  })
  it('a bare name from a library class isn\'t a same-named constant elsewhere; a static import is followed', () => {
    const java = {
      'Consts.java': 'package frc.robot;\nclass Consts { static final int kDefaultPeriod = 20; static final int TEETH = 50; }',
      'B.java': 'class B extends TimedRobot { double f() { return kDefaultPeriod / 3; } }',
      'C.java': 'import static frc.robot.Consts.*;\nclass C { static final double R = TEETH / 12; }',
    }
    expect(messages(integerDivision, java)).toEqual(['TEETH / 12 is 4 in Java, not 4.1667 (-4.0 %)'])
  })
  it('integer-division: a division meant to be 0 isn\'t a percentage of 0, and int overflow isn\'t guessed', () => {
    expect(messages(integerDivision, 'class A { static final double Z = (1 / 2) * 0; static final double W = 2048 * 2048 * 2048 / 3; }')).toEqual([])
  })
})

describe('constants the old builder regex read: in an interface, and inside a class whose name another class shares', () => {
  it('reads an interface\'s constants by its name, bare inside it, and bare in a class that implements it', () => {
    const java = {
      'RobotMap.java': 'package frc.robot;\npublic interface RobotMap extends Gearing { int TEETH = 50; public static final double RATIO = TEETH / 12; }',
      'Gearing.java': 'package frc.robot;\ninterface Gearing { int PINION = 12; }',
      'Arm.java': 'package frc.robot;\nclass Arm implements RobotMap { static final double A = RobotMap.TEETH / 12; static final double B = TEETH / PINION; }',
    }
    expect(messages(integerDivision, java)).toEqual([
      'RobotMap.TEETH / 12 is 4 in Java, not 4.1667 (-4.0 %)',
      'TEETH / PINION is 4 in Java, not 4.1667 (-4.0 %)',
      'TEETH / 12 is 4 in Java, not 4.1667 (-4.0 %)',
    ])
  })
  it('reads Constants.Shooter.ID from the Shooter inside Constants when a Shooter subsystem exists too', () => {
    const java = {
      'Constants.java': 'package frc.robot;\nclass Constants { static final class Shooter { static final int TEETH = 50; } }',
      'Shooter.java': 'package frc.robot.subsystems;\nclass Shooter extends SubsystemBase { static final int TEETH = 54; }',
      'Hood.java': 'package frc.robot;\nclass Hood { static final double A = Constants.Shooter.TEETH / 12; static final double B = frc.robot.subsystems.Shooter.TEETH / 12; }',
    }
    expect(messages(integerDivision, java)).toEqual([
      'Constants.Shooter.TEETH / 12 is 4 in Java, not 4.1667 (-4.0 %)',
      'frc.robot.subsystems.Shooter.TEETH / 12 is 4 in Java, not 4.5 (-11.1 %)',
    ])
  })
  it('still reads nothing from a bare Shooter that could be either class', () => {
    const java = {
      'Constants.java': 'package frc.robot;\nclass Constants { static final class Shooter { static final int TEETH = 50; } }',
      'Shooter.java': 'package frc.robot.subsystems;\nclass Shooter extends SubsystemBase { static final int TEETH = 48; }',
      'Hood.java': 'package frc.robot;\nclass Hood { static final double A = Shooter.TEETH / 12; }',
    }
    expect(messages(integerDivision, java)).toEqual([])
  })
  it('lets a class\'s own constant hide an interface\'s of the same name, as Java does', () => {
    const java = { 'A.java': 'package frc.robot;\ninterface RobotMap { int TEETH = 50; }\nclass Arm implements RobotMap { static final int TEETH = 54; static final double R = TEETH / 12; }' }
    expect(messages(integerDivision, java)).toEqual(['TEETH / 12 is 4 in Java, not 4.5 (-11.1 %)'])
  })
  it('reads a static import of a copied class (an old/ folder), and constants the imported class gets from an interface', () => {
    const consts = 'package frc.robot;\nclass Consts implements Gearing { static final int TEETH = 50; }\ninterface Gearing { int PINION = 12; }'
    const java = {
      'src/Consts.java': consts,
      'old/Consts.java': consts,
      'Arm.java': 'package frc.robot.arm;\nimport static frc.robot.Consts.*;\nclass Arm { static final double R = TEETH / PINION; }',
    }
    expect(messages(integerDivision, java)).toEqual(['TEETH / PINION is 4 in Java, not 4.1667 (-4.0 %)'])
  })
  it('reads an interface nested in a class, and keeps a subsystem a subsystem when that interface shares its name', () => {
    const java = {
      'Constants.java': 'package frc.robot;\nclass Constants { interface Shooter { int TEETH = 50; } }',
      'Shooter.java': 'package frc.robot.subsystems;\nclass Shooter extends SubsystemBase { static final double R = Constants.Shooter.TEETH / 12; }',
    }
    expect(messages(integerDivision, java)).toEqual(['Constants.Shooter.TEETH / 12 is 4 in Java, not 4.1667 (-4.0 %)'])
    const project = new Project(Object.entries(java).map(([path, text]) => ({ path, text })))
    expect(isSubsystem('Shooter', project)).toBe(true)
    project.close()
  })
})

/** A subsystem for the command checks: WPILib's run and runOnce come from SubsystemBase. */
const SUBSYSTEM = (body: string) => `class Intake extends SubsystemBase { ${body} }`

describe('code/never-ending-step', () => {
  it('fires on an endless step before the last, in Commands.sequence, andThen and a SequentialCommandGroup', () => {
    const java = SUBSYSTEM(`
      Command zero() { return Commands.sequence(this.run(() -> stop()), Commands.waitUntil(() -> stalled()), runOnce(() -> reset())); }
      Command a() { return run(() -> spin()).withName("spin").andThen(Commands.print("done")); }
      Command b() { return new SequentialCommandGroup(new RunCommand(() -> spin(), this), new WaitCommand(1)); }`)
    expect(messages(neverEndingStep, java)).toEqual([
      'this.run(() -> stop()) never ends on its own, so the 2 steps after it never run',
      'run(() -> spin()).withName("spin") never ends on its own, so the 1 step after it never runs',
      'new RunCommand(() -> spin(), this) never ends on its own, so the 1 step after it never runs',
    ])
  })
  it('reads addCommands and super in a class that extends SequentialCommandGroup', () => {
    const java = `class Climb extends SequentialCommandGroup {
      Climb(Climber c) { super(new RunCommand(() -> c.up(), c), new WaitCommand(1)); addCommands(Commands.idle(c), new WaitCommand(2)); }
    }`
    expect(messages(neverEndingStep, java)).toHaveLength(2)
  })
  it('fires on a command that ends at once given until or withTimeout, anywhere', () => {
    const java = SUBSYSTEM(`
      Command a() { return runOnce(() -> up()).until(() -> atTop()); }
      Command b() { return new InstantCommand(() -> unlock()).withTimeout(0.5); }`)
    expect(messages(neverEndingStep, java)).toEqual([
      'runOnce(() -> up()) ends the first time it runs, so .until(…) never waits',
      'new InstantCommand(() -> unlock()) ends the first time it runs, so .withTimeout(…) never waits',
    ])
  })
  it('stays quiet on an ended step, a last step, until(() -> true), and a project method named run', () => {
    const java = SUBSYSTEM(`
      Command a() { return Commands.sequence(this.run(() -> stop()).until(() -> stalled()), runOnce(() -> reset())); }
      Command b() { return Commands.sequence(runOnce(() -> hold()).until(() -> true), runOnce(() -> hold()).until(() -> { return true; }), this.run(() -> {})); }
      Command c() { return Commands.sequence(runOnce(() -> reset()), this.run(() -> stop())); }`) + `
      class Container { static Command run(Command... c) { return new ParallelCommandGroup(c); } Command d() { return Commands.sequence(run(x), y); } }`
    expect(messages(neverEndingStep, java)).toEqual([])
  })
})

describe('code/unused-config', () => {
  it('fires on a configuration parameter nothing reads, even beside a field of the same name', () => {
    const java = `class CANdleIOReal {
      CANdleConfiguration config;
      CANdleIOReal(int id, CANdleConfiguration config) { candle = new CANdle(id); this.config = new CANdleConfiguration(); }
    }`
    expect(messages(unusedConfig, java)).toEqual(['config (CANdleConfiguration) is passed to CANdleIOReal(…) and never used'])
  })
  it('stays quiet when it is applied, on other types, and in an interface', () => {
    const java = `class HoodIO {
      HoodIO(TalonFXConfiguration config, String threadName) { motor.getConfigurator().apply(config); }
    }
    interface IO { void configure(TalonFXConfiguration config); }
    class Many { void all() { configs.forEach((TalonFXConfiguration c) -> motor.getConfigurator().apply(base)); } }
    class HoodIOSim { HoodIOSim(int id, TalonFXConfiguration config) { sim = new DCMotorSim(id); } }`
    expect(messages(unusedConfig, java)).toEqual([])
  })
})

describe('code/stale-signal', () => {
  const io = (body: string) => `class FlywheelIO {
    private final TalonFX motor = new TalonFX(1);
    private final StatusSignal<AngularVelocity> velocity = motor.getVelocity();
    private final StatusSignal<Voltage> voltage = motor.getMotorVoltage();
    ${body}
  }`
  it('fires when a kept signal is read and never refreshed, once per class', () => {
    const java = io('void update(Inputs inputs) { inputs.v = velocity.getValueAsDouble(); inputs.volts = voltage.getValueAsDouble(); }')
    expect(messages(staleSignal, java)).toEqual(['2 status signals read but never refreshed: velocity, voltage. Each read gives the value from when they were first fetched'])
  })
  it('fires on a rate of 0, and on optimizeBusUtilization with no rate (but not for a temperature)', () => {
    const zero = io(`FlywheelIO() { BaseStatusSignal.setUpdateFrequencyForAll(0.0, velocity); }
      void update(Inputs inputs) { BaseStatusSignal.refreshAll(velocity, voltage); inputs.v = velocity.getValueAsDouble(); }`)
    expect(messages(staleSignal, zero)).toEqual(['1 status signal set to update 0 times a second (line 5) and then read: velocity. The value never changes'])
    const slowed = io(`private final StatusSignal<Temperature> temp = motor.getDeviceTemp();
      FlywheelIO() { motor.optimizeBusUtilization(); }
      void update(Inputs inputs) { BaseStatusSignal.refreshAll(velocity, voltage, temp); inputs.v = velocity.getValueAsDouble(); inputs.t = temp.getValueAsDouble(); }`)
    expect(messages(staleSignal, slowed)).toEqual(['1 status signal read with no rate of its own, so optimizeBusUtilization() (line 6) slows it to 4 a second: velocity'])
  })
  it('stays quiet when refreshed through an array, rated through its getter, re-fetched, or handed off', () => {
    const java = io(`private final BaseStatusSignal[] all = new BaseStatusSignal[] {velocity, voltage};
      FlywheelIO() { BaseStatusSignal.setUpdateFrequencyForAll(50, motor.getVelocity(), motor.getMotorVoltage()); motor.optimizeBusUtilization(); }
      void update(Inputs inputs) { BaseStatusSignal.refreshAll(all); inputs.v = velocity.getValueAsDouble(); inputs.volts = voltage.getValueAsDouble(); }`)
    expect(messages(staleSignal, java)).toEqual([])
    const fetched = 'class A { StatusSignalValue<Double> s; void update() { s = motor.getSupplyVoltage(); x = s.getValue(); } }'
    expect(messages(staleSignal, fetched)).toEqual([])
    const handed = io('FlywheelIO() { PhoenixUtil.registerSignals(velocity, voltage); } double v() { return velocity.getValueAsDouble() + voltage.getValueAsDouble(); }')
    expect(messages(staleSignal, handed)).toEqual([])
    const local = 'class A { double p() { StatusSignal<Angle> p = motor.getPosition(); return p.getStatus().isOK() ? p.getValueAsDouble() : 0; } }'
    expect(messages(staleSignal, local)).toEqual([])
  })
  it("isn't fooled by an inputs class with fields of the same names", () => {
    const java = io(`static class Inputs { double velocity; double voltage; }
      void update(Inputs inputs) { BaseStatusSignal.refreshAll(velocity, voltage); inputs.velocity = velocity.getValueAsDouble(); inputs.voltage = voltage.getValueAsDouble(); }`)
    expect(messages(staleSignal, java)).toEqual([])
  })
})

describe('deviceSettings: what the code configures on each device, for the robot snapshot', () => {
  const settingsOf = (files: Record<string, string>) => {
    const project = new Project(Object.entries(files).map(([path, text]) => ({ path, text })))
    try {
      return deviceSettings(project).map((s) => `${s.kind} ${s.id} ${s.bus} ${s.field}=${s.value} ${s.where}`)
    } finally {
      project.close()
    }
  }
  it('follows the config from where it is built, through an IO constructor, to the device it is applied to', () => {
    const files = {
      'Robot.java': `class Robot extends TimedRobot {
        Robot() { turret = new Turret(isReal() ? new CANcoderIO(5, Turret.getCancoderConfig(), canivore) : new CANcoderIOSim(5, Turret.getCancoderConfig(), canivore)); }
        static final CANBus canivore = new CANBus("canivore");
      }`,
      'Turret.java': `class Turret extends SubsystemBase {
        public static CANcoderConfiguration getCancoderConfig() {
          CANcoderConfiguration config = new CANcoderConfiguration();
          config.MagnetSensor.MagnetOffset = -0.765 - 0.882;
          config.MagnetSensor.SensorDirection = SensorDirectionValue.CounterClockwise_Positive;
          return config;
        }
      }`,
      'CANcoderIO.java': `class CANcoderIO {
        private final CANcoder cancoder;
        CANcoderIO(int id, CANcoderConfiguration config, CANBus bus) { cancoder = new CANcoder(id, bus); cancoder.getConfigurator().apply(config); }
      }`,
      'CANcoderIOSim.java': 'class CANcoderIOSim { CANcoder c; CANcoderIOSim(int id, CANcoderConfiguration config, CANBus bus) { c = new CANcoder(id, bus); c.getConfigurator().apply(config); } }',
    }
    expect(settingsOf(files)).toEqual(['CANcoder 5 canivore MagnetOffset=-1.647 Turret.java:4'])
  })
  it('reads limits and Enables, and nothing from a config built with .with…() builders', () => {
    const files = {
      'Robot.java': 'class Robot extends TimedRobot { Robot() { new HoodIO(14); new RollerIO(9); } }',
      'HoodIO.java': `class HoodIO {
        TalonFX motor;
        HoodIO(int id) { motor = new TalonFX(id); var c = new TalonFXConfiguration(); c.CurrentLimits.SupplyCurrentLimit = 40; c.CurrentLimits.SupplyCurrentLimitEnable = true; motor.getConfigurator().apply(c); }
      }`,
      'RollerIO.java': 'class RollerIO { TalonFX motor; RollerIO(int id) { motor = new TalonFX(id); motor.getConfigurator().apply(new TalonFXConfiguration().withCurrentLimits(limits)); } }',
    }
    expect(settingsOf(files)).toEqual(['TalonFX 14 the roboRIO bus SupplyCurrentLimit=40 HoodIO.java:3', 'TalonFX 14 the roboRIO bus SupplyCurrentLimitEnable=true HoodIO.java:3'])
  })
  it('reads only the config the device gets: not a same-named config of another method, nor a `-=`', () => {
    const files = {
      'Robot.java': 'class Robot extends TimedRobot { Robot() { new PivotIO(14); } }',
      'PivotIO.java': `class PivotIO {
        TalonFX motor; CANcoder encoder;
        TalonFXConfiguration config = new TalonFXConfiguration();
        PivotIO(int id) { motor = new TalonFX(id); config.CurrentLimits.SupplyCurrentLimit = 40; config.CurrentLimits.StatorCurrentLimit -= 5; motor.getConfigurator().apply(config); }
        void encoderSetup() { CANcoderConfiguration config = new CANcoderConfiguration(); config.MagnetSensor.MagnetOffset = 0.25; encoder.getConfigurator().apply(config); }
      }`,
    }
    expect(settingsOf(files)).toEqual(['TalonFX 14 the roboRIO bus SupplyCurrentLimit=40 PivotIO.java:4'])
  })
})
