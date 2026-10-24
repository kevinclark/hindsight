import { describe, expect, it } from 'vitest'
import { OWNER_ROLES, readRole, ROLE_KEY, ROLES, writeRole } from '../src/board/role.ts'

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } }

describe('"You are on" role', () => {
  it('is none until chosen, then kept under its own key', () => {
    const s = memory()
    expect(readRole(s)).toBeNull()
    writeRole(s, 'software')
    expect(s.m.get(ROLE_KEY)).toBe('software')
    expect(readRole(s)).toBe('software')
  })
  it('a stored value that is not a role is ignored, and a blocked store never throws', () => {
    const s = memory()
    s.m.set(ROLE_KEY, 'a person')
    expect(readRole(s)).toBeNull()
    const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(readRole(blocked)).toBeNull()
    expect(() => writeRole(blocked, 'pit')).not.toThrow()
  })
  it('a mentor coaches and can take over, but does not own an issue', () => {
    expect(ROLES).toContain('mentor')
    expect(OWNER_ROLES).toEqual(['pit', 'software', 'drive'])
  })
})
