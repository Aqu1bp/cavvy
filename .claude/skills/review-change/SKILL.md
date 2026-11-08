---
name: review-change
description: Review a finished change (feature, bug fix, UI) before it merges. Fresh-context reviewers read the diff against the repo and the change's intent, a vote of verifiers keeps only real findings, and on your own branch it fixes them over at most three rounds. Use after implementing something, or on a pull request.
argument-hint: "[quick|standard|deep] [PR number | branch] [--no-fix]"
disable-model-invocation: true
---

# Review a change

Arguments: $ARGUMENTS

You run the review. Subagents read and judge the code: you never review the diff yourself, because you may have written it. You collect evidence, brief the subagents, tally the votes, fix what survives and report.

The prompts for the subagents are in `prompts.md` in this skill's folder. `REVIEW.md` at the repository root says what failure looks like in this repo. Read both before starting.

## 1. Work out what to review

- **Target:**
  - A PR number: that pull request.
  - A branch name: that branch.
  - Nothing: the current branch, including uncommitted changes.
- **Base:** a pull request's base branch (`gh pr view <n> --json baseRefName,headRefOid,author,title,body`). Without a pull request, the base is `origin/main`. Diff against the merge base: `git diff origin/<base>...HEAD`. Fetch first, and say which base you used.
- **Checkout:** review a pull request or another branch in its own worktree under the state folder (below), never in the user's working tree.
- **Fix or report only:**
  - Fix on the current branch, or on the user's own pull request when they asked you to review it.
  - Report only with `--no-fix`, or on anyone else's pull request.
- **Whose code it is:** if the pull request's author isn't the user, or its diff touches `package.json`, a lockfile, `scripts/` or test helpers in a way nobody has read yet, the review is read-only. Reviewers and voters must not run its code: no tests, no scripts, no installs (AGENTS.md: a person reads a contributor's changes before they run on this machine). Tell every subagent so.
- **State folder:** `${TMPDIR:-/tmp}/review-change/<repo>-<branch or pr-N>/`. Keep the diff, the intent, each round's findings and votes, and `state.json` there:
  - `round`
  - the commit last reviewed
  - every finding already reported
  - every finding refuted

  Never put any of this in the repository. If `state.json` exists for this target, continue from it, don't start over.

## 2. Get the intent

Reviewers judge the diff against what it's meant to do, so you need that in writing.

- A pull request's title and body are the intent.
- Otherwise, write it from the conversation: the problem, the change, and the "what the user sees in each case" list from AGENTS.md.
- If neither gives you enough, ask the user in one question before going on.

Save it as `intent.md` in the state folder.

## 3. Check the change runs (before any reviewer)

Collect evidence by change type. Show output, don't summarise it.

- **Bug fix:** a test that fails without the fix and passes with it. Show both runs.
- **Feature:** each case in the "what the user sees" list, with how it was checked.
- **UI:**
  - Screenshots from `bun run gui:demo` in light and dark mode.
  - Display scales 1 and 1.5 where the change draws or maps coordinates.
  - The copy checked against AGENTS.md's UI copy rules.
- **Always:**
  - `bun run typecheck`, plus `bun run gui:typecheck` for `gui/` and `bun run desktop:typecheck` for `desktop-electron/`.
  - The test files for what changed: `bun test ./test/<file>.test.ts`. Never the whole suite.

Skip running anything when the review is read-only (step 1). What can't run here, such as the desktop app on a Mac, goes in the report as a manual check. Never claim it was done. If a check fails, stop and report it: reviewing a change that doesn't run wastes the reviewers' time.

## 4. Pick the depth

The change sets the depth, not the author. Use the first that applies:

1. The depth the user gave.
2. **Deep:**
   - the diff touches a path REVIEW.md lists under "Paths that always get a deep review", or
   - it changes more than 400 lines outside tests and docs.
3. **Quick:** the diff only touches docs, copy or tests, or changes fewer than 40 lines and none of them in the core (AGENTS.md's list).
4. Otherwise **Standard**.

Then ask whether this particular change needs more than its tier, whatever its paths and size. Examples: it starts a process, makes a network call, deletes or overwrites files, touches credentials, or changes what runs at install or update. If it does, raise the depth one level and say why. Never lower it below what the rules gave, and never go below the depth the user typed.

| | Reviewers in round 1 | Reviewers may run code | Voters per finding | A finding is kept when |
|---|---|---|---|---|
| Quick | 1, all lenses | no | 1 | the voter confirms it |
| Standard | 2: correctness; rules, tests, performance and security | yes, to confirm a finding | 3 | at least 2 of 3 confirm it |
| Deep | 3 or more: correctness (split by area when the diff spans several); rules, tests and performance; security and dependencies | yes, and they should reproduce | 3 | at least 2 of 3 confirm it |

Tell the user the depth and the reason in one line, then go on.

**Subagents:**
- Use the most capable model at high effort: in Claude Code, model `opus`, effort `high`. In Cavvy, the `Task` tool with the strongest model you have.
- Use an agent type that can run commands when the depth lets reviewers run code; Cavvy's `explore` agents refuse tests.
- Start the reviewers together, then the voters together. Cavvy runs at most four at once.

## 5. Review round

**Round 1** reviews the whole diff. Brief each reviewer with prompts.md's reviewer prompt: the lens, the paths to the diff, `intent.md` and the checkout, and whether it may run code.

**Rounds 2 and 3:**
- One reviewer reads only the diff since the commit last reviewed, plus the fixes.
- It checks that each fix really fixes its finding, and looks for every place with the same bug class.
- Give it the list of findings already reported and refuted, so it doesn't repeat them.

When the reviewers are done:
1. **Merge duplicates.** The same defect found by two reviewers is one finding. Keep both reproductions as evidence, and note the agreement.
2. **Settle disagreements:** where reviewers contradict each other, put the question to the voters.
3. **Vote.** Each voter gets every finding of the round and judges each one on its own (prompts.md's voter prompt). Voters reproduce where they may run code, and they don't see each other's verdicts.
4. **Tally:**
   - A finding is kept when enough voters say CONFIRMED.
   - Its tag (Important, Nit, Pre-existing) is the one most voters gave, and on a tie, the lower one.
   - A finding most voters REFUTED goes into the refuted list in `state.json`, and isn't reported again.
5. **Filter:** drop style, naming and formatting findings. Keep at most five Nits, the ones voters rated most useful.

## 6. Fix (unless report-only)

- **Important:** fix every one, at the root cause and at every place with the same bug class, not only the line cited. Add a test that fails without the fix where one can be written.
- **Nits:** fix those that are small and inside the change's scope. List the rest.
- **Pre-existing:** never fix them on this branch: AGENTS.md wants one kind of change per pull request. List them as follow-ups (a separate pull request or an issue).

Then re-run step 3's checks for what you touched, and commit the round's fixes as one commit (`Review fixes: <what>`). The next round then reviews exactly that commit. Don't push unless the user asks.

**Rounds:**
- Run the next round while kept Important findings remain open, up to three rounds in all.
- After round 3, stop even if some are still open. Say plainly that three rounds didn't converge and that the approach may need rethinking. Don't start a fourth round.
- A round that keeps no Important finding ends the loop.

## 7. Report

Write it in chat. Lead with the count line.

1. **Count:**
   - kept findings by tag
   - how many were refuted
   - how many rounds it took to pass, or that it didn't pass in three
   - the depth used
2. **Findings, most severe first.** Each with:
   - its tag and file:line
   - one sentence on the defect
   - what the user would see
   - the evidence
   - its status: fixed in round N with the commit, open, or listed for later
3. **Manual checks left:** what couldn't run here.
4. **Pull request text** (for the user's own change), for the user to paste:
   - **Testing:** the commands that ran and what they returned.
   - **Risk:** what could break, and who would notice.
   - **How to revert:** the commit or flag.
   - A short explanation of the change for the reviewer.

   Don't post it.
5. **Lessons for REVIEW.md:** for each kept finding whose class REVIEW.md doesn't already cover, propose one line for its Lessons section. Ask before editing REVIEW.md. If the user agrees, commit it on its own, or as its own pull request when the branch is a different kind of change.

Never comment on, approve or push to a pull request unless the user asks after seeing the report. Keep the state folder for the next run.
