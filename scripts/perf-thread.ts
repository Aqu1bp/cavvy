// Writes a long session for performance work, straight to disk through the app's own Session and UiLog (so it's
// in the format the app writes), in seconds rather than the hours a long session takes through a model:
//
//   bun scripts/perf-thread.ts <project folder> <items> [cli|native] [heavy]
//
// An item is a message, a tool call, a tool result or a thought. `cli`: a Claude Code session, whose steps are in
// the GUI's log (ui/<id>.jsonl) and whose history holds each reply's text and a note of what it did. `native`: one
// of Cavvy's own models, whose tool calls and results are in the history, with compactions as its context fills.
// `heavy`: the worst the app keeps of each kind, often: outputs at their cap, long diffs, whole files written,
// sub-agents that run long, screenshots. Set CAVVY_HOME first: the session goes where the app keeps its sessions.
//
// It prints the session's id and file. Deterministic: the same arguments write the same session.

import { statSync } from "fs";
import { Session } from "../src/agent/session";
import { agentStep, promptKey, UiLog, INLINE_OUTPUT, AGENT_KEPT } from "../src/server/history";
import type { Message, UserMessage } from "../src/providers/types";
import type { Block, FileDiff } from "../src/server/protocol";

export interface ThreadOptions {
    cwd: string;
    items: number;
    kind?: "cli" | "native";
    heavy?: boolean;
    /** Seeds the content: the same seed, the same session. */
    seed?: number;
}

export interface Thread {
    id: string;
    file: string;
    turns: number;
    items: number;
    /** The session file's size and the GUI log's, in bytes. */
    bytes: number;
    uiBytes: number;
}

const WORDS = "the server reads each line and parses it before the view is built so the cost of a session grows with how long it is unless what is read is only what is shown on screen at the time which is the point of this change and of the test that checks it stays that way".split(" ");
const CODE = ["const result = await load(path);", "if (!result.ok) throw new Error(`could not read ${path}`);", "for (const item of items) total += item.size;", "return items.filter((x) => x.visible).map(render);", "export function parse(text: string): Node[] {", "    const lines = text.split(\"\\n\");", "}", "import { describe, expect, test } from \"bun:test\";"];

function random(seed: number) {
    let s = seed >>> 0 || 1;
    const next = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
    const prose = (chars: number) => {
        let out = "";
        while (out.length < chars) out += `${words(int(8, 20)).replace(/^./, (c) => c.toUpperCase())}. `;
        return out.slice(0, chars).trimEnd();
    };
    const code = (lines: number) => Array.from({ length: lines }, () => pick(CODE)).join("\n");
    return { next, int, pick, words, prose, code };
}

/** A diff of `lines` changed lines, as fileDiff makes one. */
function diffOf(path: string, lines: number, r: ReturnType<typeof random>): FileDiff {
    const out: FileDiff["hunks"][number]["lines"] = [];
    let a = 10, b = 10;
    for (let i = 0; i < lines; i++) {
        const kind = r.next();
        if (kind < 0.3) out.push({ t: "ctx", text: r.pick(CODE), a: a++, b: b++ });
        else if (kind < 0.6) out.push({ t: "del", text: r.pick(CODE), a: a++ });
        else out.push({ t: "add", text: r.pick(CODE), b: b++ });
    }
    const added = out.filter((l) => l.t === "add").length;
    const removed = out.filter((l) => l.t === "del").length;
    return { path, status: "modified", added, removed, hunks: [{ oldStart: 10, oldLines: removed + (out.length - added - removed), newStart: 10, newLines: added + (out.length - added - removed), lines: out }] };
}

/** A tool step as the GUI shows it (its output cut to INLINE_OUTPUT), and what the GUI's log keeps of it besides. */
function toolStep(id: string, r: ReturnType<typeof random>, heavy: boolean, cwd: string, at: number) {
    const kind = r.next();
    const file = `${cwd}/src/${r.pick(WORDS)}/${r.pick(WORDS)}.ts`;
    const cut = (s: string) => (s.length > INLINE_OUTPUT ? s.slice(0, INLINE_OUTPUT) : s);
    if (kind < 0.3) {
        const lines = heavy ? 400 : r.int(20, 120);
        return { block: { t: "tool", id, name: "Read", title: `Read(${file})`, category: "read", status: "ok", input: { file_path: file }, startedAt: at, output: cut(r.code(lines)) } as Block, record: { summary: `Read ${lines} lines`, durationMs: r.int(2, 40) } };
    }
    if (kind < 0.55) {
        const command = r.pick(["npm test", "bun run typecheck", "git status --short", "ls -la src", "rg -n parse src"]);
        const out = heavy ? "output line of a build that ran for a while\n".repeat(400) : "output line of a build\n".repeat(r.int(5, 200));
        return { block: { t: "tool", id, name: "Bash", title: `Bash(${command})`, category: "command", status: "ok", input: { command, description: "Run it" }, startedAt: at, output: cut(out) } as Block, record: { summary: "Exit 0", durationMs: r.int(50, 9000) } };
    }
    if (kind < 0.7) {
        const pattern = r.pick(WORDS);
        return { block: { t: "tool", id, name: "Grep", title: `Grep(${pattern})`, category: "search", status: "ok", input: { pattern, path: `${cwd}/src` }, startedAt: at, output: cut(Array.from({ length: r.int(3, 60) }, (_, i) => `src/${r.pick(WORDS)}.ts:${i + 1}: ${r.pick(CODE)}`).join("\n")) } as Block, record: { summary: "Found matches", durationMs: r.int(5, 200) } };
    }
    if (kind < 0.92) {
        // An edit; heavy, a whole file written (its content is kept in the call's input) with a long diff.
        const lines = heavy ? r.int(600, 1500) : r.int(4, 80);
        const write = heavy || r.next() < 0.2;
        const input = write ? { file_path: file, content: r.code(lines) } : { file_path: file, old_string: r.code(3), new_string: r.code(5) };
        return { block: { t: "tool", id, name: write ? "Write" : "Edit", title: `${write ? "Write" : "Edit"}(${file})`, category: "edit", status: "ok", input, startedAt: at, output: "The file was updated." } as Block, record: { summary: `Changed ${lines} lines`, diff: diffOf(file.slice(cwd.length + 1), lines, r), durationMs: r.int(2, 30) } };
    }
    // A sub-agent; its own steps are in the GUI's log under its call's id.
    const description = `Look into the ${r.pick(WORDS)} module`;
    return { block: { t: "tool", id, name: "Task", title: `Task(${description})`, category: "agent", status: "ok", agent: true, input: { description, prompt: r.prose(400), subagent_type: "general-purpose" }, startedAt: at, output: r.prose(800) } as Block, record: { summary: "Done", durationMs: r.int(5000, 120000) }, agent: { description, steps: heavy ? AGENT_KEPT + 20 : r.int(4, 20) } };
}

function cliThread(o: Required<Omit<ThreadOptions, "seed">> & { seed: number }): Omit<Thread, "bytes" | "uiBytes"> {
    const r = random(o.seed);
    const s = Session.create(o.cwd);
    s.setModel("claude-code:default");
    const ui = new UiLog(s.path, s.meta.id, false);
    let items = 0, turns = 0, at = Date.UTC(2026, 0, 1), tool = 0, block = 0;
    while (items < o.items) {
        const index = s.messages.length;
        const text = `Turn ${turns}: ${r.prose(r.int(80, 600))}`;
        const prompt = s.push({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt", display: text, checkpoint: at } } as UserMessage) as UserMessage;
        const key = promptKey(prompt);
        ui.write({ t: "turn", seg: 0, index, at });
        ui.write({ t: "turn", seg: 0, index, at, prompt: key });
        items++;
        let after: string | null = null;
        const used: string[] = [];
        const steps = o.heavy ? r.int(15, 40) : r.int(3, 20);
        for (let k = 0; k < steps && items < o.items; k++) {
            at += r.int(200, 4000);
            const kind = r.next();
            if (kind < 0.25) {
                const b = { t: "text", id: `b${++block}`, text: r.prose(r.int(60, 600)) } as Block;
                ui.write({ t: "step", seg: 0, index, prompt: key, block: b, after });
                after = b.id;
                items++;
            } else if (kind < 0.4) {
                const b = { t: "thinking", id: `b${++block}`, text: r.prose(r.int(200, o.heavy ? 6000 : 2000)), durationMs: r.int(500, 9000) } as Block;
                ui.write({ t: "step", seg: 0, index, prompt: key, block: b, after });
                after = b.id;
                items++;
            } else {
                const id = `toolu_${o.seed}_${++tool}`;
                const step = toolStep(id, r, o.heavy, o.cwd, at);
                // As the app writes a call: under way, then done.
                ui.write({ t: "step", seg: 0, index, prompt: key, block: { ...step.block, status: "running", output: undefined } as Block, after });
                ui.write({ t: "tool", id, ...step.record, at });
                ui.write({ t: "step", seg: 0, index, prompt: key, block: step.block, after });
                if (step.agent) {
                    ui.write({ t: "agent", id, head: { turnId: "", description: step.agent.description, agentType: "general-purpose", status: "done", startedAt: at, endedAt: at + 60_000, toolCount: step.agent.steps, tokens: 40_000 } });
                    let up: string | null = null;
                    for (let j = 0; j < step.agent.steps; j++) {
                        const sub = toolStep(`${id}_s${j}`, r, false, o.cwd, at);
                        // As the app writes a sub-agent's step: its output cut (agentStep).
                        ui.write({ t: "agent", id, block: agentStep(sub.block), after: up });
                        up = sub.block.id;
                    }
                }
                used.push((step.block as { title: string }).title);
                after = step.block.id;
                items += 2;
            }
        }
        const reply = r.prose(r.int(100, 1500));
        s.push({ role: "assistant", content: [{ type: "text", text: reply }, { type: "text", text: `[Claude Code used: ${used.join(", ")}]` }], provider: "claude-code", model: "default", stopReason: "end_turn" } as Message);
        ui.write({ t: "turn", seg: 0, index, at, prompt: key, end: at + 1000, status: "done" });
        items++;
        turns++;
        at += r.int(5_000, 600_000);
    }
    return { id: s.meta.id, file: s.path, turns, items };
}

/** A screenshot's worth of base64 (about 300 KB). */
const SCREENSHOT = Buffer.alloc(220_000, 7).toString("base64");

function nativeThread(o: Required<Omit<ThreadOptions, "seed">> & { seed: number }): Omit<Thread, "bytes" | "uiBytes"> {
    const r = random(o.seed);
    const s = Session.create(o.cwd);
    s.setModel("mock:mock-opus");
    let items = 0, turns = 0, call = 0, context = 0;
    // A context window's worth of characters (about 180,000 tokens) between compactions.
    const WINDOW = 720_000;
    while (items < o.items) {
        if (context > WINDOW) {
            s.compact(`Summary of the work so far: ${r.prose(2000)}`, []);
            context = 0;
        }
        const text = `Turn ${turns}: ${r.prose(r.int(80, 600))}`;
        s.push({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" } } as UserMessage);
        items++;
        context += text.length;
        const steps = o.heavy ? r.int(10, 30) : r.int(3, 9);
        for (let k = 0; k < steps && items < o.items; k++) {
            const id = `call_${o.seed}_${++call}`;
            const thought = r.prose(r.int(300, o.heavy ? 6000 : 2000));
            const command = r.pick(["npm test", "ls -la src", "rg -n parse src", "cat src/index.ts"]);
            s.push({ role: "assistant", provider: "mock", model: "mock-opus", stopReason: "tool_use", content: [{ type: "thinking", text: thought }, { type: "text", text: r.prose(r.int(40, 400)) }, { type: "tool_call", id, name: "bash", input: { command } }] } as Message);
            const output = o.heavy ? "output line of a build that ran for a while\n".repeat(700) : "output line of a build\n".repeat(r.int(5, 300));
            // Heavy: a screenshot now and then, kept inline in the history as the app keeps one.
            const images = o.heavy && r.next() < 0.15 ? [{ type: "image" as const, mediaType: "image/png", data: SCREENSHOT }] : undefined;
            s.push({ role: "user", content: [{ type: "tool_result", toolCallId: id, toolName: "bash", content: output, ...(images ? { images } : {}) }], meta: { kind: "tool_results" } } as UserMessage);
            items += 4;
            context += thought.length + output.length;
        }
        const reply = r.prose(r.int(200, 2000));
        s.push({ role: "assistant", provider: "mock", model: "mock-opus", stopReason: "end_turn", content: [{ type: "text", text: reply }] } as Message);
        items++;
        turns++;
        context += reply.length;
    }
    return { id: s.meta.id, file: s.path, turns, items };
}

export function writeThread(o: ThreadOptions): Thread {
    const full = { kind: "cli" as const, heavy: false, seed: 1, ...o };
    const t = full.kind === "cli" ? cliThread(full) : nativeThread(full);
    const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
    return { ...t, bytes: size(t.file), uiBytes: size(t.file.replace(/([^/]+)\.jsonl$/, "ui/$1.jsonl")) };
}

if (import.meta.main) {
    const [cwd, items, kind, heavy] = process.argv.slice(2);
    if (!cwd || !items) throw new Error("usage: perf-thread.ts <project folder> <items> [cli|native] [heavy]");
    if (!process.env.CAVVY_HOME) throw new Error("Set CAVVY_HOME: the session goes where the app keeps its sessions.");
    const t = writeThread({ cwd, items: Number(items), kind: kind === "native" ? "native" : "cli", heavy: heavy === "heavy" });
    console.log(JSON.stringify(t));
}
