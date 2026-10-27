# Providers and models

## API keys

Run `cavvy` and type `/login`, then paste a key. The provider is recognized from the key's format (you pick from a list when it's ambiguous), the key is checked with one cheap authenticated request, and then stored:

- in the OS keychain (macOS Keychain, libsecret, Windows Credential Manager) via `Bun.secrets`, or
- in `~/.cavvy/credentials.json` with mode 600 when no keychain is available.

Supported: Anthropic, OpenAI, Google Gemini, Google Vertex AI (through gcloud, below), your Claude or ChatGPT subscription (through your own Claude Code or Codex: see [Claude and ChatGPT subscriptions](subscriptions.md)), your own OpenCode or Grok Build (see [Other coding agents](acp-agents.md)), OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Fireworks, Cerebras, plus Brave and Tavily for web search. Ollama and LM Studio are picked up automatically when they're running. `/login custom` adds any OpenAI-compatible (or Anthropic- or Responses-compatible) endpoint.

From a shell: `cavvy auth add [provider]` (hidden prompt, or pipe the key on stdin), `cavvy auth list`, `cavvy auth remove <provider>`. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) also work and take precedence.

## Google Cloud (Vertex AI)

Gemini through Vertex AI (which Google now calls Gemini Enterprise Agent Platform) is billed to a Google Cloud project, so Cloud credits such as the free trial's apply. A Gemini API key from AI Studio is billed separately, and the free trial's credit doesn't cover it.

There's no key to paste. Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install), run `gcloud auth login`, then `/login vertex` in Cavvy:

1. Pick the Google account (from the accounts gcloud is signed in with).
2. Pick the project to bill (projects with billing on are listed first).
3. Pick `global` or a region.

The setup is checked by listing the model catalog at the location you picked (no model is called), so a misspelled region is caught before anything is saved. If the Vertex AI API is off in the project, you're offered to turn it on (`gcloud services enable aiplatform.googleapis.com`). From a shell: `cavvy auth add vertex --project <id> [--location global] [--account <email>]`.

Only the project, location and account are saved (in `~/.cavvy/providers.json`). Requests carry an access token from `gcloud config config-helper --account=<account>`:

- Cavvy keeps the token in memory until a few minutes before it expires, and forces gcloud to issue a new one if Vertex rejects it.
- gcloud keeps its own copy in its credential store, as it does for any gcloud command. Its log file is turned off for these calls, because it would record the token there.
- The token is only sent to `aiplatform.googleapis.com` (or the region's own host).
- It's masked like a key, and so is any other Google access token (`ya29.…`) that shows up in tool output.

The account is always named explicitly, so switching gcloud's active account doesn't change who is billed. Shell commands that print a gcloud token ask first. `/logout vertex` removes the setup; gcloud itself stays signed in.

Vertex's model catalog has no context sizes or prices. They're filled in from the Gemini API's listing (if you also have a Gemini key) and OpenRouter's catalog (if you have an OpenRouter key).

## How keys are kept safe

- A key is only ever sent to its own provider's API host. (Vertex AI uses gcloud tokens instead of a key; see above.)
- Keys are registered with a redactor, so they're masked in tool output, session transcripts, exports, and error messages. Nothing that's written to disk (sessions, history, settings, the model cache) contains a key.
- Everything that enters the conversation is redacted before any model sees it: your prompts, tool results, memory files, and the model's own replies (so a key can't hop from one provider's transcript to another's when you switch models). The terminal and `-p` output are redacted too, and so is what hooks receive on stdin.
- Every process Cavvy starts (shell commands, hooks, MCP servers, git, ripgrep, your editor) gets an environment with all provider keys removed. A settings `env` entry can't put one back; MCP servers' own `env` blocks are passed through as you wrote them.
- The agent's file tools can't open the credential store at all. Reading `.env` files, `~/.ssh`, `~/.aws` and similar asks first, through the Read tool or a shell command. Shell commands are matched on their text, so this is a guard against fishing, not a sandbox.
- A `.env` in the project you're working on is never loaded. Only Cavvy's own `.env` and `~/.cavvy/.env` are read, and only for known variables.
- `bin/cavvy` starts Bun with `--no-env-file` and its own `--config`, because Bun otherwise reads `.env` and `bunfig.toml` from the current directory, and a repository's `bunfig.toml` can preload scripts.

## Models

`/model` shows one combined, searchable list of every model from every provider you have a key for, with context window and price (USD per million input/output tokens; `~` means the price comes from OpenRouter's catalog). Lists are cached for 12 hours; `ctrl+r` in the picker refreshes. Use `←`/`→` in the picker to set reasoning effort. Your choice is remembered.

Shortcuts: `/model gpt-6.1-sol` (unique match), `--model anthropic:claude-opus-5-5`, `cavvy models` for the same list in the shell (`--json` for scripts).

Model ids are `provider:model`. Wire formats: Anthropic Messages (with prompt caching and adaptive thinking), OpenAI Responses (stateless: output items are replayed each turn), and Chat Completions for everything else.

## Fast mode

The composer shows a **Standard / Fast** toggle when the selected model and backend support faster service. It changes the provider's service speed, independently of reasoning effort, and uses higher rates or plan limits. A session's choice survives closing and reopening it; the Home toggle sets the default for new sessions. Change speed while idle (or interrupt the current response first).

In the terminal, use `/fast`, `/fast on`, `/fast off`, or `/fast status`; the footer shows `↯ fast` when enabled. `/fast` also saves the default for new sessions. `cavvy --fast` and `cavvy --no-fast` override speed for that session, including `-p` runs. Unsupported models never inherit a fast request.

- **Codex:** reads `serviceTiers` from the installed CLI's model catalog (its fast tier is `priority`; older CLIs list `fast` in `additionalSpeedTiers`), and sends the fast tier on thread start/resume and each turn. Standard takes a thread off a fast tier it is on (from an earlier fast turn, or Codex's own config); any other tier from Codex's config, such as `flex`, is left alone.
- **Claude Code:** requires version 2.1.205+ and the CLI's `supportsFastMode` capability; passes `fastMode` through `--settings`. Standard explicitly overrides external fast preferences. Backend availability or cooldown notices appear in the conversation.
- **OpenAI / Anthropic APIs:** enabled only for documented first-party models/endpoints (Claude Opus 5.5, Opus 5 and Opus 4.8 on the Claude API), with `service_tier: "fast"` / `speed: "fast"` (and the `fast-mode-2026-02-01` beta). Standard sends neither, so the provider's default applies (for OpenAI, your project's own service tier). Cost estimates use the response's actual speed and fast prices; provider downgrades are surfaced. Custom/proxy endpoints and other providers are not assumed to support fast service.
- **Sub-agents** (the Task tool, and tasks Claude Code or Codex delegate to other models) run at the speed their session runs at, fast where their own model has fast mode. A change made while one runs applies from its next request (API models), its next turn (Codex), or the next time Claude Code is started for it (Claude Code takes the speed when it starts). Sub-agents that Claude Code or Codex start on their own are up to the CLI.

Model support does not guarantee account or organization access or available capacity. Refresh the model picker after upgrading a CLI. References: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode), [OpenAI pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=fast), [Claude Code Fast mode](https://code.claude.com/docs/en/fast-mode), [Claude API Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode).
