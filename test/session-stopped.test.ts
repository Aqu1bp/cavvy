// A session whose last turn didn't finish (stopped, or cut off when Cavvy quit or died while it worked) is listed as
// stopped, not done: the sidebar says "Stopped" where it would say "Done" (gui/src/components/Sidebar.tsx RowEnd).
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Session, listAllSessions } = await import("../src/agent/session");
const { sessionStatus } = await import("../gui/src/lib/session-status");
afterAll(() => iso.cleanup());

const prompt = (text: string) => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt", display: text } }) as never;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as never;
const calling = { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "c1", name: "Read", arguments: { path: "a" } }] } as never;
const results = { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", content: "x" }], meta: { kind: "tool_results" } } as never;
// As a stop writes them (agent.ts interrupted, runtime.ts for a cut-off turn).
const interrupt = { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }], meta: { kind: "interrupt" } } as never;
const toolInterrupt = { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", content: "Interrupted by user", isError: true }, { type: "text", text: "[Request interrupted by user for tool use]" }], meta: { kind: "tool_results" } } as never;

const cwd = realpathSync(tempDir());
const listed = (id: string) => listAllSessions(200).find((s) => s.id === id);
function session(...messages: never[]) {
    const s = Session.create(cwd);
    for (const m of messages) s.push(m);
    return s;
}

test("a reply ends it: done", () => {
    expect(listed(session(prompt("hi"), reply("Hello.")).meta.id)?.stopped).toBeUndefined();
    expect(listed(session(prompt("hi"), calling, results, reply("Read it.")).meta.id)?.stopped).toBeUndefined();
});

test("a note Cavvy adds after the reply (stopped background tasks, messages to send again) leaves it as the reply did", () => {
    const note = (o: Record<string, unknown> = {}) => ({ role: "user", content: [{ type: "text", text: "<system-reminder>Cavvy stopped these background tasks: x</system-reminder>" }], meta: { kind: "reminder", ...o } }) as never;
    expect(listed(session(prompt("hi"), reply("Done."), note()).meta.id)?.stopped).toBeUndefined();
    expect(listed(session(prompt("hi"), reply("Done."), note(), note({ resends: ["a"] })).meta.id)?.stopped).toBeUndefined();
    // After a stop, still stopped.
    expect(listed(session(prompt("hi"), interrupt, note()).meta.id)?.stopped).toBe(true);
});

test("stopped, before or during its tools: stopped", () => {
    expect(listed(session(prompt("hi"), interrupt).meta.id)?.stopped).toBe(true);
    expect(listed(session(prompt("hi"), calling, toolInterrupt).meta.id)?.stopped).toBe(true);
});

test("cut off (the server died mid-turn, nothing written after): stopped", () => {
    // Before a reply.
    expect(listed(session(prompt("hangforever")).meta.id)?.stopped).toBe(true);
    // Tools called, none answered.
    expect(listed(session(prompt("hi"), calling).meta.id)?.stopped).toBe(true);
    // Tools answered, the next reply never came.
    expect(listed(session(prompt("hi"), reply("Sure."), prompt("more"), calling, results).meta.id)?.stopped).toBe(true);
});

test("a later turn that finished: done again; and a session read again from where it was, as it grows", () => {
    const s = session(prompt("hi"), interrupt);
    expect(listed(s.meta.id)?.stopped).toBe(true);
    s.push(prompt("go on"));
    s.push(reply("Done it."));
    expect(listed(s.meta.id)?.stopped).toBeUndefined();
    // Written by another program, long lines and all: the tool call is found wherever it falls.
    const long = { role: "assistant", content: [{ type: "text", text: "x".repeat(600_000) }, { type: "tool_call", id: "c2", name: "Read", arguments: { path: "b" } }] };
    appendFileSync(s.path, JSON.stringify({ t: "msg", m: prompt("again") }) + "\n" + JSON.stringify({ t: "msg", m: long }) + "\n");
    expect(listed(s.meta.id)?.stopped).toBe(true);
});

test("rewound past it: not known, so not said", () => {
    const s = session(prompt("hi"), reply("Hello."), prompt("again"));
    expect(listed(s.meta.id)?.stopped).toBe(true);
    appendFileSync(s.path, JSON.stringify({ t: "rewind", count: 2 }) + "\n");
    expect(listed(s.meta.id)?.stopped).toBeUndefined();
});

test("the sidebar's word for it", () => {
    const base = { id: "x", cwd, projectName: "p", title: "t", createdAt: 0, updatedAt: 0, messages: 3, status: "idle", pinned: false, archived: false, settled: false, live: false } as const;
    expect(sessionStatus(base, 0)?.text).toBe("Done");
    expect(sessionStatus({ ...base, stopped: true }, 0)?.text).toBe("Stopped");
});

test("a head kept before this was looked for (an older Cavvy's cache): found from the file's end", () => {
    const { statSync, mkdirSync, writeFileSync, openSync, readSync, closeSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    // In a server of its own: this one has the heads in memory already.
    const quit = session(prompt("hangforever"), interrupt);
    const died = session(prompt("hangforever"));
    const fine = session(prompt("hi"), reply("Hello."));
    // What the last turn's end leaves after the message (Session.worked).
    for (const s of [quit, died, fine]) appendFileSync(s.path, JSON.stringify({ t: "worked", at: Date.now() }) + "\n");
    const heads: Record<string, unknown> = {};
    for (const s of [quit, died, fine]) {
        const st = statSync(s.path);
        const fd = openSync(s.path, "r");
        const tail = Buffer.alloc(64);
        readSync(fd, tail, 0, 64, st.size - 64);
        closeSync(fd);
        heads[s.path] = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, scanned: st.size, tail: tail.toString("base64"), head: { cwd, first: "x", firstAt: 0, count: 42 } };
    }
    mkdirSync(join(iso.home, "cache"), { recursive: true });
    writeFileSync(join(iso.home, "cache", "session-heads.json"), JSON.stringify({ version: 1, heads }));
    const script = `const { listAllSessions } = await import(${JSON.stringify(require.resolve("../src/agent/session"))}); console.log(JSON.stringify(Object.fromEntries(listAllSessions(200).map((s) => [s.id, [s.stopped ?? false, s.messages]]))));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, CAVVY_HOME: iso.home } });
    const out = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, [boolean, number]>;
    // The kept heads were used (their count), and how each turn ended was found.
    expect([out[quit.meta.id], out[died.meta.id], out[fine.meta.id]]).toEqual([[true, 42], [true, 42], [false, 42]]);
});
