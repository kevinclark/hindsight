/**
 * The words for logs left behind because the robot was never enabled in them (ADR 15). Kept out of robot.ts and sync.ts,
 * which import node modules the page cannot; both re-export what they use.
 */
import { sizeWords } from './transfer-watch.ts'

const logs = (n: number) => (n === 1 ? 'log' : 'logs')

/** What a robot pull says it left on the robot (also the job log's line). */
export function skippedWords(count: number, bytes: number): string {
  return `Skipped ${count} ${count === 1 ? 'log from a power-on' : 'logs from power-ons'} with no Driver Station attached (the robot was never enabled), ${sizeWords(bytes)}.`
}

/** What a sync says about logs it kept on this laptop. */
export const notUploadedWords = (count: number, bytes: number): string =>
  `Not uploaded: ${count} ${logs(count)} the robot was never enabled in, ${sizeWords(bytes)}, kept on this laptop.`
