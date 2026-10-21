/**
 * How the code checks name a CAN bus: the roboRIO's own bus, CANBus("*") (any CANivore), or a CANivore's name. Its
 * own module, with no parser in it, so Foresight's snapshot checks can use the names without loading tree-sitter.
 */
export const RIO = 'the roboRIO bus'
export const ANY_CANIVORE = '*'

/** A bus as a name: "canivore", "*", or the roboRIO's own bus for "", "rio" and `new CANBus()`. */
export function busName(value: number | string): string {
  const text = String(value)
  const named = /^new CANBus\(\s*"([^"]*)"/.exec(text)?.[1] ?? (text.startsWith('new CANBus(') ? '' : text)
  return named === '' || named === 'rio' ? RIO : named
}
