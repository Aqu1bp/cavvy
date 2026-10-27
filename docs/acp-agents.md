# Other coding agents (ACP)

Cavvy can run other coding agents you have installed, over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), the way it runs [Claude Code and Codex](subscriptions.md). The agent works with its own tools and models, signed in its own way. Cavvy shows what it does and answers its permission prompts with your rules.

Supported: OpenCode and Grok Build.

## OpenCode

### Setup

1. Install [OpenCode](https://opencode.ai/docs). Its free models work without signing in. For others, sign in there: `opencode auth login`.
2. In Cavvy, `/login opencode` (`cavvy auth add opencode` from a shell, or **Use my OpenCode** in the desktop app's Settings → Providers). Cavvy starts `opencode acp` and checks that it answers, then turns it on.
3. Pick a model in `/model`, like `opencode:opencode/big-pickle`. The list comes from `opencode models`, and model ids go to OpenCode as they are. The effort setting goes to OpenCode when the model has effort levels, and is ignored when it doesn't.

### How it works

- Each Cavvy session gets one `opencode acp --cwd <folder>` process, kept between turns. Your next prompt continues the same OpenCode session (`session/resume`, or `session/load` where that's all it offers), also after a restart. If that session is gone, a new one starts with the conversation so far as context.
- By default OpenCode asks about nothing. Cavvy starts it with its own permission config (`OPENCODE_CONFIG_CONTENT`), which makes it ask before it edits a file, runs a command, fetches, searches the web, starts a sub-agent or goes outside the folder, in every one of its agents. The same config is used in every mode, so a mode change needs no restart. Each ask then goes through Cavvy's rules and mode, as Codex's do:
  - A command is checked as `Bash`, an edit as `Edit` or `Write` of every file it names, a fetch as `WebFetch`. Anything else is checked as a tool named `OpenCode`. An edit that carries the file's new content is a `Write` of that content, and a delete or move says which it is, so a yes to one change doesn't cover another.
  - Deny rules refuse without asking. Allow rules approve. Accept edits approves an edit inside the workspace. Plan refuses edits, and also switches OpenCode to its own plan agent. Bypass approves.
  - OpenCode asks about every command, so a read-only command Cavvy would run for its own models runs without asking you, as with Codex.
  - Auto has no reviewer for OpenCode, so it asks you about anything a rule doesn't approve.
  - A yes is "allow once": "don't ask again" saves a Cavvy rule, never one of OpenCode's. A request Cavvy can't check (an edit that names no file, say) is refused.
- **Not covered:** OpenCode's reads, searches and file listings inside the folder run without asking, so `Read` deny rules don't stop them. A read-only agent (`explore`) is held to reads by Cavvy's checks of what OpenCode asks about.
- **The tripwire:** OpenCode merges its own config with Cavvy's, and Cavvy's wins for the keys it sets, also over a project's `opencode.json`. An allow in your own config for one of OpenCode's agents (`agent.build.permission`) can still win, though. If OpenCode edits, deletes, moves or runs something without having asked (a command that ran and then failed counts too), in any mode but Bypass, Cavvy stops the turn and says which call it was. If OpenCode doesn't stop in time, Cavvy ends the turn and stops its process.
- A project's own OpenCode configuration (`opencode.json`, `opencode.jsonc`, `.opencode/`) is loaded only in a folder you've told Cavvy you trust. Elsewhere OpenCode runs with `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
- `esc` stops the turn (`session/cancel`). The process stays for the next one.
- **Steer** (a message you send while the turn runs) goes to OpenCode at once, as a second prompt. It leaves Cavvy's queue then, and shows in the transcript where it joined the turn. OpenCode folds it into the running turn: the model reads it at its next step, after the tool running now, or with one more step after the answer it's writing. Both prompts end together, as one Cavvy turn, and their tokens are counted once. Images and text files go with it. `esc` stops both.
- Usage is recorded in tokens, and in dollars only when OpenCode reports a cost in USD.

### The agent's credentials

Cavvy never reads, copies or stores OpenCode's sign-in. It starts your installed `opencode` with the same environment as any child process, minus Cavvy's own provider keys, and doesn't offer it Cavvy's file system or terminal over ACP. `opencode auth login` and `opencode auth logout` are OpenCode's own.

### What isn't available

- Several accounts, or plan limits: OpenCode runs with its own default sign-in.
- Cavvy's MCP tools (delegation, secrets, schedules, watches, the browser) and Cavvy's hooks on the agent's tool calls.
- `/compact` (OpenCode keeps its own context, and Cavvy doesn't auto-compact it), forking its session (a fork starts its own with the conversation), importing OpenCode's sessions, and its usage logs.
- OpenCode's own slash commands, an ACP agent registry, and running another ACP command of your choice.
- One-off requests (titles, goal checks, summaries): set `smallModel` to another provider's model.

## Grok Build

### Setup

1. Install [Grok Build](https://x.ai/cli) (`curl -fsSL https://x.ai/cli/install.sh | bash`) and sign in there: `grok login`.
2. In Cavvy, `/login grok` (`cavvy auth add grok` from a shell, or **Use my Grok account** in the desktop app's Settings → Providers). Cavvy runs `grok models` to check that it's installed and signed in, then turns it on. If it says you're not signed in, run `grok login` and check again.
3. Pick a model in `/model`, like `grok:grok-4.7`. The list comes from `grok models`. The effort setting goes to Grok as its reasoning effort (`low`, `medium`, `high` or `xhigh`).

### How it works

- Each Cavvy session gets one `grok agent --no-leader stdio` process in the session's folder, kept between turns. Your next prompt continues the same Grok session (`session/resume`), also after a restart. If that session is gone, a new one starts with the conversation so far as context.
- **Cavvy's gate.** Grok reads your Claude Code and Grok permission settings (`defaultMode` and the allow rules in `~/.claude/settings.json` and the like), and nothing over ACP overrides them. So Cavvy doesn't rely on Grok asking. Each time it opens a Grok session (a new one, or one resumed after a restart), Cavvy registers a `PreToolUse` hook with it (`_meta["x.ai/hooks"]`). Grok then holds every tool call until Cavvy answers: edits, commands, reads, searches, web fetches, and its subagents' calls too. Cavvy decides each one by its rules and the mode it's in at that moment:

  | Cavvy mode | At the gate | Grok |
  |---|---|---|
  | Manual | What Cavvy would ask you about for its own models, it asks: an edit, a delete, a command that isn't read-only. Reads, searches, listings and read-only commands inside the workspace go without asking. Deny rules refuse, allow rules approve. | Grok's default mode. |
  | Accept edits | As Manual, and an edit inside the workspace goes without asking. | Grok's default mode. |
  | Plan | Edits and commands that aren't read-only are refused, except Grok's own plan file (unless a deny rule covers it). | Grok's own plan mode (`session/set_mode plan`), which also refuses edits except its plan file. Leaving Plan sets it back to `default`. |
  | Auto | Everything goes on to Grok's own reviewer, which decides what runs. What it sends for approval goes through Cavvy's rules, and asks you if no rule decides. | Grok's auto mode. |
  | Bypass | Only Cavvy's deny rules refuse. Grok's own always-approve (`yoloMode`) is never used. | Grok's default mode. |

  - A command is checked as `Bash`, a file write as a `Write` of its content (a yes covers that content only), an edit as an `Edit` of the file it names, a read as `Read`, a listing as `LS`, a search as `Grep`, a fetch as `WebFetch`, a subagent as `Task`, and an MCP tool by its `mcp__server__tool` name. Grok's own bookkeeping (its to-do list, a look at a command it started) goes without asking, in Plan too, unless a deny rule names it. Any other tool of Grok's is checked as a tool named `Grok Build`: asked about in Manual, refused in Plan.
  - You see the same permission prompt as for any other agent, with the diff where Grok says the file's content. A subagent's call says which subagent asks.
  - A yes lets the call go on. In its default mode Grok then asks about it itself, and Cavvy answers that yes without asking you again, unless the mode changed in between: then the ask is checked again. A no refuses the call, and Grok's model reads why (Cavvy's reason, or what you said). A no without a word also stops the turn.
  - **Your own allow rules don't skip Cavvy.** An allow rule in your Claude Code or Grok settings, like `Bash(git push *)`, no longer lets Grok run that command unasked in Manual. To keep one unasked, add the same rule to Cavvy (`/permissions`, or `permissions.allow` in Cavvy's settings).
  - Grok goes on without an answer when its wait runs out (Cavvy asks for its longest, 10 minutes), or when the answer is one it can't read. Cavvy always answers in time: a prompt you haven't answered 15 seconds before that is withdrawn, and the call refused. A call Cavvy can't check (a command Grok cut because it's too long, say) is refused, and so is anything Cavvy fails to decide. When you stop the turn, a call waiting at the gate is refused.
- **The tripwire.** If Grok edits a file or runs a command that isn't read-only that neither the gate nor an ask let through, in Manual, Accept edits or Plan, Cavvy stops the turn and says which call it was. Something got past the gate then: an older Grok without client hooks, say. A call the gate let through that Grok ran without asking (your settings let it) is fine.
- Grok takes auto mode only when a session is opened. Switching into or out of Auto starts a new Grok process that resumes the same session, so the conversation is kept, and registers the gate again. That takes a few seconds. Other mode changes apply to the running process, and the gate goes by the mode at each call.
- Changing the mode during a turn: Grok can't leave auto mode mid-turn, so switching from Auto to a stricter mode stops its turn and resumes it under the new one. A looser mode applies from the next turn.
- What Grok asks about itself (`session/request_permission`) goes through the same rules. A yes is "allow once": "don't ask again" saves a Cavvy rule, never one of Grok's. A request Cavvy can't check is refused. When such an ask is refused, Grok ends its turn there, so say what to do instead in your next message.
- Not covered: a search or listing of a folder is checked by its folder, so `Read` deny rules don't stop Grok's own searches or listings of the files inside a folder you allow. A project's `.grok/` and `.claude/` settings follow Grok's own folder trust, not Cavvy's, and Grok's own hooks run as they're set up. A subagent Grok runs in the background can't run anything once the turn has ended: Cavvy refuses its calls then.

### Other details

- `esc` stops the turn (`session/cancel`). The process stays for the next one.
- **Steer** (a message you send while the turn runs) goes to Grok at once, as an interjection (`_x.ai/interject`). It leaves Cavvy's queue then, and shows in the transcript where it joined the turn. Grok adds it at its next step, after the tool running now, or with one more model call after the answer it's writing. The turn ends once, and its tokens cover it. If it reaches Grok just as the turn ends, Grok runs it as a prompt of its own: Cavvy keeps the turn open until that's done, and counts its tokens too. Text only (text files go as text): a message with an image waits for its own turn. `esc` stops the turn, and Grok drops an interjection it hadn't taken yet. Cavvy hands those back for the next turn. It knows which they are from Grok's own record of the session (`updates.jsonl` under `GROK_HOME`, `~/.grok` by default), so `esc` can take up to a second longer while Grok finishes writing it. If the record can't be read, Cavvy guesses from what Grok did after the message went. If the turn has to be ended before Grok answers the stop, Cavvy reads what the record says so far, and a message Grok records later may be sent twice.
- Usage is recorded in tokens only. Grok reports a cost in a unit it doesn't document, so no dollar cost is recorded.
- An image too small for Grok (under 512 pixels in all) is dropped, and the transcript says so.

### The agent's credentials

Cavvy never reads, copies or stores Grok's sign-in (`~/.grok/auth.json`). It starts your installed `grok` with the same environment as any child process, minus Cavvy's own provider keys, and doesn't offer it Cavvy's file system or terminal over ACP. Whether it's signed in comes from what `grok models` prints. `grok login` and `grok logout` are Grok's own.

### What isn't available

- Several accounts, or plan limits: Grok runs with its own default sign-in.
- Cavvy's MCP tools (delegation, secrets, schedules, watches, the browser) and Cavvy's hooks on the agent's tool calls.
- `/compact` (Grok keeps its own context, and Cavvy doesn't auto-compact it), forking its session (a fork starts its own with the conversation), importing Grok's sessions, and its usage logs.
- Grok's own slash commands, an ACP agent registry, and running another ACP command of your choice.
- One-off requests (titles, goal checks, summaries): set `smallModel` to another provider's model.
