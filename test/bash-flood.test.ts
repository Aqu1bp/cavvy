// #298: a command that floods its output (`yes`) must not starve the server or balloon its memory.
// The tests count what happens while a flood is read (timer turns, bytes per turn, a blocked writer),
// not how long it takes.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { BackgroundShell, ToolContext, ToolState } from "../src/tools/types";

const iso = isolate();
const { SecretStore } = await import("../src/agent/secrets");
const { BashTool, BashOutputTool, KillShellTool, killAllShells, appendOutput, spawnPaced, spareFifoCount } = await import("../src/tools/bash");
const { MonitorTool } = await import("../src/tools/monitor");
const { WakeQueue } = await import("../src/agent/wakes");
const { redact, redactPrefix, registerSecret, unregisterSecret } = await import("../src/util/redact");

const dirs: string[] = [];
const states: ToolState[] = [];
afterAll(async () => {
    for (const state of states) await killAllShells({ state });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    iso.cleanup();
});

// Not secret-output's value: a secret is registered process-wide under the first name it's set with, and files share the process.
const VALUE = "pZ3kT7vB1xL9wD5G";
function noFragments(text: string, value = VALUE) {
    for (let i = 0; i <= value.length - 6; i++) expect(text).not.toContain(value.slice(i, i + 6));
}
function setup(settings: Record<string, unknown> = {}) {
    const dir = realpathSync(tempDir("cavvy-flood-"));
    dirs.push(dir);
    const secrets = new SecretStore();
    secrets.set("FLOOD_TOKEN", VALUE);
    const state: ToolState = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), secrets };
    states.push(state);
    const ctx = { state, settings, signal: new AbortController().signal, mode: () => "default", setMode() {}, ui: {} } as ToolContext;
    return { dir, ctx, state };
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function script(dir: string, body: string) {
    const file = join(dir, `emit-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(file, `const fs = require('fs');\nconst token = process.env.FLOOD_TOKEN;\nconst pause = () => new Promise(r => setTimeout(r, 150));\nconst write = (s, stream = process.stdout) => new Promise(r => stream.write(s, r));\n(async () => { ${body} })().catch(e => { console.error(e); process.exitCode = 1; });`);
    return `${quote(process.execPath)} --no-env-file ${quote(file)}`;
}
async function background(ctx: ToolContext, command: string) {
    const r = await BashTool.run({ command, run_in_background: true }, ctx);
    const id = /\b(bash_\d+)\b/.exec(r.content)![1]!;
    return { id, shell: ctx.state.shells.get(id)! };
}

/** Timer turns the server gets while `work` runs: a starved event loop gets none until it's over. */
async function turnsDuring<T>(work: () => Promise<T>): Promise<{ turns: number; result: T }> {
    let turns = 0;
    const timer = setInterval(() => turns++, 5);
    try {
        const result = await work();
        return { turns, result };
    } finally {
        clearInterval(timer);
    }
}
async function exited(sh: BackgroundShell) {
    for (let i = 0; i < 12_000 && sh.exitCode === null; i++) await Bun.sleep(5);
    expect(sh.exitCode).not.toBeNull();
}
const fds = () => readdirSync("/dev/fd").length;
/** Descriptors open apart from the spare FIFOs made ahead (two each), which come and go with other commands. */
const ownFds = () => fds() - 2 * spareFifoCount();
/** A BashOutput's lines, but for the partial ones its head and tail are cut to around an omission notice. */
function wholeLines(content: string): string[] {
    const body = /<output>\n([\s\S]*?)\n<\/output>/.exec(content)![1]!;
    const parts = body.split(/\n\n… \[[^\]]* omitted\] …\n\n/);
    if (parts.length === 1) return body.split("\n");
    return [...parts[0]!.split("\n").slice(0, -1), ...parts[1]!.split("\n").slice(1)];
}

describe("a background flood", () => {
    test("leaves the server its turns, and BashOutput (filtered or not) answers while it runs", async () => {
        const { ctx } = setup();
        // Two lines per `yes` round, 23 characters, cut at a whole round.
        const { id, shell } = await background(ctx, "yes 'GET /a 200\nPOST /b 500' | head -c 19999995; echo FINAL_MARKER");
        const reads: string[] = [];
        const { turns } = await turnsDuring(async () => {
            for (let i = 0; i < 4 && shell.exitCode === null; i++) {
                await Bun.sleep(20);
                reads.push((await BashOutputTool.run({ bash_id: id, ...(i % 2 ? { filter: "POST" } : {}) }, ctx)).content);
            }
            await exited(shell);
        });
        // Old: Bun's pipe read kept the event loop for the whole flood, so no timer ran until it ended.
        expect(turns).toBeGreaterThanOrEqual(5);
        expect(reads.length).toBeGreaterThan(0);
        for (const r of reads) expect(r).toContain("POST /b 500");
        // Filtered reads keep only matching lines.
        for (const r of reads.filter((_, i) => i % 2)) for (const line of wholeLines(r)) expect(line).toBe("POST /b 500");
        for (const r of reads.filter((_, i) => !(i % 2))) expect(r).toContain("GET /a 200\nPOST /b 500\n");
        const last = (await BashOutputTool.run({ bash_id: id }, ctx)).content;
        expect(last).toContain("FINAL_MARKER");
        expect(last).toContain("exited with code 0");
        // The ring holds the last BG_BUFFER characters, evicted at line boundaries.
        expect(shell.output.length).toBeLessThanOrEqual(1_000_000);
        expect(shell.output.endsWith("FINAL_MARKER\n")).toBe(true);
        expect(shell.output.split("\n").slice(0, -2).every((l) => l === "GET /a 200" || l === "POST /b 500")).toBe(true);
    }, 60_000);

    test("stdout and stderr flooding together come out as written, the end last", async () => {
        const { ctx } = setup();
        // Both streams share one pipe, as \`2>&1\` in a terminal: the kernel keeps the order they were written in
        // (two processes writing big blocks at once can meet mid-line, as they would there).
        const { id, shell } = await background(ctx, "(yes OUT_LINE | head -c 3999996) & (yes ERR_LINE | head -c 3999996 >&2); wait; echo FINAL_MARKER");
        const { turns } = await turnsDuring(() => exited(shell));
        expect(turns).toBeGreaterThanOrEqual(5);
        const out = (await BashOutputTool.run({ bash_id: id }, ctx)).content;
        expect(wholeLines(out).at(-1)).toBe("FINAL_MARKER");
        const saved = readFileSync(/(?:Full|Saved) output: (.+)/.exec(out)![1]!, "utf8");
        expect(saved).toContain("OUT_LINE\nOUT_LINE\n");
        expect(saved).toContain("ERR_LINE\nERR_LINE\n");
        expect(shell.output.endsWith("\nFINAL_MARKER\n")).toBe(true);
    }, 60_000);

    test("a huge line with no newline keeps its real ends while the server keeps its turns", async () => {
        const { ctx } = setup();
        const { id, shell } = await background(ctx, "printf START; head -c 20000000 /dev/zero | tr '\\0' x; printf END_MARKER");
        const { turns } = await turnsDuring(() => exited(shell));
        expect(turns).toBeGreaterThanOrEqual(5);
        const out = (await BashOutputTool.run({ bash_id: id }, ctx)).content;
        expect(out).toContain("STARTxxxx");
        expect(out).toContain("xxxxEND_MARKER");
        expect(out).toContain("exact character count unavailable for an oversized line");
        const path = /Saved output: (.+)/.exec(out)![1]!;
        expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(8 * 1024 * 1024);
    }, 60_000);

    test("a secret split across reads during a flood is never stored or shown in parts", async () => {
        const { ctx, dir } = setup();
        // Filler first, so the paced reader is mid-flood; the token's halves arrive in separate reads, one of them
        // across a 64 KiB boundary.
        const filler = `('f'.repeat(99) + '\\n').repeat(20000)`;
        const command = script(dir, `await write(${filler}); await write('key=' + token.slice(0, 8)); await pause(); await write(token.slice(8) + '\\n'); await write('x'.repeat(65536 - 7) + token + '\\n' + ${filler}); await write('END_MARKER\\n');`);
        const { id, shell } = await background(ctx, command);
        await exited(shell);
        const out = (await BashOutputTool.run({ bash_id: id }, ctx)).content;
        noFragments(out);
        noFragments(shell.output);
        const path = /(?:Full|Saved) output: (.+)/.exec(out)![1]!;
        const saved = readFileSync(path, "utf8");
        noFragments(saved);
        expect(saved).toContain("key=[REDACTED FLOOD_TOKEN]\n");
        expect(saved).toContain("x".repeat(100) + "[REDACTED FLOOD_TOKEN]\n");
        expect(out).toContain("END_MARKER");
    }, 60_000);

    test("killed mid-flood: it stops, and its pipes are closed", async () => {
        const { ctx } = setup();
        // Spare FIFOs are made ahead (two pairs): count from where they're made.
        for (let i = 0; i < 3; i++) await BashTool.run({ command: "true" }, ctx);
        await Bun.sleep(200);
        const before = ownFds();
        const tag = `FLOOD${process.pid}${Date.now()}`;
        const { id, shell } = await background(ctx, `yes ${tag}`);
        const { turns } = await turnsDuring(async () => {
            for (let i = 0; i < 2000 && shell.output.length < 500_000; i++) await Bun.sleep(5);
        });
        expect(turns).toBeGreaterThanOrEqual(5);
        expect(shell.output).toContain(tag);
        const killed = await KillShellTool.run({ shell_id: id }, ctx);
        expect(killed.content).toMatch(/Killed bash_\d+/);
        expect(shell.exitCode).not.toBeNull();
        expect(Bun.spawnSync(["pgrep", "-f", `yes ${tag}`]).stdout.toString().trim()).toBe("");
        await Bun.sleep(200);
        expect(ownFds()).toBeLessThanOrEqual(before);
    }, 60_000);

    test("the spare FIFOs top up to how many are kept, whatever ran before", async () => {
        const { ctx } = setup();
        for (let i = 0; i < 6; i++) {
            await BashTool.run({ command: "true" }, ctx);
            await Bun.sleep(100);
            expect(spareFifoCount()).toBeLessThanOrEqual(4);
        }
        expect(spareFifoCount()).toBe(4);
    }, 60_000);
});

describe("a foreground flood", () => {
    test("leaves the server its turns, with the head, the real tail and the exact omission", async () => {
        const { ctx } = setup();
        const { turns, result } = await turnsDuring(() => BashTool.run({ command: "yes | head -c 20000000" }, ctx));
        expect(turns).toBeGreaterThanOrEqual(5);
        expect(result.content.startsWith("y\ny\ny\n")).toBe(true);
        // 10,000,000 "y" lines; the result shows 30,000 characters of the 19,999,999 without the last newline.
        expect(result.content).toContain(`${20_000_000 - 1 - 30_000} characters omitted`);
        expect(result.content).toContain("Output saving stopped at the 8 MiB file limit");
    }, 60_000);

    test("carriage-return progress in a flood collapses to each line's last frame, with an exact count", async () => {
        const { ctx, dir } = setup();
        const command = script(dir, `for (let i = 0; i < 20; i++) await write('50%\\r100%\\n'.repeat(10000));`);
        const result = await BashTool.run({ command }, ctx);
        expect(result.content).not.toContain("50%");
        expect(result.content.startsWith("100%\n100%\n")).toBe(true);
        expect(result.content).toContain(`${200_000 * 5 - 1 - 30_000} characters omitted`);
    }, 60_000);
});

describe("stdout and stderr keep the order they were written in", () => {
    // Old (#342's first version): two FIFOs read at the same moments put whatever both said within a poll stdout-first.
    const cases: [string, string, (string | RegExp)[]][] = [
        ["errors between steps", "ls /nope-a; echo '--- step 2'; ls /nope-b; echo '--- step 3'; echo ok", [/nope-a/, "--- step 2", /nope-b/, "--- step 3", "ok"]],
        ["a shell trace", "set -x; echo a; ls /nonexistent; echo b; true; echo c", [/echo a$/, "a", /ls \/nonexistent$/, /\/nonexistent/, /echo b$/, "b", /true$/, /echo c$/, "c"]],
        ["a make-like loop", 'for i in 1 2 3 4 5; do echo "cc -c f$i.c"; sleep 0.0$i; echo "f$i.c: error" >&2; done', [1, 2, 3, 4, 5].flatMap((i) => [`cc -c f${i}.c`, `f${i}.c: error`])],
    ];
    for (const [name, command, expected] of cases)
        for (const bg of [false, true]) {
            test(`${name}, ${bg ? "background" : "foreground"}`, async () => {
                const { ctx } = setup();
                let content: string;
                if (bg) {
                    const { id, shell } = await background(ctx, command);
                    await exited(shell);
                    content = /<output>\n([\s\S]*?)\n<\/output>/.exec((await BashOutputTool.run({ bash_id: id }, ctx)).content)![1]!;
                } else content = (await BashTool.run({ command }, ctx)).content;
                // The foreground script's own lines after the command can show in a trace too.
                const lines = content.split("\n").slice(0, expected.length);
                expect(lines.length).toBe(expected.length);
                lines.forEach((line, i) => {
                    const want = expected[i]!;
                    if (typeof want === "string") expect(line).toBe(want);
                    else expect(line).toMatch(want);
                });
            }, 30_000);
        }
});

describe("a monitor", () => {
    test("flooding stderr (no events, so no flood guard) leaves the server its turns", async () => {
        const { ctx, state } = setup();
        const wakes = new WakeQueue();
        state.wakes = wakes;
        state.watchers = new Map();
        ctx.wakes = wakes;
        // A monitor's stdout and stderr are separate pipes (only stdout lines are events): after a pause, the order is sure.
        const r = await MonitorTool.run({ command: "(yes ERR_LINE | head -c 19999998) >&2; sleep 1; echo DONE_EVENT", description: "flood" }, ctx);
        const id = /\b(monitor_\d+)\b/.exec(r.content)![1]!;
        const shell = state.shells.get(id)!;
        const { turns } = await turnsDuring(() => exited(shell));
        expect(turns).toBeGreaterThanOrEqual(5);
        expect(wakes.pending().map((w) => w.text).join("\n")).toContain("DONE_EVENT");
        expect(shell.output.length).toBeLessThanOrEqual(1_000_000);
        expect(shell.output.endsWith("DONE_EVENT\n")).toBe(true);
    }, 60_000);
});

describe("paced pipes", () => {
    test("a flood is read at most a chunk per event-loop turn", async () => {
        let turn = 0;
        let spinning = true;
        const spin = () => {
            turn++;
            if (spinning) setImmediate(spin);
        };
        setImmediate(spin);
        const p = spawnPaced("/bin/sh", ["-c", "yes 'GET /api/v1/items?page=12 200' | head -c 5000000"], { detached: true });
        const perTurn = new Map<number, number>();
        let total = 0;
        p.stdout.on("data", (b: Buffer) => {
            perTurn.set(turn, (perTurn.get(turn) ?? 0) + b.length);
            total += b.length;
        });
        p.stderr.resume();
        await new Promise((r) => p.onClose(r));
        spinning = false;
        expect(total).toBe(5_000_000);
        expect(Math.max(...perTurn.values())).toBeLessThanOrEqual(64 * 1024);
    }, 60_000);

    test("a command waits while its output isn't taken: only the pipe's buffer is held", async () => {
        const dir = realpathSync(tempDir("cavvy-flood-"));
        dirs.push(dir);
        const marker = join(dir, "done");
        const p = spawnPaced("/bin/sh", ["-c", `head -c 4000000 /dev/zero; echo > ${quote(marker)}`], { detached: true });
        let bytes = 0;
        p.stdout.on("data", (b: Buffer) => {
            bytes += b.length;
            p.stdout.pause();
        });
        p.stderr.resume();
        await Bun.sleep(300);
        // Old (Bun's pipe): read on regardless of pause, into memory, and the command finished.
        expect(existsSync(marker)).toBe(false);
        expect(p.child.exitCode).toBeNull();
        expect(bytes).toBeLessThanOrEqual(64 * 1024);
        p.stdout.removeAllListeners("data");
        p.stdout.on("data", (b: Buffer) => (bytes += b.length));
        p.stdout.resume();
        await new Promise((r) => p.onClose(r));
        expect(bytes).toBe(4_000_000);
        expect(existsSync(marker)).toBe(true);
    }, 60_000);

    test("output written before BashOutput is read by it, without waiting for the next poll", async () => {
        const { ctx, dir } = setup();
        const { id } = await background(ctx, script(dir, `await write('BEFORE_MARKER\\n'); fs.writeFileSync('ready', ''); await new Promise(r => setTimeout(r, 5000));`));
        for (let i = 0; i < 1000 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(5);
        expect((await BashOutputTool.run({ bash_id: id }, ctx)).content).toContain("BEFORE_MARKER");
    }, 30_000);

    /**
     * Runs Bash commands in a process of its own (what mkfifo did is remembered for the process), with `dir`
     * as the whole PATH. Each step: optional shell set-up run first, a clock shift, then a command that says
     * whether its stdout and stderr share one pipe (paced) or not (ordinary pipes).
     */
    function pacing(dir: string, steps: { before?: string; later?: number }[]): string[] {
        const probe = join(dir, "probe.ts");
        writeFileSync(probe, `const { BashTool } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/bash"))});
const { execSync } = await import("node:child_process");
const real = Date.now;
let shift = 0;
Date.now = () => real() + shift;
const ctx = { state: { cwd: ${JSON.stringify(dir)}, projectRoot: ${JSON.stringify(dir)}, fileState: new Map(), todos: [], shells: new Map() }, settings: {}, signal: new AbortController().signal };
const out = [];
for (const step of ${JSON.stringify(steps)}) {
    if (step.before) execSync(step.before, { shell: "/bin/sh" });
    shift += step.later ?? 0;
    out.push((await BashTool.run({ command: "test /dev/fd/1 -ef /dev/fd/2 && echo paced || echo pipes" }, ctx)).content);
    await Bun.sleep(100);
}
console.log(out.join(","));`);
        const r = Bun.spawnSync([process.execPath, "--no-env-file", probe], { env: { ...process.env, PATH: dir } });
        return r.stdout.toString().trim().split(",");
    }
    const mkfifo = Bun.which("mkfifo")!;

    test("a failing mkfifo means ordinary pipes for a while, then FIFOs again", async () => {
        const dir = realpathSync(tempDir("cavvy-mkfifo-"));
        dirs.push(dir);
        const log = join(dir, "calls");
        const failing = join(dir, "failing");
        writeFileSync(failing, "");
        // Fails while `failing` exists (no space, say), then works.
        writeFileSync(join(dir, "mkfifo"), `#!/bin/sh\necho x >> ${quote(log)}\n[ -e ${quote(failing)} ] && exit 1\nexec ${quote(mkfifo)} "$@"\n`, { mode: 0o755 });
        const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
        expect(pacing(dir, [{}, {}, {}])).toEqual(["pipes", "pipes", "pipes"]);
        // The first command's attempt (and the spares started with it), then none while it's recent: each costs a process.
        expect(calls()).toBeLessThanOrEqual(2);
        // Old: the first failure turned FIFOs off for good, so a flood could freeze the server again until a restart.
        expect(pacing(dir, [{}, { before: `/bin/rm ${quote(failing)}`, later: 10_000 }, { later: 25_000 }, {}])).toEqual(["pipes", "pipes", "paced", "paced"]);
    }, 30_000);

    test("a missing mkfifo means ordinary pipes for good, and output still comes through", async () => {
        const dir = realpathSync(tempDir("cavvy-no-mkfifo-"));
        dirs.push(dir);
        // mkfifo turns up later: still not tried again.
        expect(pacing(dir, [{}, { before: `/bin/ln -s ${quote(mkfifo)} ${quote(join(dir, "mkfifo"))}`, later: 60_000 }, {}])).toEqual(["pipes", "pipes", "pipes"]);
    }, 30_000);

    test("with pacedOutput off, output comes through ordinary pipes", async () => {
        const off = setup({ pacedOutput: false });
        expect((await BashTool.run({ command: "printf 'one\\ntwo\\n'" }, off.ctx)).content).toBe("one\ntwo");
        const { id, shell } = await background(off.ctx, "printf 'bg one\\n'");
        await exited(shell);
        expect((await BashOutputTool.run({ bash_id: id }, off.ctx)).content).toContain("bg one");
    }, 30_000);
});

describe("the output ring", () => {
    // What appendOutput did before #298: the same text and offsets, from one string copied on every append.
    function reference(shell: { output: string; readOffset: number }, text: string) {
        shell.output += text;
        if (shell.output.length > 1_000_000) {
            let drop = shell.output.length - 1_000_000;
            const nl = shell.output.indexOf("\n", drop);
            if (nl !== -1 && nl - drop < 64 * 1024) drop = nl + 1;
            shell.output = shell.output.slice(drop);
            shell.readOffset = Math.max(0, shell.readOffset - drop);
        }
    }

    test("keeps the same text and read offset as one string did, evicting whole lines", () => {
        let seed = 298;
        const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
        const ring = { output: "", readOffset: 0 } as BackgroundShell;
        const plain = { output: "", readOffset: 0 };
        for (let i = 0; i < 400; i++) {
            const kind = random(10);
            // Short lines, long lines, lines longer than the eviction search, and text with no newline at all.
            const length = kind < 6 ? random(200) : kind < 8 ? random(30_000) : random(150_000);
            const text = "abcdefghij".repeat(Math.ceil(length / 10)).slice(0, length) + (kind === 9 ? "" : "\n");
            appendOutput(ring, text);
            reference(plain, text);
            if (random(4) === 0) ring.readOffset = plain.readOffset = random(ring.output.length + 1);
            expect(ring.output.length).toBe(plain.output.length);
            expect(ring.readOffset).toBe(plain.readOffset);
            if (i % 20 === 0) expect(ring.output).toBe(plain.output);
        }
        expect(ring.output).toBe(plain.output);
    });

    test("appending doesn't copy what it keeps: the whole text is touched only when it's read", () => {
        let reads = 0;
        let writes = 0;
        let value = "";
        const shell = {
            get output() {
                reads++;
                return value;
            },
            set output(v: string) {
                writes++;
                value = v;
            },
            readOffset: 0,
        } as BackgroundShell;
        const line = "GET /api/v1/items?page=12 200 3.2ms user=42 trace=9f8e7d6c5b4a3f2e1d0c\n";
        for (let i = 0; i < 20_000; i++) appendOutput(shell, line);
        // Old: `shell.output += text` read and rewrote the whole string for every line.
        expect(reads + writes).toBeLessThanOrEqual(1);
        expect(shell.output.length).toBeLessThanOrEqual(1_000_000);
        expect(shell.output.endsWith(line)).toBe(true);
    });
});

test("redaction reuses its matchers without carrying a position from one text to the next", () => {
    const key = "sk-ant-api03-" + "A".repeat(40);
    // redactPrefix stops partway, leaving a matcher mid-text; the next text must still be matched from its start.
    expect(redactPrefix(`${key} ${key} ${key}`, 10)).toBe("[REDACTED anthropic-key]");
    expect(redact(`${key}`)).toBe("[REDACTED anthropic-key]");
    registerSecret("qQ9wW8eE7rR6tT5y", "flood-test");
    try {
        expect(redact("a qQ9wW8eE7rR6tT5y b sk-or-v1-" + "b".repeat(40))).toBe("a [REDACTED flood-test] b [REDACTED openrouter-key]");
    } finally {
        unregisterSecret("qQ9wW8eE7rR6tT5y");
    }
});
