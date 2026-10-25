/**
 * Whether a pull's refusal means no robot answered at all. `checkRobotIdle` (src/hub/robot.ts) words a refusal before the
 * robot's NT4 socket opened as "Could not reach the robot: …" (it closed, or nothing answered in the wait: a robot that is off
 * or not cabled usually never opens it). Every other refusal (the socket opened but closed or sent no guard value, the robot is
 * enabled or on the field) means the robot answered. Only the first is "Robot not found". Kept out of robot.ts, which imports
 * node modules the page cannot; robot.ts re-exports it.
 */
export const notReached = (reason: string): boolean => /^Could not reach the robot/.test(reason)
