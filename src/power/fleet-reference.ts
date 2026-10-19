/**
 * The "fleet curve": what a healthy battery's estimated open-circuit voltage looks like as charge is drawn.
 *
 * Phase 1 has no battery history yet, so the curve is built into the app: for each 0.5 Ah bin, the LOWER of the
 * CalGames 2026 Q13 and Q21 batteries (both finished their matches without browning out). Measured with
 * ocvCurve() at 0.5 Ah bins, R from current steps (11.3 and 11.4 mΩ).
 *
 * Caveat: two batteries from one weekend. Phase 2 replaces this with the team's own history.jsonl.
 */
export interface FleetPoint { ah: number; volts: number }

export const FLEET_REFERENCE: FleetPoint[] = [
  { ah: 0.25, volts: 11.94 },
  { ah: 0.75, volts: 11.8 },
  { ah: 1.25, volts: 11.74 },
  { ah: 1.75, volts: 11.6 },
  { ah: 2.25, volts: 11.44 },
  { ah: 2.75, volts: 11.44 },
  { ah: 3.25, volts: 11.3 },
  { ah: 3.75, volts: 11.2 },
  { ah: 4.25, volts: 11.01 },
  { ah: 4.75, volts: 10.8 },
  { ah: 5.25, volts: 10.78 },
  { ah: 5.75, volts: 10.5 },
  { ah: 6.25, volts: 10.38 },
]

/** Reference voltage at a charge, by straight lines between the points. NaN past the last point. */
export function fleetVoltageAt(ah: number): number {
  const pts = FLEET_REFERENCE
  if (ah <= pts[0].ah) return pts[0].volts
  for (let i = 1; i < pts.length; i++) {
    if (ah <= pts[i].ah) {
      const f = (ah - pts[i - 1].ah) / (pts[i].ah - pts[i - 1].ah)
      return pts[i - 1].volts + f * (pts[i].volts - pts[i - 1].volts)
    }
  }
  return NaN
}
