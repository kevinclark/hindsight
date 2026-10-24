/**
 * The public pages the rules cite (a rule's `sources`, src/rules/rule.ts). A rule picks a page from here and says
 * what that page tells a reader about THIS rule:
 *
 *   sources: [{ ...WPILIB_BROWNOUTS, says: 'Below 6.3 V (roboRIO 1) the controller switches the motors off.' }]
 *
 * Add a page here only after opening it and reading the passage the rule leans on. Prefer, in order: the vendor's
 * own docs (CTRE, REV, WPILib, AdvantageKit, PhotonVision), FIRST's documents, papers and standards, then Chief
 * Delphi threads. A thread is cited by its post number, so the link lands on the post that says it.
 */
import type { Source } from './rule.ts'

/** A page without the sentence: the rule adds `says`. */
type Page = Omit<Source, 'says'>

const vendor = (title: string, url: string): Page => ({ title, url, kind: 'vendor' })
const forum = (title: string, url: string): Page => ({ title, url, kind: 'forum' })

// WPILib
export const WPILIB_BROWNOUTS = vendor('WPILib: roboRIO brownouts', 'https://docs.wpilib.org/en/stable/docs/software/roborio-info/roborio-brownouts.html')
export const WPILIB_DS = vendor('WPILib: Driver Station', 'https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station.html')
export const WPILIB_DS_BEST_PRACTICES = vendor('WPILib: Driver Station best practices', 'https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station-best-practices.html')
export const WPILIB_DS_LOG_VIEWER = vendor('WPILib: Driver Station Log Viewer', 'https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station-log-viewer.html')
export const WPILIB_DS_MESSAGES = vendor('WPILib: Driver Station errors and warnings', 'https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station-errors-warnings.html')
export const WPILIB_ALERTS = vendor('WPILib: Persistent alerts', 'https://docs.wpilib.org/en/stable/docs/software/telemetry/persistent-alerts.html')
export const WPILIB_PREEMPTIVE = vendor('WPILib: Preemptive troubleshooting', 'https://docs.wpilib.org/en/stable/docs/hardware/hardware-basics/preemptive-troubleshooting.html')
export const WPILIB_STACKTRACES = vendor('WPILib: Reading stacktraces', 'https://docs.wpilib.org/en/stable/docs/software/basic-programming/reading-stacktraces.html')
export const WPILIB_AUTO_CHOOSER = vendor('WPILib: Choosing an autonomous program from SmartDashboard', 'https://docs.wpilib.org/en/stable/docs/software/dashboards/smartdashboard/choosing-an-autonomous-program-from-smartdashboard.html')
export const WPILIB_COMMAND_COMPOSITIONS = vendor('WPILib: Command compositions', 'https://docs.wpilib.org/en/stable/docs/software/commandbased/command-compositions.html')
export const WPILIB_GYROS = vendor('WPILib: Gyros in software', 'https://docs.wpilib.org/en/stable/docs/software/hardware-apis/sensors/gyros-software.html')
export const WPILIB_JOYSTICKS = vendor('WPILib: Joysticks', 'https://docs.wpilib.org/en/stable/docs/software/basic-programming/joystick.html')
export const WPILIB_POSE_ESTIMATORS = vendor('WPILib: Pose estimators', 'https://docs.wpilib.org/en/stable/docs/software/advanced-controls/state-space/state-space-pose-estimators.html')
export const WPILIB_POWER_DISTRIBUTION = vendor('WPILib: Power Distribution Module', 'https://docs.wpilib.org/en/stable/docs/software/can-devices/power-distribution-module.html')
export const WPILIB_CONTROL_SYSTEM_HARDWARE = vendor('WPILib: Control system hardware overview', 'https://docs.wpilib.org/en/stable/docs/controls-overviews/control-system-hardware.html')
export const WPILIB_DEPLOY_GIT = vendor('WPILib: Including Git data in deploy', 'https://docs.wpilib.org/en/stable/docs/software/advanced-gradlerio/deploy-git-data.html')

// CTRE (Phoenix 6)
export const CTRE_CURRENT_LIMITS = vendor('CTRE Phoenix 6: Improving performance with current limits', 'https://v6.docs.ctr-electronics.com/en/stable/docs/hardware-reference/talonfx/improving-performance-with-current-limits.html')
export const CTRE_CURRENT_LIMITS_CONFIG = vendor('CTRE Phoenix 6 API: CurrentLimitsConfigs', 'https://api.ctr-electronics.com/phoenix6/latest/csharp/api/CTRE.Phoenix6.Configs.CurrentLimitsConfigs.html')
export const CTRE_STATUS_SIGNALS = vendor('CTRE Phoenix 6: Status signals', 'https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/status-signals.html')
export const CTRE_FAULTS = vendor('CTRE Phoenix 6: Device faults', 'https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/faults.html')
export const CTRE_CAN_TROUBLESHOOTING = vendor('CTRE Phoenix 6: CAN bus troubleshooting', 'https://v6.docs.ctr-electronics.com/en/stable/docs/troubleshooting/canbus-troubleshooting.html')
export const CTRE_CANIVORE_API = vendor('CTRE Phoenix 6: CANivore API', 'https://v6.docs.ctr-electronics.com/en/stable/docs/canivore/canivore-api.html')
export const CTRE_TALONFX = vendor('CTRE Phoenix 6: Talon FX hardware reference', 'https://v6.docs.ctr-electronics.com/en/stable/docs/hardware-reference/talonfx/index.html')
export const CTRE_TALONFX_API = vendor('CTRE Phoenix 6 API: CoreTalonFX', 'https://api.ctr-electronics.com/phoenix6/stable/csharp/api/CTRE.Phoenix6.Hardware.Core.CoreTalonFX.html')
export const CTRE_PARENT_DEVICE_API = vendor('CTRE Phoenix 6 API: ParentDevice', 'https://api.ctr-electronics.com/phoenix6/stable/csharp/api/CTRE.Phoenix6.Hardware.ParentDevice.html')
export const CTRE_PIGEON2_API = vendor('CTRE Phoenix 6 API: CorePigeon2', 'https://api.ctr-electronics.com/phoenix6/stable/csharp/api/CTRE.Phoenix6.Hardware.Core.CorePigeon2.html')
export const CTRE_PIGEON2 = vendor('CTRE Phoenix 6: Pigeon 2 hardware reference', 'https://v6.docs.ctr-electronics.com/en/stable/docs/hardware-reference/pigeon2/index.html')
export const CTRE_CANCODER = vendor('CTRE Phoenix 6: CANcoder hardware reference', 'https://v6.docs.ctr-electronics.com/en/stable/docs/hardware-reference/cancoder/index.html')
export const CTRE_REMOTE_SENSORS = vendor('CTRE Phoenix 6: TalonFX remote sensors', 'https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/device-specific/talonfx/remote-sensors.html')
export const CTRE_FOLLOWER_API = vendor('CTRE Phoenix 6 API: Follower', 'https://api.ctr-electronics.com/phoenix6/stable/csharp/api/CTRE.Phoenix6.Controls.Follower.html')
export const CTRE_DEVICE_LIST = vendor('CTRE Phoenix Tuner X: Device list', 'https://pro.docs.ctr-electronics.com/en/latest/docs/tuner/device-list.html')
export const CTRE_TUNER_ELEVATOR = vendor('CTRE Phoenix Tuner X: Elevator calibration and limits', 'https://pro.docs.ctr-electronics.com/en/stable/docs/tuner/tuner-elev/calibration-and-limits.html')

// Other vendors
export const ADVANTAGEKIT_LOGGING = vendor('AdvantageKit: Built-in logging', 'https://docs.advantagekit.org/data-flow/built-in-logging')
export const ADVANTAGEKIT_INSTALL = vendor('AdvantageKit: Installation in an existing project', 'https://docs.advantagekit.org/getting-started/installation/existing-projects')
export const PHOTON_MULTITAG = vendor('PhotonVision: MultiTag localization', 'https://docs.photonvision.org/en/latest/docs/apriltag-pipelines/multitag.html')
export const PHOTON_LATENCY = vendor('PhotonVision: End-to-end latency characterization', 'https://docs.photonvision.org/en/latest/docs/contributing/design-descriptions/e2e-latency.html')
export const PHOTON_TIME_SYNC = vendor('PhotonVision: Time synchronization protocol', 'https://docs.photonvision.org/en/latest/docs/contributing/design-descriptions/time-sync.html')
export const PHOTON_CAMERA_API = vendor('PhotonVision API: PhotonCamera', 'https://javadocs.photonvision.org/release/org/photonvision/PhotonCamera.html')
export const REV_PDH_SPECS = vendor('REV Robotics: Power Distribution Hub specifications', 'https://docs.revrobotics.com/ion-control/pdh/specs.md')
export const REV_ATO_BREAKERS = vendor('REV Robotics: ATO auto-resetting breakers', 'https://docs.revrobotics.com/ion-control/pdh/specs/rev-ato-auto-resetting-breakers')
export const WCP_KRAKEN_PERFORMANCE = vendor('WCP: Kraken X60 motor performance', 'https://docs.wcproducts.com/welcome/electronics/kraken-x60/kraken-x60-motor/overview-and-features/motor-performance')
export const MK_ES17_12 = vendor('MK Battery: ES17-12 specifications', 'https://revrobotics.com/content/docs/ES17-12_User_Guide.pdf')
export const BUSSMANN_SERIES_18X = vendor('Cooper Bussmann: Series 18X Hi-Amp circuit breaker data sheet', 'https://s3.amazonaws.com/docusync-files/baba5c15ada1218997f9c616c919a604de5ef6211d61b85852209a2503b05a7b/am-0282%20data_sheet.pdf')
export const PWF_BATTERY_FUEL_GAUGE: Page = { title: 'Playing With Fusion: Battery Fuel Gauge user manual', url: 'https://www.playingwithfusion.com/files/rob70001_frc_usermanual_r02.pdf', kind: 'manual' }

// FIRST
export const GAME_MANUAL_2026: Page = { title: '2026 FIRST Robotics Competition Game Manual (REBUILT, TU22)', url: 'https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf', kind: 'standard' }

// Chief Delphi (by post)
export const CD_BATTERY_IMPEDANCE = forum('Chief Delphi: "Severe Voltage Drop & Swerve Steer Jitter with CTRE Swerve", post 25', 'https://www.chiefdelphi.com/t/481104/25')
export const CD_BATTERY_IR_MATCH_ONLY = forum('Chief Delphi: "Yet another power usage thread", post 52', 'https://www.chiefdelphi.com/t/519109/52')
export const CD_BATTERY_ACCEPTANCE = forum('Chief Delphi: "Everything On Batteries", post 33', 'https://www.chiefdelphi.com/t/518160/33')
export const CD_BATTERY_REST_SWAP = forum('Chief Delphi: "2026 battery offerings, testing, and discussion", post 103', 'https://www.chiefdelphi.com/t/509748/103')
export const CD_BATTERY_CBA_LINE = forum('Chief Delphi: "2026 battery offerings, testing, and discussion", post 115', 'https://www.chiefdelphi.com/t/509748/115')
export const CD_BATTERY_TRACKING = forum('Chief Delphi: "2026 Playing with Fusion Product Launch: Advanced Battery Solution", post 35', 'https://www.chiefdelphi.com/t/507717/35')
export const CD_MAIN_BREAKER_TRIPS = forum('Chief Delphi: "Do we want a swerve killer", post 40', 'https://www.chiefdelphi.com/t/462220/40')
export const CD_MAIN_BREAKER_CAUSES = forum('Chief Delphi: "Disabled robots on Einstein", post 31', 'https://www.chiefdelphi.com/t/519830/31')
export const CD_CANIVORE_USB = forum('Chief Delphi: "Repeated Issues with CANivore"', 'https://www.chiefdelphi.com/t/repeated-issues-with-canivore/516663')
export const CD_USB_HUB_CPU = forum('Chief Delphi: "Brownout Issues with just swerve and High Roborio CPU Usage", post 50', 'https://www.chiefdelphi.com/t/518203/50')
export const CD_LOOP_OVERRUN = forum('Chief Delphi: "Watchdog Not Fed - Motion Magic dropping - Java recommendations"', 'https://www.chiefdelphi.com/t/watchdog-not-fed-motion-magic-dropping-java-recommendations/346661')
