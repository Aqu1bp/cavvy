---
name: e2e-test
description: Test a change end to end in the real app, the way a user would, hunting for the bugs they'd hit. Builds a case list from what the change touches, runs every case in the built app with evidence, fixes what fails and retests, over at most three rounds. Use when a feature or fix is built and before calling it done, or when asked to test a change end to end. Add --fresh to also have an agent that didn't build it test it.
argument-hint: "[--fresh] [what to test, if not the change in this session]"
---

# Test a change end to end

Arguments: $ARGUMENTS

Your job is to find the bugs a user would hit, not to show the change works. Passing everything on the first try usually means the cases were too easy: look again before you believe it.

## 1. Say what you're testing

- **The change:** what was built in this session, or what the arguments name. Diff it against `origin/main` (`git diff origin/main...HEAD`, plus uncommitted changes) so you know every file it touches.
- **The intent:** the user's own words: their request or the pull request body. Not your summary of what you built: if you misread the request, testing against your reading will pass anyway.
- **State folder:** `${TMPDIR:-/tmp}/e2e-test/<branch>/`. Keep the case list, screenshots, logs and each round's results there, never in the repository.

## 2. Write the case list before running anything

One line per case: **what the user does → what they should see**. Failures count as cases: the user should see what went wrong and what to do, never a result that didn't happen.

Build it in this order:

1. **Your own shortcuts.** List every assumption and corner you cut while building: "the server always answers", "the path exists", "only one window is open". Each one is a case. This is where your bugs are.
2. **The intent, case by case.** Every behaviour the user asked for, including each variant they mentioned.
3. **What the change touches.** Go through the table and add the cases for every row that applies. Skip a row only when the change truly doesn't touch it, and say so.

| If the change… | Test |
|---|---|
| Has any UI | Empty state, very long content, odd input (unicode, pasted files, huge text), rapid repeat clicks, keyboard only, light and dark mode, small window. The screen matches what actually happened. The copy follows AGENTS.md's UI copy rules |
| Runs during a turn | Esc mid-turn, steering vs. queueing, each permission mode, reloading the session mid-turn and after |
| Talks over a network or to another process | It's unreachable, slow, times out, drops mid-operation, returns an error, returns garbage. Afterwards the user sees what happened and what was lost |
| Uses credentials or secrets | Missing, wrong, expired, revoked. They never appear in logs, screenshots, the model's context, or files written elsewhere |
| Reads or writes files | Missing, unreadable, read-only, huge, odd names (spaces, unicode), disk full, a file changed underneath it. Undo and snapshots still work |
| Runs commands or reaches another machine | Each permission mode and the sandbox still apply, the command runs where the user thinks it does, a dangerous command still asks |
| Keeps state | Restart the app, reload the session, two sessions or windows at once, upgrading with old state on disk |
| Adds or removes a configured thing (account, server, provider…) | Adding one that's broken, removing one that's in use, switching between several |
| Exists in both the GUI and the TUI | Every case in both |
| Is next to other features | The neighbouring features still work: list the ones the diff could break and check each |
| Costs something per reply, turn or startup | `bun run perf:budgets` after `gui:build`, and AGENTS.md's Performance section |

Show the user the case list before running it. If they add cases, add them.

## 3. Run every case in the real app

- **Where:** the built app, launched as AGENTS.md says (isolated `CAVVY_HOME`, `CAVVY_ELECTRON_USER_DATA`, `CAVVY_NO_KEYCHAIN=1`, started directly, never with `open`). For the GUI without real models, `bun run gui:demo`. Unit tests don't count as running a case.
- **Real CLIs:** only harmless commands, in a scratch repository, with a test `HOME` of their own. If a CLI needs signing in, ask the user once; if they can't, mark those cases blocked and say so. Never fall back to the real `HOME`.
- **Outside services:** use a throwaway one (a local container, a test account), never the user's real data. Prefer one you can break on purpose (cut the network, add latency, fill the disk) so the failure cases are really run, not reasoned about.
- **Evidence for each case:** a screenshot, the command and its output, or the log or session-file line that shows what happened. Check a CLI's session file to know whether it read a message; don't infer it. A case without evidence wasn't run.
- **Scrub:** evidence may hold host names, home paths, keys or account IDs. Keep it in the state folder; anything that goes into a pull request is trimmed and checked as AGENTS.md's "It's public" says.

What can't run here (the desktop app on a Mac, a CLI nobody can sign in) goes in the report as a manual check left for the user. Never mark it passed.

## 4. Fix and retest

For each failure:
- Fix the cause, not the symptom. Search the change for every other place with the same mistake and fix those too.
- Add a test that fails without the fix where one can be written: `bun test ./test/<file>.test.ts`, never the whole suite.
- Rerun the failed case, and the cases around it that the fix could affect.

Then the typechecks: `bun run typecheck`, plus `gui:typecheck` for `gui/` and `desktop:typecheck` for `desktop-electron/`.

At most three rounds. If cases still fail after round 3, stop and say so plainly: the approach may need rethinking.

A security bug (something a repository, a page, an agent or a remote machine could use against the user) is fixed without describing the exploit, and never written into an issue, pull request or comment: see `SECURITY.md`.

## 5. Fresh tester (with --fresh, or when the change is risky)

When the arguments include `--fresh`, or the change touches credentials, permissions, another machine, or what runs on the user's computer, start one subagent that didn't build it, after your own rounds pass. Offer it in one line if `--fresh` wasn't given.

Give it only:
- the user's intent, in their words (step 1)
- the branch and how to launch the app
- this skill's steps 2 to 3
- the instruction: "Find what the first tester missed. Attack the parts where a mistake does the most damage."

Don't give it your case list or your results: it would test the same things. Fix what it finds as in step 4.

## 6. Report

Lead with one line: cases run, passed, failed and fixed, blocked, and rounds taken.

Then a table, one row per case:

| Case | Expected | Actual | Result | Evidence |
|---|---|---|---|---|

Result is PASS, FIXED (round N, commit), FAIL, or BLOCKED (why). Evidence is a path in the state folder or the output itself.

Then:
- **Bugs found:** what the user would have seen, the cause (file:line), and how it was fixed.
- **Not tested:** each case left out, and why.
- **Manual checks left:** what the user has to try themselves, step by step.
- **Felt wrong:** anything that passed but would confuse a user.

Never write "LGTM", "should work" or "looks good". Say what ran, what it showed, and what didn't run.
