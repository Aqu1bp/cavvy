// A fake OpenAI-compatible model server for developing and testing the GUI
// without API keys. It streams Chat Completions SSE like a real provider,
// and picks a script from keywords in the prompt:
//
//   "sso" / "demo"   explore, read, edit (asks permission), run tests, summarize
//   "diagnostics"    an edit with a type error, then its fix (shows the language server's report)
//   "question"       asks a multiple-choice question
//   "mcpform" / "mcpsample" / "mcpresources"   an MCP server named "docs" asks for a form, for sampling; its resources
//   "plan"           presents a plan for approval
//   "todo"           keeps a todo list while working
//   "slow"           streams a long answer slowly
//   "streamdemo"     a long markdown reply (headings, lists, code, a table) at a model's pace: uneven chunks, uneven gaps
//   "agents"         hands two reviews to sub-agents on other models (Task), then sums up
//   "note"           a sub-agent that writes a file (asks permission in Manual mode)
//   "background"     a sub-agent in the background (Task run_in_background), and a turn that goes on meanwhile
//   "first message"  says what the user's first message was, and how many they've sent
//   "pause"          a short answer after a moment's wait (time to queue a message meanwhile)
//   "reject400"      the request is refused (HTTP 400, as for a bad request)
//   "hangforever"    nothing is ever sent back (until the request is cancelled)
//   "emptyreply"     a response with no text and no tool calls
//   "untitled"       the request for the session's title is refused (HTTP 400)
//   "stubborn"       runs a command that ignores being told to stop (SIGTERM)
//   "waitcheck"      starts a background command, then waits and checks it in one response
//   "use the x skill" loads skill x (Skill tool), then quotes the start of its instructions
//   "schedule"       schedules the test suite for weekday mornings (CronCreate)
//   "goaldemo"       runs the tests (for /goal); the goal check answers "not met" on its first check and
//                    "met" after, or "impossible" when the goal says so
//   "ship"           commits, opens a pull request and watches it (GitCommit, CreatePullRequest)
//   (a wake)         answers a watched pull request's news: failed checks, comments, passing checks
//   "monitor"        watches a build log with Monitor; its lines wake the agent later
//   anything else    a short markdown answer
//
//   bun scripts/mock-llm.ts [--port 4010] [--delay 12]
//
// Register it as a provider (no key needed) in ~/.harness/providers.json:
//   { "custom": [{ "id": "mock", "name": "Mock", "baseUrl": "http://127.0.0.1:4010/v1", "requiresKey": false }] }

type Json = Record<string, any>;

interface Step {
    reasoning?: string;
    text?: string;
    /** Stream the text the way a model does: a few characters to a few words at a time, at uneven gaps (same every run). */
    paced?: boolean;
    calls?: { name: string; args: Json }[];
}

export interface MockOptions {
    port?: number;
    /** Milliseconds between streamed chunks. */
    delayMs?: number;
}

const MODELS = [
    { id: "mock-opus", name: "Mock Opus", context_length: 200_000 },
    { id: "mock-sonnet", name: "Mock Sonnet", context_length: 200_000 },
    { id: "mock-haiku", name: "Mock Haiku", context_length: 128_000 },
];

const SUMMARY = `Enterprise admins can now configure **SAML single sign-on** from organization settings, and members can sign in through their identity provider.

### What changed
- \`src/auth/sso.ts\` — new \`SamlProvider\` that validates assertions and maps attributes to users
- \`src/auth/index.ts\` — registers the SSO strategy next to email login
- \`src/settings/org.ts\` — \`requireSso\` flag, only enforceable once the connection is verified

| Check | Result |
| --- | --- |
| Unit tests | passing |
| Email login | unchanged |

\`\`\`ts
export function requireSso(org: Org): boolean {
    return org.sso?.verified === true && org.sso.enforced;
}
\`\`\`

Existing email login keeps working for everyone, and admins keep a recovery path even when SSO is enforced.`;

const AUTH_REPORT = `Sign-in strategies are registered in one list:

- \`src/auth/index.ts\` exports \`strategies\`, currently \`[emailStrategy]\`
- \`src/auth/email.ts\` implements \`Strategy\` from \`src/auth/types.ts\`
- \`loadSamlConfig()\` already reads \`SAML_ENTRY\`, so an SSO strategy can be appended to \`strategies\` without other changes.`;

const TESTS_REPORT = `Only email sign-in is tested (\`test/auth.test.ts\`, one case). Missing:

1. A rejected password (\`authenticate\` returning \`null\`)
2. The order of \`strategies\`
3. Anything for SSO: assertion checks and the \`requireSso\` gate`;

function scenario(prompt: string, toolRounds: number, lastResult: string): Step | undefined {
    const p = prompt.toLowerCase();
    // A turn of a long, realistic session (scripts/perf-seed.ts): looks around, writes a file, then a long answer.
    if (/\bperfturn\b/.test(p)) {
        const n = Number(/perfturn (\d+)/.exec(p)?.[1] ?? 0);
        const body = Array.from({ length: 40 }, (_, i) => `export function step${n}_${i}(x: number): number {\n    return x * ${i + 1} + ${n};\n}\n`).join("\n");
        const steps: Step[] = [
            {
                reasoning: `Turn ${n}: find where this lives before changing it. `.repeat(8),
                text: `I'll look around first (turn ${n}).`,
                calls: [
                    { name: "Glob", args: { pattern: "src/**/*.ts" } },
                    { name: "Read", args: { file_path: "src/auth/index.ts" } },
                    { name: "Grep", args: { pattern: "strategy", path: "src" } },
                ],
            },
            {
                text: "Now the change, and a quick check.",
                calls: [
                    { name: "Write", args: { file_path: `src/perf/module${n % 12}.ts`, content: `// turn ${n}\n${body}` } },
                    { name: "Bash", args: { command: `ls src && echo turn ${n}`, description: "List the sources" } },
                ],
            },
            { text: `${STREAM_DEMO}\n\n${SUMMARY}\n\nTurn ${n} is done.` },
        ];
        return steps[toolRounds];
    }
    // A turn that changes hundreds of files at once (scripts/perf-seed.ts): the "322 changed files" card.
    if (/\bbulkchange\b/.test(p)) {
        const steps: Step[] = [
            {
                text: "Generating the client for every endpoint.",
                calls: [{ name: "Bash", args: { command: `mkdir -p gen && for i in $(seq 1 322); do seq 1 168 | sed "s/.*/export const x$i""n& = 1;/" > gen/endpoint$i.ts; done && echo done`, description: "Generate the endpoint clients" } }],
            },
            { text: "Generated **322** endpoint clients under `gen/`." },
        ];
        return steps[toolRounds];
    }
    // A monitor's lines woke the agent: say what they were.
    if (/<event source="monitor"/.test(prompt)) {
        const lines = [...prompt.matchAll(/<monitor-output[^>]*>\n([\s\S]*?)<\/monitor-output>/g)].flatMap((m) => m[1]!.trim().split("\n"));
        const ended = /ended: its command exited with code (\d+)/.exec(prompt);
        if (ended) return { text: `The build watch ended (exit code ${ended[1]}).` };
        const failed = lines.find((l) => /error|fail/i.test(l));
        return { text: failed ? `The build reported a failure: \`${failed}\`. I'll look into \`test/auth.test.ts\` next.` : `Progress: ${lines.join("; ")}.` };
    }
    // News from a watched pull request (the harness woke the agent).
    if (/events? you asked to be told about arrived/.test(p)) {
        if (/checks failed/.test(p)) return { text: "CI's **test** job failed on the latest commit. The log shows the SAML assertion test expects an issuer check; I'll fix it and push again." };
        if (/new comments?:/.test(p)) return { text: "A reviewer asked for a test of the rejected-assertion path. I'll add it and reply once it's pushed." };
        if (/passed/.test(p)) return { text: "All checks passed. The pull request is ready for your review." };
        return { text: "Noted." };
    }
    if (/\bship\b/.test(p) && !/\bgoaldemo\b/.test(p)) {
        const steps: Step[] = [
            { text: "I'll commit the SSO work first.", calls: [{ name: "GitCommit", args: { message: "Add SAML SSO sign-in\n\nRegisters a SamlProvider strategy next to email sign-in." } }] },
            {
                text: "Now the pull request, and I'll watch it.",
                calls: [{ name: "CreatePullRequest", args: { title: "Add SAML SSO sign-in", body: "Adds a SAML strategy next to email sign-in.\n\nTested with `bun test`.", watch: true } }],
            },
            { text: "The pull request is open and I'm watching it: I'll be back when CI finishes or someone comments." },
        ];
        return steps[toolRounds];
    }
    // A sub-agent's task (from "agents"): look around, then report.
    if (/^subtask:/.test(p)) {
        // One that changes something (asks permission in Manual mode).
        if (/\bnote\b/.test(p)) return [{ text: "Writing the note.", calls: [{ name: "Write", args: { file_path: "NOTES.md", content: "# Notes\n" } }] }, { text: "Wrote NOTES.md." }][toolRounds];
        const tests = /\btests?\b/.test(p);
        const steps: Step[] = [
            {
                reasoning: tests ? "I need the test files first, then what each one covers. ".repeat(4) : "Start from the auth module's entry point and follow the imports. ".repeat(4),
                text: tests ? "I'll find the tests first." : "I'll start with the auth module.",
                calls: tests ? [{ name: "Glob", args: { pattern: "test/**/*.ts" } }] : [{ name: "Glob", args: { pattern: "src/auth/*.ts" } }, { name: "Read", args: { file_path: "src/auth/index.ts" } }],
            },
            {
                reasoning: "Now the details. ".repeat(6),
                calls: tests ? [{ name: "Read", args: { file_path: "test/auth.test.ts" } }, { name: "Grep", args: { pattern: "authenticate", path: "src" } }] : [{ name: "Read", args: { file_path: "src/auth/email.ts" } }, { name: "Grep", args: { pattern: "strategies", path: "src" } }],
            },
            { text: tests ? TESTS_REPORT : AUTH_REPORT },
        ];
        return steps[toolRounds];
    }
    if (/\bbackground\b/.test(p)) {
        if (toolRounds === 0)
            return {
                text: "I'll have a reviewer look at the tests in the background while I check the auth module.",
                calls: [{ name: "Task", args: { description: "Find gaps in sign-in tests", prompt: "Subtask: check which tests cover sign-in and list what's missing.", subagent_type: "general-purpose", model: "mock:mock-haiku", run_in_background: true } }],
            };
        if (toolRounds === 1) return { text: "While it works, the auth module:", calls: [{ name: "Read", args: { file_path: "src/auth/index.ts" } }] };
        return { text: "Strategies are registered in `src/auth/index.ts`. The test review is still running in the background; its findings come with your next message." };
    }
    if (/\bnote\b/.test(p)) {
        if (toolRounds === 0)
            return {
                text: "I'll have a sub-agent write it.",
                calls: [{ name: "Task", args: { description: "Write the release note", prompt: "Subtask: write a note in NOTES.md.", subagent_type: "general-purpose", model: "mock:mock-haiku" } }],
            };
        return { text: "The note is in `NOTES.md`." };
    }
    if (/\bagents?\b/.test(p)) {
        if (toolRounds === 0)
            return {
                text: "I'll split this into two reviews and run them in parallel.",
                calls: [
                    { name: "Task", args: { description: "Map the auth module", prompt: "Subtask: read src/auth and report how sign-in strategies are registered, with file paths.", subagent_type: "explore", model: "mock:mock-haiku" } },
                    { name: "Task", args: { description: "Find gaps in sign-in tests", prompt: "Subtask: check which tests cover sign-in and list what's missing.", subagent_type: "explore", model: "mock:mock-sonnet" } },
                ],
            };
        return { text: "Both reviews are back.\n\n- **Auth:** strategies live in one list in `src/auth/index.ts`, so SSO can be appended there.\n- **Tests:** only the happy path of email sign-in is covered; SSO and failures need tests." };
    }
    // An edit with a type error the language server catches, then the fix (needs typescript-language-server installed).
    if (/\bdiagnostics\b/.test(p)) {
        const line = "        return email ? { id: email, email } : null;";
        const typo = "        return email ? { id: email, mail: email } : null;";
        const steps: Step[] = [
            { text: "I'll rename the field in the email strategy.", calls: [{ name: "Read", args: { file_path: "src/auth/email.ts" } }] },
            { calls: [{ name: "Edit", args: { file_path: "src/auth/email.ts", old_string: line, new_string: typo } }] },
            {
                text: lastResult.includes("<new-diagnostics>") ? "The language server caught it: `User` has no `mail` field. Putting it back." : "Checking it again.",
                calls: [{ name: "Edit", args: { file_path: "src/auth/email.ts", old_string: typo, new_string: line } }],
            },
            { text: "Done. `src/auth/email.ts` type-checks again." },
        ];
        return steps[toolRounds];
    }
    if (/\b(sso|demo)\b/.test(p)) {
        const steps: Step[] = [
            {
                reasoning: "The user wants SAML SSO. I should find the existing auth patterns first: where strategies are registered and how org settings are stored.",
                text: "I'll start by looking at how authentication is wired up today.",
                calls: [
                    { name: "Glob", args: { pattern: "src/**/*.ts" } },
                    { name: "Read", args: { file_path: "src/auth/index.ts" } },
                    { name: "Grep", args: { pattern: "strategy", path: "src" } },
                ],
            },
            {
                text: "Email login is registered as a strategy in `src/auth/index.ts`. I'll add an SSO strategy next to it.",
                calls: [
                    {
                        name: "Write",
                        args: {
                            file_path: "src/auth/sso.ts",
                            content: `import type { Strategy, User } from "./types";\n\nexport interface SamlConfig {\n    entryPoint: string;\n    issuer: string;\n    cert: string;\n}\n\nexport class SamlProvider implements Strategy {\n    readonly name = "saml";\n\n    constructor(private config: SamlConfig) {}\n\n    async authenticate(assertion: string): Promise<User | null> {\n        if (!assertion.includes(this.config.issuer)) return null;\n        return { id: "sso-user", email: "user@example.com" };\n    }\n}\n`,
                        },
                    },
                ],
            },
            {
                calls: [
                    {
                        name: "Edit",
                        args: {
                            file_path: "src/auth/index.ts",
                            old_string: `export const strategies = [emailStrategy];`,
                            new_string: `import { SamlProvider } from "./sso";\n\nexport const strategies = [emailStrategy, new SamlProvider(loadSamlConfig())];`,
                        },
                    },
                ],
            },
            {
                text: "Now let me run the test suite.",
                calls: [{ name: "Bash", args: { command: "bun test 2>&1", description: "Run the test suite" } }],
            },
            { text: SUMMARY },
        ];
        return steps[toolRounds];
    }
    // Asks for a secret, then uses it without ever seeing it. "checksum N M" (from `printf %s VALUE | cksum`) checks the value it got.
    if (/\bsecret\b/.test(p)) {
        if (toolRounds === 0) return { text: "I need a token for this.", calls: [{ name: "RequestSecret", args: { name: "DEMO_TOKEN", purpose: "To call the demo API with curl." } }] };
        if (toolRounds === 1) {
            if (!lastResult.startsWith("The user provided")) return { text: "Understood, I'll carry on without it." };
            const sum = /checksum (\d+ \d+)/.exec(p)?.[1];
            const check = sum ? `; [ "$(printf %s "$DEMO_TOKEN" | cksum | awk '{print $1, $2}')" = "${sum}" ] && echo MATCH || echo NO-MATCH` : "";
            return { text: "Using it now.", calls: [{ name: "Bash", args: { command: `echo "echo: $DEMO_TOKEN"; printenv | grep '^DEMO_TOKEN='; [ -n "$DEMO_TOKEN" ] && echo SET || echo UNSET${check}`, description: "Use the demo token" } }] };
        }
        return { text: `Done. The command printed:\n${lastResult}` };
    }
    // MCP, with a server named "docs" (test/fixtures/mcp-stdio-server.ts): a form it asks for, sampling, and its resources.
    if (/\bmcpform\b/.test(p)) {
        if (toolRounds === 0) return { text: "I'll ask the docs server, which needs your name first.", calls: [{ name: "mcp__docs__ask_name", args: {} }] };
        return { text: `The server got: \`${lastResult}\`` };
    }
    if (/\bmcpsample\b/.test(p)) {
        if (toolRounds === 0) return { text: "The docs server wants to ask a model something.", calls: [{ name: "mcp__docs__sample", args: { q: "In one word: what colour is the sky?" } }] };
        return { text: `The server got back: \`${lastResult.slice(0, 300)}\`` };
    }
    if (/\bmcpresources\b/.test(p)) {
        if (toolRounds === 0) return { text: "Let me see what the MCP servers offer.", calls: [{ name: "ListMcpResources", args: {} }] };
        if (toolRounds === 1) return { calls: [{ name: "ReadMcpResource", args: { server: "docs", uri: "fixture://readme" } }] };
        return { text: `The readme says:\n\n${lastResult}` };
    }
    if (/\bquestion\b/.test(p)) {
        if (toolRounds === 0) return { text: "Before I start, one decision:", calls: [{ name: "AskUserQuestion", args: { question: "Which identity protocol should we support first?", options: [{ label: "SAML 2.0", description: "Most enterprise IdPs (Okta, Azure AD)" }, { label: "OpenID Connect", description: "Simpler, modern, JSON-based" }, { label: "Both", description: "More work up front" }] } }] };
        return { text: `Great, going with that. (${lastResult.replace(/^The user answered: /, "")})` };
    }
    if (/\bplan\b/.test(p)) {
        if (toolRounds === 0) return { reasoning: "I'll research first, then propose.", calls: [{ name: "Glob", args: { pattern: "**/*.ts" } }] };
        if (toolRounds === 1) return { calls: [{ name: "ExitPlanMode", args: { plan: "## Plan: add SSO\n\n1. Add `SamlProvider` in `src/auth/sso.ts`\n2. Register it in `src/auth/index.ts`\n3. Add `requireSso` to org settings\n4. Tests for enforcement and recovery access\n\n**Risk:** lockout if SSO is enforced before verification — gate on `verified`." } }] };
        return { text: lastResult.startsWith("The user approved") ? "Plan approved — starting on step 1." : "Understood, I'll revise the plan." };
    }
    if (/\btodo\b/.test(p)) {
        const todos = (done: number) => ["Read the auth module", "Add the SSO strategy", "Run the tests"].map((content, i) => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending", activeForm: content.replace(/^(\w+)/, (w) => `${w}ing`.replace("eing", "ing")) }));
        if (toolRounds < 3) return { text: toolRounds === 0 ? "I'll track this as a short list." : undefined, calls: [{ name: "TodoWrite", args: { todos: todos(toolRounds) } }] };
        return { text: "All three steps are done." };
    }
    if (/\bschedule\b/.test(p)) {
        if (toolRounds === 0) return { text: "I'll set that up.", calls: [{ name: "CronCreate", args: { cron: "57 8 * * 1-5", prompt: "Run the test suite and summarize any failures", durable: true } }] };
        return { text: `Done: the test suite runs on weekday mornings at 8:57. ${lastResult.match(/Next run: [^.]*/)?.[0] ?? ""}. It's saved with this session, and recurring schedules stop after 7 days.` };
    }
    if (/\bmonitor\b/.test(p)) {
        if (toolRounds === 0)
            return {
                text: "I'll watch the build and react when it reports something.",
                calls: [{ name: "Monitor", args: { command: 'for i in 1 2 3; do sleep 2; echo "build step $i/3 ok"; done; sleep 1; echo "ERROR test/auth.test.ts: 1 failed"; sleep 2', description: "build progress and errors", timeout_ms: 120000 } }],
            };
        return { text: "Watching the build. Each step it reports will come back to me, so you don't need to check on it." };
    }
    // Starts a background command, then waits a moment and checks it in one response (the check queues behind the wait).
    if (/\bwaitcheck\b/.test(p)) {
        if (toolRounds === 0) return { text: "Starting it.", calls: [{ name: "Bash", args: { command: "sleep 2", description: "Run the slow suite", run_in_background: true } }] };
        const shell = /bash_\d+/.exec(lastResult)?.[0];
        if (toolRounds === 1 && shell) return { calls: [{ name: "Bash", args: { command: "sleep 1; echo done", description: "Wait for it" } }, { name: "BashOutput", args: { bash_id: shell } }] };
        return { text: "Done." };
    }
    // "use the <name> skill": loads it (Skill), then says what its instructions begin with.
    const skill = p.match(/\buse the ([a-z0-9][a-z0-9:_-]*) skill\b/);
    if (skill) {
        if (toolRounds === 0) return { text: `Loading the ${skill[1]} skill.`, calls: [{ name: "Skill", args: { skill: skill[1] } }] };
        if (toolRounds === 1) return { text: `Following the skill. It starts: ${lastResult.split("\n").find((l) => l.trim() && !l.startsWith("<") && !l.startsWith("Base directory")) ?? lastResult.slice(0, 80)}` };
    }
    if (/\bgoaldemo\b/.test(p)) {
        if (toolRounds === 0) return { text: "Running the auth tests.", calls: [{ name: "Bash", args: { command: "echo 'test/auth: 12 pass, 0 fail'", description: "Run the auth tests" } }] };
        return { text: `The auth tests pass: ${lastResult.trim() || "12 pass, 0 fail"}.` };
    }
    if (/\bstubborn\b/.test(p)) return toolRounds === 0 ? { text: "Running it.", calls: [{ name: "Bash", args: { command: "trap '' TERM; sleep 3", description: "Wait, ignoring SIGTERM" } }] } : { text: "Done." };
    if (/\bstreamdemo\b/.test(p)) return { reasoning: "They want the session flow explained with an example.", text: STREAM_DEMO, paced: true };
    if (/\bslow\b/.test(p)) return { reasoning: "Let me think about this carefully. ".repeat(6), text: Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: streaming text arrives a few words at a time so the interface can be checked for smooth rendering and stable scrolling.`).join("\n\n") };
    if (toolRounds > 0) return { text: "Done." };
    return {
        reasoning: "A short, direct answer will do.",
        text: `Here's a quick overview.\n\n1. **Server** — \`src/server/\` runs sessions\n2. **GUI** — talks to it over a WebSocket\n\n\`\`\`ts\nconst x: number = 42;\n\`\`\``,
    };
}

/** The /goal check (src/agent/goal.ts): not met on the first check, met after; impossible when the goal asks for it. */
function goalVerdict(prompt: string): string {
    const goal = /<goal>\n([\s\S]*?)\n<\/goal>/.exec(prompt)?.[1] ?? "";
    const check = Number(/Check (\d+) of this goal/.exec(prompt)?.[1] ?? 1);
    if (/\bimpossible\b/i.test(goal)) return JSON.stringify({ verdict: "impossible", reason: "The goal asks for something that contradicts itself, so it can never hold." });
    if (check < 2) return JSON.stringify({ verdict: "not_met", reason: "The conversation shows no linter run yet; run it and show that it's clean." });
    return JSON.stringify({ verdict: "met", reason: "The output shows 12 auth tests passing with 0 failures, and the linter is clean." });
}

function titleFor(prompt: string): string {
    const p = prompt.toLowerCase();
    if (/\bperfturn 9\d\d\b/.test(p)) return "Short session";
    if (/\bperfturn 7\d\d\b/.test(p)) return `Older session ${/perfturn (\d+)/.exec(p)![1]}`;
    if (/\bperfturn\b/.test(p)) return "Long session";
    if (/\bsso\b|\bdemo\b/.test(p)) return "Add enterprise SSO";
    if (/\bdiagnostics\b/.test(p)) return "Rename the email field";
    if (/\bplan\b/.test(p)) return "Plan the SSO rollout";
    if (/\bquestion\b/.test(p)) return "Choose an identity protocol";
    if (/\bsecret\b/.test(p)) return "Use a demo token";
    if (/\btodo\b/.test(p)) return "Track SSO tasks";
    if (/\bagents?\b/.test(p)) return "Review auth with agents";
    if (/\bnote\b/.test(p)) return "Write a release note";
    if (/\bbackground\b/.test(p)) return "Review tests in the background";
    if (/\bmonitor\b/.test(p)) return "Watch the build";
    return prompt.split(/\s+/).slice(0, 4).join(" ").replace(/^\w/, (c) => c.toUpperCase());
}

/** What a model would answer from the conversation it was sent: the user's first message, and every one of theirs. */
function recall(messages: Json[]): string {
    const said = messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: Json) => c.text ?? "").join("\n")).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim())
        .filter(Boolean);
    return `Your first message was "${said[0] ?? ""}". You've said: ${said.map((s) => `"${s}"`).join(", ")}.`;
}

const STREAM_DEMO = `Sessions keep running when the window closes: the server owns them, and the GUI is only a view onto its state. Here's how a turn moves through it.

## How a turn runs

The engine takes the prompt, calls the model, and streams **every event** back over the socket as it happens. Each session has its own queue, so a slow tool in one never holds up another.

1. **Prompt** — \`Composer\` sends it with \`sendPrompt()\`
2. **Model call** — the engine opens a stream to the provider
   - text deltas append to the last text block
   - tool calls become cards, each with its own status
3. **Tools** — run in the session's folder, asking first when the mode says so

### The append path

Text deltas are merged into the turn in place, so the transcript only re-renders what changed:

\`\`\`ts
function onDelta(turn: Turn, delta: string) {
    const last = turn.blocks.at(-1);
    if (last?.t === "text") last.text += delta;
    else turn.blocks.push({ t: "text", id: nextId(), text: delta });
}
\`\`\`

## What each side owns

| Part | Owns | Survives a restart |
| --- | --- | --- |
| Server | sessions, turns, tool runs | yes |
| GUI | scroll position, open panels | no |
| Provider | the model's context | per request |

The short version: the GUI can come and go, and nothing in \`~/.harness/sessions\` is lost when it does. If a reply is cut off, *resume* picks it up from the last saved turn.`;

/** A model's pace: 1 to 5 tokens a chunk (about 4 characters each), 15 to 90ms apart. Seeded, so every run is the same. */
function pacedChunks(text: string): [string, number][] {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const out: [string, number][] = [];
    for (let i = 0; i < text.length; ) {
        const n = Math.max(1, Math.round((1 + rand() * 4) * 4 * (0.6 + rand() * 0.8)));
        out.push([text.slice(i, i + n), Math.round(15 + rand() * rand() * 75)]);
        i += n;
    }
    return out;
}

/** Split text into small chunks the way a model streams it. */
function chunks(text: string): string[] {
    return text.match(/\S+\s*|\s+/g) ?? [];
}

export function startMockLlm(o: MockOptions = {}) {
    const delay = o.delayMs ?? 12;
    let calls = 0;
    /** Each completion asked for, including the prompt/attachments and raw body sent. */
    const requests: { model: string; kind: "title" | "summary" | "turn"; body: string; prompt: string; images: number }[] = [];
    /** The latest requests' bodies as they arrived, for tests that check what the model was sent. */
    const bodies: Json[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: o.port ?? 0,
        idleTimeout: 120,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname.endsWith("/models")) return Response.json({ data: MODELS });
            if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const raw = await req.text();
            const body = JSON.parse(raw) as Json;
            bodies.push(body);
            if (bodies.length > 50) bodies.shift();
            const messages: Json[] = body.messages ?? [];
            const system = String(messages.find((m) => m.role === "system")?.content ?? "");
            // The prompt that started this turn and how many tool rounds have happened since.
            let promptIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i]!;
                if (m.role === "user") {
                    const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((c: Json) => c.text ?? "").join("");
                    if (!text.startsWith("<system-reminder>") || i === 0) {
                        promptIdx = i;
                        break;
                    }
                }
            }
            const promptMsg = messages[promptIdx] ?? {};
            // The harness's own notes ride along with prompts; only the user's words pick the script.
            // A prompt after an interrupt arrives joined to the interrupted one (one user message): only what follows counts.
            const prompt = (typeof promptMsg.content === "string" ? promptMsg.content : (promptMsg.content ?? []).map((c: Json) => c.text ?? "").join("\n")).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").split("[Request interrupted by user]").pop()!.trim();
            const images = Array.isArray(promptMsg.content) ? promptMsg.content.filter((c: Json) => c.type === "image_url").length : 0;
            const after = messages.slice(promptIdx + 1);
            const toolRounds = after.filter((m) => m.role === "assistant").length;
            const lastResult = String([...after].reverse().find((m) => m.role === "tool")?.content ?? "");
            calls++;

            const isTitle = /name coding-assistant sessions/.test(system);
            if (isTitle && /\buntitled\b/i.test(prompt)) {
                requests.push({ model: body.model ?? "mock-haiku", kind: "title", body: raw, prompt, images });
                return Response.json({ error: { message: "No title for this one", code: 400 } }, { status: 400 });
            }
            if (!isTitle && /\breject400\b/i.test(prompt)) {
                requests.push({ model: body.model ?? "mock-opus", kind: body.tools?.length ? "turn" : "summary", body: raw, prompt, images });
                return Response.json({ error: { message: "Invalid request: the mock refuses this one", code: 400 } }, { status: 400 });
            }
            if (!isTitle && /\bhangforever\b/i.test(prompt)) {
                requests.push({ model: body.model ?? "mock-opus", kind: "turn", body: raw, prompt, images });
                // Headers and all held back, until the client gives up.
                await new Promise<void>((r) => req.signal.addEventListener("abort", () => r(), { once: true }));
                return new Response(null, { status: 499 });
            }

            let step: Step;
            if (/name coding-assistant sessions/.test(system)) step = { text: titleFor(prompt) };
            else if (/check whether a coding agent has reached a goal/.test(system)) {
                // A real check takes a moment: long enough to see it (not in tests, which run with no delay).
                if (delay) await Bun.sleep(delay * 100);
                step = { text: goalVerdict(prompt) };
            }
            else if (!body.tools?.length) step = { text: "Summary: the user asked for help; the work is in progress." };
            else if (/what was my first message/i.test(prompt)) step = { text: recall(messages) };
            else if (/\bpause\b/i.test(prompt)) {
                await Bun.sleep(400);
                step = { text: "Done waiting." };
            } else if (/\bemptyreply\b/i.test(prompt)) step = {};
            else step = scenario(prompt, toolRounds, lastResult) ?? { text: "Done." };

            const enc = new TextEncoder();
            const id = `chatcmpl-${calls}`;
            const model = body.model ?? "mock-opus";
            requests.push({ model, kind: /name coding-assistant sessions/.test(system) ? "title" : body.tools?.length ? "turn" : "summary", body: raw, prompt, images });
            const stream = new ReadableStream({
                async start(ctrl) {
                    const send = (obj: Json) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
                    const delta = (d: Json, finish: string | null = null) => send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: d, finish_reason: finish }] });
                    const wait = () => (delay ? Bun.sleep(delay) : Promise.resolve());
                    try {
                        if (step.reasoning) for (const c of chunks(step.reasoning)) {
                            delta({ reasoning_content: c });
                            await wait();
                        }
                        if (step.text && step.paced) for (const [c, ms] of pacedChunks(step.text)) {
                            delta({ content: c });
                            await Bun.sleep(delay ? ms : 0);
                        }
                        else if (step.text) for (const c of chunks(step.text)) {
                            delta({ content: c });
                            await wait();
                        }
                        (step.calls ?? []).forEach((c, i) => {
                            const args = JSON.stringify(c.args);
                            delta({ tool_calls: [{ index: i, id: `call_${calls}_${i}`, type: "function", function: { name: c.name, arguments: "" } }] });
                            for (let k = 0; k < args.length; k += 40) delta({ tool_calls: [{ index: i, function: { arguments: args.slice(k, k + 40) } }] });
                        });
                        delta({}, step.calls?.length ? "tool_calls" : "stop");
                        const out = Math.ceil(((step.reasoning ?? "") + (step.text ?? "") + JSON.stringify(step.calls ?? [])).length / 4);
                        send({ id, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 1200 + messages.length * 350, completion_tokens: out } });
                        ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
                    } catch {
                        // client went away
                    }
                    ctrl.close();
                },
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        },
    });
    return { url: `http://127.0.0.1:${server.port}/v1`, port: server.port, requests, bodies, stop: () => server.stop(true) };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const arg = (n: string) => {
        const i = args.indexOf(n);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const m = startMockLlm({ port: Number(arg("--port") ?? 4010), delayMs: Number(arg("--delay") ?? 12) });
    process.stderr.write(`mock LLM at ${m.url}\n`);
}
