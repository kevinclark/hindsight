/**
 * Whether a pull's refusal means no robot answered at all. `checkRobotIdle` (src/hub/robot.ts) refuses in four ways: the socket
 * closed before any value ("Could not check the robot: Connection closed…": nothing answered); the guard value never came, or the
 * robot is enabled, or on the field (all of those mean the robot answered). Only the first is "Robot not found". Kept out of
 * robot.ts, which imports node modules the page cannot; robot.ts re-exports it.
 */
export const notReached = (reason: string): boolean => /^Could not check the robot: Connection closed/.test(reason)
