# Releases

Every push to `main` that touches the app (see the paths in `.github/workflows/release.yml`) runs the tests, builds Mac, Windows and
Linux, and publishes release `v0.1.<commit count>`. The version is set at build time; package.json keeps its own number.
A run by hand from another branch (Actions > release > Run workflow) builds and uploads artifacts but never publishes.

## What's new

A release's notes open with the `Changelog:` trailer of every commit since the last release. Give a commit one when someone
using the app would notice the change, as the last paragraph of its message, with any other trailers:

    Changelog: Pulling logs tries Ethernet first, then USB.

One short line for a student or mentor: what they can now do or see, no file names or internals. This repository is public,
so no names, matches or team verdicts. Tests, refactors and docs get none; a release with no lines says "Small fixes and
behind-the-scenes work."

The same lines are baked into each build: after an update, Now shows what landed since the version last seen on that computer,
until "Got it" (`src/now/changelog.ts`). A fresh install shows nothing.

Repository secrets:

- `HINDSIGHT_GOOGLE_CLIENT_ID`, `HINDSIGHT_GOOGLE_CLIENT_SECRET`: the Desktop OAuth client baked into the build (Drive sign-in).
- Mac signing, all optional together: `MAC_CSC_LINK` (base64 of the Developer ID Application .p12), `MAC_CSC_KEY_PASSWORD`,
  `APPLE_API_KEY_P8` (the App Store Connect API key file's text), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
  With `MAC_CSC_LINK` set the Mac build is signed, notarized and updates itself; without it the build is ad hoc and the app shows the update banner.

The build steps never hold `GH_TOKEN`; only the release job has `contents: write`.
