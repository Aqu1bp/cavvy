# Working on Harness

Several agents work on this repository at the same time. These rules keep you out of each other's way.

## Branches

- Work in your own git worktree, on a branch from the current `origin/main`. Don't commit to `main`. Every change reaches it through a pull request.
- Keep a pull request to one change, so rebasing it stays cheap.
- GitHub merges a pull request only when it's up to date with `main` and its `ci` check passed. When `main` moves, rebase onto it and push. CI then runs again on the rebased branch.

## Tests

The whole suite takes about 20 minutes on a Mac. When several agents run it at once, they slow each other down until tests time out. CI runs it in about three minutes, so:

- Locally, run only the test files for what you changed: `bun test ./test/foo.test.ts`. The leading `./` makes bun take it as a path rather than a substring of file names. Also run `bun run typecheck`, and `bun run gui:typecheck` if you changed `gui/`.
- Don't run the whole suite locally. Push, then wait for CI: `gh pr checks --watch`.
- When CI fails, find the failing tests with `gh run view <run-id> --log-failed`, run those files locally, fix them, and push.
- When a test fails in CI and then passes on a rerun (`gh run rerun <run-id> --failed`), it's flaky. Open an issue with the log excerpt. Don't add retries to make it pass.

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, on Linux:

- **Typecheck and GUI build:** `bun run typecheck`, `bun run gui:typecheck`, `bun run gui:build`.
- **Tests (1/4 to 4/4):** the suite split across four machines by `scripts/test-shard.ts`, using each file's time from `test/timings.json`. A new file counts as the median file until the timings are refreshed. To refresh them, download a recent `main` run's reports and rewrite the file:

  ```bash
  gh run download <run-id> -p 'junit-*' -D /tmp/junit
  bun scripts/test-shard.ts --timings /tmp/junit/*/*.xml
  ```

- **ci:** passes only when every job above passed. Branch protection requires this check.

**For now:** some tests fail on Linux, tracked in #135, #136, #137 and #138, so `ci` fails on every pull request until those are fixed and isn't required yet. Until then, compare your pull request's failures with those issues. Anything not listed there is yours to fix.
