# Performance targets, v2

The owner's targets, quoted as they were set (2026-11-15). They replace the pass mark in
[performance-plan.md](performance-plan.md), which keeps the history and how things are measured. Below the targets is
where each one stands; it's kept up to date as work lands.

## The targets (as set)

### Decisions
- Test threads at **50,000 and 100,000 items**. An item is a message, tool call, tool result or reasoning block.
- A target that may be out of reach stays at that level, and we still push past it as far as we can. Never lower one; if it's out of reach, list the measured reason.
- Machine: the owner's Mac is an M5 (4 performance + 6 efficiency cores, 16 GB, 120 Hz). Advice given, not yet decided by the owner:
  - No macOS VM for frame, GPU or WindowServer figures, because the VM's GPU is a software stand-in.
  - Instruction counts on the M5.
  - An 8 GB VM only for memory pressure.
  - A real slow Mac (base 8 GB M1 Air) for the millisecond targets before releases.
- Goal in the owner's words: an app that's "fast, efficient and looks and feels good at the same time".

### Principles
- Cost depends only on what's on screen, never on the size of the thread, history or repository.
- Feel ceilings: typing shows on the next frame (8 ms at 120 Hz); opening or switching ≤ 50 ms; anything else ≤ 100 ms.
- Machine-wide costs are measured against the same CLIs run bare in a terminal.
- Remote: no more than the round trips and bytes the work strictly needs.
- Speed is decided by the bench; any flash or jump is a bug however fast the screen was; how it looks is the owner's call.

### A. Huge threads (50,000 and 100,000 items, a realistic mix)
| Case | Target |
|---|---|
| Open it again after switching away | First frame ≤ 50 ms, within 10% of a 10-item thread |
| Open it cold after a restart | ≤ 100 ms; bytes read from disk don't grow with the thread |
| Scroll from bottom to top | 0 dropped frames; window memory afterwards within 10% of before |
| Jump to any item (search hit, turn) | ≤ 100 ms |
| Send in it | Message on screen the next frame; server work doesn't grow with the thread |
| Stream at the end of it | Within 5% of the same reply in a new thread |
| Rewind, fork, reload | ≤ 100 ms to screen |
| Memory with it open | ≤ 10 MB more than a 10-item thread, in the server and in the window |

### B. Huge single items
| Case | Target |
|---|---|
| 1 MB reasoning streaming | Each character parsed ≤ 2 times, flat from the first KB to the last |
| 50 MB output, a single 10 MB line | First screen ≤ 50 ms, no frame over 8 ms, longest server pause ≤ 8 ms |
| Diff of 5,000 files | Opens ≤ 100 ms, no dropped frames while scrolling |
| 200 images in a turn | Memory grows only with the images on screen |
| Terminal flood | ≤ 1.1× what Terminal.app costs for the same output |

### C. Many sessions
| Case | Target |
|---|---|
| Breaking point against bare CLIs | Within 2% (current plan: 5%) |
| Cost per session | Flat from 1 to 100 sessions |
| 30 sessions finish in the same second | All shown done ≤ 100 ms, no frame over 8 ms |
| One session flooding output | Other sessions' turn times unchanged, within noise |
| 10,000 sessions in history | Sidebar and search per keystroke ≤ 50 ms, the same as with 10 |

### D. Responding while busy (10 streaming, 100,000-item thread on screen, 30 open)
| Case | Target |
|---|---|
| Keystroke to screen | Next frame; 0 dropped frames over the whole bench |
| Esc | Shown stopped ≤ 50 ms; CLI signalled ≤ 10 ms after the key |
| Permission prompt | On screen within 1 frame of the server getting the call |
| Switch session, palette, Settings, any screen | ≤ 50 ms, the first open included |

### E. Streaming, idle, memory
| Case | Target |
|---|---|
| Streaming against the CLI in Terminal.app | ≤ 1.1× instructions and WindowServer |
| Idle, waiting with spinner, hidden, minimized | Within noise of Cavvy not running |
| All of Cavvy's memory | Less than one CLI (~370 MB) with 100 sessions open |
| Soak (stands in for a week) | Memory at the end within 5% of the start, and given back to the OS |

### F. Startup and repositories
| Case | Target |
|---|---|
| Composer ready | ≤ 250 ms warm, ≤ 1 s cold, the same with 100 restored and 10,000 in history |
| First snapshot | ≤ `git status` |
| @-mention in a 1,000,000-file repository | ≤ 50 ms per keystroke |
| Turn changing 10,000 files | ≤ what `git add` of them costs |
| File watchers when nothing changes | 0 CPU |

### G. Remote
Link profiles:
- 100 ms round trip
- slow 3G (about 400 ms round trip, 400 kbps)
- 2% packet loss
- drops of 30 s and of 10 min
- laptop asleep overnight

| Case | Target |
|---|---|
| Open a 100,000-item thread on slow 3G | 1 round trip plus one screen's bytes (about 1 s) |
| Bytes per streamed character | ≤ 1.2 (today's budget allows 3.3) |
| Reconnect after a drop or sleep | Caught up within 1 round trip plus the missed events' bytes; nothing lost or duplicated |
| Esc, steer, permission answer | Acted on within 1 round trip |
| Terminal typing | Echo within 1 round trip, even while output floods |
| Time to first token | Cavvy adds ≤ 1 round trip over running the CLI on the server |
| With 2% loss | Every target above within 2× |

### H. Smoothness (added 2026-11-15)
| Case | Target |
|---|---|
| Opening a chat or any screen | The first frame is the finished one: no blank frame, no placeholder, nothing that moves after it appears |
| Loading earlier turns while scrolling | What you're reading moves by 0 px |
| Flinging through 100,000 items | No blank area ever shows; the scrollbar's size and position stay steady |
| Images, code blocks, diffs arriving | Nothing below them shifts after the first frame |
| Animations and transitions under heavy use | Every frame drawn, the same as when idle |

Measure these by recording frames and counting layout shifts and blank frames (extend `test/perf-gui.test.ts`).

### I. Failures, and mobile later
- **Failures:**
  - Target 10 (no work lost, the other sessions carry on) holds at 100 sessions.
  - A full disk while a 100,000-item thread is being written loses no work.
  - A corrupt session file still opens up to where the damage starts.
  - The window is back ≤ 200 ms after a crash (today 150–200 ms).
- **Mobile:**
  - The same targets as G.
  - A 100,000-item thread uses no more phone memory than a 10-item one.
  - Resuming from the background costs 1 round trip plus the missed bytes.
  - While idle, the connection wakes the radio only for push notifications.

## Where each stands

Met, not met, or not measured, with the measurement and where it was taken: **Mac** (the owner's M5, the build
named), **Linux** (headless Chrome or the server on a 4-core Linux container), or **plan** (recorded in
performance-plan.md, from builds before this work). "Out of reach" only once a measurement shows it can't be done.

| Target | Status | Measurement |
|---|---|---|
| A. Open again after switching away | Not measured | Not at 50,000/100,000 items. Mac (b1a66d2): the session just left 9–21 ms; a cold switch to a 60 KB-reply session 67–83 ms. Linux, a long reply now built from its end (0185941): the switch's task 20–32 ms. |
| A. Open cold after a restart | Not met (Claude Code) | Plan, Linux, server: 14–21 ms for Cavvy's own models; 83–92 ms for a 100,000-item Claude Code session, which reads its whole 9.6 MB transcript (bytes grow with the thread). |
| A. Scroll from bottom to top | Not measured | Mac, 200 turns: memory +2.6–3.3% after paging; frames not counted. |
| A. Jump to any item | Not measured | |
| A. Send in it | Not measured | |
| A. Stream at the end of it | Not measured | |
| A. Rewind, fork, reload | Not measured | |
| A. Memory with it open | Not met (Claude Code); window not measured | Linux perf-size, 30,000 items, server kept open: native 1.8–2.7 MB vs 1.35, CLI 6.3 vs 4.1. Plan, M5: a 100,000-item Claude Code session keeps 16–20 MB. |
| B. 1 MB reasoning streaming | Not met | Counted (Linux): budget 9.3 parses a character. |
| B. 50 MB output, a 10 MB line | Not met | Plan: longest server pause 14 ms. |
| B. Diff of 5,000 files | Not measured | |
| B. 200 images | Not measured | |
| B. Terminal flood | Not measured | |
| C. Breaking point | Not met | Plan, 4-core Linux VM, 30 sessions: 6.3% slower than bare CLIs. |
| C. Cost per session | Not measured past 30 | Plan: flat to 30. |
| C. 30 finish in the same second | Not measured | |
| C. One session flooding | Partly | Plan: met for one big build. |
| C. 10,000 sessions in history | Search: met (Linux), Mac to confirm. Sidebar: met (Linux) | Linux, 10,000 sessions: the palette waited 140 ms after each key before searching (an intentional wait, now removed); a search a second after the last whole listing listed every session file first (now renewed in the background); two-letter searches skip sessions without that pair. Key to results on screen: 10–29 ms (56–71 ms with the palette's blur, drawn in software headless). Server search per key 2–8 ms. Sidebar: 25 rows either way; its list call 1.4–3.6 ms (was 22–34 ms of statting every file). The window's heap is 8 MB larger with 10,000 sessions: not yet explained. |
| D. Keystroke to screen | Not met | Plan, Mac interactions bench: 1–3 dropped frames, without the load. |
| D. Esc | Screen: met (Linux, no load); CLI part not measured | Linux, mock model: the turn shows stopped 25–37 ms after Esc (was 55–72). |
| D. Permission prompt | Not measured | Applied at the next frame since a20f8cd. |
| D. Switch, palette, Settings, any screen | Not met | Mac (b1a66d2): cold switch to the long-reply session 67–83 ms; Settings first open 15–17 ms (f1f0e45). Linux: see A and C. |
| E. Streaming vs Terminal.app | Not met | Plan, Mac: 2.1× instructions, WindowServer 15.6% vs 3.0%. |
| E. Idle, waiting, hidden, minimized | Not met while waiting | Plan, Mac: idle 22 M instructions/s, waiting 134. Linux: while waiting, about 20 frames a second from the spinners (turn spinner and sidebar ring 20 steps/s, shimmer 10); main thread 6.6 ms/s. Fewer steps would change how they look: the owner's call. |
| E. All of Cavvy's memory | Not met | Plan, Mac: 545 MB at 15 sessions. |
| E. Soak | Not met | Plan, Mac: keeps 304 MB after its sessions close. |
| F. Composer ready | Not met warm | Mac perf-bench (f1f0e45): 261–271 ms. Linux, 10,000 in history: 158–181 ms. |
| F. First snapshot | Not met | Plan, Linux: 0.55 s vs 0.35 s for `git status`. |
| F. @-mention, 1,000,000 files | Met (Linux) | Plan: 1–4 ms median, 35–42 ms worst. |
| F. Turn changing 10,000 files | Met (Linux) | Plan: 1.4–1.5 s vs 7.4 s for `git add`. |
| F. File watchers | Nearly | Plan: 0.12 ms of CPU a second. |
| G. Bytes per streamed character | Not met | Counted, uncompressed JSON: budget 3.3. |
| G. Everything else | Not measured | |
| H. Opening: first frame finished | Not measured with frame recording | "Worked for" no longer fades in as a page of turns is built (a944406; Linux 0 of 62). |
| H. Loading earlier turns while scrolling | Not met for "Show earlier" | Mac: wheel up a 200-turn session 0 px over 137 steps; "Show earlier" 0.6 px. |
| H. Flinging through 100,000 items | Not measured | |
| H. Images, code blocks, diffs arriving | Code blocks met (Linux); the rest not measured | Linux: code blocks out of sight are their drawn size at text sizes 12–18: 0 moves. |
| H. Animations under heavy use | Not measured | |
| I. Failures at 100 sessions, full disk, corrupt file | Not measured | Plan: failures met at 20 sessions. |
| I. Back after a crash | Met | 150–200 ms. |
| I. Mobile | Not measured | |
