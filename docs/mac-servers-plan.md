# Mac servers: plan

Cavvy's servers are Linux only today: setup refuses anything whose `uname -s` isn't `Linux` (`src/servers/remote.ts` `targetFor`). This plan adds Macs on Apple silicon, mainly so iOS and Mac work (Xcode builds, the Simulator) can run unattended, which a Linux server can't do at all.

## What was measured

On an AWS `mac-m4.metal` instance (macOS 27.2.1, 24 GB) reached over SSH, with a prototype of the changes below, 2026-11-26.

| Question | Result |
|---|---|
| Server build for macOS | `bun build --compile --target=bun-darwin-arm64-v1.4.4` works from a Mac and from Linux; both come out ad-hoc signed and run. 47 MB packed with the GUI (Linux: 58 MB). |
| Reusing the desktop app's program | `Cavvy.app/Contents/MacOS/cavvy` is the same entry points, flags and build ID (`desktop-electron/pack.ts`) and runs on the server as is. |
| Setup, update, GUI, terminal | `servers add`, `servers update`, `gui --server` and the GUI's terminal all work with the prototype. `servers check` reports the Seatbelt sandbox on. |
| Keeping it running: today's fallback | macOS `nohup` refuses to run from a non-interactive SSH session ("can't detach from console") and there's no `setsid`: nothing starts. |
| Per-user launchd agent (`user/<uid>`, `LimitLoadToSessionType=Background`) | Starts without admin and survives the connection closing. Not started again after a reboot, with or without auto-login. Without `Background`, bootstrap fails (error 5). |
| System LaunchDaemon with `UserName` | Needs admin once. Came back by itself after a reboot with nobody logged in; the GUI reconnected. |
| Keychain | No login keychain over SSH or launchd. `Bun.secrets` fails at once (no hang); the server already runs with `CAVVY_NO_KEYCHAIN=1`. |
| Claude Code sign-in | `servers login` works. With no keychain it keeps its sign-in in `~/.claude/.credentials.json` (0600), which launchd-started sessions read. |
| A real agent | Haiku 5.5 through Claude Code, in a session of the server started by launchd with nobody logged in: built the sample iOS app with `xcodebuild`, installed and launched it, tapped its button twice with the Simulator tools and read the label. |
| Simulator with nobody logged in | Boot, `simctl`, install, launch, and Cavvy's helper (screen, accessibility tree, touches) work from an SSH session, the launchd agent and the LaunchDaemon. Boot 5–10 s. |
| Simulator pane over the link | Shows the server's own device; a tap by hand registers. About 1 KB/s while still, about 77 KB/s while the home screen moves (rough). |
| Xcode | Not on the AMI. Gatekeeper refuses its first launch while nobody is logged in ("requires a prompt but there is no logged in user"); approved once at the screen, it then builds with nobody logged in. A copy of another Mac's App Store Xcode was called "damaged" even with a valid signature. The iOS runtime installs with `xcodebuild -downloadPlatform iOS` without an Apple Account (about 4 min). |
| Sleep | EC2 Macs don't sleep (`sleep 0`). Cavvy takes no wake lock anywhere. |

## Path

Each step is its own pull request, gathered on an integration branch.

1. **Accept a Mac.** `targetFor`: Darwin on arm64 is `darwin-arm64`; Intel Macs are refused with a reason. The probe reads memory with `sysctl` and skips the glibc and AVX2 checks there. `onServer` holds on Darwin (it's still decided by the program living under `~/.cavvy/server/builds`). Tests: the pretend server answers as Darwin.
2. **Its build.** From a checkout, compiled as for Linux. From the desktop app, packed from the app's own `MacOS/cavvy` and `gui`, so the app carries nothing more. Release CI (Linux) adds the `darwin-arm64` bundle to what it publishes.
3. **Keeping it running.** On a Mac, never `nohup`. Setup tries `sudo -n` to install a LaunchDaemon (`UserName` the user, `KeepAlive` on failure, `ExitTimeOut 30`): starts at boot. Without it, a per-user Background agent, and `servers check` says it won't come back after a reboot, with the one command that fixes it, as `lingerFix` does for Linux. `stop`, `update` and `rollback` go through `launchctl`.
4. **Xcode in `servers check`.** Says when Xcode is missing, when its first launch hasn't been approved (`xcodebuild -version` killed), and when there's no iOS runtime (with the command to get one). Cavvy doesn't install Xcode.
5. **Wake lock.** While a session there works, the server holds an idle-sleep assertion, so a Mac mini set to sleep doesn't stop agents mid-task.
6. **Docs.** `docs/servers.md`: Linux or a Mac; what a Mac needs (Apple silicon, Xcode opened once at its screen, admin once for starting at boot).

## Still open

- How an App Store or `xcodes` install of Xcode behaves at first launch with nobody logged in (only a copied Xcode was tried).
- The Simulator stream under sustained motion over a slow link; measure against the targets in `docs/performance-plan.md` before calling the pane done.
- Sleep behaviour on a home Mac mini with default energy settings.
- Codex over the same path (installed, not signed in).
