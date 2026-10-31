# Performance goal

Cavvy is as fast and as light as the best widely used coding-agent apps, in the packaged app, measured the same way each time. This is done when every line below meets its target in two runs in a row, and a run with real models shows the same. A target that turns out to be out of reach for an Electron app stays listed, with why.

Today's figures are from the `optimized-app` branch. T3 Code's and PandaCode's come from the comparison PandaCode publishes in its `bench/t3-compare` (headless Chrome, no socket, no window, on an M4 Max). Ours run in the real app through the real server and socket, so they carry more work than theirs do. Claude desktop's was read from outside on the same Mac, as it sat idle.

## One long reply

`bun desktop-electron/bench-reply.ts`: 50 KB in 25-byte deltas, 16 ms apart, in a session with 20 earlier turns.

| | T3 Code | PandaCode | Today | Target |
|---|---:|---:|---:|---:|
| Main-thread work (ms) | 8332 | 2947 | 6954 | 3000 |
| of which script (ms) | 5632 | 288 | 1723 | 500 |
| of which layout (ms) | 222 | 208 | 526 | 250 |
| of which style (ms) | 403 | 283 | 768 | 300 |
| Same stretch with nothing delivered (ms) | 133 | 38 | 67 | 38 |
| Last delivery to final paint (ms) | 27 | 49 | 197 | 50 |
| JS heap after the reply (MB) | 54.2 | 11.5 | 16.1 | 12 |

## The whole app

`bun run perf:bench`. Instructions retired, in millions a second, across the window, GPU, main and server processes.

| | Original | Today | Target |
|---|---:|---:|---:|
| A reply streaming, short session | 2301 | 1049 | 700 |
| A reply streaming, long session | 3382 | 1981 | 900 |
| Waiting on a model | 349 | 139 | 60 |
| Idle, long session | 199 | 185 | 50 |

## Speed

| | Today | Target |
|---|---:|---:|
| Launch to composer, cached (ms) | 309 | 300 |
| Launch to composer with a slow login shell (ms) | not measured | 350 |
| Opening a long session (ms) | 94 | 100 |
| Switching between long sessions (ms) | 63 | 50 |
| Longest frame while a reply streams (ms) | not measured | 25 |

## Memory

| | Claude desktop | Today | Target |
|---|---:|---:|---:|
| The whole app, fresh and idle (MB) | 896 | not measured | 300 |
| The whole app after a real run of 12 prompts (MB) | not measured | 500 | 400 |

## Counted work

`test/perf-budgets.json` holds these in CI, and a budget only comes down.

| | Today | Target |
|---|---:|---:|
| Markdown parsed per streamed character | 12.3 | 3 |
| Each code line tokenized | not measured | 2 |
| `git` processes per turn | 27 | 20 |
| `git` processes while idle | 0 | 0 |
