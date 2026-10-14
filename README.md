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
| **Auto** | Edits in the workspace, plus any action a reviewer model judges routine and in scope. Risky actions are shown to you with the reason. |
| **Bypass permissions** | Everything. Only available when started with `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`, or with `permissions.allowBypass` in your user settings. |

Whatever the mode:

- Deny rules always win.
- Catastrophic commands (`rm -rf ~`, `mkfs`, writes to raw disks, fork bombs and similar) always ask, even in bypass mode.
- Edits to the harness's own configuration, `.mcp.json` or `.git/` always ask, except in bypass mode.

When a prompt appears you can allow once, allow and don't ask again (saved as a rule in `.harness/settings.local.json`), or decline and say what to do instead.

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
- The harness takes over the terminal window: it clears the screen and scrollback when it starts, keeps the spinner, prompt and status line on the bottom rows (the reply and running tools follow the conversation above them), and lets the conversation scroll into the terminal's own scrollback (so scrolling, selecting and copying work as usual, and the conversation stays there after you quit). When the window is resized, it clears the screen and scrollback again and lays everything out at the new size.
- Sessions are saved per project. Resume them with `-c` (latest), `-r` (picker) or `/resume`.

Commands: `/help /model /login /logout /providers /effort /permissions /mode /plan /clear /compact /cost /context /status /resume /rename /export /copy /init /review /memory /config /thinking /mcp /agents /hooks /todos /bashes /add-dir /doctor /exit`.

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
    "Stop": [{ "command": "npm test --silent" }]
  }
}
```

Hooks get the event as JSON on stdin. Exit code 2 blocks the action and shows stderr to the model. JSON output can set `permissionDecision` (`allow` / `deny` / `ask`) or add `additionalContext`.

## Status line

```jsonc
{ "statusLine": { "command": "~/.harness/statusline.sh" } }
```

The command gets `{session_id, cwd, model: {id, display_name}, permission_mode, cost_usd, context_tokens, context_window}` as JSON on stdin. The first line it prints replaces the right side of the footer. It runs at most every 2 seconds and is killed after 3. Colors are kept; any other escape sequence is stripped.

## Headless

```bash
harness -p "fix the lint errors" --permission-mode acceptEdits --allowedTools "Bash(npm run lint:*)"
git diff | harness -p "review this" --output-format json
harness -p "…" --output-format stream-json     # one JSON event per line
```

In `-p` mode nothing can prompt you, so anything that would ask is denied. Allow it with `--allowedTools`, rules, or `--permission-mode`. The exit code is 0 on success and 1 on error or `--max-turns`.

Piped stdin is added to the prompt. When the prompt is also given on the command line, stdin is optional: if nothing arrives within 3 seconds the run goes on without it (so a parent process that leaves stdin open can't hang it). To pipe a command that's slow to start printing, save its output to a file first. Retries (rate limits, overloaded or unreachable providers) are reported on stderr as they happen. `-c` and `-r` continue with the model the session was using, if it's still available.

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
