# Permissions

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

- Deny rules always win. A deny or ask rule for a command also catches it given by path (`/bin/rm`), behind `env` (`env -S '…'` included), `exec`, `nohup`, `nice`, `command`, `timeout`, `xargs` or `sudo` with any of their options, inside `sh -c '…'`, `eval` and `$(…)`, and, on macOS and Windows, in another case (`RM`, `/BIN/RM`), since the shell finds `/bin/rm` for that name there. A program named by a variable (`$X`) isn't known to them. Allow rules match only the command as written, so `Bash(npm test:*)` doesn't allow `NPM test`.
- Catastrophic commands (`rm -rf ~`, `mkfs`, writes to raw disks, fork bombs and similar) always ask, even in bypass mode, by any of those names (`SH -c 'rm -rf ~'` too).
- Edits to Cavvy's own configuration, `.mcp.json`, `.git/`, or the agent CLIs' `.claude/` and `.codex/` always ask, except in bypass mode. A git worktree Claude Code keeps in `.claude/worktrees/<name>/` counts as a project of its own: its files are ordinary edits, and only its own `.claude/`, `.codex/`, `.cavvy/`, `.mcp.json` and `.git` ask.

When a prompt appears you can allow once, allow and don't ask again (saved as a rule in `.cavvy/settings.local.json`), or decline and say what to do instead.

## Auto mode

- **Sandboxed shell.** Shell commands, read-only ones included, run in a sandbox when the OS has one: Seatbelt (`sandbox-exec`) on macOS. On Linux, bubblewrap is used only when you turn it on with `"sandbox": true`, because it's experimental (see below). Inside the sandbox a command:
  - can write only in the workspace and the temp directories, and never to `.git/hooks`, git config (submodules' and worktrees' included), `.cavvy/`, `.mcp.json`, the agent CLIs' `.claude/` and `.codex/`, or `~/.cavvy`. The git worktrees Claude Code keeps in `.claude/worktrees/<name>/` are projects of their own, so their files can be written, but not their own `.claude/`, `.codex/`, `.cavvy/`, `.mcp.json` or `.git` file, and a new one can't be made there. It also can't move or repoint the repo's git directory (`.git`, a worktree's `.git` file, `commondir`), those worktrees or the workspace itself, so it can't plant config that a later unsandboxed git command would run;
  - can't read credential files (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, the keychain, `~/.cavvy` and others);
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

  A blocked action goes back to the model with the reason and a warning not to get the same result another way, so it can take a safer route or stop and ask. After 3 blocks in a row, or 20 in a session, flagged actions come to you instead, and your answer starts the count over. Each step has a time limit (5 seconds for the check, 20 for the verdict). A step that runs out, fails or answers nonsense sends the action to you; nothing runs unreviewed, and you're told once that the reviewer failed. A reply that Anthropic's safety filter stops (it does for actions like sending secrets out) counts as a block, after the verdict step has had its own try. An approved action shows how long its review took. This reviewer covers Cavvy's own tools, so API models and their sub-agents. Claude Code and Codex use their own auto modes.
- **Only your messages authorize anything.** The reviewer sees your last few messages, labelled as yours. A sub-agent's task, a compaction summary, the agent's recent actions, file contents and tool output are shown to it as the agent's words or as data.
- **Always asks:** catastrophic commands, Cavvy and git configuration, credential stores, and `git push` to `main`/`master`/`trunk`. That push rule also covers `--all`/`--mirror`, and a plain `git push` or `git push origin HEAD` while `main` is checked out. Commands that use a `.env` file go to the reviewer: loading it for the tests or creating it from `.env.example` is fine; printing or sending its values asks.
- `"sandbox": false` in settings turns the sandbox off. Read-only commands then run, and other shell commands go to the reviewer.

### What the sandbox doesn't cover

- Changes inside the workspace itself. That's why deletions are reviewed. Git is the undo for shell changes; `/rewind` restores only what the edit tools changed.
- Code a sandboxed command leaves behind runs with your full access when something unsandboxed runs it later. That includes scripts, `package.json` scripts on `npm install`, `.husky/` hooks, and a nested repo or submodule with its own git config when git runs inside it unsandboxed (your own `git status` in a terminal recurses into submodules).
- Which commands need the network is a guess from the command text. One that fails in the sandbox is retried with the hosts it needs, or outside the sandbox, after review.
- A listed host is open to the whole command. The proxy decides on the host name the client asks for and doesn't look inside TLS, so a host that fronts others (a CDN) reaches those too, and anything a listed host accepts (an upload, say) can carry data out. Tools that ignore the proxy variables (plain ssh, most database drivers) get no network at all.
- On Linux, bubblewrap has no proxy: commands that need the network run outside the sandbox, after review, as before.
- Linux (bubblewrap, experimental):
  - It has its own network, PID and IPC namespaces. It hides the usual Unix-socket locations (`/run`, X11, tmux, ssh-agent, Docker Desktop, Colima, Lima), but sockets elsewhere stay reachable.
  - It can only protect paths that exist when the command starts. A `.cavvy/`, `.mcp.json`, `.claude/` or `.codex/` that doesn't exist yet can be created, and so can the hooks of a repo created by that same command.
  - It has only been tested at the level of the arguments it builds, not on a real Linux machine.

## Rules

`/permissions` edits them.

```jsonc
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Edit(src/**)", "WebFetch(domain:docs.python.org)", "mcp__github"],
    "ask":   ["Bash(git push:*)"],
    "deny":  ["Read(./secrets/**)", "Bash(curl:*)"]
  }
}
```
