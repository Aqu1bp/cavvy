# Electron spike: performance evidence

Measured on an Apple M5 MacBook Pro (macOS 26), Electron 45, against the demo (mock model, demo site), with a fresh
profile each run. Raw results: `bench-results/`. Reproduce:

    bun desktop-electron/bench.ts --label <name> [--app <packaged executable>]
    bun desktop-electron/bench-startup.ts --label <name> [--app <packaged executable>]
    bun desktop-electron/pack.ts                     # Harness.app, signed ad hoc

`bench.ts` phases: idle on the home screen; after the agent browsed the demo site; the Browser pane open and idle;
frame times while the side panel is dragged; three agent sessions working at once (one streaming on screen, one
editing and running tests, one browsing) while the person types; four busy pages in tabs nobody sees, 45 s later.
Memory is macOS's footprint (Activity Monitor's Memory) of all the app's processes, the server included; CPU the mean
of 10 one-second samples. Development-build idle footprint varies by up to ~90 MB between identical runs.

## Results

| | Baseline | After | Change |
|---|---|---|---|
| 4 busy pages in unseen tabs: CPU (whole app) | 10.4% | 0.7–1.7% (7 of 9 runs; see below) | −84 to −93% |
| — their tabs' memory (working set) | 807 MB | 616–653 MB | −20 to −24% |
| — whole app footprint | 1,145 MB | 926–980 MB | −14 to −19% |
| Browser pane open, idle: CPU | 0.7% | 0.0–0.1% | gone |
| Idle on the home screen: footprint | 335 MB (dev) | 308–316 MB packaged; 318–423 MB dev | packaged lowest |
| 3 agent sessions at once: footprint / CPU | 885 MB / 11.3% | 863–915 MB / 10.2–12.5% | unchanged (it's the agents' work) |
| — typing in the composer meanwhile, key to paint p95 | 7 ms | 7–8 ms | unchanged |
| — UI frame time p95 | 9 ms | 9–10 ms | unchanged |
| Startup, composer ready (warm) | 307 ms dev | 305 ms packaged | unchanged |
| Startup, first launch of a new build | — | 493 ms (2.6 s once: macOS checking the new binaries) | |

What changed:
- **Background tabs sleep** (src/browser-host.ts): a tab nobody sees and nobody has used for 30 s has its webview
  hidden, so Chromium stops drawing it; it's then frozen and asked to release memory. Any command or a pane showing
  it wakes it first. Measured on one busy page: CPU 1.8% → 0.1%, GPU 1.6% → 0.1%, memory 171 → 114 MB, and it draws
  correctly when shown again (the macOS blank-webview bug T3 works around doesn't occur on Electron 45). It stays
  asleep through the window being minimized, hidden or covered.
  Chromium's freeze alone does nothing to a page it considers visible (timers and frames ran on), and even hidden,
  pages report `visible` and their timers keep running: the saving is that they're not drawn.
  Two early runs (`diag`, `diag-b`) slept all tabs yet they used full CPU again; the cause isn't found. The app now
  checks sleeping tabs' processes every 5 s and puts a busy one back to sleep; it hasn't had to in 3 runs since.
- **The pane and floating view follow their box only when it can move** (gui/src/lib/follow-box.ts), not every frame.
- **Packaged build** (pack.ts): asar archive, server as one binary, V8 code cache for the UI. Lowest idle footprint;
  the code cache made no measurable startup difference at this UI's size.

## How it feels in use

`bench-ux.ts` times what a person does, from their click or key (trusted input through Chromium) to the frame that
shows the result, and the longest frame meanwhile (this display draws every 8 ms; one over 25 ms is a dropped frame).
Data made through the app's own server by the mock model: a 60-turn session of long markdown replies, steps and
commands; one turn 30 prompts long; 40 short sessions; a 4,000-line diff. Builds alternated run by run, minified
GUI: before (5 runs), after (5); after without the markdown warm-up (8), for the warm-up's own effect.

    bun desktop-electron/bench-ux.ts --label <name> [--app <packaged executable>] [--trace <dir>]

| Interaction: time to result / longest frame (median; range) | Before | After |
|---|---|---|
| Open a long session (the first one since launch) | 190 / 118 ms (109–159) | 93 / 34 ms (33–67) |
| Switch back to it, scrolled up where it was read | 148 / 91 ms (83–117) | 57 / 25 ms (24–33) |
| Switch to the long turn, a short session, back | 42–64 / 17 ms | 32–57 / 9–17 ms |
| Flick through the long session, jump to start/end | 17–25 ms frames | 17–25 ms frames |
| Unfold a turn's work | 49 / 17 ms | 42 / 17 ms |
| Type in its composer: worst frame | 17 ms | 17 ms |
| Side panel and its tabs; scrolling a 4,000-line diff | 9–26 ms frames | 9–17 ms frames |
| Open that diff | 39 / 17 ms (17–25) | 41 / 33 ms (18–35) |
| Command palette, Settings and its sections | 8–48 / 17–25 ms | 8–48 / 17–25 ms |
| Terminal open / close, new session | 64 / 33, 29 / 17, 22 / 17 ms | 55 / 25, 22 / 17, 23 / 17 ms |

What changed (traced with `--trace`, CPU-sampled, mapped to the source):
- **A session mounts its last two screens of turns first** (lib/transcript-scroll.ts `firstWindow`), the rest of the
  page 4 at a time between frames; reopened where it was read, the turns from there down first. Before, all 40 turns
  of the page went in in one frame.
- **Markdown is warmed 1.5 s after launch** (lib/markdown.ts `warmMarkdown`): the first reply a window rendered was
  also the first run of the lexer and its patterns, 10× slower than a later one in the trace. Rendering markdown in the
  first open: 28.6 → 17.6 ms (median of 3 runs each, CPU profile); its longest frame 55 → 34 ms (8 and 5 runs).
- **Date formatters made once** (lib/format.ts), not on every turn's time.

Left:
- The first open's longest frame is still 33–67 ms: building three long replies' DOM and laying them out, about half
  of it, is work a first view of them needs.
- Opening the big diff draws one or two frames later than before (median 17 → 33 ms). Traced in both builds, the
  UI's work for it is the same (the click 7–8 ms, the diff's data 11–13 ms, frames 6–9 ms); the long frame in the
  final build's trace was the GPU process waiting on Metal for 12 ms. These changes don't touch the diff; not resolved.

The 8 runs without the warm-up (for its comparison) include one that overlapped with tests run on the same machine:
its side panel and palette frames, untouched by any of this, were 75–217 ms.

Not improved:
- **Occasional long UI frame under multi-session load**: 200 ms (baseline), 158 ms and 117 ms in 3 of 12 runs, 33–42 ms
  otherwise. Long-animation-frame entries never attributed it to UI JavaScript; one coincided with a background
  session's new tab being embedded. Unresolved.
- **The main process (~170 MB working set)**: its JavaScript heap is 6–7 MB; the rest is Chromium's browser process.
