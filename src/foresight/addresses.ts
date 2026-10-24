/**
 * The addresses Foresight offers for a robot, from the team number (FRC's own rule): the roboRIO is 10.TE.AM.2 with the team
 * number split as TE.AM (254 is 10.2.54.2, 9999 is 10.99.99.2, 12345 is 10.123.45.2), and answers to roborio-<team>-frc.local. The USB tether is the
 * same for every team. Without a team number only USB is offered.
 */
export interface RobotAddress { value: string; label: string }

export const USB_ADDRESS: RobotAddress = { value: '172.22.11.2', label: 'USB tether' }

/** A team number the 10.TE.AM.2 rule can express: TE is 0 to 255 (WPILib), so 1 to 25599. */
export const validTeam = (team: number | null | undefined): team is number => Number.isInteger(team) && team! >= 1 && team! <= 25599

export function robotAddresses(team: number | null | undefined): { addresses: RobotAddress[]; note: string | null } {
  if (!validTeam(team)) return { addresses: [USB_ADDRESS], note: "A team number (the Session view's Blue Alliance fields, or the app's team setting) adds the Ethernet and by-name addresses." }
  return {
    addresses: [
      USB_ADDRESS,
      { value: `10.${Math.floor(team / 100)}.${team % 100}.2`, label: 'Ethernet tether' },
      { value: `roborio-${team}-frc.local`, label: 'by name' },
    ],
    note: null,
  }
}
