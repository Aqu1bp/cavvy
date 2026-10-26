# Plugins

A plugin bundles slash commands, sub-agents, skills, hooks and MCP servers and language servers. Plugins come from marketplaces: catalogs you add once. The format is Claude Code's, so Claude Code plugins and marketplaces (Anthropic's `anthropics/claude-plugins-official`, say) install as they are.

```bash
cavvy plugin marketplace add anthropics/claude-plugins-official   # owner/repo, a git URL (#branch), a folder, or a marketplace.json path or URL
cavvy plugin install commit-commands                             # name, or name@marketplace when two have it
cavvy plugin install pr-review-toolkit --scope project           # user (default) | project | local
cavvy plugin list
cavvy plugin disable commit-commands                             # enable | disable | update [name|--all] | uninstall
cavvy plugin validate ./my-plugin                                # check a plugin or marketplace folder
```

In the terminal, `/plugin` opens a browser: installed plugins first, then what your marketplaces offer (type to filter), with install, enable/disable, update and uninstall, and the marketplaces themselves. `/plugin install …` and the rest work as in the shell. In the GUI, it's **Settings → Plugins** (or `/plugin`). Changes apply at once: commands, agents and hooks load, and MCP servers start.

| Scope | Setting | Effect |
|---|---|---|
| `user` | `~/.cavvy/settings.json` | On for you in every folder. |
| `project` | `.cavvy/settings.json` | On for everyone working in the repo (commit it). Teammates without the plugin are told to install it. |
| `local` | `.cavvy/settings.local.json` | On just for you, in this repo. |

The setting is `"enabledPlugins": { "name@marketplace": true }`; a narrower scope wins (local over project over user), so `false` in local settings turns a project's plugin off for you. In a folder you haven't trusted, only your user-scope plugins load.

A plugin's parts are named after it: commands are `/plugin:command` (a bare `/command` works when no other command has that name and only one plugin does), agents `plugin:agent`, MCP servers `plugin:plugin:server` (tools `mcp__plugin_…`). Hooks run alongside yours and are listed by `/hooks` with the plugin's name. `${CLAUDE_PLUGIN_ROOT}` (or `${CAVVY_PLUGIN_ROOT}`) in a plugin's MCP configuration is its folder, and hook commands get both as environment variables.

On Claude Code, Claude Code loads the plugins itself: each enabled plugin's installed folder is passed with `--plugin-dir`, so it runs their commands, agents, skills, hooks, MCP and language servers natively, as plugins it installed would run. Cavvy then doesn't run their hooks itself (except Notification hooks, for its own notices), and sends a plugin's `/command` or skill to Claude Code as typed. On Codex and API models, Cavvy loads them as described above, and their language servers join `lsp.servers` as `plugin:<plugin>@<marketplace>:<server>` (a server you configure under that name wins, `"lsp": false` turns them off with the rest), so edits there get the plugin's diagnostics too. Codex takes MCP servers only from its own config, so a plugin's MCP servers reach Codex sessions only if you also install the plugin in Codex (`codex plugin marketplace add …`, then `codex plugin add …`), which reads the same format. Read-only sub-agents get no plugins on Claude Code.

Plugin sources in a marketplace: a path inside the marketplace (`./plugins/x`), `{ "source": "github", "repo": "o/r" }`, `{ "source": "url", "url": "….git" }`, `{ "source": "git-subdir", "url", "path" }` (each with an optional `ref` or `sha`), and `{ "source": "npm", "package", "version" }` (a version, tag or range; the tarball is checked against its integrity hash, and no install scripts run). Fetching runs no code from the plugin: git hooks are off, git never prompts for credentials (a private repository fails with git's message instead), and a manifest path that points outside the plugin is ignored. Installed copies live in `~/.cavvy/plugins/cache/`; a plugin's hooks and MCP servers run commands on your computer, so install plugins you trust.
