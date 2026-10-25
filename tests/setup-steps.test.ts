// Slice 2: the steps of "Set up this laptop". Invented values only.
import { describe, expect, it } from 'vitest'
import { setupProgress, setupSteps, showSetupCard, stepsLeft, type SetupState } from '../src/ui/setup-steps.ts'

const none: SetupState = { hub: true, team: null, tbaKey: false, github: false, google: { configured: true, signedIn: false, teamFolder: false } }
const all: SetupState = { hub: true, team: 1234, tbaKey: true, github: true, google: { configured: true, signedIn: true, teamFolder: true } }
const ids = (s: SetupState) => stepsLeft(setupSteps(s)).map((x) => x.id)

describe('setupSteps', () => {
  it('lists team, key, Google, GitHub in that order, each saying what it adds', () => {
    const steps = setupSteps(none)
    expect(steps.map((s) => s.id)).toEqual(['team', 'tba', 'google', 'github'])
    expect(steps.find((s) => s.id === 'tba')!.adds).toBe('names the event and its schedule; without it each laptop types the next match')
    expect(steps.find((s) => s.id === 'github')!.adds).toBe('links logs to their code for code checks')
    expect(steps.find((s) => s.id === 'google')!.adds).toBe('the shared library and triage history across laptops')
    for (const s of steps) expect(s.adds.length).toBeGreaterThan(10)
  })
  it('ticks each step on its own setting', () => {
    expect(ids(none)).toEqual(['team', 'tba', 'google', 'github'])
    expect(ids({ ...none, team: 8 })).toEqual(['tba', 'google', 'github'])
    expect(ids({ ...none, tbaKey: true })).toEqual(['team', 'google', 'github'])
    expect(ids({ ...none, github: true })).toEqual(['team', 'tba', 'google'])
  })
  it('Google is done only with a sign-in and a team folder', () => {
    expect(ids({ ...all, google: { configured: true, signedIn: true, teamFolder: false } })).toEqual(['google'])
    expect(ids({ ...all, google: { configured: true, signedIn: false, teamFolder: true } })).toEqual(['google'])
  })
  it('the page has no Google step, so it is hidden once the other three are done', () => {
    const page = { ...all, hub: false, google: { configured: true, signedIn: false, teamFolder: false } }
    expect(setupSteps(page).find((s) => s.id === 'google')!.applicable).toBe(false)
    expect(showSetupCard(setupSteps(page))).toBe(false)
    expect(showSetupCard(setupSteps({ ...page, github: false }))).toBe(true)
  })
  it('the card shows until every applicable step is done', () => {
    expect(showSetupCard(setupSteps(none))).toBe(true)
    expect(showSetupCard(setupSteps({ ...all, github: false }))).toBe(true)
    expect(showSetupCard(setupSteps(all))).toBe(false)
  })
  it('a build with no Google client has no Google step (it could never be done), and the card can finish', () => {
    const noClient = { ...all, google: { configured: false, signedIn: false, teamFolder: false } }
    expect(setupSteps(noClient).find((s) => s.id === 'google')!.applicable).toBe(false)
    expect(showSetupCard(setupSteps(noClient))).toBe(false)
    expect(ids({ ...none, google: { configured: false, signedIn: false, teamFolder: false } })).toEqual(['team', 'tba', 'github'])
  })
  it('counts the steps done over those that apply', () => {
    expect(setupProgress(setupSteps(none))).toEqual({ done: 0, of: 4 })
    expect(setupProgress(setupSteps({ ...all, github: false }))).toEqual({ done: 3, of: 4 })
    expect(setupProgress(setupSteps({ ...all, hub: false }))).toEqual({ done: 3, of: 3 })
  })
  it('step one does not claim to find matches (only the key does)', () => {
    expect(setupSteps(none)[0].adds).toBe("filters the robot lists to your team's robots")
  })
})
