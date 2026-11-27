# How the desktop app updates itself

Cavvy updates itself in one of two ways, depending on how it was installed.

- **Built from a checkout** (`bun run desktop:install`): it updates from `main`, rebuilding it from source
  (`scripts/update-desktop.ts`). This works as it always has.
- **Downloaded** (a release build, which has `Contents/Resources/release.json`): it updates to Cavvy's latest
  release on GitHub (`src/server/release-update.ts`). If `desktop:install` later puts a checkout's build in the
  same place, that build updates from `main` again.

## A downloaded app

It checks for a newer release a few seconds after it starts, then every 6 hours. When it finds one, the download
icon shows beside Settings, and Settings → About offers the update and links to the release notes.

When you choose Update, Cavvy downloads the new version in the background and checks it. It replaces the app only
if every check passes:

- The release's description (`cavvy-desktop-darwin-<arch>.json`) is signed with Cavvy's release key, the same key
  used to sign server builds.
- The release is for this kind of Mac (Apple silicon or Intel, from the hardware), and it's newer than the
  running version. Cavvy never moves to an older or the same version.
- The release was published under its own version's tag.
- The zip has the size and SHA-256 the description gives.
- The zip holds exactly one app, nothing outside it, and no links that point out of it.
- macOS's `codesign` accepts the new app, and it's signed by the same certificate as the running app (the
  running app's designated requirement, and the server's own). A copy of Cavvy signed ad hoc never updates itself.
- The new app's `release.json` matches the description.

Cavvy downloads files only from the release's own tag, never from an address inside the description. The new
app is unpacked next to the installed one, under a hidden name, and isn't quarantined, so macOS doesn't ask about
it again.

To finish, Cavvy quits the way it normally does. If a session has unsaved work and you cancel the quit, nothing
changes, and About shows that the update is ready. Once Cavvy has quit, a small helper checks the new app again,
renames it into place, and opens it. If the new version hasn't started within two minutes, the helper puts the
old version back and opens that.

Cavvy can't replace itself in these cases, and About says to move it to Applications:

- It's running from the disk image.
- macOS opened it from the folder it was downloaded to (app translocation).
- Its folder is read-only.

If Cavvy is in a folder you aren't allowed to change (for example Applications, when you aren't an administrator), About says to ask an administrator to update it.

If macOS's App Management setting stops Cavvy from replacing itself, About says where to allow it: System
Settings → Privacy & Security → App Management.

If the check fails during a background check (for example, because you're offline), nothing is shown. Cavvy
tries again at the next check.
