# Headless runs and the SDK

## Headless

```bash
cavvy -p "fix the lint errors" --permission-mode acceptEdits --allowedTools "Bash(npm run lint:*)"
git diff | cavvy -p "review this" --output-format json
cavvy -p "…" --output-format stream-json     # one JSON event per line
```

In `-p` mode nothing can prompt you, so anything that would ask is denied, and there are no notifications. Allow it with `--allowedTools`, rules, or `--permission-mode`. The exit code is 0 on success and 1 on error or `--max-turns`.

Piped stdin is added to the prompt. When the prompt is also given on the command line, stdin is optional: if nothing arrives within 3 seconds the run goes on without it (so a parent process that leaves stdin open can't hang it). To pipe a command that's slow to start printing, save its output to a file first. Retries (rate limits, overloaded or unreachable providers, or one that sends nothing for 5 minutes) are reported on stderr as they happen. `-c` and `-r` continue with the model the session was using, if it's still available.

## SDK

Drive Cavvy from TypeScript (Bun): the same agent as the CLI, in your process.

```ts
import { query } from "cavvy/sdk";

for await (const m of query({ prompt: "fix the lint errors", options: { permissionMode: "acceptEdits" } })) {
    if (m.type === "result") console.log(m.result);
}
```

Messages have the same shapes as `--output-format stream-json`. Permission prompts go to a `canUseTool` callback, and `tool()` gives the agent tools of your own. See [src/sdk/README.md](../src/sdk/README.md) and [examples/sdk](../examples/sdk) (`bun run sdk:example` runs them without keys).
