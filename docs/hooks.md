# Hooks

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Edit|Write", "command": "./scripts/check-paths.sh" }],
    "PostToolUse": [{ "matcher": "Edit", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }],
    "Stop": [{ "type": "prompt", "prompt": "Did the assistant run the tests it said it would? $ARGUMENTS" }],
    "Notification": [{ "type": "http", "url": "https://hooks.example.com/cavvy", "headers": { "Authorization": "Bearer $ALERT_TOKEN" }, "allowedEnvVars": ["ALERT_TOKEN"] }]
  }
}
```

Each event takes a list of handlers. Claude Code's nested format works too, so a `hooks` block copied from `.claude/settings.json` runs unchanged: `{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "./fmt.sh" }] }`. Both can be mixed in one list. An entry that can't run (an unknown type, a command hook with no command, an unknown event name) is skipped, and `/hooks` lists what was skipped and why.

## Handler types


| `type` | Runs | Fields | Default timeout |
|---|---|---|---|
| `command` (default) | A shell command, input on stdin | `command`; or `command` plus `args` to run it without a shell (`${VAR}` expanded); `async: true` runs it in the background and reports when done | 60 s |
| `http` | A POST with the input as JSON | `url`, `headers`; `$VAR` / `${VAR}` in headers are filled in only for names in `allowedEnvVars` (provider keys never). Redirects are refused | 60 s |
| `prompt` | Asks the session's model (or `model`) a yes/no question about the input | `prompt` (`$ARGUMENTS` is the input), `model`. Answer `{"ok": false, "reason": "…"}` blocks | 30 s |
| `mcp_tool` | Calls a tool on one of the session's MCP servers | `server`, `tool`, `input` (`${tool_input.file_path}` and other paths are filled in from the input) | 60 s |

Every handler also takes `matcher`, `if` (a permission rule such as `Bash(git *)`, for tool events), `timeout` in seconds and `statusMessage`. Handlers for one event run in parallel; their answers are combined in the order they're configured. Hooks get the event as JSON: `hook_event_name`, `cwd`, `session_id`, `permission_mode`, the fields below, and `agent_id`/`agent_type` inside a sub-agent, with keys redacted. Commands also get `CAVVY_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`. Project hooks only run in folders you trust.

## Events and matchers

`matcher`: empty, `*` or absent matches everything. A name or a `|` list of names (`Edit|Write`) matches exactly. Anything else is a regular expression. What it's compared with is in the table's last column; events without one run every handler.

| Event | When | Input | Can block | Matcher field |
|---|---|---|---|---|
| `SessionStart` | A session starts, resumes, is cleared or compacted | `source`, `model` | — (`additionalContext` reaches the model with the next prompt) | `source` |
| `InstructionsLoaded` | Each memory file (CAVVY.md, AGENTS.md, CLAUDE.md, and the files they `@import`) is loaded | `file_path`, `memory_type`, `load_reason` (`include` for an import), `parent_file_path` (an import's) | — | `load_reason` |
| `UserPromptSubmit` | You send a prompt | `prompt` | The prompt | — |
| `PreToolUse` | Before a tool runs | `tool_name`, `tool_input`, `tool_use_id` | The call (or `allow` / `deny` / `ask`, `updatedInput`) | `tool_name` |
| `PermissionRequest` | Before you're asked to approve a tool | `tool_name`, `tool_input` | Answers for you: `decision.behavior` `allow` (with `updatedInput`) or `deny` (with `message`, `interrupt`) | `tool_name` |
| `PermissionDenied` | Auto mode's reviewer refused a call | `tool_name`, `tool_input`, `reason` | — | `tool_name` |
| `PostToolUse` | A tool succeeded | `tool_name`, `tool_input`, `tool_response`, `duration_ms` | Adds the reason to the result; `updatedToolOutput` replaces it | `tool_name` |
| `PostToolUseFailure` | A tool failed | `tool_name`, `tool_input`, `error`, `is_interrupt`, `duration_ms` | Adds the reason to the result | `tool_name` |
| `PostToolBatch` | All of one model turn's tool calls finished | `tool_calls` | Ends the turn | — |
| `SubagentStart` | A sub-agent starts | `agent_id`, `agent_type` | — (`additionalContext` goes to the sub-agent) | `agent_type` |
| `SubagentStop` | A sub-agent finishes | `agent_type`, `description`, `last_assistant_message` | The sub-agent keeps going | `agent_type` |
| `Notification` | A notification would be shown, even with `notifications` off | `message`, `notification_type`: `done`, `permission`, `question`, `plan` or `error` | — | `notification_type` |
| `PreCompact` | Before the conversation is compacted | `trigger`: `manual` or `auto`, `custom_instructions` | Skips the compaction | `trigger` |
| `PostCompact` | After it was compacted | `trigger`, `compact_summary` | — | `trigger` |
| `CwdChanged` | The working directory moved (`cd` in Bash or `!`) | `old_cwd`, `new_cwd` | — | — |
| `FileChanged` | A watched file changed on disk, whatever changed it | `file_path`, `event`: `add`, `change` or `unlink` | — | the file's name |
| `DirectoryAdded` | `/add-dir` added a folder | `directory`, `source` | — | `source` |
| `WorktreeCreate` | A worktree is created (GUI, `/plan` handoff) | `name`, `branch`, `base` | Refuses it. When configured, the hook creates the worktree instead of Git and prints its path as its last line | — |
| `WorktreeRemove` | A worktree is removed | `worktree_path` | — (when it deletes the folder, Git doesn't run) | — |
| `Stop` | The model finishes its answer | `last_assistant_message`, `stop_hook_active` | The model keeps going (up to 3 times) | — |
| `StopFailure` | A turn ended on an error | `error` (`rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `server_error`, `max_output_tokens` or `unknown`), `error_details` | — | `error` |
| `SessionEnd` | A session ends | `reason`: `exit`, `clear` or `resume` | — | `reason` |

`FileChanged` watches the files its matchers list (`.envrc|.env`, `config/app.json`, or an absolute path), relative to the project folder; a name matches a file of that name, a path that file. A hook can add paths with `watchPaths` in its JSON output (from SessionStart, CwdChanged or FileChanged). A pattern (`^\.env`), or no matcher, matches every watched file by name but adds none.

## What a hook can answer

Exit code 2 blocks where the table says it can, with stderr as the reason; elsewhere it's reported like any other failure. JSON on stdout follows Claude Code's format: `continue: false` (with `stopReason`) ends the turn from any event, `systemMessage` is shown to you, `decision: "block"` with `reason` blocks, and `hookSpecificOutput` carries `permissionDecision`, `updatedInput`, `additionalContext` (up to 10,000 characters), `updatedToolOutput`, `watchPaths` and, for PermissionRequest, `decision`. UserPromptSubmit and SessionStart also take plain text as context. SessionStart, SessionEnd and Notification hooks run in the background, except that Cavvy waits up to 5 seconds for SessionEnd hooks when it exits.

PostToolUse now runs only when the tool succeeded, as in Claude Code. A hook that should see failures goes in PostToolUseFailure too.

## On Claude Code and Codex


| | Claude Code | Codex |
|---|---|---|
| UserPromptSubmit, Stop, SessionEnd, Notification, InstructionsLoaded, FileChanged, DirectoryAdded, StopFailure | Cavvy | Cavvy |
| SessionStart | Cavvy; after a compaction (Claude Code's own too), Claude Code calls back | Cavvy |
| PreToolUse | Claude Code calls back to Cavvy for each handler | Codex calls back to Cavvy before every tool call (below) |
| PermissionRequest | When Claude Code asks for approval | When Codex asks for approval |
| PostToolUse, PostToolUseFailure | Claude Code calls back | Commands, patches and MCP calls that ran; context is steered into the turn |
| PostToolBatch, PermissionDenied, CwdChanged, WorktreeCreate, WorktreeRemove | Claude Code calls back | — |
| SubagentStart, SubagentStop | Claude Code calls back | Codex calls back when it starts and finishes a sub-agent (below) |
| PreCompact, PostCompact | Claude Code calls back | `/compact`; Codex's own auto-compaction runs PostCompact only |

Claude Code runs Cavvy's hooks for its own tools, sub-agents, compaction and worktrees through its SDK hook callbacks: each handler runs in Cavvy, with Claude Code's input and Cavvy's `session_id` (Claude Code's own is `backend_session_id`). The events Cavvy runs itself aren't registered with Claude Code, so nothing runs twice. SessionStart handlers that match `compact` are registered too, for compaction only, so after Claude Code compacts (on its own or for `/compact`) their context reaches its model. Prompt hooks for these events go to Claude Code in its settings instead, and it asks its own model, as for its own prompt hooks. Prompt hooks for the events Cavvy runs, and on Codex, are answered by the session's CLI in a throwaway session with no tools (Claude Code with `--tools ""`, Codex in an ephemeral read-only thread with no shell), so they work without a `smallModel`.

Codex 0.160 and later run hooks themselves, so PreToolUse goes to Codex as one of its own: an `mcp_tool` hook that calls a tool on Cavvy's MCP server (hidden from Codex's model), where Cavvy runs your handlers, as with Claude Code. It fires before every tool call (commands, patches, MCP tools, sub-agents), in every mode, and Codex keeps its own approval policy. A read-only agent gets the hook even when you have no PreToolUse hooks, and it refuses what isn't a read before your handlers run. Codex runs only hooks it trusts, so Cavvy gives the hook with its trust hash and checks with `hooks/list` that Codex took it; your own Codex hooks and their trust are left alone. Codex's tools reach your matchers under Cavvy's names: `Bash`, `Write` or `Edit` for a patch (with its first file as `file_path` and the patch as `patch`), `Task` for `spawn_agent`, `mcp__server__tool`; its other tools keep their names. A rewrite (`updatedInput`) runs, after being checked as the call it becomes (deny rules, read-only agents, the mode); a patch or a sub-agent can't be rewritten, so that call is refused. A hook's `ask` asks you from the hook, since Codex may not ask (Bypass never does). If the hook's call fails, Codex goes on with the tool call, so Cavvy stops the turn and says so. SubagentStart and SubagentStop go to Codex the same way, with `agent_type` `codex` and the sub-agent's task as `description`: SubagentStart's `additionalContext` reaches the sub-agent before its prompt, and a SubagentStop block keeps it going with the reason, after which the hook runs again with `stop_hook_active` set. A Codex that doesn't take the hooks (older than 0.160) gets the earlier behavior: PreToolUse sees only what Codex asks about, and in Bypass mode Cavvy sets Codex to ask about every command; SubagentStart and SubagentStop run in Cavvy, where they can't add context or keep a sub-agent going. Codex's PostToolUse can't change a result that's already in Codex, so `updatedToolOutput` is ignored there; feedback and context reach the model as a steering message. Codex has no events for a moved working directory, its worktrees, or a batch of tool calls.

## Not supported yet

The `agent` handler type, `PermissionDenied`'s `retry`, and Claude Code's Setup, UserPromptExpansion, TaskCreated, TaskCompleted, TeammateIdle, Elicitation, ElicitationResult, MessageDisplay, ConfigChange and Pre/PostModelSwitch events (Cavvy has no equivalent point for most of them yet).
