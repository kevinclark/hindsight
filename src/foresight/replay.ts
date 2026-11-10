/**
 * A log replayed through Foresight the way live.ts reads a robot: the signals Foresight subscribes to arrive in time
 * order, and every second the store is pruned and checked (engine.ts). Records kept only for their last seconds, and the
 * coupled pairs' currents kept while they ran, behave as they do live, which a check over the whole log at once would not
 * show. For the on-check tests and scripts/foresight-oncheck-backtest.ts.
 */
import type { WpilogFile } from '../readers/wpilog.ts'
import type { RobotProfile } from '../profiles/types.ts'
import type { ProfileChoice } from '../profiles/choose.ts'
import { DATALOGMANAGER_SIGNALS } from '../profiles/datalogmanager.ts'
import { RecordStore } from './records.ts'
import { evaluateForesight, type ForesightResult } from './engine.ts'
import { foresightKeysIn } from './keys.ts'

export interface ReplayStep {
  /** Robot time of the check (s): the latest record. */
  now: number
  result: ForesightResult
  /** How long the check took (ms). */
  ms: number
}

/**
 * One check a second from `from` (default: a second after code start) to the log's end. Code start is the first record
 * after 0 (live.ts: the metadata's time, or the first value). Before `from` nothing is checked, so nothing is kept past
 * its seconds there either: start before the enables that matter. `keys`: null for every signal in the log instead of the
 * subscribed ones.
 */
export function* replayLive(log: WpilogFile, profile: RobotProfile, choice: ProfileChoice | undefined, opts: { from?: number; keys?: Iterable<string> | null } = {}): Generator<ReplayStep> {
  const keys = opts.keys === undefined ? [...foresightKeysIn(log, profile), ...Object.values(DATALOGMANAGER_SIGNALS).flat()] : opts.keys
  const full = RecordStore.fromWpilog(log, keys)
  const records = [...full.entries.values()].flatMap((e) => e.t.map((t, i) => ({ e, t, payload: e.payload[i] })))
  records.sort((a, b) => a.t - b.t)
  if (!records.length) return
  const store = new RecordStore()
  for (const e of full.entries.values()) store.entries.set(e.name, { name: e.name, type: e.type, metadata: e.metadata, t: [], payload: [] })
  const codeStart = records.find((r) => r.t > 0)?.t ?? records[0].t
  const last = records[records.length - 1].t
  let k = 0
  for (let at = Math.max(codeStart + 1, Math.ceil(opts.from ?? codeStart + 1)); at < last + 1; at++) {
    while (k < records.length && records[k].t <= at) { const r = records[k++]; store.add(r.e.name, r.e.type, r.t, r.payload) }
    store.prune()
    const t0 = performance.now()
    const result = evaluateForesight({ store, codeStart, now: store.latest, lastPassingSha: null, profile, choice })
    yield { now: store.latest, result, ms: performance.now() - t0 }
  }
}
