# Performance goal

Cavvy is as fast and as light as the best widely used coding-agent apps, in the packaged app, measured the same way each time. This is done when every line below meets its target in two runs in a row, and a run with real models shows the same. A target that turns out to be out of reach for an Electron app stays listed, with why.

Today's figures are from the `optimized-app` branch, on an M5 MacBook Pro with 16 GB. T3 Code's and PandaCode's come from the comparison PandaCode publishes in its `bench/t3-compare` (headless Chrome, no socket, no window, on an M4 Max). Ours run in the real app with its window on screen.

## How to read these

- **Instructions and energy decide.** A build that does less can show the same milliseconds or more, because macOS moves lighter work to slower cores: during a reply only 8–14% of the work runs on performance cores. Milliseconds still say how something feels, but they aren't a fair comparison between builds or between machines.
- **A figure that looks too good is suspect.** A bench must fail if it isn't measuring what it says: `bench-stream` stops if a session didn't open, because the rail holds its rows while the real cursor is over it, and a stretch on the wrong session reads as a great result. Bench connections call `session.shown`, or the server counts them as looking at everything.
- **Tracing inflates.** Rows from `bench-reply`'s trace run slower than the same work untraced.

## One long reply

`bun desktop-electron/bench-reply.ts`: 50 KB in 25-byte deltas, 16 ms apart, in a session with 20 earlier turns.

| | T3 Code | PandaCode | First measured | Today | Target |
|---|---:|---:|---:|---:|---:|
| The window's instructions (G) | | | 59.1 | 34.5 | 30 |
| The window's CPU energy (J) | | | 17.5 | 3.7 | 3.5 |
| Main-thread work (ms, see above) | 8332 | 2947 | 7816 | 7644 | 3000, not comparable |
| of which script (ms) | 5632 | 288 | 2066 | 2140 | 500, not comparable |
| of which layout (ms) | 222 | 208 | 599 | 615 | 250, not comparable |
| of which style (ms) | 403 | 283 | 835 | 955 | 300, not comparable |
| Same stretch with nothing delivered (ms) | 133 | 38 | | 44 | 38 |
| Last delivery to final paint (ms, traced) | 27 | 49 | 184 | 85 | 50 |
| JS heap after the reply (MB) | 54.2 | 11.5 | 15.9 | 16.0 | 12 |

The millisecond targets came from the published comparison, and they can't be met or missed fairly on this gauge. To say how Cavvy stands against those apps needs them measured by instructions in the same conditions, which hasn't been done.

## The whole app

`bun run perf:bench`. Instructions retired, in millions a second, across the window, GPU, main and server processes. Two runs each.

| | Original | Today | Target |
|---|---:|---:|---:|
| A reply streaming, short session | 2301 | 642, 662 | 700 |
| A reply streaming, long session | 3382 | 771, 801 | 900 |
| Waiting on a model | 349 | 130, 133 | 60, likely out of reach |
| Idle, long session, settled | 199 | 0–1% of a core | 50 |
| Idle, long session, in its first 15 s | | 173 | |

Waiting: with nothing animating at all the app takes 37. The spinner draws the window 20 times a second, which is what the rest of this is. Fewer steps would meet the target and look choppy, so it stays missed.

## Five sessions at once

`bun desktop-electron/bench-heavy.ts --only many`. An ordinary repository (2,000 files), and a very large one (100,000).

| | 2,000 files | 100,000 files | Target |
|---|---:|---:|---:|
| 1 on screen, 4 out of sight, all streaming | 785 | 786 | 800 |
| All 5 out of sight, streaming | 147 | 235 | 150, 250 |
| All 5 waiting | 155 | 184 | 160, 200 |
| Whole app's memory (MB) | 439–540 | 431–558 | 550, 600 |
| of which the server (MB) | 61 | 113–131 | 100, 150 |

## Long use

`bun desktop-electron/bench-heavy.ts --only soak`: 5 sessions working non-stop, about 45 turns a minute, far more than people manage.

| | Today | Target |
|---|---:|---:|
| Turns failed in an hour | 0 of 2752 | 0 |
| Crashes | 0 | 0 |
| Opening a session, during it (ms) | 44–71 | 100 |
| Server's memory after 734 turns, ordinary repository (MB) | 51, from 48 | 100 |
| Whole app's memory with the sessions closed afterwards (MB) | 298 (just opened with a session: 256–310) | 320 |
| Page's JS heap, per turn kept (MB) | 0.03 | |

In a repository of 30,000 files at this pace the server's memory climbed in steps: 95–110 MB in the first minutes, then 250–580 MB over an hour, and it stayed there with the sessions closed. It was the turn snapshots: each read, hashed and kept every file of the repository, and each turn fingerprinted every other worktree. Since snapshots take unchanged files from Git's index and stat on a worker thread (`docs/git.md`), it stays level: 4 sessions on the mock model in a 27,600-file repository for 10 minutes on a 4-core Linux VM, 262–302 MB throughout (before: climbing to 970 MB, peaking at 1,189), with 772 turns done instead of 225 (median 3.0 s instead of 10.4) and the socket's slowest replies 3 ms at p95 instead of 137. To measure again on a Mac with `bench-heavy.ts --only soak`.

## Very large sessions and repositories

`bun desktop-electron/bench-heavy.ts --only open,git`. A session of 400 turns of 200 KB of output each.

| | Today | Target |
|---|---:|---:|
| Opening it (ms) | 111–126 | 150 |
| Switching back to it (ms) | 40 | 50 |
| Frames over 50 ms | 0 | 0 |
| Time in `git` per unchanged turn, 2,000 files (ms) | 65 | 100 |
| Time in `git` per unchanged turn, 30,000 files (ms) | 118 | 150 |
| Time in `git` per unchanged turn, 100,000 files (ms) | 194 | 250 |
| Added to a turn once settled, 100,000 files (s) | 1.0 | 1.5 |
| A session's snapshots on disk, 100,000 files (MB) | 18.6 | 50 |

## Speed

| | Today | Target |
|---|---:|---:|
| Launch to composer, cached (ms) | about 270 | 300 |
| Launch to composer with a slow login shell (ms) | 297 | 350 |
| Opening a long session (ms) | 59–69 | 100 |
| Switching between long sessions (ms) | 48–63 | 50 |
| First word on screen after it arrives (ms) | 13 | 50 |
| Last word on screen after it arrives (ms) | 49 | 100 |
| Longest frame while a reply streams (ms) | not over 50; finer not measured | 25 |

## Memory

| | Claude desktop | Today | Target |
|---|---:|---:|---:|
| The whole app, fresh and idle (MB) | 896 | 208 | 300 |
| The whole app after a real run of 12 prompts (MB) | not measured | to measure again (500 before) | 400 |

## Counted work

`test/perf-budgets.json` holds these in CI, and a budget only comes down.

| | Today | Target |
|---|---:|---:|
| Markdown parsed per streamed character | 12.3 | 3, not worth it |
| Each code line tokenized | 2 | 2 |
| `git` processes per turn with an edit | 20 | 20 |
| `git` processes per unchanged turn | 2 | 2 |
| `git` processes while idle | 0 | 0 |

Markdown: reaching 3 would save about 31 ms of work over a 12-second reply, for a cache that could get a reply's text wrong. It stays at 12.3.

## Recovery

Not a speed line, but required: if the window's page crashes, it's back in about 150–200 ms with the same session, the reply still coming, the half-written message and the terminal (30 checks in the packaged app: mid-reply, idle, with a browser tab open, hidden, a crash loop). A rule in `test/perf-rules.test.ts` keeps the handler in place.
