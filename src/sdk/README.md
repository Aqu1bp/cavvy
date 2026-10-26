# Cavvy SDK (TypeScript)

Drive Cavvy from your own code: run prompts, stream what the agent does, answer its permission prompts, and give it tools of your own. It's the same agent as the `cavvy` CLI, in your process, with the same keys, settings, providers, MCP servers, hooks, permission rules and session files. The API follows Claude Code's Agent SDK (`query()` returning an async generator of messages).

```ts
import { query } from "cavvy/sdk";

for await (const m of query({ prompt: "Why does test/auth.test.ts fail?", options: { cwd: "/path/to/project" } })) {
    if (m.type === "result") console.log(m.result);
}
```

**Runtime:** Bun 1.4 or newer. Cavvy is a Bun program (it uses `Bun.spawn`, `Bun.serve` and friends), so the SDK runs in Bun only, not Node.

**Installing:** the package isn't published. Depend on this repository (`bun add github:Aqu1bp/cavvy`, or `bun add /path/to/cavvy`) and import `cavvy/sdk`. Keys come from the same place as the CLI's: `cavvy auth add`, the environment, or `~/.cavvy/.env`.

## Examples

- [`examples/sdk/basic.ts`](../../examples/sdk/basic.ts): one prompt, streamed text, `canUseTool`, and a custom tool.
- [`examples/sdk/conversation.ts`](../../examples/sdk/conversation.ts): several turns in one session, with `steer()`.

`bun run sdk:example` runs both against a mock model, so no keys are needed. `bun run sdk:bench` measures the SDK's overhead.

## `query({ prompt, options })`

Returns a `Query`, an async generator of `SDKMessage`. Nothing runs until you start iterating.

`prompt` is a string for one turn, or an `AsyncIterable` of messages (strings, or `{ type: "user", content }`) for a conversation in one session. Each message is a turn, in order, and the next is taken when the one before it ends. To add something to the turn that's running, use `steer()`.

### Options

| Option | |
|---|---|
| `cwd` | The project folder. Default `process.cwd()`. |
| `model` | `"provider:model"`, as in `cavvy models`. Default: as the CLI (your settings, then the first model with a key). |
| `permissionMode` | `"default"`, `"acceptEdits"`, `"plan"`, `"auto"` or `"bypassPermissions"`. Default: your settings' `defaultMode` (bypass only from user settings), else `"default"`. |
| `allowedTools`, `disallowedTools` | Permission rules, as `--allowedTools` and `--disallowedTools`: `"Bash(npm test:*)"`, `"Edit(src/**)"`, `"WebFetch"`. Deny rules beat everything. |
| `additionalDirectories` | More folders the agent may work in, as `--add-dir`. |
| `canUseTool` | Answers the calls that would otherwise prompt you. Without it they're denied, as in `cavvy -p`. |
| `tools` | Tools of your own, made with `tool()`. |
| `maxTurns` | Most model responses in one turn (`error_max_turns` when reached). |
| `appendSystemPrompt` | Added to the system prompt on every request, not saved in the session. |
| `effort`, `fastMode` | As the CLI flags. |
| `resume` | A session id, or the start of one, in `cwd`. |
| `continue` | Continue the latest session in `cwd`. |
| `persistSession` | Default `true`: saved like the CLI's sessions, so `cavvy -r <id>` and the GUI open it. `false` with `resume` goes on in an unsaved copy and writes nothing to the original. Claude Code and Codex fork their own session for it (`--fork-session`, `thread/fork`), so they keep the conversation's context. |
| `trusted` | Load the project's `.cavvy/settings.json`, `.mcp.json`, memory files, agents and skills. `true` trusts the folder until the process exits, as answering yes to the trust prompt does (not saved), so Claude Code and Codex get the project's own configuration too. `false` keeps all of it out, even in a folder you trusted, and a resumed session is sent without the memory files its saved prompt was made with. Default: as `cavvy -p`, which trusts folders you trusted and, for that query only, folders with no project configuration. |
| `settings` | Settings over those loaded from disk: `hooks`, `mcpServers`, `env`, `permissions`, … Rule lists and hooks add up; maps merge by key. |
| `abortController` | Aborting it ends the query. |
| `includePartialMessages` | Also yield `stream_event` messages as text streams in. |

### `Query` methods

| | |
|---|---|
| `interrupt()` | Stop the running turn. Its result has subtype `error_aborted`. A conversation goes on with the next message. |
| `steer(text)` | Send a message to the running turn: the model gets it between steps (Codex takes it into its running turn at once), as when you type while the agent works. With no turn running, it becomes the next turn. Resolves `false` when the query is over. |
| `setPermissionMode(mode)` | For the rest of the query, the running turn included (Claude Code and Codex turns too). The model is told with its next message, as in the terminal. |
| `close()` | End the query: stop the turn, run SessionEnd hooks, stop background shells and MCP servers, let go of the session. `break` out of `for await` does the same, and so does `await using q = query(…)`. |
| `sessionId` | A promise of the session's id. |

## Messages

These are also what `cavvy -p --output-format stream-json` prints, one per line.

| `type` | |
|---|---|
| `system` / `init` | First: `session_id`, `cwd`, `model`, `permission_mode`, `tools`, `mcp_servers`, and `agent_backend` for Claude Code or Codex. |
| `system` / `notice` | Warnings and errors, as the CLI shows them (`level`, `message`). |
| `system` / `retry`, `system` / `compact` | A request being retried; the conversation compacted. |
| `assistant` | One model response: `message.content` is `text`, `thinking` and `tool_call` blocks. A sub-agent's have `parent_tool_use_id`. |
| `tool_result` | `tool_use_id`, `tool`, `is_error`, `content` (cut at 20,000 characters). |
| `stream_event` | With `includePartialMessages`: `event.type` is `text_delta` or `thinking_delta`. |
| `result` | Last in every turn: `subtype` (`success`, `error_max_turns`, `error_aborted`, `error_during_execution`), `is_error`, `result` (the last text), `num_turns`, `duration_ms`, `total_cost_usd`, `usage`, `permission_denials`, `errors`. |

## Permissions

The same rules as the CLI decide first: deny rules, then the permission mode, then allow rules. `canUseTool` hears only about what's left, the calls that would prompt you in the terminal.

```ts
const canUseTool: CanUseTool = async (toolName, input, { title, reason, suggestions, signal }) => {
    if (toolName === "Bash" && String(input.command).startsWith("npm test")) return { behavior: "allow", rules: suggestions };
    return { behavior: "deny", message: "Only tests may run. Describe other changes instead." };
};
```

- `{ behavior: "allow" }` runs the call. `rules` (for example the `suggestions` it was given) allow matching calls for the rest of the query without asking.
- `{ behavior: "deny", message }` tells the model why and lets it carry on. Without a `message` the turn stops there, as when you decline in the terminal.
- If it throws, the call is denied and a notice says why.
- `signal` ends when the answer no longer matters (the turn was interrupted). An answer that never comes doesn't hold up an interrupt.

## Custom tools

```ts
import { tool } from "cavvy/sdk";

const lookup = tool(
    "lookup_customer",
    "A customer's plan and status, by email.",
    { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
    async ({ email }, { signal }) => JSON.stringify(await crm.find(email, { signal })),
    { readOnly: true },
);
```

The input schema is JSON Schema. The handler returns a string, or `{ content, isError }`; a thrown error becomes an error result the model sees, and the turn goes on. Your tools run without a permission prompt (you wrote them), but deny rules and ask rules on their names still apply, and in plan mode only those marked `readOnly` run. Names can't clash with the built-in tools, `Skill` included. Claude Code and Codex models run their own tools, so they aren't offered yours; the query says so in a notice.

## Errors

- A query that can't start (bad options, an unknown model, no key, a session that doesn't exist or is open in another query) throws `CavvySdkError` from the iterator.
- A turn that fails (the provider refused the request, a hook blocked the prompt) ends with an error `result`. Its `errors` hold the turn's error notices; warnings come as `system` / `notice` messages. A conversation goes on with the next message.
- An input iterable that throws ends the query with that error, after cleaning up.

## Concurrency

Queries are independent: run as many at once as you like, in the same folder or different ones. Each has its own session, tools state and background shells. A session can be open in one query at a time.

## Overhead

`bun run sdk:bench` on Linux, Bun 1.4.2, against a mock model with no delay:

| | |
|---|---|
| Importing `cavvy/sdk` | ~1 ms (the engine loads on the first query, ~110 ms once, the same as `cavvy -p`) |
| Starting a query (to the init message) | ~1.5 ms |
| A turn, beyond the provider's own time | ~1.3 ms |
| For comparison: `cavvy -p`, a process per prompt | ~160 ms |
