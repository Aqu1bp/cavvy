<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo/cavvy-lockup-on-dark.svg">
    <img alt="Cavvy" src="design/logo/cavvy-lockup.svg" width="240">
  </picture>
</p>

<p align="center">A coding agent for your terminal and desktop that works with any model provider.</p>

<p align="center">
  <a href="https://github.com/Aqu1bp/cavvy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Aqu1bp/cavvy/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

Cavvy reads, edits and runs code in your project, asks before doing anything risky, and keeps your API keys out of everything it writes. Use it in the terminal, in its desktop app, or in your browser: a session started in one continues in the others.

## Highlights

- **Any model.** Anthropic, OpenAI, Gemini and Vertex AI, OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Fireworks and Cerebras; local models through Ollama and LM Studio; and any OpenAI-compatible endpoint. One searchable list, with context sizes and prices.
- **Your Claude or ChatGPT plan.** Cavvy runs your own Claude Code or Codex, signed in by you, so a subscription works without an API key. Several accounts per CLI, switched between responses.
- **Asks before it acts.** Five permission modes, from asking before every edit to an auto mode that runs shell commands in a sandbox and has a reviewer model check everything else.
- **A desktop app.** Several sessions at once, approvals with diff previews, a review pane where you commit, push and open pull requests, worktrees, a terminal panel, and a browser the agent can drive.
- **Other models as sub-agents.** Hand a task to another provider's model: a second opinion, a review, a cheaper research run.
- **Works with what you already use.** MCP servers, Claude Code plugins and marketplaces, hooks in Claude Code's format, and `CLAUDE.md` and `AGENTS.md` memory files.
- **Keys stay secret.** They're kept in the OS keychain, sent only to their own provider, and redacted from tool output, transcripts and logs.

## Install

Cavvy needs [Bun](https://bun.sh) and Git. The terminal app and the browser GUI run on macOS and Linux; the desktop app is built for macOS.

```bash
git clone https://github.com/Aqu1bp/cavvy.git
cd cavvy
bun install
bun link                     # puts `cavvy` on your PATH (or add bin/ to it)
```

`bun run build` makes a standalone binary instead, in `dist/cavvy`.

The desktop app builds from the same checkout, and keeps itself up to date from then on:

```bash
bun run desktop:install      # builds it and installs it into /Applications
```

To try the GUI without any keys, `bun run gui:demo` serves it with a mock model and a demo project.

## Quick start

```bash
cavvy                                    # start in the current project
cavvy -p "explain src/agent/agent.ts"    # one-shot, for scripts
cavvy gui                                # the GUI in your browser (run `bun run gui:build` once first)
```

In the terminal app, `/login` adds an API key (or `/login claude-code`, `/login codex` for your plan), `/model` picks a model, and `shift+tab` cycles the permission mode. In the desktop app, Settings → Providers adds keys and turns on Claude Code or Codex.

## Documentation

| Page | What's in it |
|---|---|
| [Providers and models](docs/providers.md) | API keys, Vertex AI, the model list, fast mode, and how keys are kept safe |
| [Claude and ChatGPT subscriptions](docs/subscriptions.md) | Running your own Claude Code or Codex, several accounts, continuing a CLI session |
| [Permissions](docs/permissions.md) | Permission modes, auto mode's sandbox and reviewer, rules |
| [The terminal app](docs/terminal.md) | Shortcuts, commands, rewinding and forking, the status line, notifications |
| [Desktop app and GUI](docs/desktop.md) | Building, installing and updating, using it, the terminal panel, project scripts, security |
| [Changes, worktrees and comparing models](docs/git.md) | The review pane, committing and pushing, pull requests, worktrees, one task on several models |
| [Browser](docs/browser.md) | The browser tools and the Browser pane |
| [Sub-agents on other models](docs/sub-agents.md) | Delegating a task to another provider's model |
| [Asking for secrets](docs/secrets.md) | Tokens the agent asks you for, kept out of its sight |
| [Project files](docs/project-files.md) | `CAVVY.md` and other memory files, settings files, trust |
| [MCP](docs/mcp.md) · [Plugins](docs/plugins.md) · [Hooks](docs/hooks.md) | Extending it |
| [Diagnostics after edits](docs/lsp.md) | Language servers checking each edit |
| [Headless runs and the SDK](docs/headless.md) | `cavvy -p` in scripts and CI, and the TypeScript SDK |
| [Development](docs/development.md) | Building, testing, and how the code is laid out |

## Contributing

Issues and pull requests are welcome. [Development](docs/development.md) covers building and testing, and [AGENTS.md](AGENTS.md) has the working rules for branches, tests and CI. Please report security problems privately, as [SECURITY.md](SECURITY.md) explains.

## License

MIT, see [LICENSE](LICENSE). Third-party material and its licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
