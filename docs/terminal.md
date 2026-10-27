# The terminal app

## Basics

- `@path` attaches a file (completion included); `!cmd` runs a shell command yourself; `#note` saves a memory; `/` opens commands.
- `esc` interrupts; type while it works and `enter` steers: your message joins the running turn at its next step. `tab` queues it for after the turn instead (the `followUpBehavior` setting swaps the two; the prompt says which key does which). A model that can't take messages mid-turn queues them either way. While messages are queued, `esc` takes back the latest one into the prompt instead (one per press), and interrupts once nothing is queued; after an interrupt, anything not yet sent goes back to the prompt; `ctrl+o` toggles verbose output; `ctrl+t` toggles the todo list; `ctrl+g` opens `$EDITOR`; `↑`/`↓` history.
- For a newline in the prompt, type `\` then `enter`, or press `ctrl+j`. `shift+enter` works too in terminals that support the kitty keyboard protocol, which Cavvy turns on while it runs; in other terminals it usually sends the message instead.
- Cavvy takes over the terminal window: it clears the screen and scrollback when it starts, keeps the spinner, prompt and status line on the bottom rows (the reply and running tools follow the conversation above them; when a turn ends, the conversation is brought back down to the prompt), and lets the conversation scroll into the terminal's own scrollback (so scrolling, selecting and copying work as usual, and the conversation stays there after you quit). When the window is resized, it clears the screen and scrollback again and lays everything out at the new size.
- Sessions are saved per project. Resume them with `-c` (latest), `-r` (picker) or `/resume`. `--append-system-prompt` applies to the run you give it on, a resumed session included, and isn't saved with the session.
- `--max-turns n` stops each prompt after n model turns, in the TUI as with `-p`; send another message to let it continue.
- Jupyter notebooks: `Read` shows each cell with its id, and the `NotebookEdit` tool replaces, inserts or deletes a cell by that id (replacing a code cell clears its outputs). It asks for permission like any other edit.
- `/rewind` (or `esc esc` on an empty prompt) goes back to before one of your prompts: restore the files Cavvy changed since then, the conversation, or both. The prompt goes back in the input box to edit and resend. Before an edit tool first changes a file during a prompt, Cavvy saves a copy in `~/.cavvy/projects/<project>/file-history/<session>/` (private to you; files over 10 MB aren't saved), so it works after `-c`/`-r` too. Files changed outside Cavvy since it last wrote them are listed before they're overwritten, and if a file can't be restored the conversation is kept, so you can try again. Shell and backend edits are recorded separately in Git turn snapshots for review, but `/rewind` still restores only the edit tools’ copies. Prompts from before a `/compact` can't be rewound to. Both kinds of history are deleted 30 days after the session was last used.
- `/fork` (GUI or terminal) continues in a new session from the latest finished response. In the GUI, use **Fork from here** on an earlier response or ⌘K → **Fork session**; **Forked from …** opens the original. The terminal prints its `/resume <id>` command. A fork keeps the conversation, timeline, frozen system prompt, and current model, effort, permission mode and speed, with the title "Fork of <title>". Spend starts at zero; queues, shells, delegated tasks and file history aren't copied. Rewinding before the fork restores only the conversation and files changed by the fork itself; earlier file changes can only be restored from the original. Imported CLI responses can be forked too, while their original rewind restrictions remain. Running turns and turns before the last compaction can't be forked. Claude Code (`--resume --fork-session`) and Codex (`thread/fork`) copy eligible backend sessions on next use: both sessions first persist a marker preventing either from continuing the shared backend in place. For an earlier cut or a busy original, the fork instead starts a fresh backend with conversation context.

## Commands

Commands: `/help /model /login /logout /providers /effort /permissions /mode /plan /clear /compact /cost /context /status /resume /rewind /fork /rename /export /copy /init /review /memory /config /thinking /mcp /plugin /agents /hooks /todos /tasks /bashes /add-dir /doctor /exit`.

Custom commands are markdown files in `~/.cavvy/commands/` or `.cavvy/commands/`. The body is the prompt; `$ARGUMENTS` and `$1`…`$9` are substituted; `commands/git/pr.md` becomes `/git:pr`.

## Status line

```jsonc
{ "statusLine": { "command": "~/.cavvy/statusline.sh" } }
```

The command gets `{session_id, cwd, model: {id, display_name}, permission_mode, cost_usd, context_tokens, context_window}` as JSON on stdin. The first line it prints replaces the right side of the footer. It runs at most every 2 seconds and is killed after 3. Colors are kept; any other escape sequence is stripped.

## Notifications

When the terminal window isn't focused, Cavvy lets you know when a turn that took 30 seconds or more finishes, when it's waiting for you (a permission prompt, a question, or a plan to approve), and when a turn stops with an error.

```jsonc
{ "notifications": "auto", "notifyAfterSeconds": 30 }
```

| `notifications` | How |
|---|---|
| `auto` (default) | A desktop notification in terminals known to show one (iTerm2, WezTerm, Ghostty, kitty, foot), otherwise the terminal bell. |
| `terminal` | The terminal's notification sequence: OSC 9, or OSC 99 in kitty. |
| `bell` | The terminal bell. |
| `system` | `osascript` on macOS, `notify-send` on Linux. The bell if that fails. |
| `off` | Nothing. Notification hooks still run. |

`/config` switches between them. Focus comes from the terminal's focus reporting. If the terminal doesn't report focus, prompts and errors always notify, and so do turns over the time limit. Nothing is notified in `-p` mode. Messages are short ("Cavvy: done (2m 10s)", "Cavvy: waiting for your approval") and never include tool input.

Inside tmux, `auto` uses the bell, which tmux passes on to your terminal. `terminal` wraps the sequence for tmux passthrough, which works only with `set -g allow-passthrough on` (tmux 3.3 and later; `on` passes it only from a visible pane, `all` from any pane). For focus reporting inside tmux, also `set -g focus-events on`.
