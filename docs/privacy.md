# Hindsight privacy

Hindsight is open-source software (BSD-3-Clause) that reads FRC robot logs. It has no server, no accounts of its own,
no analytics and no advertising. This page says what the desktop app does with data. The page `hindsight.html`, opened
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
people typed (driver names included). Everyone who can open the team folder can read it. Hindsight sends nothing to anyone else.

To stop: remove Hindsight at <https://myaccount.google.com/permissions>, and delete the app's library folder. Files already in
the team folder stay there until the folder's owners remove them.

## Other network use

- **The robot:** when you ask, the app connects to the roboRIO on your network (its read-only status feed and its file
  server) to list and copy logs. Nothing is written to the robot.
- **Updates:** on start the app asks `api.github.com` once for the list of Hindsight releases, to show a "newer version" notice.
  GitHub sees your address as for any web request.

## Questions

Open an issue at <https://github.com/kevinclark/hindsight/issues>.
