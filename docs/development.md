# Development

Working rules for branches, tests and CI are in [AGENTS.md](../AGENTS.md).

```bash
bun run typecheck
bun run gui:typecheck
bun run test
```

## Layout

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
| `src/server` | GUI server: protocol, multi-session engine, WebSocket server (`cavvy gui` / `serve`) |
| `gui` | The GUI (SolidJS, Vite). `bun run gui:dev` (add `--demo` for the mock model) runs it with hot reload at http://localhost:5173 |
| `desktop-electron` | The desktop app (Electron): its window, the Browser pane's pages, packaging and benchmarks |
| `desktop` | The app's icons, and the Tauri shell it replaces |
| `scripts` | Mock model and demo project (`gui:demo`), sidecar build |

## Adding features

Anything in the core (`src/agent`, `src/tools`, `src/providers`, `src/permissions`, `src/mcp`) reaches both apps by itself. Something you see or click needs a part in each: the terminal's in `src/ui` and `src/commands`, the GUI's in `src/server/runtime.ts` (which plays the role of `src/ui/app.ts`) and `gui/`. Keeping the logic in the core and the two front ends thin keeps them from drifting apart.
