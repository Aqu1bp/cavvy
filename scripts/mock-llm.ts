// A fake OpenAI-compatible model server for developing and testing the GUI
// without API keys. It streams Chat Completions SSE like a real provider,
// and picks a script from keywords in the prompt:
//
//   "sso" / "demo"   explore, read, edit (asks permission), run tests, summarize
//   "question"       asks a multiple-choice question
//   "plan"           presents a plan for approval
//   "todo"           keeps a todo list while working
//   "slow"           streams a long answer slowly
//   "agents"         hands two reviews to sub-agents on other models (Task), then sums up
//   "note"           a sub-agent that writes a file (asks permission in Manual mode)
//   "reject400"      the request is refused (HTTP 400, as for a bad request)
//   "hangforever"    nothing is ever sent back (until the request is cancelled)
//   "emptyreply"     a response with no text and no tool calls
//   "untitled"       the request for the session's title is refused (HTTP 400)
//   "stubborn"       runs a command that ignores being told to stop (SIGTERM)
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
    if (/\bstubborn\b/.test(p)) return toolRounds === 0 ? { text: "Running it.", calls: [{ name: "Bash", args: { command: "trap '' TERM; sleep 3", description: "Wait, ignoring SIGTERM" } }] } : { text: "Done." };
    if (/\bslow\b/.test(p)) return { reasoning: "Let me think about this carefully. ".repeat(6), text: Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: streaming text arrives a few words at a time so the interface can be checked for smooth rendering and stable scrolling.`).join("\n\n") };
    if (toolRounds > 0) return { text: "Done." };
    return {
        reasoning: "A short, direct answer will do.",
        text: `Here's a quick overview.\n\n1. **Server** — \`src/server/\` runs sessions\n2. **GUI** — talks to it over a WebSocket\n\n\`\`\`ts\nconst x: number = 42;\n\`\`\``,
    };
}

function titleFor(prompt: string): string {
    const p = prompt.toLowerCase();
    if (/\bsso\b|\bdemo\b/.test(p)) return "Add enterprise SSO";
    if (/\bplan\b/.test(p)) return "Plan the SSO rollout";
    if (/\bquestion\b/.test(p)) return "Choose an identity protocol";
    if (/\btodo\b/.test(p)) return "Track SSO tasks";
    if (/\bagents?\b/.test(p)) return "Review auth with agents";
    if (/\bnote\b/.test(p)) return "Write a release note";
    return prompt.split(/\s+/).slice(0, 4).join(" ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Split text into small chunks the way a model streams it. */
function chunks(text: string): string[] {
    return text.match(/\S+\s*|\s+/g) ?? [];
}

export function startMockLlm(o: MockOptions = {}) {
    const delay = o.delayMs ?? 12;
    let calls = 0;
    /** Each completion asked for: the model, and what it was for. */
    const requests: { model: string; kind: "title" | "summary" | "turn" }[] = [];
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
            const body = (await req.json()) as Json;
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
            const prompt = (typeof promptMsg.content === "string" ? promptMsg.content : (promptMsg.content ?? []).map((c: Json) => c.text ?? "").join("\n")).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            const after = messages.slice(promptIdx + 1);
            const toolRounds = after.filter((m) => m.role === "assistant").length;
            const lastResult = String([...after].reverse().find((m) => m.role === "tool")?.content ?? "");
            calls++;

            const isTitle = /name coding-assistant sessions/.test(system);
            if (isTitle && /\buntitled\b/i.test(prompt)) {
                requests.push({ model: body.model ?? "mock-haiku", kind: "title" });
                return Response.json({ error: { message: "No title for this one", code: 400 } }, { status: 400 });
            }
            if (!isTitle && /\breject400\b/i.test(prompt)) {
                requests.push({ model: body.model ?? "mock-opus", kind: body.tools?.length ? "turn" : "summary" });
                return Response.json({ error: { message: "Invalid request: the mock refuses this one", code: 400 } }, { status: 400 });
            }
            if (!isTitle && /\bhangforever\b/i.test(prompt)) {
                requests.push({ model: body.model ?? "mock-opus", kind: "turn" });
                // Headers and all held back, until the client gives up.
                await new Promise<void>((r) => req.signal.addEventListener("abort", () => r(), { once: true }));
                return new Response(null, { status: 499 });
            }

            let step: Step;
            if (/name coding-assistant sessions/.test(system)) step = { text: titleFor(prompt) };
            else if (!body.tools?.length) step = { text: "Summary: the user asked for help; the work is in progress." };
            else if (/\bemptyreply\b/i.test(prompt)) step = {};
            else step = scenario(prompt, toolRounds, lastResult) ?? { text: "Done." };

            const enc = new TextEncoder();
            const id = `chatcmpl-${calls}`;
            const model = body.model ?? "mock-opus";
            requests.push({ model, kind: /name coding-assistant sessions/.test(system) ? "title" : body.tools?.length ? "turn" : "summary" });
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
                        if (step.text) for (const c of chunks(step.text)) {
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
