# 2026-10-23: the profile builder on robots built from AdvantageKit's TalonFX swerve template

Merged as bc34c5f (branch `claude/outside-robots`).

## What changed

- `src/code/check/devices.ts`: a CAN bus written `new CANBus(<a constant>)` is the constant's name. It was read as the
  roboRIO bus, which is a wrong value. An argument that can't be worked out gives no device.
- `src/builder/motors.ts`: `<motor>SupplyAmpsAbs` is that motor's supply current, and `…AbsAvg` is listed as not
  used. The draft notes that an absolute value counts regeneration as draw.
- `src/builder/code-motors.ts`, `src/code/check/flow.ts`, `src/code/check/device-settings.ts`: the template's module
  folders (`"Drive/Module" + Integer.toString(index)`), IDs from CTRE's `createModuleConstants(steer, drive, encoder,
  …)`, the factory's `.with…` values, and the limits `ModuleIOTalonFX` writes on the config it starts from.

## Evidence

- Two public robots built on the template, scored by hand against their code at each log's commit: every swerve
  motor's ID, kind and limits came out right. Before, they had no IDs or limits, and on one robot no supply current.
- Builder backtest over 739 logs, before and after: no 8033 robot's output changed.
- code-check backtest: PASS.
- vitest 1044 pass, svelte-check 0 errors.

## Left on purpose

- A folder passed as a call argument (`log("Intake")`) on a class whose method is reached through its constructors is
  open. A test pins it. Appending constructor chains to call chains would pair one object's folder with another's IO.
- A team's own method named `createModuleConstants` isn't read in CTRE's argument order: it gives no ID.
- A supply lower limit (`SupplyCurrentLowerLimit`/`LowerTime`) isn't part of a profile's limits.
