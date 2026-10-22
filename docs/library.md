# The log library (desktop app)

The desktop app is the same page as `hindsight.html` in an Electron window, plus a **Library** tab: every log the team has
brought in, filtered, opened in the Session view. `npm run build` still makes `hindsight.html` from the same source for
dropping a log with nothing installed; the Library tab exists only in the app.

## Run it

```
npm run app            # build the page and the app's own code, start the window
npm run dist:app       # installers into release/ (dmg + zip, NSIS, AppImage), unsigned
```

The Google client (see "Drive") comes from the environment at build time: `HINDSIGHT_GOOGLE_CLIENT_ID` and
`HINDSIGHT_GOOGLE_CLIENT_SECRET`. Without them the app has no Google sign-in until a client is pasted in the Team Drive
panel. Neither is committed.

## What it does

- **Add logs…** takes a folder on this computer (any structure, recursive), a Drive folder (any the signed-in user can
  see, recursive) or the robot. For every `.wpilog`, `.hoot`, `.dslog`, `.dsevents` it keeps a **copy** in the library
  and writes a record; the original is never moved, renamed or deleted.
- **Identity is content** (sha-256). The same bytes under two names are one log with both names; a re-run finds everything
  already there and writes nothing. A Drive file whose checksum the library already has is not downloaded.
- **Filing is by what the log says**, not its name: `logs/<school year, Aug-Jul>/<YYYY-MM-DD>/<original name>`
  (`-<first 8 sha digits>` before the extension on a name clash; `logs/undated/` when nothing dates it). The date is the
  robot clock, else the AdvantageKit file name (read as UTC from 2026, Pacific for 2025 and earlier), and the day is the
  computer's local day. Event and match come from `/DriverStation/MatchType` + `MatchNumber`, never the name.
- `.dslog` and `.dsevents` attach to the robot log whose match they overlap on the wall clock. `.hoot` files are stored
  unparsed (Hindsight has no hoot reader and CTRE's converter is never bundled); they attach by the time in their name,
  else the roboRIO's modified time recorded at the pull.
- The **report** after an import lists what was added, what was already there (under which name), what could not be read
  (and why), logs with no date, and stubs (under 1 MB, never enabled).
- **Filters** (within a facet OR, across facets AND): school year, season or off-season, event or practice place, match
  type, battery, robot, driver. Place (per day), driver (per day or per log), battery and robot (per log) are typed in the
  list and saved as tags. Season is kickoff to the end of Championship (`src/hub/season.ts`: only 2026 is checked).
- **Open in Session view** reads the filtered logs one at a time into the Session view.

## Sharing through the team's Drive

- Sign in with Google (system browser, loopback redirect, PKCE; scope `drive`). The app is *unverified*: Google warns,
  and at most 100 users can sign in. The consent screen must be published, not left in Testing (7-day tokens).
- The refresh token is encrypted with Electron's `safeStorage` and kept in the app's data folder. Where there is no
  keyring (Linux) it is not kept. On a Mac, reading `safeStorage` makes the system ask for Keychain permission, so the app
  does that only at sign-in.
- **Sync** (one named plan, then a click): downloads teammates' manifests, uploads this computer's logs the team folder
  lacks (a log that came from Drive is copied *inside* Drive), then publishes this computer's records. A log's record is
  written only after its file is there, so a failed upload leaves no record. Nothing is deleted or overwritten.
- Each computer appends only to its own `manifests/<machine id>.jsonl`, so Drive never makes a conflict copy. The library
  is the union of every manifest. The team folder is chosen in the app and remembered on that computer: it is not in this
  repository.
- Logs the team has and this computer lacks are listed with a size; **Download** fetches them under a temp name and
  renames each only after its sha-256 matches.

## The robot

`Add logs from the robot` lists the roboRIO over SFTP (the `ssh2` package; nothing runs on the robot) only while it is
disabled and not on the field (read over NT4 with Foresight's read-only client and field guard; if it can't tell, it
refuses). It skips files modified in the last 30 s or still growing. It never deletes on the robot.

## Updates

On start the app asks the public repository's releases once. When a newer app release (`vX.Y.Z`) exists, a banner says
"Hindsight X.Y is out: download". Unsigned Mac builds cannot update themselves.

## Not verified

See the session note for what was exercised live and what only in tests. In short: the Drive adapter has been run against a
fake of the Drive API, not Google; the robot pull has not touched a roboRIO; the Windows and Linux installers were built but
not launched.
