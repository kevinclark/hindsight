/**
 * Does each camera see an AprilTag? (An assisted check: a student holds a tag up.)
 *
 * Checks (Foresight, the live pit check, only): whether the camera saw at least one AprilTag during the disabled
 * stretch, from its raw PhotonVision result; an accepted pose counts too (and is all it has when the result is not
 * sent). In the pit or the queue usually no tag is
 * in view, so until it has seen one this is a step for a person ("hold a tag up to Back_Left"), not a fault, and it
 * never moves the verdict. The pass lasts as long as the stretch: after the robot is driven, or after 15 min, the
 * oldest records are gone and the step comes back (a camera knocked during a drive should be shown a tag again).
 * Why the raw result and not the accepted pose: on this robot the pose is logged only from two or more tags (multi-
 * tag), so a single hand-held tag never makes one. 2026 logs (three matches; both cameras): 0 of 19,095
 * one-tag results logged a pose; all 20,873 results with two or more did; no pose without a tag.
 */
import { rule } from '../rule.ts'
import { PHOTON_MULTITAG } from '../sources.ts'

export default rule({
  id: 'foresight/camera-sees-tag',
  title: 'Camera has not seen an AprilTag yet',
  severity: 'info',
  judges: 'performance',
  foresightOnly: true,
  who: ['pit', 'software'],
  meaning: 'This camera has not reported an AprilTag since the check started. In the pit that is normal: hold a tag in front of it to prove it is on and detecting.',
  causes: [
    { id: 'none-in-view', cause: 'No tag is in front of the camera (the usual reason in the pit)', look: 'hold a printed AprilTag 0.5–2 m in front of the lens' },
    { id: 'pipeline', cause: 'The camera is on the wrong pipeline, or its exposure or tag family is wrong', look: 'the PhotonVision dashboard: the camera\'s pipeline, tag family (36h11) and the live image' },
    { id: 'connection', cause: 'The camera or coprocessor is not running (loose cable, no power)', look: 'the camera\'s USB cable and the coprocessor\'s power and Ethernet' },
  ],
  nextStep: 'Hold an AprilTag (36h11, the field\'s family) 0.5–2 m in front of the camera until this line clears.',
  incident: 'The team\'s 2026 pit checklist: "All cameras on and detecting AprilTags"',
  sources: [
    { ...PHOTON_MULTITAG, says: 'Enabling multi-target estimation turns off the per-tag camera-to-target calculations unless "Always Do Single-Target Estimation" is on.' },
  ],
  thresholds: [
    { name: 'a pose from one tag', value: 'none', basis: 'measured', how: 'On the 2026 logs, 0 of 19,095 one-tag results logged a pose; all 20,873 results with two or more tags did.' },
    { name: 'how long a pass lasts', value: 'until the robot is driven, or 15 min', basis: 'judgment', how: 'Chosen: the oldest records are gone after 15 min.' },
  ],
  forEach: 'camera',

  check(camera, match) {
    const stretch = match.pitStretch
    // Strictly inside the stretch: the value held at its start is from before it.
    const during = [{ start: stretch.start + 1e-6, end: stretch.end + 1e-6 }]
    const hasResult = camera.resultKey !== null && match.has(camera.resultKey)
    // Live, the pose topic appears only once the code first made a pose; until then there is none to count.
    const hasPose = match.has(camera.acceptedPoseKey)
    if (!hasResult && !hasPose) return match.couldNotCheck(`${camera.name} sends neither its camera result nor a pose`)
    const tags = hasResult ? camera.tagsSeen().samples(during) : []
    const isDuringCheck = (t: number) => t > during[0].start && t <= stretch.end
    const poses = hasPose ? camera.acceptedPose().series.t.filter(isDuringCheck).length : 0
    if (tags.some((n) => n >= 1) || poses > 0) return

    // With only the pose to go on, one tag may not be enough (this robot's code makes a pose only from two).
    let message = `Hold two AprilTags up to ${camera.name} (it reports only poses)`
    let evidence: Record<string, number> = { 'poses since the check started': 0 }
    if (hasResult) {
      message = `Hold an AprilTag up to ${camera.name}`
      evidence = { 'camera results since the check started': tags.length, 'results with a tag': 0 }
    }
    return { message, at: stretch.end, evidence }
  },
})
