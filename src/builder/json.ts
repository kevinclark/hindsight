/**
 * profile.json: a robot profile as a file, so it can be kept in the browser, saved, shared and dropped back in.
 *
 * The shape extends the snapshot view's profile file (fixtures/robot-snapshot/example-profile.json: a name and motor
 * groups with CAN IDs and limits). Every other field is optional: one the file leaves out gets the empty value, and
 * the rules that need it list as "not checked". A zeroing mechanism's done message (a RegExp in a TypeScript
 * profile) is stored as its source and flags.
 *
 * Fields only the builder uses, which the TypeScript profile has no place for, ride along and are dropped by
 * toProfile(): where each value came from, a motor's CAN bus, a current that doesn't say supply or stator, a
 * suggested "same loop", and which snapshot the limits were read from.
 */
import { formatOfSignals } from '../profiles/formats.ts'
import type { CurrentLimits, Motor, MotorGroup, RobotProfile, ZeroingMechanism } from '../profiles/types.ts'

export const PROFILE_SCHEMA = 'hindsight.profile/1'

/** Where a value came from, shown beside it in the builder. */
export type Source = 'log' | 'snapshot' | 'code' | 'code hint' | 'you'

export interface MotorJson extends Motor {
  /** Where the motor is in the log (its struct entry or key stem): how the builder knows it. */
  logPath?: string
  /** The CAN bus the snapshot found it on ("" is the roboRIO's own bus). */
  bus?: string
  /** A current key that doesn't say supply or stator, until the student says which. */
  current?: string
  /** Where its CAN ID came from. */
  canIdFrom?: Source
  /** Who said which current is supply and which stator, when the key's name doesn't: the code, or the student. */
  kindFrom?: 'code' | 'you'
}

export interface GroupJson extends Omit<MotorGroup, 'motors' | 'limits'> {
  motors: MotorJson[]
  limits?: CurrentLimits
  /** sameLoop was ticked by the builder (from leader/follower names), not yet by the student. */
  sameLoopSuggested?: boolean
  /** Why these motors are one group: the builder's evidence (the code, or the log's names), or the student's say. */
  groupedBy?: 'code' | 'swerve' | 'one array' | 'leader/follower' | 'one motor' | 'you'
  /** The robot code builds these motors together (one place, one folder, or a leader and its followers). */
  groupFromCode?: true
  /** The code makes one of them follow another (`setControl(new Follower(…))`): why "same loop" is suggested. */
  followerFromCode?: true
  /** The limits were read from the robot code (a snapshot's are marked by limitsFrom on the profile). */
  limitsFromCode?: true
}

export type ZeroingJson = Omit<ZeroingMechanism, 'doneMessage'> & { doneMessage: { source: string; flags: string } }

export interface ProfileJson extends Partial<Omit<RobotProfile, 'motorGroups' | 'zeroing' | 'signals' | 'battery' | 'keptAs'>> {
  schema?: typeof PROFILE_SCHEMA
  name: string
  motorGroups: GroupJson[]
  signals?: Partial<RobotProfile['signals']>
  battery?: Partial<RobotProfile['battery']>
  zeroing?: ZeroingJson[]
  /** The snapshot the applied current limits were read from (its takenAt): the snapshot view doesn't compare a robot with itself. */
  limitsFrom?: { snapshotTakenAt: string }
  /** When and from what the builder drafted it. */
  builtFrom?: { log?: string; snapshot?: string; code?: string; at: string }
}

const EMPTY_SIGNALS: RobotProfile['signals'] = {
  dsBrownoutCount: '', canivoreUsbDisconnects: '', canivoreTxFails: '', usbPortDisabled: '',
  codebase: '', logClock: '', radioConnected: '', powerDistributionCurrents: '', powerDistributionVoltage: '', powerDistributionChannels: '', totalCurrent: '',
  enabled: '', autonomous: '', fmsAttached: '', dsAttached: '', eventName: '', matchType: '', matchNumber: '', replayNumber: '',
  allianceStation: '', gitSha: '', gitBranch: '', gitDate: '', gitDirty: '', epochMicros: '', systemTimeValid: '', batteryVoltage: '',
  brownedOut: '', brownoutVoltage: '', commsDisableCount: '', systemActive: '', loopCycleMs: '', console: '', alertGroups: [],
  gyroPitch: '', gyroRoll: '', accelX: '', accelY: '', odometryPose: '', emergencyStop: '', matchTimeLeft: '', autoChoice: '',
  joystickButtonCounts: [],
}
const EMPTY_BATTERY: RobotProfile['battery'] = { id: [], idSource: [], gaugeValid: [], effectiveCapacityAh: [], ratedCapacityAh: [], remainingChargePct: [], numCycles: [] }
/** The assumptions every hand-written profile uses: nothing on a robot measures them. */
export const DEFAULT_POWER: RobotProfile['power'] = { otherLoadsAmps: 3, restVoltageMin: 12.5, marginVolts: 1.0, healthyResistanceMaxOhms: 0.020 }

const NO_LIMITS: CurrentLimits = { where: 'not known: drop a robot snapshot, or set them in the profile' }

/**
 * A RobotProfile from a profile.json. Fields the file leaves out get their empty value; builder-only fields are
 * dropped, and so is keptAs: only the browser's store gives a profile that id.
 */
export function toProfile(json: ProfileJson): RobotProfile {
  const { schema: _s, limitsFrom: _l, builtFrom: _b, keptAs: _k, motorGroups, signals, battery, zeroing, ...rest } = json as ProfileJson & { keptAs?: unknown }
  return {
    codebase: '',
    code: { repo: '', branch: '', sha: '' },
    game: { name: '', autoSeconds: 15, teleopSeconds: 135 },
    power: DEFAULT_POWER,
    otherDevices: [],
    whatIfGroup: '',
    cameras: [],
    ...rest,
    // A profile kept before a signal existed gets its log type's key for it (when the type is clear), not ''.
    signals: { ...EMPTY_SIGNALS, ...(signals ? formatOfSignals(signals)?.signals : undefined), ...signals },
    battery: { ...EMPTY_BATTERY, ...battery },
    zeroing: (zeroing ?? []).map((z) => ({ ...z, doneMessage: new RegExp(z.doneMessage.source, z.doneMessage.flags) })),
    motorGroups: motorGroups.map(({ sameLoopSuggested: _ss, groupedBy: _g, groupFromCode: _gc, followerFromCode: _fc, limitsFromCode: _lc, motors, limits, ...g }) => ({
      ...g,
      limits: limits ?? NO_LIMITS,
      motors: motors.map(({ bus: _bus, current: _c, canIdFrom: _f, kindFrom: _k, logPath: _p, ...m }) => m),
    })),
  }
}

/** A profile.json from a RobotProfile (a built-in one, or one toProfile made). */
export function fromProfile(profile: RobotProfile): ProfileJson {
  const { zeroing, keptAs: _k, ...rest } = profile
  return {
    schema: PROFILE_SCHEMA,
    ...structuredClone(rest),
    zeroing: zeroing.map((z) => ({ ...structuredClone({ ...z, doneMessage: undefined }), doneMessage: { source: z.doneMessage.source, flags: z.doneMessage.flags } })),
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Read a profile.json. Throws an Error naming what's wrong when it isn't one. */
export function parseProfileJson(text: string, fileName = 'profile.json'): ProfileJson {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`${fileName} is not JSON`) }
  if (!isObject(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.motorGroups)) throw new Error(`${fileName} is not a robot profile (it needs a name and motorGroups)`)
  if (raw.schema !== undefined && raw.schema !== PROFILE_SCHEMA) throw new Error(`${fileName}: schema ${JSON.stringify(raw.schema)}, expected ${PROFILE_SCHEMA}`)
  raw.motorGroups.forEach((g, i) => {
    if (!isObject(g) || typeof g.name !== 'string' || !Array.isArray(g.motors)) throw new Error(`${fileName}: motor group ${i + 1} needs a name and motors`)
    if (g.limits !== undefined && (!isObject(g.limits) || typeof g.limits.where !== 'string')) throw new Error(`${fileName}: ${g.name}: limits need a "where" text (where the code sets them)`)
    g.motors.forEach((m, j) => {
      if (!isObject(m) || typeof m.name !== 'string') throw new Error(`${fileName}: ${g.name}, motor ${j + 1} needs a name`)
      if (m.canId !== undefined && !Number.isInteger(m.canId)) throw new Error(`${fileName}: ${g.name}, ${m.name}: canId must be a whole number`)
    })
  })
  for (const z of Array.isArray(raw.zeroing) ? raw.zeroing : []) {
    const d = isObject(z) ? z.doneMessage : undefined
    if (!isObject(d) || typeof d.source !== 'string') throw new Error(`${fileName}: a zeroing mechanism's doneMessage needs { source, flags }`)
    try { new RegExp(d.source, typeof d.flags === 'string' ? d.flags : '') } catch { throw new Error(`${fileName}: doneMessage ${JSON.stringify(d.source)} is not a regular expression`) }
  }
  return raw as unknown as ProfileJson
}
