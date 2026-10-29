# Antigravity

Cavvy can run Google's Antigravity CLI (`agy`) with your Antigravity plan, the way it runs [Claude Code and Codex](subscriptions.md). `agy` works with its own tools, models and context, signed in its own way. Cavvy shows what it does and decides each of its tool calls with your rules.

## Setup

1. Install [Antigravity's CLI](https://antigravity.google/docs/cli), run `agy` once and sign in there (Google's own sign-in).
2. In Cavvy, `/login antigravity` (`cavvy auth add antigravity` from a shell, or **Use my Antigravity plan** in the desktop app's Settings → Providers). Cavvy runs `agy models` to check that it's installed and signed in, then turns it on.
3. Pick a model in `/model`, like `antigravity:gemini-4-argon-high`. The list comes from `agy models`, and each model id names its effort (`-low`, `-medium`, `-high`), so Cavvy's effort setting isn't used.

macOS and Linux only for now: the permission hook is a shell script that needs `curl`. Without it, setup says so and Antigravity isn't turned on.

## How it works

- Each Cavvy session gets one `agy -p= --input-format stream-json --output-format stream-json` process in the session's folder, kept between turns. Your next message continues the same Antigravity conversation (`--conversation`), also after a restart. If that conversation is gone, a new one starts with the conversation so far as context.
- **Cavvy's gate.** Run this way, `agy` can't ask you anything: on its own, it refuses whatever needs approval. Cavvy adds a folder of its own as another workspace (`--add-dir`, after your `additionalDirectories`), whose `.agents/hooks.json` has a `PreToolUse` hook. `agy` runs it before every tool call, its subagents' too, and the hook asks the Cavvy session that started it (on 127.0.0.1, with a token only that process has). Cavvy decides the call by its rules and the mode it's in at that moment, and answers `auto_approve` or `deny`. Nothing is installed into `agy`, and your own `agy` runs never see the hook.

  | Cavvy mode | At the gate |
  |---|---|
  | Manual | What Cavvy would ask you about for its own models, it asks: an edit, a write, a command that isn't read-only. Reads, searches and read-only commands inside the workspace go without asking. Deny rules refuse, allow rules approve. |
  | Accept edits | As Manual, and an edit inside the workspace goes without asking. |
  | Plan | Edits, writes and commands that aren't read-only are refused. |
  | Auto | There's no reviewer for `agy`: edits inside the workspace go without asking, and anything else a rule doesn't approve is asked about. The mode menu says so. |
  | Bypass | Only deny rules refuse. |

  - A command is checked as `Bash`, a write as a `Write` of its content (a yes covers that content only), an edit as an `Edit` of the text it replaces, a read as `Read`, a web search as `WebSearch`, a fetch as `WebFetch`, an MCP tool by its `mcp__server__tool` name. Its own bookkeeping (waiting on a command, its task list, its subagents' messages to each other) goes without asking unless a deny rule names it. Any other tool of its own (the browser, image generation, schedules) is checked by its own name, `Antigravity_` and agy's name for it (`Antigravity_generate_image`, `Antigravity_open_browser_url`): asked about in Manual, refused in Plan. A yes for the session covers that tool only, and a rule names one the same way.
  - You see the same permission prompt as for any other agent, with the diff of a write or an edit. A no refuses the call, and the model reads why (Cavvy's reason, or what you said). A no without a word also stops the turn.
  - `agy` refuses a call when the hook fails or gives no answer, so Cavvy not answering never lets one through. Cavvy withdraws a prompt you haven't answered after about an hour, and the call is refused. When you stop the turn, a call waiting at the gate is refused.
  - When a new conversation starts, the hook tells the model which folder is its own: `agy` lists its workspaces by path, and Cavvy's comes second for most project folders but not all of them. A write or an edit in Cavvy's folder is refused with a note that sends the model back to yours; nothing ran, so the transcript doesn't show it.
- **The tripwire.** If `agy` runs a command, a write or an edit that never reached the gate, in any mode but Bypass, Cavvy stops the turn and says which call it was. Something got past the gate then: an `agy` that no longer loads the hook, say.
- `esc` stops the turn. Nothing on `agy`'s input stops a turn, so Cavvy sends it SIGINT: it ends the turn and exits, and your next message starts it again on the same conversation. That takes a few seconds.
- **Steer** (a message you send while the turn runs) joins it at `agy`'s next model call: after the tool running now, through the same hook folder (a `PreInvocation` hook that adds it as your message). It leaves Cavvy's queue then, and shows in the transcript where it joined. If the turn ends before another model call (it was writing its answer), the message goes as your next turn. `esc` stops the turn, and a message that hadn't reached `agy` yet goes back to the queue. Cavvy knows which reached it: each shows in `agy`'s output as a message of its own.
- **Images and PDFs.** `agy` takes text only on its input, but its `read_file` shows the model an image or a PDF. So Cavvy writes each attachment to a folder of its own (beside the hook folder, readable only by you) and names it in the message, and the model reads it there. Reading those files goes without asking (deny rules still apply). They're deleted when `agy` stops. Steering messages carry them the same way.
- Changing the model restarts `agy` on the same conversation.
- **Fork and rewind.** `agy` can't fork or rewind a conversation of its own, so a fork, or a rewind, starts a new one with the conversation so far as context.
- **Titles.** `agy` can't answer a one-off request, so with no `smallModel` set, a session is named after its first prompt.
- Usage is recorded in tokens only. It's covered by your plan, so no dollar cost is recorded.

### What protects the hook

- A project's `.agents/` folder (where `agy` reads its hooks, skills and rules) is treated like `.claude/` and `.codex/`: changing it asks in every mode but Bypass, for every agent Cavvy runs, and the shell sandbox keeps it read-only. So are `agy`'s own settings: `~/.gemini/config/` and `~/.gemini/antigravity-cli/`.
- Cavvy's hook folder is in your temporary folder, readable only by you, and written again whenever it doesn't hold what Cavvy put there.

### Not covered

- A project's own `.agents/hooks.json` runs on `agy`'s rules, and nothing turns it off. So in a folder that has one, `agy` runs only once you trust the folder: sending a message there asks you to trust it first (`/trust` in the terminal), and the message waits in the box. The same goes for an additional directory with one. Its hooks can't let a call through that Cavvy refuses: a single deny refuses it.
- Your own `agy` settings still apply on top of Cavvy's answers: a deny rule there refuses a call Cavvy allowed.

## The agent's credentials

Cavvy never reads, copies or stores Antigravity's sign-in. It starts your installed `agy` with the same environment as any child process, minus Cavvy's own provider keys, plus the gate's address and token. Whether it's signed in comes from what `agy models` prints. Signing in and out (`/logout` inside `agy`) is Antigravity's own.

## What isn't available

- Several accounts, and plan limits.
- Cavvy's MCP tools (delegation, secrets, schedules, watches, the browser, worktrees) and Cavvy's hooks on the agent's tool calls.
- `/compact` (`agy` keeps its own context), importing its conversations, and its usage logs.
- One-off requests (titles, goal checks, summaries): set `smallModel` to another provider's model.
- The gate's address and token are in the environment of the commands `agy` runs, as they are in the hook's. A command that uses them can only ask Cavvy about a call (you see the prompt) or take a message you queued to steer the turn; it already runs as you.
