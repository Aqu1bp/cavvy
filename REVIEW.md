# Reviewing Cavvy

What a reviewer of a Cavvy change checks, human or agent. `/review-change` gives this file to every reviewer. [AGENTS.md](AGENTS.md) has the rules for writing the code; this file says what failure looks like.

## What failure looks like

| Area | It fails when |
|---|---|
| Core: `src/agent`, `src/tools`, `src/providers`, `src/permissions`, `src/mcp` | the terminal app and the GUI behave differently, or a front end holds logic the other one needs |
| `src/permissions` | it lets through what it should block, or blocks routine work |
| `src/backends` (starting agent CLIs) | the CLI gets a different argv, environment, folder, pid or error than before, or a kill or Esc misses it |
| Snapshots and Git (`src/agent/turn-snapshots*`, `native/`, `src/server/git-*`) | a turn's diff is wrong or missing, or an optional helper fails and nothing falls back to git |
| UI (`gui/`, `src/ui`, `desktop-electron/`) | it says something happened that didn't, the copy breaks AGENTS.md's UI copy rules, or it works only at display scale 1 (check 1.25, 1.5 and 3 too) |
| `docs/` | it lies |
| `scripts/probes/`, fixtures, commits, PR text | it leaks a home path, host name, email, ID or token |
| `.github/workflows/` | it runs a pull request's code with secrets, or uses an action not pinned to a commit |

## Check on every change

- **Fallbacks:** when an optional piece (a helper process, a native module, a CLI feature) answers with an error or times out, the user gets the old path's result, not an error.
- **Hot paths:** nothing quadratic (growing a buffer by concatenation), nothing done per frame, per object or per token that could be skipped, and no single slow request that blocks every session.
- **Tests:**
  - They fail without the change.
  - They don't skip silently in CI.
  - They don't depend on the developer's environment variables.
- **Bug fixes:** the fix is at the root cause, and every place with the same bug class is fixed.

## Paths that always get a deep review

`.github/workflows/`, `src/permissions/`, `src/backends/cli.ts`, `src/server/git-*`, `native/`, `scripts/probes/lib.ts`, `desktop-electron/pack.ts`, `scripts/install-desktop.ts`, `scripts/update-desktop.ts`, and any new dependency in `package.json`, `gui/package.json`, `desktop-electron/package.json` or `native/Cargo.toml`.

## Skip

Lockfiles (`bun.lock`, `native/Cargo.lock`) except for new dependencies, `test/timings.json`, and recorded fixtures under `test/fixtures/` except to check them for leaks.

## How to report

- Evidence for every finding: file and line, plus a quote or the command and its output. Not a guess from a name.
- Tag each finding **Important**, **Nit** or **Pre-existing** (wrong, but not changed by this diff).
- At most five Nits. No style, naming or formatting findings.
- Start the summary with a count. When there's nothing to fix, say so plainly.

## Lessons

Classes of bug that reviews here have caught. Check for each one.

- Display scale: frame and click mapping that only holds at scale 1.
- Long-lived caches sized when they open (pack slots, buffers) that later fail without recovery.
- An error from an optional helper rethrown instead of falling back.
- A wrapper put in front of a spawned program (`nice`, `env`, a shell) that changes which error the user sees.
