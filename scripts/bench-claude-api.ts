// A stand-in for Anthropic's Messages API that drives a real Claude Code CLI through an agent's working day, so the same
// work can be run under Cavvy and in a bare terminal: every reply depends only on the prompt and how far into it the
// turn is. A prompt "workday file=<abs path> cmd=<base64 shell command> out=<KB> words=<n>" goes: read the file, append a
// line to it with Bash, run the command (a build, a test suite), print `out` KB if asked, then a reply of `words` words
// streamed at about a model's pace. Anything else gets a short reply.
//
// For scripts/bench-ramp.ts --mock <url>: the CLIs get ANTHROPIC_BASE_URL=<url> and a dummy key.
//
//   bun scripts/bench-claude-api.ts [--port 0] [--tps 80]    prints its URL; POST /control {"limit": seconds} answers 429s that long

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const TPS = Number(arg("--tps") ?? 80);
let limitedUntil = 0;
let served = 0, limited = 0;

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOREM = "the change keeps the existing behaviour for every caller and only adds the new path where it was asked for while the tests cover both".split(" ");
const words = (n: number) => Array.from({ length: n }, (_, i) => LOREM[(i * 7) % LOREM.length]).join(" ");

function textOf(c: unknown): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p: any) => (p?.type === "text" ? p.text : "")).join("");
    return "";
}

/** The step of the turn: assistant messages since the user's last message with text (not tool results). */
function plan(body: any): Block[] {
    const msgs: any[] = body.messages ?? [];
    let at = msgs.length - 1;
    while (at >= 0 && !(msgs[at].role === "user" && /\bworkday\b/.test(textOf(msgs[at].content)))) at--;
    if (at < 0 || !body.tools?.length) return [{ type: "text", text: "Done." }];
    const prompt = textOf(msgs[at].content);
    const step = msgs.slice(at + 1).filter((m) => m.role === "assistant").length;
    const get = (k: string) => /\S+/.exec(prompt.split(`${k}=`)[1] ?? "")?.[0];
    const file = get("file")!;
    const cmd = get("cmd") ? Buffer.from(get("cmd")!, "base64").toString() : "true";
    const out = Number(get("out") ?? 0);
    const n = Number(get("words") ?? 300);
    switch (step) {
        case 0: return [{ type: "text", text: "Reading the file first." }, { type: "tool_use", name: "Read", input: { file_path: file } }];
        case 1: return [{ type: "text", text: "Adding the change." }, { type: "tool_use", name: "Bash", input: { command: `printf '\\n/* workday ${Date.now()} */\\n' >> '${file}'`, description: "Append a line" } }];
        case 2: return [{ type: "text", text: "Building and running the tests." }, { type: "tool_use", name: "Bash", input: { command: cmd, description: "Build and test", timeout: 600000 } }];
        case 3: if (out) return [{ type: "tool_use", name: "Bash", input: { command: `head -c ${out * 768} /dev/urandom | base64 -w 120`, description: "Print the log" } }];
        // falls through
        default: return [{ type: "text", text: `${words(n)}.` }];
    }
}

async function stream(ctrl: ReadableStreamDefaultController, blocks: Block[], model: string) {
    const send = (event: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    const id = `msg_${(++served).toString(36)}`;
    send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    let out = 0;
    for (const [i, b] of blocks.entries()) {
        if (b.type === "text") {
            send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
            // About TPS tokens a second (4 characters each), in chunks of a few tokens, as a model streams.
            for (let k = 0; k < b.text.length; k += 16) {
                send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text.slice(k, k + 16) } });
                await sleep(1000 / (TPS / 4));
            }
            out += Math.ceil(b.text.length / 4);
        } else {
            send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_${served}_${i}`, name: b.name, input: {} } });
            const json = JSON.stringify(b.input);
            for (let k = 0; k < json.length; k += 40) send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(k, k + 40) } });
            out += Math.ceil(json.length / 4);
        }
        send("content_block_stop", { type: "content_block_stop", index: i });
    }
    send("message_delta", { type: "message_delta", delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: out } });
    send("message_stop", { type: "message_stop" });
    ctrl.close();
}

const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(arg("--port") ?? 0),
    idleTimeout: 255,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/control") {
            const c = (await req.json()) as { limit?: number };
            if (c.limit !== undefined) limitedUntil = Date.now() + c.limit * 1000;
            return Response.json({ served, limited, limitedUntil });
        }
        if (url.pathname === "/stats") return Response.json({ served, limited });
        if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 2000 });
        if (!url.pathname.endsWith("/messages")) return Response.json({ data: [] });
        if (Date.now() < limitedUntil) {
            limited++;
            const wait = Math.ceil((limitedUntil - Date.now()) / 1000);
            return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Rate limited (stand-in)." } }, { status: 429, headers: { "retry-after": String(wait), "anthropic-ratelimit-requests-reset": new Date(limitedUntil).toISOString() } });
        }
        const body = (await req.json()) as any;
        if (process.env.MOCK_LOG) require("fs").appendFileSync(process.env.MOCK_LOG, JSON.stringify({ bytes: JSON.stringify(body).length, tools: (body.tools ?? []).length, toolBytes: JSON.stringify(body.tools ?? []).length, namesBrowser: JSON.stringify(body).includes("mcp__cavvy__browser_navigate"), mentions: (JSON.stringify(body.messages ?? []).match(/mcp__cavvy__[a-z_]+/g) ?? []).slice(0, 20), systemMentions: (JSON.stringify(body.system ?? "").match(/[Bb]rowser[^"]{0,80}/g) ?? []).slice(0, 3), systemBytes: JSON.stringify(body.system ?? "").length, names: (body.tools ?? []).map((t: any) => t.name) }) + "\n");
        const blocks = plan(body);
        const model = body.model ?? "claude-sonnet-4-5";
        // Thinking time before the first token, as a model's.
        await sleep(400 + (served % 5) * 120);
        if (!body.stream) {
            served++;
            return Response.json({ id: `msg_${served}`, type: "message", role: "assistant", model, content: blocks.map((b, i) => (b.type === "text" ? b : { type: "tool_use", id: `toolu_${served}_${i}`, name: b.name, input: b.input })), stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 50 } });
        }
        return new Response(new ReadableStream({ start: (ctrl) => stream(ctrl, blocks, model) }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
});
console.log(`http://127.0.0.1:${server.port}`);
