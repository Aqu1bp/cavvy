# Harness

A coding agent for your terminal that works with any model provider. It reads, edits and runs code in your project, asks before doing anything risky, and keeps your API keys out of everything it writes.

```bash
bun install
bin/harness                 # interactive
bin/harness -p "explain src/agent/agent.ts"   # one-shot
```

Put `bin/` on your `PATH` (or run `bun link`) to type `harness` anywhere. `bun run build` produces a standalone binary in `dist/harness`.

## API keys

Run `harness` and type `/login`, then paste a key. The provider is recognized from the key's format (you pick from a list when it's ambiguous), the key is checked with one cheap authenticated request, and then stored:

- in the OS keychain (macOS Keychain, libsecret, Windows Credential Manager) via `Bun.secrets`, or
- in `~/.harness/credentials.json` with mode 600 when no keychain is available.

Supported: Anthropic, OpenAI, Google Gemini, Google Vertex AI (through gcloud, below), OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Fireworks, Cerebras, plus Brave and Tavily for web search. Ollama and LM Studio are picked up automatically when they're running. `/login custom` adds any OpenAI-compatible (or Anthropic- or Responses-compatible) endpoint.

From a shell: `harness auth add [provider]` (hidden prompt, or pipe the key on stdin), `harness auth list`, `harness auth remove <provider>`. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) also work and take precedence.

### Google Cloud (Vertex AI)

Gemini through Vertex AI (which Google now calls Gemini Enterprise Agent Platform) is billed to a Google Cloud project, so Cloud credits such as the free trial's apply. A Gemini API key from AI Studio is billed separately, and the free trial's credit doesn't cover it.

There's no key to paste. Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install), run `gcloud auth login`, then `/login vertex` in the harness:

1. Pick the Google account (from the accounts gcloud is signed in with).
2. Pick the project to bill (projects with billing on are listed first).
3. Pick `global` or a region.

The setup is checked by listing the model catalog at the location you picked (no model is called), so a misspelled region is caught before anything is saved. If the Vertex AI API is off in the project, you're offered to turn it on (`gcloud services enable aiplatform.googleapis.com`). From a shell: `harness auth add vertex --project <id> [--location global] [--account <email>]`.

Only the project, location and account are saved (in `~/.harness/providers.json`). Requests carry an access token from `gcloud config config-helper --account=<account>`:

- The harness keeps the token in memory until a few minutes before it expires, and forces gcloud to issue a new one if Vertex rejects it.
- gcloud keeps its own copy in its credential store, as it does for any gcloud command. Its log file is turned off for these calls, because it would record the token there.
- The token is only sent to `aiplatform.googleapis.com` (or the region's own host).
- It's masked like a key, and so is any other Google access token (`ya29.…`) that shows up in tool output.

The account is always named explicitly, so switching gcloud's active account doesn't change who is billed. Shell commands that print a gcloud token ask first. `/logout vertex` removes the setup; gcloud itself stays signed in.

Vertex's model catalog has no context sizes or prices. They're filled in from the Gemini API's listing (if you also have a Gemini key) and OpenRouter's catalog (if you have an OpenRouter key).

How keys are kept safe:

- A key is only ever sent to its own provider's API host. (Vertex AI uses gcloud tokens instead of a key; see above.)
- Keys are registered with a redactor, so they're masked in tool output, session transcripts, exports, and error messages. Nothing that's written to disk (sessions, history, settings, the model cache) contains a key.
- Everything that enters the conversation is redacted before any model sees it: your prompts, tool results, memory files, and the model's own replies (so a key can't hop from one provider's transcript to another's when you switch models). The terminal and `-p` output are redacted too, and so is what hooks receive on stdin.
- Every process the harness starts (shell commands, hooks, MCP servers, git, ripgrep, your editor) gets an environment with all provider keys removed. A settings `env` entry can't put one back; MCP servers' own `env` blocks are passed through as you wrote them.
- The agent's file tools can't open the credential store at all. Reading `.env` files, `~/.ssh`, `~/.aws` and similar asks first, through the Read tool or a shell command. Shell commands are matched on their text, so this is a guard against fishing, not a sandbox.
- A `.env` in the project you're working on is never loaded. Only the harness's own `.env` and `~/.harness/.env` are read, and only for known variables.
- `bin/harness` starts Bun with `--no-env-file` and its own `--config`, because Bun otherwise reads `.env` and `bunfig.toml` from the current directory, and a repository's `bunfig.toml` can preload scripts.

## Models

`/model` shows one combined, searchable list of every model from every provider you have a key for, with context window and price (USD per million input/output tokens; `~` means the price comes from OpenRouter's catalog). Lists are cached for 12 hours; `ctrl+r` in the picker refreshes. Use `←`/`→` in the picker to set reasoning effort. Your choice is remembered.

Shortcuts: `/model gpt-6.1-sol` (unique match), `--model anthropic:claude-opus-5-5`, `harness models` for the same list in the shell (`--json` for scripts).

Model ids are `provider:model`. Wire formats: Anthropic Messages (with prompt caching and adaptive thinking), OpenAI Responses (stateless: output items are replayed each turn), and Chat Completions for everything else.

## Permission modes

`shift+tab` cycles modes; `/mode` picks one; `--permission-mode` sets it at startup.

| Mode | What runs without asking |
|---|---|
| **Manual** (default) | Reads, searches and read-only shell commands inside the workspace. Everything else asks. |
| **Accept edits** | The above, plus file edits inside the workspace. |
| **Plan** | Read-only research. Edits and state-changing commands are refused until you approve the plan the model presents. |
| **Auto** | Edits in the workspace and temp directories, shell commands inside a sandbox, and anything else a reviewer model judges routine and asked for. Risky actions are shown to you with the reason. See [Auto mode](#auto-mode). |
| **Bypass permissions** | Everything. Only available when started with `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`, or with `permissions.allowBypass` in your user settings. |

Whatever the mode:

- Deny rules always win.
- Catastrophic commands (`rm -rf ~`, `mkfs`, writes to raw disks, fork bombs and similar) always ask, even in bypass mode.
- Edits to the harness's own configuration, `.mcp.json` or `.git/` always ask, except in bypass mode.

When a prompt appears you can allow once, allow and don't ask again (saved as a rule in `.harness/settings.local.json`), or decline and say what to do instead.

### Auto mode

- **Sandboxed shell.** Shell commands, read-only ones included, run in a sandbox when the OS has one: Seatbelt (`sandbox-exec`) on macOS. On Linux, bubblewrap is used only when you turn it on with `"sandbox": true`, because it's experimental (see below). Inside the sandbox a command:
  - can write only in the workspace and the temp directories, and never to `.git/hooks`, git config (submodules' and worktrees' included), `.harness/`, `.mcp.json` or `~/.harness`. It also can't move or repoint the repo's git directory (`.git`, a worktree's `.git` file, `commondir`) or the workspace itself, so it can't plant config that a later unsandboxed git command would run;
  - can't read credential files (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, the keychain, `~/.harness` and others);
  - has no network except localhost and the hosts the command lists (below), and no Unix sockets (so no ssh-agent or Docker);
  - can't signal processes it didn't start;
  - on macOS, can't open apps, send Apple Events, create launchd jobs, or reach the keychain, clipboard or window server.

  Sandboxed commands run without asking and without review. The exception is commands that delete or discard work, which go to the reviewer first and then still run sandboxed. These are `rm`, `find -delete`, `git checkout` of files, `git restore`, `git stash drop`, `git branch -D`, and deletions in inline `python -c`/`node -e` code.
- **Network in the sandbox (macOS).** A command that needs the network lists the hosts in `allowedHosts`, like `["registry.npmjs.org"]` for `npm install`. The reviewer sees the hosts with the command, and if it allows them the command runs sandboxed with only those hosts open, for that command only. This works for package installs (npm, pnpm, yarn, Bun, pip, uv), `npx`/`bunx`, `curl`/`wget` and `git clone` over https. Each command gets its own proxy on localhost, which tools find through `HTTPS_PROXY` and the like. Other commands can't use it: it wants a password that's only in that command's environment, which macOS doesn't show to other processes. It refuses unlisted hosts and names them in the result, so the model knows what to ask for. It also refuses a listed name that resolves only to this machine or the cloud metadata address, unless the IP itself is listed. A command that clearly needs the network but lists no hosts is turned back with the likely hosts before it runs. Sandboxed npm, Bun, uv and pip get their own package caches in the temp directory, and so does Corepack (the pnpm or yarn a project pins) when the command lists hosts.
- **The reviewer** sees everything else:
  - commands that need more than the network (`git push`/`fetch`/`pull`, an ssh `git clone`, `gh`, `docker`, cloud CLIs, `npm publish`, `kill`, …), read-only ones like `gh pr view` included, since even those can run programs from a repo's config;
  - sandboxed commands that list hosts;
  - commands the model reruns outside the sandbox after the sandbox got in the way (`dangerouslyDisableSandbox`);
  - web fetches and MCP tools.

  It's a small model (`smallModel` in settings, or the provider's small default). It allows routine work, and effects outside the machine (push, PR, deploy) only when you asked for that specific action in your own words. Everything else is shown to you with its reason: pushes, deploys, publishing or messages you didn't ask for, exposing secrets, data leaving the machine, changes outside the project, deleting work, actions unrelated to your request. If the small model fails, answers nonsense or takes over 60 seconds, the main model reviews instead, and you're told once; if that fails too, you're asked.
- **Only your messages authorize anything.** The reviewer sees your last few messages, labelled as yours. A sub-agent's task, a compaction summary, the agent's recent actions, file contents and tool output are shown to it as the agent's words or as data.
- **Always asks:** catastrophic commands, harness and git configuration, credential stores, and `git push` to `main`/`master`/`trunk`. That push rule also covers `--all`/`--mirror`, and a plain `git push` or `git push origin HEAD` while `main` is checked out. Commands that use a `.env` file go to the reviewer: loading it for the tests or creating it from `.env.example` is fine; printing or sending its values asks.
- `"sandbox": false` in settings turns the sandbox off. Read-only commands then run, and other shell commands go to the reviewer.

What the sandbox doesn't cover:
- Changes inside the workspace itself. That's why deletions are reviewed. Git is the undo for shell changes; `/rewind` restores only what the edit tools changed.
- Code a sandboxed command leaves behind runs with your full access when something unsandboxed runs it later. That includes scripts, `package.json` scripts on `npm install`, `.husky/` hooks, and a nested repo or submodule with its own git config when git runs inside it unsandboxed (your own `git status` in a terminal recurses into submodules).
- Which commands need the network is a guess from the command text. One that fails in the sandbox is retried with the hosts it needs, or outside the sandbox, after review.
- A listed host is open to the whole command. The proxy decides on the host name the client asks for and doesn't look inside TLS, so a host that fronts others (a CDN) reaches those too, and anything a listed host accepts (an upload, say) can carry data out. Tools that ignore the proxy variables (plain ssh, most database drivers) get no network at all.
- On Linux, bubblewrap has no proxy: commands that need the network run outside the sandbox, after review, as before.
- Linux (bubblewrap, experimental):
  - It has its own network, PID and IPC namespaces. It hides the usual Unix-socket locations (`/run`, X11, tmux, ssh-agent, Docker Desktop, Colima, Lima), but sockets elsewhere stay reachable.
  - It can only protect paths that exist when the command starts. A `.harness/` or `.mcp.json` that doesn't exist yet can be created, and so can the hooks of a repo created by that same command.
  - It has only been tested at the level of the arguments it builds, not on a real Linux machine.

Rules (`/permissions` to edit them):

```jsonc
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Edit(src/**)", "WebFetch(domain:docs.python.org)", "mcp__github"],
    "ask":   ["Bash(git push:*)"],
    "deny":  ["Read(./secrets/**)", "Bash(curl:*)"]
  }
}
```

## Using it

- `@path` attaches a file (completion included); `!cmd` runs a shell command yourself; `#note` saves a memory; `/` opens commands.
- `esc` interrupts; type while it works and your message is delivered at the next step (after an interrupt, anything not yet sent goes back to the prompt); `ctrl+o` toggles verbose output; `ctrl+t` toggles the todo list; `ctrl+g` opens `$EDITOR`; `↑`/`↓` history.
- For a newline in the prompt, type `\` then `enter`, or press `ctrl+j`. `shift+enter` works too in terminals that support the kitty keyboard protocol, which the harness turns on while it runs; in other terminals it usually sends the message instead.
- The harness takes over the terminal window: it clears the screen and scrollback when it starts, keeps the spinner, prompt and status line on the bottom rows (the reply and running tools follow the conversation above them), and lets the conversation scroll into the terminal's own scrollback (so scrolling, selecting and copying work as usual, and the conversation stays there after you quit). When the window is resized, it clears the screen and scrollback again and lays everything out at the new size.
- Sessions are saved per project. Resume them with `-c` (latest), `-r` (picker) or `/resume`. `--append-system-prompt` applies to the run you give it on, a resumed session included, and isn't saved with the session.
- `--max-turns n` stops each prompt after n model turns, in the TUI as with `-p`; send another message to let it continue.
- Jupyter notebooks: `Read` shows each cell with its id, and the `NotebookEdit` tool replaces, inserts or deletes a cell by that id (replacing a code cell clears its outputs). It asks for permission like any other edit.
- `/rewind` (or `esc esc` on an empty prompt) goes back to before one of your prompts: restore the files Harness changed since then, the conversation, or both. The prompt goes back in the input box to edit and resend. Before an edit tool first changes a file during a prompt, Harness saves a copy in `~/.harness/projects/<project>/file-history/<session>/` (private to you; files over 10 MB aren't saved), so it works after `-c`/`-r` too. Files changed outside Harness since it last wrote them are listed before they're overwritten, and if a file can't be restored the conversation is kept, so you can try again. Changes made by shell commands aren't tracked, prompts from before a `/compact` can't be rewound to, and the copies are deleted 30 days after the session was last used.

Commands: `/help /model /login /logout /providers /effort /permissions /mode /plan /clear /compact /cost /context /status /resume /rewind /rename /export /copy /init /review /memory /config /thinking /mcp /agents /hooks /todos /bashes /add-dir /doctor /exit`.

Custom commands are markdown files in `~/.harness/commands/` or `.harness/commands/`. The body is the prompt; `$ARGUMENTS` and `$1`…`$9` are substituted; `commands/git/pr.md` becomes `/git:pr`.

## Project files

| File | Purpose |
|---|---|
| `HARNESS.md` (also reads `AGENTS.md`, `CLAUDE.md`) | Notes loaded into every session. `/init` writes one. |
| `HARNESS.local.md` | Personal notes, git-ignored. |
| `~/.harness/HARNESS.md` | Notes for all projects. |
| `.harness/settings.json`, `.harness/settings.local.json`, `~/.harness/settings.json` | Settings: project, personal, user. |
| `.mcp.json` | Shared MCP servers (each needs approval in `/mcp` the first time). |
| `.harness/agents/*.md`, `~/.harness/agents/*.md` | Custom sub-agents (frontmatter: `name`, `description`, `tools`, `model`). |

Settings files may contain `//` and `/* */` comments and trailing commas. A settings, credentials, providers or trust file that has a JSON error is ignored (with a warning) and is never overwritten: saving a setting into it fails with a message naming the file, so nothing in it is lost. Saving rewrites the file as plain JSON, so comments in a file the harness edits are not kept.

When a folder contains harness configuration, you're asked once whether you trust it. Until you do, its settings, hooks, MCP servers, commands and memory files (HARNESS.md, AGENTS.md, CLAUDE.md) are ignored, except deny/ask rules, which only add restrictions. Memory files are only read when they are markdown inside the project (a symlink pointing elsewhere is skipped), and the harness's own git calls run with `core.fsmonitor` disabled so an untrusted repo can't run code on startup.

## MCP

```bash
harness mcp add github -- npx -y @modelcontextprotocol/server-github
harness mcp add --transport http docs https://example.com/mcp -H "Authorization: Bearer …"
harness mcp list
```

Both protocol generations are supported. The client probes with `server/discover` (the 2026-07-28 stateless protocol) and falls back to `initialize` for servers on 2025-11-25 and earlier. stdio and streamable HTTP transports are supported.

## Hooks

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Edit|Write", "command": "./scripts/check-paths.sh" }],
    "PostToolUse": [{ "matcher": "Edit", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }],
    "Stop": [{ "command": "npm test --silent" }],
    "Notification": [{ "command": "jq -r .message >> ~/harness-alerts.log" }]
  }
}
```

Hooks get the event as JSON on stdin: `hook_event_name`, `cwd`, `session_id`, and the fields below, with keys redacted. `matcher` (a tool name, `*` or a regex) applies to PreToolUse and PostToolUse; other events run every hook. Each hook is stopped after `timeout` seconds (default 60). Project hooks only run in folders you trust.

| Event | When | Input | Exit code 2 |
|---|---|---|---|
| `SessionStart` | A session starts | `source`: `startup`, `resume` or `clear` | — |
| `UserPromptSubmit` | You send a prompt | `prompt` | Blocks the prompt |
| `PreToolUse` | Before a tool runs | `tool_name`, `tool_input` | Blocks the call; stderr goes to the model |
| `PostToolUse` | After a tool runs | `tool_name`, `tool_input`, `tool_response` | stderr is added to the tool result |
| `Notification` | A notification would be shown, even with `notifications` off | `message`, `kind`: `done`, `permission`, `question`, `plan` or `error` | — |
| `PreCompact` | Before the conversation is compacted | `trigger`: `manual` or `auto`, `custom_instructions` | — |
| `Stop` | The model finishes its answer | `last_message` | The model keeps going, with stderr as the reason (up to 3 times) |
| `SubagentStop` | A sub-agent finishes | `agent_type`, `description`, `last_message`; `session_id` is the parent's | The sub-agent keeps going |
| `SessionEnd` | A session ends | `reason`: `exit`, `clear` or `resume` | — |

Only UserPromptSubmit, PreToolUse, PostToolUse, Stop and SubagentStop can block. The other events are informational: an exit code 2 there is reported like any other failure. SessionStart, SessionEnd and Notification hooks run in the background, except that the harness waits up to 5 seconds for SessionEnd hooks when it exits.

JSON output on stdout: PreToolUse can set `permissionDecision` (`allow` / `deny` / `ask`). UserPromptSubmit and PostToolUse can add `additionalContext`, which reaches the model with the prompt or with the tool results. UserPromptSubmit also takes plain text as context. Other events' output is ignored.

## Status line

```jsonc
{ "statusLine": { "command": "~/.harness/statusline.sh" } }
```

The command gets `{session_id, cwd, model: {id, display_name}, permission_mode, cost_usd, context_tokens, context_window}` as JSON on stdin. The first line it prints replaces the right side of the footer. It runs at most every 2 seconds and is killed after 3. Colors are kept; any other escape sequence is stripped.

## Notifications

When the terminal window isn't focused, the harness lets you know when a turn that took 30 seconds or more finishes, when it's waiting for you (a permission prompt, a question, or a plan to approve), and when a turn stops with an error.

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

`/config` switches between them. Focus comes from the terminal's focus reporting. If the terminal doesn't report focus, prompts and errors always notify, and so do turns over the time limit. Nothing is notified in `-p` mode. Messages are short ("Harness: done (2m 10s)", "Harness: waiting for your approval") and never include tool input.

Inside tmux, `auto` uses the bell, which tmux passes on to your terminal. `terminal` wraps the sequence for tmux passthrough, which works only with `set -g allow-passthrough on` (tmux 3.3 and later; `on` passes it only from a visible pane, `all` from any pane). For focus reporting inside tmux, also `set -g focus-events on`.

## Headless

```bash
harness -p "fix the lint errors" --permission-mode acceptEdits --allowedTools "Bash(npm run lint:*)"
git diff | harness -p "review this" --output-format json
harness -p "…" --output-format stream-json     # one JSON event per line
```

In `-p` mode nothing can prompt you, so anything that would ask is denied, and there are no notifications. Allow it with `--allowedTools`, rules, or `--permission-mode`. The exit code is 0 on success and 1 on error or `--max-turns`.

Piped stdin is added to the prompt. When the prompt is also given on the command line, stdin is optional: if nothing arrives within 3 seconds the run goes on without it (so a parent process that leaves stdin open can't hang it). To pipe a command that's slow to start printing, save its output to a file first. Retries (rate limits, overloaded or unreachable providers, or one that sends nothing for 5 minutes) are reported on stderr as they happen. `-c` and `-r` continue with the model the session was using, if it's still available.

## Development

```bash
bun run typecheck
bun run test
```

Layout:

| Directory | Contents |
|---|---|
| `src/agent` | Loop, sessions, compaction, hooks, memory, sub-agents |
| `src/providers` | Wire formats, model catalog, pricing |
| `src/permissions` | Rules, shell-command analysis, the auto-mode classifier |
| `src/tools` | Built-in tools |
| `src/mcp` | MCP client |
| `src/ui` | Terminal renderer, editor, markdown, dialogs |
| `src/commands` | Slash commands |
