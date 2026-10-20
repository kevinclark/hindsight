/**
 * PhotonVision's pipeline result (proto:photonvision.proto.ProtobufPhotonPipelineResult), read only as far as
 * "how many targets": field 2 is the repeated `targets`, field 3 the optional multi-tag result (photon.proto).
 * Checked on the CalGames 2026 logs: 134,401 results from two cameras all parsed, and the multi-tag field was set
 * exactly when two or more targets were.
 */

function varint(b: Uint8Array, p: number): [number, number] | null {
  let value = 0
  for (let shift = 0; p < b.length && shift < 64; shift += 7) {
    const x = b[p++]
    value += (x & 0x7f) * 2 ** shift
    if (!(x & 0x80)) return [value, p]
  }
  return null
}

/** How many targets (AprilTags) the result lists; null if the bytes don't parse as protobuf. */
export function photonTargetCount(bytes: Uint8Array): number | null {
  let p = 0
  let targets = 0
  while (p < bytes.length) {
    const key = varint(bytes, p)
    if (!key) return null
    p = key[1]
    const field = Math.floor(key[0] / 8)
    switch (key[0] & 7) {
      case 0: { const v = varint(bytes, p); if (!v) return null; p = v[1]; break }
      case 1: p += 8; break
      case 5: p += 4; break
      case 2: {
        const len = varint(bytes, p)
        if (!len) return null
        p = len[1] + len[0]
        if (field === 2) targets++
        break
      }
      default: return null
    }
  }
  return p === bytes.length ? targets : null
}
