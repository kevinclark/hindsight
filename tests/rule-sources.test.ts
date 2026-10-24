// Every registered rule cites at least one public source, and says where each threshold came from (slice 7).
import { describe, expect, it } from 'vitest'
import { FORESIGHT_RULES, RULES } from '../src/rules/index.ts'
import * as catalog from '../src/rules/sources.ts'

const registered = [...new Map([...RULES, ...FORESIGHT_RULES].map((r) => [r.id, r])).values()]

describe('rule sources', () => {
  it('registers 44 rules', () => {
    expect(registered).toHaveLength(44)
  })

  it.each(registered.map((r) => [r.id, r] as const))('%s cites at least one https source and says what it says', (_id, rule) => {
    expect(rule.sources.length).toBeGreaterThanOrEqual(1)
    for (const s of rule.sources) {
      expect(s.url).toMatch(/^https:\/\/[^\s]+$/)
      expect(s.title.trim()).not.toBe('')
      expect(['vendor', 'manual', 'paper', 'forum', 'standard']).toContain(s.kind)
      expect(s.says.trim().length).toBeGreaterThan(20)
    }
    expect(new Set(rule.sources.map((s) => s.url)).size).toBe(rule.sources.length)
  })

  it.each(registered.filter((r) => r.thresholds).map((r) => [r.id, r] as const))('%s marks each threshold measured or judgment, with how', (_id, rule) => {
    for (const t of rule.thresholds ?? []) {
      expect(['measured', 'judgment']).toContain(t.basis)
      expect(t.name.trim()).not.toBe('')
      expect(t.value.trim()).not.toBe('')
      expect(t.how.trim()).not.toBe('')
    }
  })

  it('the catalog has no page no rule cites, and no private address', () => {
    const cited = new Set(registered.flatMap((r) => r.sources.map((s) => s.url)))
    const pages = Object.values(catalog) as { url: string }[]
    expect(pages.filter((p) => !cited.has(p.url)).map((p) => p.url)).toEqual([])
    for (const p of pages) expect(p.url).not.toMatch(/slack|docs\.google|drive\.google|localhost|\.local\b/i)
  })
})
