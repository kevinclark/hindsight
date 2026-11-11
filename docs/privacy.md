# Hindsight privacy

Hindsight is open-source software (BSD-3-Clause) that reads FRC robot logs. It has no server, no accounts of its own,
no analytics and no advertising. This page says what the desktop app and the iPhone app do with data. The page `hindsight.html`, opened
from a file, sends nothing anywhere.

## On your computer

- Logs you add are **copied** into the app's library folder on your computer. The originals are never moved, renamed or
  deleted.
- The app reads each log to find its date, event, match, battery and robot, and keeps those facts, a checksum and the file
  names in a list (a "manifest") beside the logs. Values you type in the Library view (driver, practice place, battery,
  robot) are kept in the same list.
- Settings and, if you sign in to Google, the sign-in token live in the app's data folder. On macOS and Windows the token is
  encrypted with the system keychain. Where the system has no keychain (Linux without a keyring) the token is not kept.

## Google Drive (optional)

If you sign in with Google, Hindsight asks for the `drive` permission. Google words it as access to all of your Drive
files; Hindsight uses it only to read the Drive folders you choose to import from, and to read and add files in the team folder
you choose. It never deletes, trashes or overwrites a file, and its code refuses to send such a request. Sign-in happens in
your browser; Hindsight never sees your Google password.

What goes into the team folder: copies of the logs you add, and a list of each log's facts, checksum, file names and the values
people typed (driver names included); the triage marks people make; and, for the phone app, each event's match summaries
(the findings and numbers Hindsight read from each log of every event in this computer's library, without the marks).
Everyone who can open the team folder can read it. Hindsight sends nothing to anyone else.

To stop: remove Hindsight at <https://myaccount.google.com/permissions>, and delete the app's library folder. Files already in
the team folder stay there until the folder's owners remove them.

## On an iPhone

The iPhone app shows what the team's laptops found and marked at the current event, and any log in the team folder you
open from its Library. It only reads; it changes nothing on Drive and makes no marks.

- **Google sign-in** asks for `drive.readonly`: Google words it as seeing all of your Drive files. The app reads only the
  team folder you choose (and, while you choose it, the names of the folders you browse): the files the laptops share
  there for the phone (each laptop's match summaries for every event it holds, and its triage marks), the laptops' lists of logs (for
  the Library, and for Match review to find a match's log), and a log and its Driver Station logs when you open one. Sign-in happens in Apple's sign-in sheet; the app
  never sees your Google password.
- **What stays on the phone:** the sign-in's refresh token in the iOS Keychain (kept for this device only: it does not move
  to a new phone); the team folder's id and name, the copies of the summaries, marks and lists it read (so it
  opens with the last copy when there is no signal; and the logs you opened most recently, up to the size you choose in the Library (1 GB to start), so reopening one needs no
  download), and the team number, The Blue Alliance read key and Nexus Pull API key you type, all in
  the app's own storage. Sign out removes the refresh token, the team folder, the copies and the kept logs at once; the typed keys
  stay until you clear them or delete the app, which removes everything.
- **Who it talks to:** Google (sign-in and Drive), The Blue Alliance and Nexus (the schedule and queue times, with your own
  keys). Nothing else.

To stop: Sign out in the app, then remove Hindsight at <https://myaccount.google.com/permissions>.

## Other network use

- **The robot:** when you ask, the app connects to the roboRIO on your network (its read-only status feed and its file
  server) to list and copy logs. Nothing is written to the robot.
- **Event schedule:** with a team number and your own The Blue Alliance read key (and, optionally, a Nexus Pull API key),
  the app asks The Blue Alliance and Nexus for the event's schedule, results and queue times.
- **Updates:** on start the app asks `api.github.com` once for the list of Hindsight releases, to show a "newer version" notice.
  GitHub sees your address as for any web request.

## Questions

Open an issue at <https://github.com/kevinclark/hindsight/issues>.
