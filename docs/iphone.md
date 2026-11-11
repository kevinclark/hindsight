# The iPhone app

The phone shows what the team's laptops found and marked at the current event (or any earlier event a laptop published,
picked on the event line; Match review shows the laptop's summary, or, when the phone has that match's log in its Library,
reads the whole log itself: at once if the phone kept it, else after a "Full review" button downloads it; a match recorded in several logs, because the robot program restarted mid-match, gets the summary only), and opens any team log
from its Library (downloaded whole; the most recent kept on the phone, 1 GB to start, set in the Library; iOS gives an app's storage an
undocumented limit and never asks, so the phone may keep less than the size chosen), read only, from the team's Google Drive folder (design: the phone pages in `src/phone.ts`, `src/hub/browser-hub.ts`; what it keeps and sends: `docs/privacy.md`).
It is the same page as the laptop's, built for the phone (`phone.html`, `vite.phone.config.ts`) and run in a Capacitor 8
WKWebView (`ios/`).

## What the native side does

`ios/App/App/HindsightNativePlugin.swift` (its JavaScript side: `src/phone/native.ts`) does three things:

- **Sign-in**: Google refuses sign-in inside a WKWebView, so it opens in ASWebAuthenticationSession. The app is a Google
  **iOS** OAuth client (no secret); Google redirects to the client id reversed (`com.googleusercontent.apps.…`), which is
  also the URL scheme in `Info.plist`. PKCE, scope `PHONE_SCOPE` (`src/phone/google.ts`, `src/hub/oauth.ts`).
- **Keychain**: the refresh token, this device only (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- **HTTP**: requests to `www.googleapis.com`, `oauth2.googleapis.com`, `www.thebluealliance.com` and `frc.nexus` only,
  bodies as base64 both ways, the answer's bytes untouched (`src/phone/native-fetch.ts`; the page's `fetch` is routed
  there for those hosts; a redirect to any other host is refused). CORS doesn't force this (measured 2026-11-08: all four
  hosts allow `capacitor://localhost`); it is kept as insurance against that changing, for reads with no cache or
  cookies, and as one host list. Not CapacitorHttp: it parses any `application/json` answer, which would break the
  sha-256 check on Drive's files.

## Build

Needs Xcode 26 or later (with an iOS Simulator runtime) and Node 22 or later. If `xcode-select -p` still points at the
command-line tools, prefix the Xcode commands with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

```bash
npm ci
npm run phone            # the real app: builds dist-phone/ and copies it into ios/
npm run phone:fixture    # the invented event, no sign-in
PHONE_BUILD=selftest npm run build:phone && npx cap copy ios   # checks the native bridge, prints HINDSIGHT-SELFTEST lines
```

Simulator, from the command line:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/DerivedData build CODE_SIGNING_ALLOWED=NO
xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch --console-pty booted io.github.kevinclark.hindsight
```

Or `npx cap open ios` and Run in Xcode.

## On your own iPhone (development signing)

1. Xcode › Settings › Accounts: add your Apple ID.
2. iPhone: Settings › Privacy & Security › Developer Mode: on (the phone restarts). Connect it by cable and tap Trust.
3. `npm run phone`, then `npx cap open ios`; target App › Signing & Capabilities: tick "Automatically manage signing" and
   pick your team. Choose the iPhone as the run destination and Run. Picking a team writes `DEVELOPMENT_TEAM` into
   `project.pbxproj`: don't commit that hunk.
4. With a free (personal) team only: on the phone, Settings › General › VPN & Device Management › trust your Apple ID.
   An app signed by a free team stops opening after 7 days; build it again.
5. In the app: Sign in with Google. iOS first asks whether Hindsight may use google.com to sign in: Continue. Use the
   account that can open the team folder, allow Drive access, choose the team folder.

Signing files (`.p8`, `.p12`, provisioning profiles) never go in this repository; `.gitignore` refuses them.

## Not yet

- TestFlight and a CI build (Apple Distribution signing, App Store Connect).
- App icon and launch image: the template's placeholder images are kept out of the repository (text only); a real icon
  comes with the TestFlight build. Without them the app builds (4 warnings) with no icon.
