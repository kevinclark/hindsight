// Arrow-key movement in the navigation menus (src/ui/menu-keys.ts, used by src/ui/Menu.svelte).
import { describe, expect, it } from 'vitest'
import { menuTarget } from '../src/ui/menu-keys.ts'

describe('menuTarget', () => {
  it('moves down and wraps past the last item', () => {
    expect(menuTarget('ArrowDown', 0, 6)).toBe(1)
    expect(menuTarget('ArrowDown', 5, 6)).toBe(0)
  })
  it('moves up and wraps past the first item', () => {
    expect(menuTarget('ArrowUp', 3, 6)).toBe(2)
    expect(menuTarget('ArrowUp', 0, 6)).toBe(5)
  })
  it('starts at an end when nothing in the menu has focus yet', () => {
    expect(menuTarget('ArrowDown', -1, 4)).toBe(0)
    expect(menuTarget('ArrowUp', -1, 4)).toBe(3)
  })
  it('Home and End jump to the ends', () => {
    expect(menuTarget('Home', 3, 6)).toBe(0)
    expect(menuTarget('End', 1, 6)).toBe(5)
  })
  it('ignores other keys and empty menus', () => {
    expect(menuTarget('a', 1, 6)).toBeNull()
    expect(menuTarget('Enter', 1, 6)).toBeNull()
    expect(menuTarget('ArrowDown', 0, 0)).toBeNull()
  })
})
