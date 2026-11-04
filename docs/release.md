# Releases

Every push to `main` that touches the app (see the paths in `.github/workflows/release.yml`) runs the tests, builds Mac, Windows and
Linux, and publishes release `v0.1.<commit count>`. The version is set at build time; package.json keeps its own number.
A push to `claude/auto-release` builds and uploads artifacts but never publishes.

Repository secrets:

- `HINDSIGHT_GOOGLE_CLIENT_ID`, `HINDSIGHT_GOOGLE_CLIENT_SECRET`: the Desktop OAuth client baked into the build (Drive sign-in).
- Mac signing, all optional together: `MAC_CSC_LINK` (base64 of the Developer ID Application .p12), `MAC_CSC_KEY_PASSWORD`,
  `APPLE_API_KEY_P8` (the App Store Connect API key file's text), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
  With `MAC_CSC_LINK` set the Mac build is signed, notarized and updates itself; without it the build is ad hoc and the app shows the update banner.

The build steps never hold `GH_TOKEN`; only the release job has `contents: write`.
