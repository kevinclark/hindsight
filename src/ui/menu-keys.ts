/** Where the arrow keys move inside an open menu: the index to focus next, or null when the key is not a menu key. */
export function menuTarget(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
