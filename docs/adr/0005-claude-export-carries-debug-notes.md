# 5. The Claude export carries the debug notes and lists its contents

Status: accepted, 2026-10-23

## Context

"Download for Claude" saves one file per match (findings, evidence numbers, short signal windows, the battery model,
never the Wi-Fi key hash) that a student can give to an AI assistant. The debug workspace adds ranked causes, the tests
run and what each ruled out. Hindsight has no model inside it (venue Wi-Fi, API keys in a public tool, logs leaving the
laptop).

## Decision

The export also carries the debug workspace's notes, and before it is saved it lists what is inside. The file leaves
the laptop only if the student uploads it.
