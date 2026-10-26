# Diagnostics after edits

When the model changes a file with Edit, MultiEdit or Write, the file's new text goes to a language server, and the errors and warnings it finds come back with the edit: the model reads them in the tool result, and you see them under the edit (in the terminal, `✗ 1 error in src/a.ts` and the first problems; in the GUI, a count on the row and the list in its details, each opening the file at that line). Only what's new since the last report on that file is listed, so the same problem isn't repeated on every edit, and problems that went away are counted as fixed. Hints and information are left out, and a report holds at most 20 problems a file and 40 in all.

Language servers run the project's own code (its TypeScript install, build scripts, its Python environment), so they only run in a folder you've trusted yourself. A folder Cavvy trusted for the session only, because it had nothing to protect when it was opened, says diagnostics are off on the first edit; `/trust` (in the terminal or the GUI) trusts it and turns them on.

Servers start on the first edit of a file one handles, so a session that doesn't edit code starts none. They're shared by every session open in the same folder and stop after 10 minutes without edits. Files changed some other way (a shell command, your editor, a rewind) are sent again before the next check. These run when they're installed (on `PATH`, or in the project's `node_modules/.bin`):

| Language | Server |
|---|---|
| TypeScript, JavaScript | `typescript-language-server` (with `typescript` installed) |
| Python | `pyright-langserver`, else `basedpyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |
| C, C++ | `clangd` |

An edit waits up to 3 seconds for the diagnostics (12 when it has to start the server); what comes later reaches the model with the next tool results. With TypeScript Cavvy asks tsserver directly, which takes well under 100 ms once the project is loaded. A server that crashes restarts on the next edit, and after three crashes it stays off until Cavvy restarts.

Add or replace servers in settings (the shape of Claude Code's `lspServers`), or turn the feature off:

```jsonc
{
  "lsp": {
    "servers": {
      "deno": { "command": "deno", "args": ["lsp"], "extensionToLanguage": { ".ts": "typescript" } },
      "clangd": { "disabled": true }
    }
  }
  // or "lsp": false
}
```

A server named like a built-in replaces it. Each takes `command`, `args`, `env`, `extensionToLanguage`, `initializationOptions`, `settings` (answers to the server's `workspace/configuration` requests) and `startupTimeout` (ms). Project settings count only in folders you trust. Codex has no language servers of its own: when one of its patches finishes, Cavvy checks the files it changed and steers new problems into its running turn (`turn/steer`), in the same format and with the same limits. If that turn has already ended, you get a notice instead, and no turn starts. Claude Code gets diagnostics from its own LSP plugins.
