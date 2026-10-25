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
- **Filters** (within a facet OR, across facets AND; a count is how many logs with that value the list would hold, shown
  as "+N", what it would add, beside a pick in the same facet): school year, season or off-season, event or practice place, match
  type, battery, robot, driver. Place (per day), driver (per day or per log), battery and robot (per log) are typed in the
  list and saved as tags. Season is kickoff to the end of Championship (`src/hub/season.ts`: only 2026 is checked).
- **Robot** is named from a profile only when the log's own Codebase (and branch) matched one, or a profile fit by signals.
  A best guess that does not fit is not an identity: the list shows the log's Codebase text marked "(code name)", or nothing.
- **Event** shown for an on-field log is the name from `src/hub/events/<year>.json` (TBA event code, or an FMS division word,
  to name) when the table has it; a day whose logs are all on the field with one such name shows it with no input. The table
  is generated with `TBA_READ_KEY=… node --experimental-strip-types scripts/build-event-table.ts <year>`; the committed
  files hold a seed (`_source`) until that has been run. A typed place never overrides an FMS name.
- **Read logs again** re-describes every robot log on this computer with this version and appends a `meta` record to this
  computer's manifest for each (the catalog lays the latest over the log record; `kind`, `playedAt` and `dateSource` never
  change, as they decide the file's path; only the describable fields (`DESCRIBABLE_KEYS` in `src/hub/types.ts`), each of the
  right shape, are ever laid over a log, because a teammate's manifest is untrusted input). A record names the describer that
  wrote it, `<app version>+<hash of the files describing a log depends on>` (`describerHash` in `vite.build-id.ts`: everything
  `describe.ts` imports, so a change to the Library view does not make every log read again): the catalog prefers the newer
  app version, and with the same version the later record (the hash is not ordered). A log whose
  latest record already names this build, or a strictly newer app version, is skipped (reported as `skipped`), so a second run reads nothing; a log that reads
  the same still gets a record, which is what marks it as read. It is a job like the others: one at a time, with a bar. A
  code link survives a re-reading: it is copied into the new record.
- **Older builds ignore `meta` lines.** A build from before this record type counts them in the manifest's `skipped` total
  (which nothing in the UI shows) and keeps showing the first reading of each log. Nothing breaks; the fix appears when that
  computer updates.
- **The event table is a seed until it is generated.** `src/hub/events/*.json` holds only entries checked by hand
  (`"_source": "seed, not generated"`); a code not in it keeps the FMS text and a typed place. Generate a year with
  `TBA_READ_KEY=… node --experimental-strip-types scripts/build-event-table.ts <year>`.
- **Link code** (Library view, "Your team" box; settings keep `team` and `codeSources`: GitHub organizations as `name` or repos as
  `owner/name`, chosen on this computer, never in the repo). For logs whose robot only has a Codebase text, the button reads
  each repo's `src/main/java/frc/robot/Robot.java` at its default branch from raw.githubusercontent.com (not counted by
  GitHub) for `recordMetadata("Codebase", "…")`, and, for a log with a build commit, asks `GET /repos/{repo}/commits/{sha}`
  of each repo recording that text (a 404 or 422 is "not there"; only `.sha` is read). The label shows *at least* how many **API**
  requests it will make (unauthenticated GitHub allows 60 an hour per network): one listing per source (per 100 repos, paged;
  a bare name that is no organization is tried as a user, one more), plus one commit check per repo that records that
  Codebase text, per distinct build commit. The button shows "(no logs to link)" and is disabled when no log needs a link,
  adding "read logs again first?" when some robot log was filed before any reading was stamped. A failed commit check (not
  404, 422 or the limit) counts as "not there" for that run, adds a problem line, and is asked again next time. Writing a
  link that is the same as the one held (but for `checkedAt`) writes nothing. A log with no reading stamped yet gets the link
  record under this build's id, so "Read logs again" will skip it until a newer version; run it first. Not done: sharing
  `src/code/github.ts` (it has no org listing or commits lookup), and re-checking commits known to be missing. It stops at the first "no requests remain" answer, says when the
  limit resets and keeps what it linked. Two repos recording one text: the one holding the commit wins; with no commit, a name
  without "template" or "training", then the latest push; the others are kept as `candidates`. The link is stored as a `meta`
  record (`code`: repo, `linkedBy` `sha` or `codebase`, full sha when by commit, `checkedAt`). No tag or branch other than
  the default is tried, so a Codebase line that moved off the default branch is not found.
- **Your team** (top of the Library view). The team number (a whole number, 1 to 99999) and the GitHub sources are saved together
  (`hub:setTeam`; both are checked first). With the number set, the Session view's and Match review's robot lists show that
  team's built-in robots and the kept profiles that are its or have no team; other teams' robots are left out, except those
  the session's own logs use. With no number (or the page opened from disk, which has no settings) every robot is listed,
  grouped by team. Automatic robot choice is unchanged and still sees every profile. Saving runs the full
  Link code pass once, uncapped, because saving is the user's own action, but only when the sources differ from those of the last pass that
  finished (a new team number alone asks GitHub nothing; a pass that failed or hit the rate limit is tried again on the next save).
- **Logs are linked when they are added.** After an add (folder, Drive or robot) that was not stopped, the logs it added that
  name only their code and have no link yet are linked in the same job, with at most 20 GitHub API requests (one listing per
  source plus one commit check per new build commit; the raw `Robot.java` reads are not counted). At the cap it stops, keeps
  what it linked, and the add's report says "Stopped after 20 GitHub requests; Link code finishes the rest" (the cap is ours,
  not GitHub's limit). Codebase-only links are not re-checked on add; the button does the full pass. Nothing is asked of
  GitHub when no added log needs a link.
- **Draft a profile from the linked code.** In the Session view, a session whose robot was chosen by signals or by the log's
  code name, and whose logs carry a code link, shows "This robot's code is `repo` at `sha`" with *Draft a profile from it*.
  It opens the Robot profile page with that log loaded and "Use GitHub" filled in (`repo@commit`, or the log's branch when
  the commit is not on GitHub); the student presses Read, so the GitHub requests stay theirs. Nothing is used until the
  profile is kept; then the session finds it by code name. The Library's robot facet comes from the built-in profiles only,
  so it keeps showing the code name.
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
- **The triage history** (known issues, and the issue board's lines) is `history/<machine id>.jsonl`, appended only by that
  computer, beside the manifests. The board is the fold of every file (`hub:history`; order by when, device, seq; lines
  this build can't read are kept as they came). Sync brings teammates' files down and puts this computer's up by the
  manifests' rule: a copy is replaced only by a longer one that starts with it, anything else is a problem and nothing is
  overwritten. In the app, marking an issue appends there, not to the browser store; the first open moves what the
  browser store holds that the library lacks, once, and says so in one line. "Save hindsight-history.jsonl" stays as an
  export. The page opened from disk keeps the browser store and the file.
- Each computer appends only to its own `manifests/<machine id>.jsonl`, so Drive never makes a conflict copy. The library
  is the union of every manifest. The team folder is chosen in the app and remembered on that computer: it is not in this
  repository.
- Logs the team has and this computer lacks are listed with a size; **Download** fetches them under a temp name and
  renames each only after its sha-256 matches.

## The robot

`Pull logs off the robot` lists the roboRIO over SFTP (the `ssh2` package; nothing runs on the robot) only while it is
disabled and not on the field (read over NT4 with Foresight's read-only client and field guard; if it can't tell, it
refuses). It skips files modified in the last 30 s or still growing. It never deletes on the robot.

## Updates

On start the app asks the public repository's releases once. When a newer app release (`vX.Y.Z`) exists, a banner says
"Hindsight X.Y is out: download". Unsigned Mac builds cannot update themselves.

## Limits

- Drive can hold two files of one name, and "does it exist, then create it" is not atomic: two computers uploading the same
  path at once can leave two files (the library reads one). Sync from one computer at a time.
- The robot's idle check runs once, before the pull; an enable during the pull is not noticed.
- An upload is resumed within a run, not after Hindsight is closed (the upload session address is not kept).
- Phoenix `.hoot` names are read as UTC (assumed, not compared with a hoot file's own clock).

## Not verified

See the session note for what was exercised live and what only in tests. In short: the Drive adapter has been run live once
(2026-10-22: a first sync of four logs, a second that wrote nothing, a tag update in place, a second library that downloaded
them and matched every sha-256), and Drive answered one request with a 403 rate limit, which the adapter now waits out; the
robot pull has not touched a roboRIO; the Windows and Linux installers were built but not launched.
