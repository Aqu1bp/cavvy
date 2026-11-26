# Mac servers: what was measured, and what was built

Cavvy's servers were Linux only: setup refused anything whose `uname -s` wasn't `Linux`. A Mac with Apple silicon is now a server too, mainly so iOS and Mac work (Xcode builds, the Simulator) can run unattended, which a Linux server can't do at all. How to use one is in [servers.md](servers.md#a-mac-as-a-server); this is the record behind it.

## What was measured

On an AWS `mac-m4.metal` instance (macOS 27.2.1, 24 GB) reached over SSH, 2026-11-26. The first table is from a prototype, before the design; the second is the code as built.

| Question | Result |
|---|---|
| Server build for macOS | `bun build --compile --target=bun-darwin-arm64-v1.4.4` works from a Mac and from Linux; both come out ad-hoc signed and run. 47 MB packed with the GUI (Linux: 58 MB). |
| Reusing the desktop app's program | `Cavvy.app/Contents/MacOS/cavvy` is the same entry points, flags and build ID (`desktop-electron/pack.ts`) and runs on the server as is. |
| Setup, update, GUI, terminal | `servers add`, `servers update`, `gui --server` and the GUI's terminal all work. `servers check` reports the Seatbelt sandbox on. |
| Keeping it running: Linux's fallback | macOS `nohup` refuses to run from a non-interactive SSH session ("can't detach from console") and there's no `setsid`: nothing starts. |
| Per-user launchd agent (`user/<uid>`, `LimitLoadToSessionType=Background`) | Starts without admin and survives the connection closing. Not started again after a reboot, with or without auto-login. Without `Background`, bootstrap fails (error 5). |
| System LaunchDaemon with `UserName` | Needs admin once. Came back by itself after a reboot with nobody logged in; the GUI reconnected. |
| Keychain | No login keychain over SSH or launchd. `Bun.secrets` fails at once (no hang); the server already runs with `CAVVY_NO_KEYCHAIN=1`. |
| Claude Code sign-in | `servers login` works. With no keychain it keeps its sign-in in `~/.claude/.credentials.json` (0600), which launchd-started sessions read. |
| A real agent | Haiku 5.5 through Claude Code, in a session of the server started by launchd with nobody logged in: built the sample iOS app with `xcodebuild`, installed and launched it, tapped its button twice with the Simulator tools and read the label. |
| Simulator with nobody logged in | Boot, `simctl`, install, launch, and Cavvy's helper (screen, accessibility tree, touches) work from an SSH session, the launchd agent and the LaunchDaemon. Boot 5–10 s. |
| Simulator pane over the link | Shows the server's own device; a tap by hand registers. About 1 KB/s while still, about 77 KB/s while the home screen moves (rough). |
| Xcode | Not on the AMI. Gatekeeper refuses its first launch while nobody is logged in ("requires a prompt but there is no logged in user": `xcodebuild` is killed, exit 137); with someone logged in it can wait on a dialog instead. Approved once at the screen, it then builds with nobody logged in. A copy of another Mac's App Store Xcode was called "damaged" even with a valid signature. The iOS runtime installs with `xcodebuild -downloadPlatform iOS` without an Apple Account (about 4 min). |
| Sleep | EC2 Macs don't sleep (`sleep 0`). |

With the code as built (`src/servers/service.ts`), on the same Mac:

| Question | Result |
|---|---|
| `servers update` over a LaunchDaemon installed by hand | Replaced the daemon's file and loaded the new one; Cavvy ran from it as the user (parent: launchd). |
| `servers stop` | Cavvy stopped and the job left launchd. Loading the daemon again as a boot does, with Cavvy stopped on purpose, ran it once (exit 0) and started nothing. |
| A killed Cavvy (`kill -9`) | Started again by launchd within 14 s. |
| A Mac where `sudo` asks for a password (a stand-in `sudo` that refuses) | Started by the per-user agent; set-up and `servers check` gave the `sudo install …` command. Run on the Mac, the advice went. |
| A reboot after that command | Cavvy was running 17 s after boot with nobody logged in, started by the daemon; the agent wasn't loaded. |
| Stop and start after that reboot, still without admin | The daemon stayed loaded and idle; the agent ran Cavvy. With `sudo` back, the next start moved it to the daemon and removed the agent. |
| `servers rollback` | Went back a build through the same path. |
| Set-up by a compiled Cavvy with no checkout, laid out as the app is (`Cavvy.app/Contents/MacOS/cavvy`, `Resources/gui`) | It packed its own program (`Packing Cavvy for macOS…`), sent it, and the Mac ran that build with its GUI; the program arrived with no extended attributes. 28 s in all. |
| A real agent again, in a session of the server as the daemon now runs it (through `sh`), nobody logged in | Haiku 5.5 through Claude Code ran `xcodebuild` for the sample app (`** BUILD SUCCEEDED **`), then booted a simulator with `simctl` and counted one booted. |
| The wake lock, with a real turn (Haiku 5.5 through Claude Code running `sleep 12`) | `pmset -g assertions` showed no `caffeinate` before, one during the turn and just after it, none a minute later. |
| `servers check`'s Xcode questions | 0.18 s in all on a Mac with Xcode ready (`xcode-select -p` 0.01, `xcodebuild -version` 0.07, `simctl list runtimes` 0.10), asked while Cavvy's own check (0.2 s) runs. The connection itself took 3.3 s from where it was tried. |

## What was built

1. **A Mac is accepted.** `targetFor` (`src/servers/remote.ts`): Darwin on arm64 is `darwin-arm64`; an Intel Mac is refused with the reason. The probe reads memory with `sysctl` and asks nothing about glibc or AVX2 there. `onServer` holds on macOS too: it's still decided by the program living under `~/.cavvy/server/builds`, which the desktop app's own program never does.
2. **Its build.** From a checkout, compiled as for Linux. From the desktop app on Apple silicon, packed from the app's own `Contents/MacOS/cavvy` and `Contents/Resources/gui` (`appsOwnBuild` in `src/servers/build.ts`), so the app carries nothing more; the program in the app is asked which build it is first, and nothing of its file attributes is packed. Any other copy downloads the published one: the release job (Linux) publishes `darwin-arm64` with the rest.
3. **Keeping it running.** Never `nohup`. One launchd job name, `dev.cavvy.server`, as one of two jobs that run the same thing:
   - A LaunchDaemon with `UserName`, installed and started through `sudo -n` when that works: starts at boot.
   - Otherwise an agent in the user's background session. Set-up and `servers check` say it won't come back after a reboot, with the command that installs the daemon (`ServiceReport.bootFix`). Once installed by hand, the daemon starts Cavvy at boot and the agent starts it at any other time, since only an administrator may start a daemon.
   - Both run `sh -c` with a two-line script rather than Cavvy directly: it exits at once when Cavvy was stopped on purpose (launchd loads a job at boot whatever it was told before), and sends output to the server's log. `KeepAlive` only after a failed exit, so a stop isn't undone; `ExitTimeOut` 30.
   - Another user's daemon under the same name on the same Mac is left alone; that second user has no start at boot.
4. **Xcode in `servers check`.** `xcode-select -p`, `xcodebuild -version` (8 s at most) and `simctl list runtimes` (15 s at most), from the checking machine's script, in the background of Cavvy's own check. Missing, not opened yet (killed, failed or out of time), no iOS simulator (with the command), or nothing to say.
5. **Wake lock.** `src/servers/wake.ts`: `caffeinate -i -w <pid>` from a turn's start until a minute after the last one ends, and for as long after as a session still has work running (looked at once a minute). Only in a server's Cavvy on macOS.
6. **Docs.** `servers.md`.

## Still open

- How an App Store or `xcodes` install of Xcode behaves at first launch with nobody logged in (only a copied Xcode was tried).
- The Simulator stream under sustained motion over a slow link; measure against the targets in `docs/performance-plan.md` before calling the pane done.
- Sleep on a home Mac mini with default energy settings: the wake lock was tried on a Mac that never sleeps, so what's known is that the assertion is taken and released, not that it keeps a Mac mini awake through a long build, nor how soon one sleeps after the last turn.
- Codex over the same path (installed, not signed in).
- The desktop app's own program sent from a real Cavvy.app: tried with a compiled program laid out as an app's (above), not with a packed and installed app, nor one signed by `desktop:install` with a certificate, nor one downloaded (that the packing drops a file's attributes was checked with a test attribute, not with the quarantine mark itself).
- The release job's `darwin-arm64` bundle with `--bytecode` (Bun 1.4.4 on Linux): a cross-compiled build ran, but whether its bytecode is used on a Mac or passed over wasn't measured.
