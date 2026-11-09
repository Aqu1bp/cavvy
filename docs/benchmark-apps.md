# Comparing Cavvy with other apps

What it costs a Mac to use Cavvy for agent work, next to other apps that do the same job, measured the same way for
each with `desktop-electron/bench-apps.ts`. The aim is a fair answer, whoever comes out ahead: report every run,
including the ones Cavvy loses.

## What's measured

For each app, over a fixed stretch:

- **Work:** instructions retired by every process of the app's bundle and everything they started (the agent CLIs
  included), by role: the app's main process, its pages, its GPU process, helpers, CLIs.
- **WindowServer:** its CPU share, as what the app's drawing costs the system. It includes every other app, so the
  Mac must be quiet.
- **Memory:** `footprint` of each process, totalled.

Compare **totals with the CLIs included**. Where an agent's work happens differs between apps: a CLI rendering its own
terminal UI does work that, in Cavvy, its server and window do instead.

## Conditions

- The same Mac, plugged in, after a restart of the apps measured. Other apps closed or minimized; `top` recorded before
  each run (the script does).
- The same window size for every app (set it before measuring), on the same display.
- The same model and the same prompt in each app, from a fresh session in the same project.
- Each app alone: quit the others. Runs alternated between apps (A, B, C, A, B, C, ...), 3 or more each, medians
  reported with every run listed.
- Real models, so replies differ from run to run: report the text each produced (characters) beside its cost.

## Stretches

1. **Idle:** a long session open (the same conversation, 40+ turns, in each), nothing happening. 60 s.
2. **One reply streaming on screen:** the prompt below, measured from 5 s after the reply starts. 60 s.
3. **Several sessions:** as many as each app supports up to 5, each given the prompt, one on screen. 60 s.
4. **Memory after use:** after an hour of the workload, and after closing its sessions.

The streaming prompt: "Write a 2,500-word explanation of how a hash map works, with headings, bulleted lists and three
code examples in TypeScript. Don't use any tools."

## Running it

```bash
bun desktop-electron/bench-apps.ts --app "/Applications/<App>.app" --label "<app> streaming 1" --seconds 60 --after 5
```

Start what's to be measured, run the command, and leave the keyboard and mouse alone until it prints. The results
append to `desktop-electron/bench-results/apps.jsonl`.

## Caveats to report with the results

- A desktop app that also hosts the session measuring it (the Claude app hosting a Remote Control session) is measured
  with that session idle, and its idle cost noted.
- An app's settings (themes, animations, reduced motion) are left at their defaults.
- One Mac, one display: results on other hardware can differ.
