# Performance goal

Cavvy is a light wrapper over the agents it runs: under heavy use the hardware runs out, not the app. So each target below is measured against what the same work costs without Cavvy (the same CLIs run bare, in terminals), on the same machine and in the same run, not against a fixed number. A target is met when it holds in two runs in a row under the whole workload below, not just with one or two sessions. One that turns out to be out of reach (Electron's own floor, say) stays listed with the measured reason; it isn't lowered.

## The heavy-use workload

Every target must hold under all of this at once. Where it can't run on a real 16 GB laptop, it runs in a 16 GB cgroup.

- 30 sessions open, 10 streaming at the same time
- spread across many worktrees of large repositories (100,000 files, over 1 GB)
- sessions 2,000+ turns long, tool output of tens of MB, many images
- agents running builds, test suites, dev servers and file watchers
- subagents, background tasks and MCP servers in many sessions at once
- 1,000 sessions in history; the app left open for a week (a long soak stands in for this)
- bursts: many sessions finishing at once, rate limits hitting all of them together

## Pass mark

| # | Target | Today | |
|---|---|---|---|
| 1 | **Breaking point.** Add sessions in steps under the workload until the machine gives out, once in Cavvy and once with the bare CLIs. Cavvy fits within 5% as many sessions; what ran out is RAM or CPU used by the agents and their processes, and Cavvy can still stop sessions then. | 4-core, 16 GB Linux VM, Sonnet, 100,000-file worktrees: CPU runs out at about 20 sessions either way (memory never does). Turns finished in 4 minutes at 5 / 10 / 20 / 30 sessions: Cavvy 66 / 87 / 100 / 101, bare CLIs 149 / 225 / 315 / 277 | Fails |
| 2 | **Scaling.** Cost per session stays flat from 1 to 30 sessions; one session running a big build or flooding output doesn't slow the others. | Same runs: Cavvy's server 678 MB at 5 sessions, 1,282 MB at 30; its answers to the GUI 31 ms (p95) at 5, 2.6 s at 30 | Fails |
| 3 | **Streaming.** A streaming reply costs no more than the same CLI printing it in a terminal, with 10 streaming at once. | 2 sessions: Cavvy's server 34% of a core, both CLIs 19% | Fails |
| 4 | **Idle**, or waiting on a model: within measurement noise of Cavvy not running. | Not measured yet | |
| 5 | **Hidden sessions:** no drawing or layout cost. | | Needs a Mac run |
| 6 | **Snapshots.** The first one of a repository is no slower than `git status` on it. A turn that changed files costs about what `git add` of those files costs. An unchanged turn starts no processes and reads no repository files. | Unchanged turn: 2 gits and a stat of every file. 5,000 changed files: 1.3 s, `git add` 0.8 s | Fails |
| 7 | **No dropped frames** while typing or scrolling with 10 replies streaming (8 ms a frame at 120 Hz). | | Needs a Mac run |
| 8 | **Size doesn't show.** Opening a 2,000-turn session is as fast as opening a new one. Startup with 30 sessions restored is as fast as with 1. Lists and search with 1,000 sessions in history are as fast as with 10. A 50 MB tool output shows without freezing anything. | Not measured yet | |
| 9 | **Memory.** All of Cavvy uses less than one of the agent CLIs it runs, at any session count, and stays flat over an hours-long soak (the end matches the start). | 2 sessions in 100,000-file worktrees: Cavvy 304 MB, one Claude Code CLI about 250 MB. 30 sessions: Cavvy 1,282 MB, a CLI about 120 MB | Fails |
| 10 | **Failures** with 20 live sessions: a crashed CLI, a server restart, a network drop, out of memory or a full disk loses no work, and the other sessions carry on. | Not measured yet | |

## How it's measured

`scripts/bench-ramp.ts` runs N real Claude Code sessions, each in its own worktree of a large repository, given the same prompts (an edit and a build, a subagent's search, megabytes of tool output, a dev server, a commit), either under one `cavvy serve` as the desktop app runs it or as bare `claude` processes started with the flags Cavvy gives them. It adds sessions in steps, and every second records CPU and memory by role (Cavvy, its own helper processes, the CLIs, what the agents run, the rest of the machine), the machine's pressure, turn times and failures, and how fast Cavvy's socket answers. Real models are the evidence. Where a comparison has to be exact (the same work to the byte in both), a stand-in for the model's API scripts the replies, and the CLIs and everything they run are real.

The Mac-only targets (5, 7, and the window's share of 3 and 9) are measured with the packaged app: `bun run perf:bench`, `desktop-electron/bench-heavy.ts` and `bench-real.ts`, by instruction counts, not milliseconds:

- **Instructions and energy decide.** A build that does less can show the same milliseconds or more, because macOS moves lighter work to slower cores: during a reply only 8–14% of the work runs on performance cores. Milliseconds still say how something feels, but they aren't a fair comparison between builds or between machines.
- **A figure that looks too good is suspect.** A bench must fail if it isn't measuring what it says: `bench-stream` stops if a session didn't open, because the rail holds its rows while the real cursor is over it, and a stretch on the wrong session reads as a great result. Bench connections call `session.shown`, or the server counts them as looking at everything.
- **Tracing inflates.** Rows from `bench-reply`'s trace run slower than the same work untraced.

## Recovery

Not a speed line, but required: if the window's page crashes, it's back in about 150–200 ms with the same session, the reply still coming, the half-written message and the terminal (30 checks in the packaged app: mid-reply, idle, with a browser tab open, hidden, a crash loop). A rule in `test/perf-rules.test.ts` keeps the handler in place.
