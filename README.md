# Harness

A coding agent for your terminal and desktop that works with any model provider. It reads, edits and runs code in your project, asks before doing anything risky, and keeps your API keys out of everything it writes.

```bash
bun install
bin/harness                 # interactive
bin/harness -p "explain src/agent/agent.ts"   # one-shot
```

Put `bin/` on your `PATH` (or run `bun link`) to type `harness` anywhere. `bun run build` produces a standalone binary in `dist/harness`. For the desktop app and the browser GUI, see [Desktop app and GUI](#desktop-app-and-gui).

## API keys

Run `harness` and type `/login`, then paste a key. The provider is recognized from the key's format (you pick from a list when it's ambiguous), the key is checked with one cheap authenticated request, and then stored:

- in the OS keychain (macOS Keychain, libsecret, Windows Credential Manager) via `Bun.secrets`, or
- in `~/.harness/credentials.json` with mode 600 when no keychain is available.

Supported: Anthropic, OpenAI, Google Gemini, Google Vertex AI (through gcloud, below), your Claude or ChatGPT subscription (through your own Claude Code or Codex, [below](#claude-and-chatgpt-subscriptions)), OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Fireworks, Cerebras, plus Brave and Tavily for web search. Ollama and LM Studio are picked up automatically when they're running. `/login custom` adds any OpenAI-compatible (or Anthropic- or Responses-compatible) endpoint.

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

## Claude and ChatGPT subscriptions

A Claude plan (Pro, Max, Team, Enterprise) or a ChatGPT plan can be used through the official CLI you already have installed. The harness runs Claude Code or Codex itself, the way editor integrations and apps like T3 Code do, rather than calling the API with your plan's credentials.

1. Install [Claude Code](https://code.claude.com/docs/en/setup) or the [Codex CLI](https://developers.openai.com/codex/cli), and sign in there: `claude auth login`, or `codex login`. That's Anthropic's or OpenAI's own sign-in.
2. In the harness, `/login claude-code` or `/login codex` (`harness auth add claude-code` from a shell, or **Use my Claude subscription** / **Use my ChatGPT plan** in the desktop app's Settings → Providers). This asks the CLI whether it's signed in (`claude auth status`; Codex's `account/read`) and turns it on. On first run with nothing set up, the harness offers whichever of the two is installed.
3. Pick a model in `/model`: `claude-code:default`, `claude-code:sonnet`, `codex:gpt-6.1-sol`, …. The list comes from the CLI.

How it works:

- Each prompt runs as one turn in the CLI: `claude -p` with stream-json input and output (the protocol the Agent SDK uses), or `codex app-server` (JSON-RPC). The CLI uses its own system prompt, tools, sandbox, context management and memory (CLAUDE.md, AGENTS.md, its own settings, skills and MCP servers). The harness streams what it does into the transcript.
- When the CLI asks for permission, the harness answers with its own rules and dialog. Deny rules refuse without asking. An explicit allow rule (`Bash(npm test:*)`, `Write`, `--allowedTools`) approves. In Accept edits, so does an edit inside the workspace. Anything else asks you, with the same diff previews as the harness's own tools, and "don't ask again" saves a harness rule. In `-p` mode, anything that would ask is refused. Codex itself only tells its model "rejected by user", so when the harness refuses something, it also tells Codex why. Claude Code's `AskUserQuestion` and `ExitPlanMode`, and Codex's questions to the user, use the harness's question and plan dialogs. Codex asks before an MCP tool call that needs approval with an MCP elicitation of its own; the harness answers it like a command, with its rules for that tool (`mcp__server__tool`) and then you. An MCP server's own form or link goes to the question dialog. In `-p` mode they're declined.
- What the CLI does without asking never reaches the harness, so the harness's rules have to be in the CLI itself to cover it:
  - Claude Code gets the harness's deny and ask rules as its own permission rules, plus a deny rule for the harness's credential store. They then also cover what it would otherwise do on its own, like reading a file in the project. The translation:
    - Paths are made absolute the way the harness resolves them.
    - `WebFetch(domain:example.com)` also gets `domain:*.example.com`, since the harness's rule covers subdomains and Claude Code's doesn't.
    - `*` stays `*`, and `*(path)` becomes a read and an edit rule.

    Where the two still differ:
    - Claude Code matches Bash rules on the command as written, so `Bash(rm:*)` doesn't catch `/bin/rm …` or `bash -c 'rm …'` as the harness's does. That matters only when Claude Code wouldn't ask anyway: its own auto and bypass modes, or allow rules in your Claude Code settings.
    - Claude Code reads `[…]` in a path as a pattern, where the harness reads it literally.
    - A bare `Bash` ask rule doesn't stop Claude Code's sandbox from approving commands, if you've turned that sandbox on in your Claude Code settings.

    The rules go on Claude Code's command line, so other local processes can see them (`ps`). Don't put a secret in a rule (a token in a `Bash(…)` command, say).
  - Codex can't take them. Deny rules cover only what Codex asks approval for. In Manual, Plan and Accept edits, that's every edit and every command (Codex 0.162 asks even about `cat`). Commands the harness would run for its own models without asking (read-only ones, unless a rule or a file with credentials is involved) run without asking you, and the rest come to you. A `Read` deny rule doesn't stop Codex from reading a file with a command. In Auto and Bypass Codex asks much less, and runs commands itself, so it can read `~/.harness/credentials.json` there, if a key is stored there rather than in the OS keychain. In Auto, Codex's own reviewer answers what it would otherwise ask (commands and edits outside its sandbox, network access, more permissions), so the harness's rules don't see those; when the reviewer turns something down, the transcript says what and why.
- The harness's permission mode maps to the CLI's:

  | Harness | Claude Code | Codex (approval policy, sandbox) |
  |---|---|---|
  | Manual | `default` | `untrusted`, read-only |
  | Accept edits | `default`; the harness approves edits inside the workspace | `untrusted`, workspace-write; the harness approves edits inside the workspace |
  | Plan | `plan` | `untrusted`, read-only, told to only plan; requests for more permissions are refused |
  | Auto | `auto` (Claude Code's own auto mode) | `on-request`, workspace-write, with Codex's own reviewer (`auto_review`): commands and edits inside the sandbox run without asking, and the reviewer decides on the rest |
  | Bypass permissions | `bypassPermissions` | `never`, no sandbox |

  Neither CLI's own accept-edits behavior is used, because both are looser than the harness's: Claude Code's `acceptEdits` also runs file commands (`rm`, `mv`, `sed`) without asking, and Codex's `on-request` runs any command inside its sandbox. Edits to `.claude/`, `.codex/`, `.harness/`, `.mcp.json` and `.git/` always ask. Codex's requests to widen its sandbox always ask (in Auto, Codex's reviewer answers them). They're refused without asking if a deny rule could match anything in a folder they name (symlinks resolved), if that folder holds the harness's credential store, or if they name something the harness can't map to folders (like Codex's "minimal" system paths).
- Changing the mode during a turn: Claude Code switches immediately. Codex can't change its approval policy mid-turn, so switching to a stricter mode stops its turn and resumes it under the new one. A looser mode applies from the next turn, as do prompts you queue.

- The next prompt continues the same Claude Code session (`--resume`) or Codex thread (`thread/resume`), also after `-c`/`-r`. Each turn is also saved in the harness session as text (what was said, and which tools ran). If you switch to another model and back, the CLI gets what the other model said in between; if its session is gone, a new one starts with the conversation so far.
- Usage is recorded in tokens. On a plan the cost shows as $0. If the CLI is signed in with an API key instead, Claude Code's reported cost counts, and `/login` warns you.
- `esc` interrupts the CLI's turn. `/compact` runs the CLI's own compaction, and auto-compaction is left to the CLI.

What's different from the harness's own models:

- The harness's tools, MCP servers, PreToolUse/PostToolUse hooks and auto-mode sandbox don't apply. The CLI's own do, and the harness only sees the permission prompts the CLI raises. UserPromptSubmit and Stop hooks still run. The exception is the harness's delegation tools ([below](#sub-agents-on-other-models)).
- `/rewind` rewinds the conversation, but restores only files the harness's own tools changed. Use git for the CLI's edits.
- A project's own configuration for the CLIs can run commands: hooks, skills, sub-agents and permission rules in `.claude/`, MCP servers in `.mcp.json`, and config in `.codex/`. And `claude -p` shows no trust prompt of its own. So the CLIs get that configuration only in a folder you've told the harness you trust. A folder the harness trusts only because it had nothing to protect at startup doesn't count. Otherwise, Claude Code runs with `--setting-sources user --strict-mcp-config`, and Codex is told the folder, its git root and the folders above are untrusted, even if you trusted the project in Codex itself. While a CLI is on, the startup trust prompt lists that configuration. `/login claude-code` and `/login codex` offer to trust a folder that has some.
- One-off helper requests can't go to a CLI (auto-mode reviews and WebFetch summaries are for the harness's own tools anyway). Set `smallModel` (and `reviewModel`, if you have no Anthropic key) to another provider's model if you use those.

What the harness never does: read, copy or store the CLI's credentials (its keychain entry, `~/.claude/.credentials.json`, `~/.codex/auth.json`), sign in on its behalf, send its tokens anywhere, or modify the binary. The CLIs get the same environment as any child process, minus the harness's own provider keys. That way Claude Code uses your plan rather than an `ANTHROPIC_API_KEY` you gave the harness. Only `providers.json` records that a CLI is on, and optionally `path` (a CLI that isn't on `PATH`) and `args` (extra arguments):

```jsonc
{ "agents": { "claude-code": {}, "codex": { "path": "~/bin/codex", "args": ["-c", "model_reasoning_summary=detailed"] } } }
```

Why it's built this way: Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says subscription sign-in is for Claude Code and Anthropic's own apps. Third-party developers may not offer Claude.ai login, route requests through Free, Pro or Max plan credentials, or "collect, store, or intermediate Claude.ai credentials or session tokens". The same page says this doesn't prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Tools that took Claude Code's sign-in and called the API with it were cut off in early 2026. Running the user's own unmodified Claude Code, signed in by the user, is the pattern the terms leave open. That pattern is meant for your own use. If you build a product or service on it for other people, Anthropic directs you to API keys (including for the Agent SDK). Their plan limits also assume ordinary, individual use. For Codex, `codex app-server` is the interface OpenAI ships for driving Codex from other programs (its editor extensions use it), and the harness runs your own Codex through it, signed in with `codex login`.

## Sub-agents on other models

The main agent can hand a self-contained task to a model from another provider: a second opinion from Gemini, a review by Codex, a research task on a cheaper model. The task runs as a sub-agent that starts fresh and reports back.

- **Harness models** use the `Task` tool, which takes a `model` (`provider:model`). `ListModels` shows the agent types and every model that can run, with how each is billed. Without a model, a sub-agent runs on its agent type's model, else the main agent's.
- **Claude Code and Codex** keep their own sub-agents for their own models (Claude models, OpenAI models, and the same models through OpenRouter). For other providers' models, the harness gives them an MCP server named `harness` with four tools: `models`, `delegate`, `task_status` and `task_cancel`. They get it only when another provider is set up, and never as sub-agents themselves. `"delegation": false` in settings turns it off.

A delegated agent works in the same folder, under the same permission mode and rules. Its actions are approved or asked about like the main agent's, and the prompt names it and its model (`Review auth (provider:model)`). Its work shows under the call that started it, and its spend counts toward the session's (billed by its own provider). It can't delegate further. Only one delegated task that can change files runs at a time, and up to four run at once. An `explore` agent is read-only: on Claude Code or Codex, reads and read-only commands run without asking you, and the harness refuses everything else. On Claude Code it runs without its edit tools or any MCP servers. On Codex, the MCP servers in your Codex config are turned off for it, because Codex runs tools set to `approve` there without asking. Servers that come from Codex plugins or apps aren't turned off. If a stopped sub-agent was asking you something, the prompt is withdrawn, and background commands it started are stopped.

`delegate` waits for the result: 10 minutes by default, 60 at most. After that the task keeps running, and `task_status` gets its result. With `wait: false` it returns a task id at once, so several tasks can run together. If a task is still running when the turn ends, its result goes to the CLI with your next message. In `-p` mode there is no next message, so the main agent is told to collect every result before it finishes, and tasks still running when it does are stopped. `esc` stops the delegated tasks still running (whichever model is answering), `/tasks` lists them, and `/tasks stop [id]` stops them. Quitting, `/clear`, `/resume` and `/logout` stop them too. In the desktop app and `harness gui`, each sub-agent shows as a chip above the input while it works ([below](#desktop-app-and-gui)), and a delegated task still running when the turn ends keeps its permission prompts until you answer or stop it.

The server listens on 127.0.0.1 only, with a random token for each session. Claude Code gets the server over stdin (an `mcp_set_servers` request), and Codex gets it in the thread's config over its app-server connection. The token never goes on a command line or into the environment, and it's redacted from anything shown or saved. Requests from a browser (with an `Origin` header) or without a live token are refused. The CLIs run the harness's tools without their own approval prompt, because the delegated agent's actions are checked one by one as they happen. The contract follows [T3 Code](https://github.com/pingdotgg/t3code)'s orchestration (MIT): wait or run in the background, a timeout that leaves the task running, and status and cancel by id.

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
| **Auto** | Edits in the workspace and temp directories, shell commands inside a sandbox, and anything else a reviewer model judges routine and asked for. Risky actions are turned back to the model with the reason; after repeated blocks, or when the reviewer can't decide, they're shown to you. See [Auto mode](#auto-mode). |
| **Bypass permissions** | Everything. Only available when started with `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`, or with `permissions.allowBypass` in your user settings. |

Whatever the mode:

- Deny rules always win.
- Catastrophic commands (`rm -rf ~`, `mkfs`, writes to raw disks, fork bombs and similar) always ask, even in bypass mode.
- Edits to the harness's own configuration, `.mcp.json`, `.git/`, or the agent CLIs' `.claude/` and `.codex/` always ask, except in bypass mode. A git worktree Claude Code keeps in `.claude/worktrees/<name>/` counts as a project of its own: its files are ordinary edits, and only its own `.claude/`, `.codex/`, `.harness/`, `.mcp.json` and `.git` ask.

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

  It's `reviewModel` in your user settings (a project's settings can't choose it), or Claude Sonnet 5.5 when you have an Anthropic key, or else the session's own model. It reviews in two steps. First comes a one-word check without extended thinking, which lets routine actions straight through. Anything it isn't sure of gets a reasoned verdict. Both steps send the same cached instructions. It allows routine work, and effects outside the machine (push, PR, deploy) only when you asked for that specific action in your own words. It blocks pushes, deploys, publishing or messages you didn't ask for. It also blocks exposing secrets, probing for credentials, data leaving the machine, lasting changes outside the project or to security settings, deleting work, and actions unrelated to your request. Its rules adapt those of [OpenAI Codex's auto-review policy](https://github.com/openai/codex) (Apache-2.0).

  A blocked action goes back to the model with the reason and a warning not to get the same result another way, so it can take a safer route or stop and ask. After 3 blocks in a row, or 20 in a session, flagged actions come to you instead, and your answer starts the count over. Each step has a time limit (5 seconds for the check, 20 for the verdict). A step that runs out, fails or answers nonsense sends the action to you; nothing runs unreviewed, and you're told once that the reviewer failed. A reply that Anthropic's safety filter stops (it does for actions like sending secrets out) counts as a block, after the verdict step has had its own try. An approved action shows how long its review took. This reviewer covers the harness's own tools, so API models and their sub-agents. Claude Code and Codex use their own auto modes.
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

Commands: `/help /model /login /logout /providers /effort /permissions /mode /plan /clear /compact /cost /context /status /resume /rewind /rename /export /copy /init /review /memory /config /thinking /mcp /agents /hooks /todos /tasks /bashes /add-dir /doctor /exit`.

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

When a folder contains harness configuration, you're asked once whether you trust it. Until you do, its settings, hooks, MCP servers, commands and memory files (HARNESS.md, AGENTS.md, CLAUDE.md) are ignored, except deny/ask rules, which only add restrictions. Memory files are only read when they are markdown inside the project (a symlink pointing elsewhere is skipped), and the harness's own git calls run with `core.fsmonitor` disabled so an untrusted repo can't run code on startup (creating a worktree also turns hooks off, and needs trust when the repository's own config could run commands on checkout; see **Terminal and worktrees**).

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

## Desktop app and GUI

The same agent, in a window: a sidebar of sessions from every project, several sessions running at once, the reply streaming in with tool calls folded into one-line summaries ("Read 3 files, searched 2 times · +13 −1") you can open, approvals as cards above the input, a Changes panel with the session's diffs, the plan as a checklist, and context and cost at a glance. Sessions are the same files the terminal app uses: start in one, continue in the other (`harness -r <id>`, or **Copy resume command** in the GUI).

```bash
bun run gui:build          # once (and after pulling GUI changes): builds gui/dist
harness gui                # opens it in your browser (harness serve: server only)
bun run gui:demo           # try it without API keys: a mock model and a demo project
```

The desktop app wraps the same GUI in a native window ([Tauri](https://tauri.app)); the agent runs alongside it as a sidecar, the CLI compiled with `bun build --compile`:

```bash
bun run desktop:dev        # hot-reloading GUI, server from source
bun run desktop:build      # installers in desktop/src-tauri/target/release/bundle
bun run desktop:install    # macOS: this checkout's app into /Applications, restarted
```

`desktop:install` is for trying a change in the real app: it builds whatever branch or worktree you run it in, quits Harness if it's open (its sessions close as on any quit), replaces the installed app and opens it. `--no-restart` installs without touching a running Harness.

Building it needs Rust ([rustup](https://rustup.rs)) and, on Linux, the WebKitGTK headers (`libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` on Debian and Ubuntu). To distribute it on macOS, sign and notarize the app, sidecar included.

Using it:

- `⌘K` (`Ctrl+K`) searches sessions, projects and actions; `⌘N` new session, `⌘B` sidebar, `⌘.` side panel, `⌘/` model, `⌘[` `⌘]` previous/next session, `⌘,` settings.
- In the input: `@` mentions a file, `/` lists commands (`/compact`, `/init`, `/review`, `/rewind`, custom commands…), `!` runs a shell command yourself, paste or drop images, `↑` recalls a prompt, `shift+tab` cycles the permission mode, `Esc` interrupts. Messages sent while it works are queued; remove them before they go, and after an interrupt they come back to the input.
- Approvals: `1` `2` `3` choose, `Esc` denies (with a note for the model if you type one). The buttons never take focus on their own, so an Enter meant for the input can't approve anything.
- Hover a prompt to copy it or rewind to before it (files, conversation, or both, as with `/rewind`).
- Themes: Light, Paper, Dark, Midnight, Dusk and High contrast, or follow the system; nine accent colors, text size and density. Settings → Providers adds API keys (validated, then stored in the OS keychain, like `/login`) or turns on Claude Code or Codex to use your own Claude subscription or ChatGPT plan.
- Sub-agents (Task calls, Claude Code's and Codex's own sub-agents, and tasks Claude Code or Codex delegate to another provider's model) show as chips above the input: their name, model, and whether they're working, waiting for you, done or failed. A chip opens that agent in the side panel: the task it was given, what it's saying and doing as it goes (each tool call opens to its output or diff), and its report. A delegated task has a Stop button; a Task sub-agent stops with the turn. When one asks permission, the prompt names it and links to it. `/tasks` lists them all, and `/tasks stop [task-id]` stops delegated tasks.
- A session that finishes or needs you while you're elsewhere sends a notification; the window title counts the sessions waiting for you.

How it fits together:

```
desktop app (Rust, Tauri)          browser tab (harness gui)
  native window, system webview      ─┐
  └─ GUI (gui/, SolidJS) ─────────────┴─ WebSocket on 127.0.0.1, token ─┐
                                                                        ▼
  harness serve  (src/server: engine.ts → runtime.ts, one per open session)
     └─ the agent (src/agent), tools, permissions, providers, MCP: shared with the CLI
```

`src/server/protocol.ts` is the contract between the two sides. A session's timeline is changed by small ops (add a block, append text, patch a tool's status) that the server applies to its own copy and sends; the GUI applies them with the same code (`src/server/timeline.ts`), batched once per frame, so streaming only touches the text that changed. Opening a session rebuilds the same timeline from the transcript plus a small log of what it doesn't keep (diffs, timings), so a reopened session looks the way it did live, including turns from before a compaction.

Security. Whoever can talk to the server can run commands as you, so:

- It listens on 127.0.0.1 only (`--host` exposes it, with a warning). Every WebSocket needs the server's random token, sent as a subprotocol so it never appears in a URL or a log. The browser link carries a one-time code (two minutes) that the page trades for the token. Host and Origin headers are checked, so a web page that rebinds a DNS name to 127.0.0.1 can't connect, and the pages are served with a strict Content-Security-Policy.
- Model output is untrusted: raw HTML in it is shown as text, links open in your browser (never in the app), and images in replies aren't loaded, since a remote image URL can carry data out the moment it's displayed.
- The desktop app's webview has no shell access; only the Rust side starts the sidecar. The sidecar exits when its stdin closes, so it goes away with the app, even if the app is killed.
- Apps started outside a terminal don't get your shell's `PATH`; the desktop sidecar asks your login shell for it (`--login-env`), so the agent finds your tools.

`HARNESS_GUI_DEBUG=1` makes the server say why it refused a connection. On Linux, if the window stays blank, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Terminal and worktrees.** The terminal button in the title bar (or Ctrl+backtick, on every platform) opens a resizable bottom panel with interactive shell tabs in the current project's directory. Drag its top edge to resize it; hiding the panel keeps shells running. Each project/worktree has its own tabs: opening the panel starts a shell where there is none, and going to another project with the panel open doesn't (click **New terminal** there). A window has up to 12 terminals across all its projects. Closing a tab stops its shell; closing or disconnecting the window stops its terminals (use Restart shell after reconnecting). Shells get your own environment (your `PAGER`, not the agent tools' settings, and nothing from the terminal or tmux the harness was started in; `TERM_PROGRAM` is `Harness`). When a command prints faster than the panel can draw, the panel skips ahead to the latest output and says how much it skipped. Terminal commands are your own shell commands, outside agent permission prompts and conversation history. This panel currently requires macOS or Linux.

Under the new-chat composer, click the branch to select a Git worktree. The menu refreshes each time it opens and shows branches and full paths, including detached worktrees. Selection changes the new chat's folder; existing chats keep their own folders.

**New worktree…** in that menu creates one on a new branch (`git worktree add -b`) and starts the new chat there. The base defaults to the folder's current branch (its commit when detached); the new branch starts at the base's commit and gets no upstream. By default it goes in `<main worktree>/.claude/worktrees/<branch, with / as ->` (where Claude Code keeps its worktrees, even when you start from a linked worktree); you can rename the folder or choose a folder elsewhere. The harness creates `.claude/worktrees` when it's missing but doesn't touch your `.gitignore`. It refuses an existing branch, an existing path, and a `.claude` or `.claude/worktrees` that is a symlink. Git runs with hooks turned off (`core.hooksPath=/dev/null`), so the repository's `post-checkout` hook never runs; run any setup a hook would have done yourself. Checking files out does still run filter drivers (Git LFS, for example) and anything else Git config sets up for a checkout. Those from your own global or system config always run. In a project you haven't trusted, the repository's own config (`.git/config`) may only hold settings that can't run anything: what `git init` and `clone` write, plus branch and remote bookkeeping. Per-worktree config (`config.worktree`, with `extensions.worktreeConfig`) applies only in its own worktree. Each worktree Git runs in is held to the same rule unless that worktree's own folder (or a folder containing it) is trusted; trusting a sibling worktree doesn't count. When something needs trust, the message names the folder, and the button trusts that folder. Before Git runs in a folder (the one you asked from, and the worktree being removed), the harness checks that it really belongs to this repository: its common Git directory must be the main worktree's, and its own Git directory must sit under that one's `worktrees/`. A worktree whose metadata points at another repository (whose config was never checked) is refused outright; trusting wouldn't fix it. If it has anything else (a filter driver, an `include`, `core.sshCommand`, a credential helper, a partial clone's promisor remote, …), you're asked to trust the project first (**Trust and create**), before Git so much as resolves the base. The harness's own checks never fetch missing objects in a partial clone (`GIT_NO_LAZY_FETCH=1`); only the checkout itself does, in a trusted project. In a trusted project its filters run as usual.

Worktrees in `.claude/worktrees` also get a remove button. Removal runs `git worktree remove` without `--force`, counting untracked files even if your config hides them, so Git refuses when there are changes. Branches are kept. Git would delete ignored files (an `.env`, `node_modules/`) without asking, so they're listed first, and removal goes ahead only once you've agreed to delete exactly those (**Delete them and remove**). Removal is refused for the main worktree, a locked worktree, and a detached worktree whose commit isn't on any branch. It's also refused while a Harness session is open in the worktree: a session in the app counts, including one still closing; a session in another process (such as the terminal) counts once it has sent a message. Git still refuses a worktree with changes, so a session that isn't seen loses nothing. While Git removes it, no session can open in it from the app and no other removal of it starts. Checking for changes reads the files, so it needs the same trust as creating when the repository's own config could run commands (**Trust and remove**). A worktree whose folder is already gone loses only its own record; other worktrees' records stay, even when their folders are away (say, on a drive that isn't mounted).

**Comparing models.** When you're not sure which model will do a task best, give it to two to four at once. On Home, in a Git project, turn on **Compare models** in the model picker and tick the models, from any provider, Claude Code and Codex included. The picker then says how many you picked, and the send button says **Send to N models**. Picking them doesn't change your default model. In a folder that isn't a Git repository the switch is off, with the reason, and a session's own composer is unchanged. Sending creates one worktree per model, one at a time, each on a new branch from the Home folder's last commit, in `<main worktree>/.claude/worktrees/<name>`, the same place and through the same checks as **New worktree…**. Uncommitted changes in the Home folder aren't carried over. It then opens a session in each worktree on exactly that model, with the composer's permission mode and attachments, and sends it the prompt. Each worktree is named after a few words of the prompt and the model, for example `fix-login-redirect-opus-5-5`. Names use only letters, digits and `-`, keys and other secrets are taken out of the prompt first, and `-2`, `-3`, … are added when the branch or folder exists. A sheet then shows each model's result: started, with its branch and folder, or why not and what to do (no key for that provider, a model that isn't listed, images for a model that doesn't take them, a worktree Git couldn't create, …). One model failing never stops the others. A worktree whose session couldn't start is kept, and the sheet names it. A session that can't be set to its model is never sent the prompt, rather than running on the default model. Nothing is deleted for you; remove worktrees as above. In the sidebar a run's sessions stay together under the prompt, in both views, each card naming its model. A session in a run shows the others in its title bar with their status (working, needs you, done, stopped), one click each. Runs are remembered in `gui.json` (the last 50).

**Cost guard.** Starting more than two models billed per token through an API key asks first, listing them with their prices (or "price unknown"); cancel and nothing is created. Claude Code and Codex run on your plan, and Ollama, LM Studio and other servers on this machine are free, so they don't count. Every other provider does, including Vertex and custom ones. The server enforces this, not only the app.

**Trust for a run.** The Git config rules above apply to every worktree a run creates. When the repository's own config needs trust, nothing is created until you trust the folder it names. Then the run starts again by itself. The new worktrees' project configuration (`.harness/`, `.mcp.json`, the agent CLIs' `.claude/` and `.codex/`) is decided once per run, before anything is created. If a folder you trusted contains them (their main worktree, say), they're trusted. If you chose **Open without its configuration** for the Home folder or the main worktree, they open that way too. If they'd have configuration and you haven't decided, the run asks you once (trust the main worktree, or open them without their configuration) and starts after your answer. Nothing is trusted on your behalf.

**Adding features.** Anything in the core (`src/agent`, `src/tools`, `src/providers`, `src/permissions`, `src/mcp`) reaches both apps by itself. Something you see or click needs a part in each: the terminal's in `src/ui` and `src/commands`, the GUI's in `src/server/runtime.ts` (which plays the role of `src/ui/app.ts`) and `gui/`. Keeping the logic in the core and the two front ends thin keeps them from drifting apart.

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
bun run gui:typecheck
bun run test
```

Layout:

| Directory | Contents |
|---|---|
| `src/agent` | Loop, sessions, compaction, hooks, memory, sub-agents |
| `src/providers` | Wire formats, model catalog, pricing |
| `src/backends` | Claude Code and Codex as agent backends (your installed CLIs) |
| `src/permissions` | Rules, shell-command analysis, the auto-mode reviewer |
| `src/tools` | Built-in tools |
| `src/mcp` | MCP client |
| `src/ui` | Terminal renderer, editor, markdown, dialogs |
| `src/commands` | Slash commands |
| `src/server` | GUI server: protocol, multi-session engine, WebSocket server (`harness gui` / `serve`) |
| `gui` | The GUI (SolidJS, Vite). `bun run gui:dev` (add `--demo` for the mock model) runs it with hot reload at http://localhost:5173 |
| `desktop` | The desktop app (Tauri): Rust shell, icons, capabilities |
| `scripts` | Mock model and demo project (`gui:demo`), sidecar build |

### Fast mode

The composer shows a **Standard / Fast** toggle when the selected model and backend support faster service. It changes the provider's service speed, independently of reasoning effort, and uses higher rates or plan limits. A session's choice survives closing and reopening it; the Home toggle sets the default for new sessions. Change speed while idle (or interrupt the current response first).

In the terminal, use `/fast`, `/fast on`, `/fast off`, or `/fast status`; the footer shows `↯ fast` when enabled. `/fast` also saves the default for new sessions. `harness --fast` and `harness --no-fast` override speed for that session, including `-p` runs. Unsupported models never inherit a fast request.

- **Codex:** reads `serviceTiers` from the installed CLI's model catalog (its fast tier is `priority`; older CLIs list `fast` in `additionalSpeedTiers`), and sends the fast tier on thread start/resume and each turn. Standard takes a thread off a fast tier it is on (from an earlier fast turn, or Codex's own config); any other tier from Codex's config, such as `flex`, is left alone.
- **Claude Code:** requires version 2.1.205+ and the CLI's `supportsFastMode` capability; passes `fastMode` through `--settings`. Standard explicitly overrides external fast preferences. Backend availability or cooldown notices appear in the conversation.
- **OpenAI / Anthropic APIs:** enabled only for documented first-party models/endpoints (Claude Opus 5.5, Opus 5 and Opus 4.8 on the Claude API), with `service_tier: "fast"` / `speed: "fast"` (and the `fast-mode-2026-02-01` beta). Standard sends neither, so the provider's default applies (for OpenAI, your project's own service tier). Cost estimates use the response's actual speed and fast prices; provider downgrades are surfaced. Custom/proxy endpoints and other providers are not assumed to support fast service.
- **Sub-agents** (the Task tool, and tasks Claude Code or Codex delegate to other models) run at the speed their session runs at, fast where their own model has fast mode. A change made while one runs applies from its next request (API models), its next turn (Codex), or the next time Claude Code is started for it (Claude Code takes the speed when it starts). Sub-agents that Claude Code or Codex start on their own are up to the CLI.

Model support does not guarantee account or organization access or available capacity. Refresh the model picker after upgrading a CLI. References: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode), [OpenAI pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=fast), [Claude Code Fast mode](https://code.claude.com/docs/en/fast-mode), [Claude API Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode).
