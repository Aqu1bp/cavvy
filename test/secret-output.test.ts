import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { isolate, tempDir } from "./helpers/isolate";
import type { ToolContext, ToolState } from "../src/tools/types";

const iso = isolate();
const { SecretStore } = await import("../src/agent/secrets");
const { BashTool, BashOutputTool, KillShellTool, killAllShells } = await import("../src/tools/bash");
const { ReadTool } = await import("../src/tools/file-tools");
const { GrepTool } = await import("../src/tools/search-tools");
const dirs: string[] = [];
const states: ToolState[] = [];
afterAll(async () => {
    for (const state of states) await killAllShells({ state });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    iso.cleanup();
});

// Random-looking fake values: checking only the whole value misses split leaks.
const VALUE = "hN8sR4uY2cF7jM9Q";
function noFragments(text: string, value = VALUE) {
    for (let i = 0; i <= value.length - 6; i++) expect(text).not.toContain(value.slice(i, i + 6));
}
function setup(value = VALUE) {
    const dir = realpathSync(tempDir("cavvy-output-"));
    dirs.push(dir);
    const secrets = new SecretStore();
    secrets.set("OUTPUT_TOKEN", value);
    const state: ToolState = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), secrets };
    states.push(state);
    const progress: string[] = [];
    const ctx = { state, settings: {}, signal: new AbortController().signal, mode: () => "default", setMode() {}, ui: {}, onProgress: (s: string) => progress.push(s) } as ToolContext;
    return { dir, ctx, progress };
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function script(dir: string, body: string) {
    const file = join(dir, "emit.cjs");
    writeFileSync(file, `const fs = require('fs');\nconst token = process.env.OUTPUT_TOKEN;\nconst pause = () => new Promise(r => setTimeout(r, 150));\nconst write = (s, stream = process.stdout) => new Promise(r => stream.write(s, r));\n(async () => { ${body} })().catch(e => { console.error(e); process.exitCode = 1; });`);
    return `${quote(process.execPath)} --no-env-file ${quote(file)}`;
}
async function finished(ctx: ToolContext, id: string) {
    const sh = ctx.state.shells.get(id)!;
    for (let i = 0; i < 500 && sh.exitCode === null; i++) await Bun.sleep(10);
    expect(sh.exitCode).toBe(0);
    return BashOutputTool.run({ bash_id: id }, ctx);
}
async function background(ctx: ToolContext, command: string) {
    const r = await BashTool.run({ command, run_in_background: true }, ctx);
    return /\b(bash_\d+)\b/.exec(r.content)![1]!;
}

test("redact a trailing-space secret before cleaning foreground and background output", async () => {
    const value = VALUE + " ";
    const { ctx, progress } = setup(value);
    const command = 'printf %s "$OUTPUT_TOKEN"';
    const fg = await BashTool.run({ command }, ctx);
    const bg = await finished(ctx, await background(ctx, command));
    for (const out of [fg, bg]) {
        noFragments(JSON.stringify(out), value);
        expect(out.content).toContain("[REDACTED OUTPUT_TOKEN]");
    }
    noFragments(progress.join(""), value);
});

test("foreground cap previews an oversized line without splitting a complete secret", async () => {
    const { ctx, dir, progress } = setup();
    // The old 8192-character cut lands six characters into a complete secret.
    const command = script(dir, `await write('a'.repeat(591803) + token + 'b'.repeat(599990 - 591803 - token.length)); await pause(); await write('b'.repeat(11)); await pause(); await write('end\\n');`);
    const out = await BashTool.run({ command }, ctx);
    noFragments(JSON.stringify(out));
    noFragments(progress.join(""));
    expect(out.content).toContain("characters omitted");
});

test("foreground cap cannot expose an unfinished outer secret after an inner match expands", async () => {
    const inner = "vR8kD2mN";
    const value = "qP7tL4sW9xF" + inner + "uA6jH2rK8";
    const { ctx, dir, progress } = setup(value);
    ctx.state.secrets!.set("A".repeat(58) + "_TOKEN", inner);
    const command = script(dir, `await write('a'.repeat(600001 - token.length + 1) + token.slice(0, -1)); await pause(); await write(token.slice(-1) + '\\n');`);
    const out = await BashTool.run({ command }, ctx);
    noFragments(JSON.stringify(out), value);
    noFragments(progress.join(""), value);
});

test("newline-heavy output is scanned linearly, including an absent CR delimiter", async () => {
    const { ctx, dir } = setup();
    const bytes = 16 * 1024;
    const command = script(dir, `await write('y\\n'.repeat(${bytes / 2}));`);
    const original = String.prototype.indexOf;
    let scanned = 0;
    const probe = spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search: string, from = 0) {
        const at = original.call(this, search, from);
        if ((search === "\r" || search === "\n") && this.length > 1024 && (this[0] === "y" || this[0] === "\n")) {
            scanned += (at < 0 ? this.length : at + 1) - from;
        }
        return at;
    });
    try {
        const out = await BashTool.run({ command }, ctx);
        expect(out.isError).toBeFalsy();
        expect(out.content).toContain("y\ny");
        // Counts the ranges searched, so slow CI and fast native string search cannot hide quadratic work.
        expect(scanned).toBeGreaterThan(bytes / 2);
        expect(scanned).toBeLessThanOrEqual(bytes * 3);
    } finally {
        probe.mockRestore();
    }
});

test("background buffer never exposes a secret split by front eviction", async () => {
    const { ctx, dir } = setup();
    // Every line fits the streaming limit; their total exceeds the ring's 1,000,000-character bound.
    const command = script(dir, `await write('evicted-start\\n'); for (let i = 0; i < 144; i++) await write('f'.repeat(8191) + '\\n'); await write('kept: ' + token + '\\n');`);
    const id = await background(ctx, command);
    const out = await finished(ctx, id);
    const sh = ctx.state.shells.get(id)!;
    expect(sh.output.length).toBeGreaterThan(900_000);
    expect(sh.output.length).toBeLessThanOrEqual(1_000_000);
    expect(sh.output).not.toContain("evicted-start");
    expect(sh.output).not.toContain("Output line omitted");
    // The ring must only hold redacted text BEFORE eviction can take a slice from it.
    noFragments(sh.output);
    expect(sh.output).toContain("kept: [REDACTED OUTPUT_TOKEN]");
    noFragments(JSON.stringify(out));
    expect(out.content).toContain("kept: [REDACTED OUTPUT_TOKEN]");
});

test("BashOutput drops an overlong unfinished line instead of releasing secret fragments", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write('a'.repeat(66000) + token.slice(0, 8)); fs.writeFileSync('ready', ''); while (!fs.existsSync('continue')) await pause(); await write(token.slice(8) + '\\nafter\\n');`);
    const id = await background(ctx, command);
    for (let i = 0; i < 500 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(10);
    expect(existsSync(join(dir, "ready"))).toBe(true);
    await Bun.sleep(30);
    const early = await BashOutputTool.run({ bash_id: id }, ctx);
    writeFileSync(join(dir, "continue"), "");
    const late = await finished(ctx, id);
    noFragments(JSON.stringify(early));
    noFragments(JSON.stringify(late));
    expect(late.content).toContain("after");
});

for (const stream of ["stdout", "stderr"]) {
    test(`UTF-8 decoding survives a split code point on ${stream}, foreground and background`, async () => {
        const value = "mK4tR8vWé9sJ2nF7Q";
        const { ctx, dir, progress } = setup(value);
        const command = script(dir, `const bytes = Buffer.from(token); await write(bytes.subarray(0, 9), process.${stream}); await pause(); await write(Buffer.concat([bytes.subarray(9), Buffer.from('\\n')]), process.${stream});`);
        const fg = await BashTool.run({ command }, ctx);
        const bg = await finished(ctx, await background(ctx, command));
        for (const out of [fg, bg]) {
            noFragments(JSON.stringify(out), value);
            expect(out.content).toContain("[REDACTED OUTPUT_TOKEN]");
            expect(out.content).not.toContain("�");
        }
        noFragments(progress.join(""), value);
    });
}

test("carriage-return progress is published while the command is still running", async () => {
    const { ctx, dir, progress } = setup();
    const command = script(dir, `await write('step\\r'); fs.writeFileSync('ready', ''); while (!fs.existsSync('continue')) await pause(); await write('done\\n');`);
    const running = BashTool.run({ command }, ctx);
    for (let i = 0; i < 500 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(10);
    await Bun.sleep(30);
    const early = progress.join("");
    writeFileSync(join(dir, "continue"), "");
    const out = await running;
    expect(early).toContain("step");
    expect(out.content).toBe("done");
});

test("a truncated foreground line cannot certify a final search's exit status", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write('a'.repeat(600001) + token + '\\n');`) + "; grep nomatch /dev/null";
    const out = await BashTool.run({ command }, ctx);
    expect(out.content).toContain("characters omitted");
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain("found no matches");
    noFragments(JSON.stringify(out));
});

test("redaction cannot hide the raw output cap from a final search", async () => {
    const value = VALUE.repeat(32);
    const { ctx, dir } = setup(value);
    const command = script(dir, `await write((token + '\\n').repeat(1300));`) + "; grep nomatch /dev/null";
    const out = await BashTool.run({ command }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain("found no matches");
    noFragments(JSON.stringify(out), VALUE);
});

test("a redacted shell diagnostic still prevents a no-match success", async () => {
    const value = "(eval):1: " + VALUE;
    const { ctx } = setup(value);
    const out = await BashTool.run({ command: 'printf "%s\\n" "$OUTPUT_TOKEN" >&2; grep nomatch /dev/null' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain("found no matches");
    noFragments(JSON.stringify(out), value);
});

test("a final search can still report no match after ordinary redacted output", async () => {
    const { ctx } = setup();
    const out = await BashTool.run({ command: 'printf "%s\\n" "$OUTPUT_TOKEN"; grep nomatch /dev/null' }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toContain("found no matches");
    noFragments(JSON.stringify(out));
});

for (const backgroundMode of [false, true]) {
    test(`large ${backgroundMode ? "background" : "foreground"} output preserves head, real tail, exact omission and full file`, async () => {
        const { ctx } = setup();
        const command = "seq 1 200000; printf 'FINAL_ERROR_MARKER\\n'";
        const out = backgroundMode ? await finished(ctx, await background(ctx, command)) : await BashTool.run({ command }, ctx);
        expect(out.content).toContain("1\n2\n3\n");
        expect(out.content).toContain("200000\nFINAL_ERROR_MARKER");
        const full = Array.from({ length: 200000 }, (_, i) => `${i + 1}\n`).join("") + "FINAL_ERROR_MARKER\n";
        expect(out.content).toContain(`${full.trimEnd().length - 30000} characters`);
        const path = /Full output: (.+)/.exec(out.content)?.[1];
        expect(path).toBeDefined();
        expect(readFileSync(path!, "utf8")).toBe(full);
        expect((await ReadTool.run({ file_path: path!, offset: 200000, limit: 2 }, ctx)).content).toContain("FINAL_ERROR_MARKER");
        expect((await GrepTool.run({ path: path!, pattern: "FINAL_ERROR_MARKER", output_mode: "content" }, ctx)).content).toContain("FINAL_ERROR_MARKER");
        if (backgroundMode) {
            const id = [...ctx.state.shells.keys()][0]!;
            expect((await BashOutputTool.run({ bash_id: id }, ctx)).content).toContain("(no new output)");
            await KillShellTool.run({ shell_id: id }, ctx);
            expect(existsSync(path!)).toBe(true);
        }
        await killAllShells({ state: ctx.state });
        expect(existsSync(path!)).toBe(false);
    });
}

test("invalid BashOutput regex preserves unread output for a corrected retry", async () => {
    const { ctx } = setup();
    const id = await background(ctx, "printf 'important result\\n'");
    const sh = ctx.state.shells.get(id)!;
    for (let i = 0; i < 500 && sh.exitCode === null; i++) await Bun.sleep(10);
    const bad = await BashOutputTool.run({ bash_id: id, filter: "[" }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("Invalid filter regex");
    expect(sh.readOffset).toBe(0);
    expect((await BashOutputTool.run({ bash_id: id, filter: "important" }, ctx)).content).toContain("important result");
    expect((await BashOutputTool.run({ bash_id: id }, ctx)).content).toContain("(no new output)");
});

for (const backgroundMode of [false, true]) {
    test(`oversized ${backgroundMode ? "background" : "foreground"} line preserves its real ends and full file`, async () => {
        const { ctx, dir } = setup();
        const command = script(dir, `await write('START' + 'x'.repeat(1200000) + 'FINAL_ERROR');`);
        const out = backgroundMode ? await finished(ctx, await background(ctx, command)) : await BashTool.run({ command }, ctx);
        expect(out.content.includes("START")).toBe(true);
        expect(out.content.includes("FINAL_ERROR")).toBe(true);
        expect(out.content.includes(`${1200000 + 5 + 11 - 30000} characters omitted`)).toBe(true);
        const path = /Full output: (.+)/.exec(out.content)![1]!;
        expect(readFileSync(path, "utf8")).toBe("START" + "x".repeat(1200000) + "FINAL_ERROR");
    });

    test(`pending ${backgroundMode ? "background" : "foreground"} stdout retains its order before final stderr`, async () => {
        const { ctx, dir } = setup();
        const command = script(dir, `await write('START'); await pause(); await write('FINAL\\n', process.stderr);`);
        const out = backgroundMode ? await finished(ctx, await background(ctx, command)) : await BashTool.run({ command }, ctx);
        expect(out.content).toContain("STARTFINAL");
    });
}

test("BashOutput filter searches the entire unread output, including the omitted middle", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write(('x'.repeat(999) + '\\n').repeat(400)); await write('MATCH_IN_MIDDLE\\n'); await write(('y'.repeat(999) + '\\n').repeat(1200));`);
    const id = await background(ctx, command);
    const sh = ctx.state.shells.get(id)!;
    for (let i = 0; i < 1000 && sh.exitCode === null; i++) await Bun.sleep(10);
    expect(sh.exitCode).toBe(0);
    const out = await BashOutputTool.run({ bash_id: id, filter: "MATCH_IN_MIDDLE" }, ctx);
    expect(out.content).toContain("MATCH_IN_MIDDLE");
    expect((await BashOutputTool.run({ bash_id: id }, ctx)).content).toContain("(no new output)");
}, 20000);

test("background spawn failure can be cleaned up before its events arrive", async () => {
    const { ctx, dir } = setup();
    ctx.state.cwd = join(dir, "nonexistent");
    await background(ctx, "true");
    await killAllShells({ state: ctx.state });
    await Bun.sleep(30);
    expect(ctx.state.shells.size).toBe(0);
});

test("saved output remains readable with secrets redacted by Read and Grep", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write(('x'.repeat(999) + '\\n').repeat(800)); await write('secret: ' + token + '\\n');`);
    const out = await BashTool.run({ command }, ctx);
    const path = /Full output: (.+)/.exec(out.content)![1]!;
    const read = await ReadTool.run({ file_path: path, offset: 801, limit: 1 }, ctx);
    const grep = await GrepTool.run({ path, pattern: "secret:", output_mode: "content" }, ctx);
    for (const result of [out, read, grep]) {
        noFragments(JSON.stringify(result));
        expect(result.content).toContain("[REDACTED OUTPUT_TOKEN]");
    }
});

test("invalid BashOutput regex preserves a monitor's in-memory cursor too", async () => {
    const { ctx } = setup();
    ctx.state.shells.set("monitor", { id: "monitor", command: "test", startedAt: Date.now(), output: "important result\n", readOffset: 0, exitCode: 0, kill: async () => "gone" });
    const bad = await BashOutputTool.run({ bash_id: "monitor", filter: "[" }, ctx);
    expect(bad.isError).toBe(true);
    expect((await BashOutputTool.run({ bash_id: "monitor" }, ctx)).content).toContain("important result");
});


test("concurrent BashOutput reads consume each saved snapshot once", async () => {
    const { ctx } = setup();
    const id = await background(ctx, "printf 'one result\\n'");
    const sh = ctx.state.shells.get(id)!;
    for (let i = 0; i < 500 && sh.exitCode === null; i++) await Bun.sleep(10);
    const results = await Promise.all([BashOutputTool.run({ bash_id: id }, ctx), BashOutputTool.run({ bash_id: id }, ctx)]);
    expect(results.filter((r) => r.content.includes("one result"))).toHaveLength(1);
    expect(results.filter((r) => r.content.includes("(no new output)"))).toHaveLength(1);
});


for (const backgroundMode of [false, true]) {
    // stdout and stderr share one pipe, in the order written (#342): a secret split by a write to the other
    // stream would show split, as a terminal shows it. Split across reads of one stream, it stays whole.
    test(`review: saved ${backgroundMode ? "background" : "foreground"} output cannot interleave secret fragments and strips ANSI`, async () => {
        const { ctx, dir } = setup();
        const command = script(dir, `await write(('x'.repeat(999) + '\\n').repeat(40)); await write('\\x1b[31mwarn\\x1b[0m\\n', process.stderr); await pause(); await write('key=' + token.slice(0, 8)); await pause(); await write(token.slice(8) + '\\n');`);
        const out = backgroundMode ? await finished(ctx, await background(ctx, command)) : await BashTool.run({ command }, ctx);
        const path = /Full output: (.+)/.exec(out.content)![1]!;
        const saved = readFileSync(path, "utf8");
        noFragments(saved);
        expect(saved).not.toContain("\x1b");
        expect(saved).toContain("warn\nkey=[REDACTED OUTPUT_TOKEN]\n");
        const read = await ReadTool.run({ file_path: path, offset: 41, limit: 3 }, ctx);
        expect(read.isError).toBeFalsy();
        noFragments(read.content);
        expect(read.content).toContain("[REDACTED OUTPUT_TOKEN]");
    });

    test(`review: ${backgroundMode ? "background" : "foreground"} omission counts use cleaned text`, async () => {
        const { ctx, dir } = setup();
        const command = script(dir, `for (let i = 0; i < 800; i++) await write('old'.repeat(400) + '\\r\\x1b[31m' + 'new'.repeat(400) + '\\x1b[0m\\n');`);
        const out = backgroundMode ? await finished(ctx, await background(ctx, command)) : await BashTool.run({ command }, ctx);
        expect(out.content.includes(`${800 * 1201 - 1 - 30000} characters omitted`)).toBe(true);
        expect(out.content.includes("oldoldold")).toBe(false);
        const path = /Full output: (.+)/.exec(out.content)![1]!;
        expect((await ReadTool.run({ file_path: path, limit: 1 }, ctx)).isError).toBeFalsy();
    });
}

test("review: background output survives an archive write failure", async () => {
    const { ctx, dir } = setup();
    const id = await background(ctx, script(dir, `await write('first\\n' + ('x'.repeat(999) + '\\n').repeat(40)); fs.writeFileSync('ready', ''); while (!fs.existsSync('continue')) await pause(); await write(('x'.repeat(999) + '\\n').repeat(40) + 'IMPORTANT_SECOND\\n');`));
    for (let i = 0; i < 500 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(10);
    const first = await BashOutputTool.run({ bash_id: id }, ctx);
    const path = /Full output: (.+)/.exec(first.content)![1]!;
    rmSync(dirname(path), { recursive: true, force: true });
    writeFileSync(join(dir, "continue"), "");
    const out = await finished(ctx, id);
    expect(out.content).toContain("IMPORTANT_SECOND");
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Could not save complete output");
});

test("review: output storage is capped without losing the model's real tail", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write('HEAD\\n'); for (let i = 0; i < 12000; i++) await write('x'.repeat(1023) + '\\n'); await write('FINAL_ERROR\\n');`);
    const out = await finished(ctx, await background(ctx, command));
    expect(out.content).toContain("HEAD");
    expect(out.content).toContain("FINAL_ERROR");
    expect(out.content).toContain("limit");
    const path = /(?:Full|Saved) output: (.+)/.exec(out.content)![1]!;
    expect(statSync(path).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(readFileSync(path, "utf8").slice(-300)).toContain("limit");
    expect(readdirSync(dirname(path))).toEqual([path.split("/").pop()!]);
}, 20000);

test("review: a sub-agent proxy shares output cleanup with its root map", async () => {
    const { ctx } = setup();
    const root = ctx.state.shells;
    ctx.state.shells = new Proxy(root, { get(target, p) {
        const value = Reflect.get(target, p, target);
        return typeof value === "function" ? value.bind(target) : value;
    } });
    const out = await BashTool.run({ command: "seq 1 10000" }, ctx);
    const path = /Full output: (.+)/.exec(out.content)![1]!;
    await killAllShells({ state: { shells: root } });
    expect(existsSync(path)).toBe(false);
});


test("review: dense colored output is saved as readable text, including split escapes", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write('\\x1b['); await pause(); await write('31m'); await write('x\\x1b[0m\\n'); for (let i = 0; i < 4000; i++) await write('\\x1b[31mhello world\\x1b[0m\\n');`);
    const out = await BashTool.run({ command }, ctx);
    const path = /Full output: (.+)/.exec(out.content)![1]!;
    expect(readFileSync(path, "utf8")).toBe('x\n' + 'hello world\n'.repeat(4000));
    const read = await ReadTool.run({ file_path: path, limit: 2 }, ctx);
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain("hello world");
});

test("review: new sessions clean crashed output owners and preserve live ones in tmpdir", async () => {
    const root = tmpdir();
    mkdirSync(root, { recursive: true });
    const dead = mkdtempSync(join(root, "cavvy-output-2147483647-"));
    const live = mkdtempSync(join(root, `cavvy-output-${process.pid}-`));
    writeFileSync(join(dead, "leftover.txt"), "stale output");
    writeFileSync(join(live, "active.txt"), "active output");
    try {
        const { ctx } = setup();
        const out = await BashTool.run({ command: "seq 1 10000" }, ctx);
        const path = /Full output: (.+)/.exec(out.content)![1]!;
        expect(path.startsWith(root + "/")).toBe(true);
        expect(existsSync(dead)).toBe(false);
        expect(existsSync(live)).toBe(true);
        await killAllShells({ state: ctx.state });
        expect(existsSync(path)).toBe(false);
    } finally {
        rmSync(dead, { recursive: true, force: true });
        rmSync(live, { recursive: true, force: true });
    }
});

test("review: small foreground results do not leave unused output files", async () => {
    const { ctx } = setup();
    const out = await BashTool.run({ command: "seq 1 10000" }, ctx);
    const path = /Full output: (.+)/.exec(out.content)![1]!;
    for (let i = 0; i < 4; i++) await BashTool.run({ command: "echo hi" }, ctx);
    expect(readdirSync(dirname(path))).toEqual([path.split("/").pop()!]);
});


test("review: oversized lines do not mix unsanitized lengths into exact omission counts", async () => {
    const { ctx, dir } = setup();
    // Adjacent matches collapse to one marker; never cut the shortened result by raw offsets.
    ctx.state.secrets!.set("SPACED_OUTPUT_TOKEN", VALUE + " ");
    const command = script(dir, `for (let i = 0; i < 600; i++) await write((token + ' ').repeat(1000)); await write(' FINAL_ERROR\\n');`);
    const out = await BashTool.run({ command }, ctx);
    expect(out.content).toContain("exact character count unavailable for an oversized line");
    expect(out.content).toContain("FINAL_ERROR");
    noFragments(out.content);
    const path = /Saved output: (.+)/.exec(out.content)![1]!;
    const saved = readFileSync(path, "utf8");
    noFragments(saved);
    expect(saved).toContain("exact character count unavailable");
    expect(statSync(path).size).toBeLessThanOrEqual(8 * 1024 * 1024);
}, 20000);

for (const bg of [false, true]) {
    test(`round 2: stray ESC and CSI cannot expose secrets in ${bg ? "background" : "foreground"} output`, async () => {
        const { ctx, dir, progress } = setup();
        const command = script(dir, `await write('\\x1b'); await pause(); await write(token + '\\n\\x1b[' + token + '\\n'); await write(('filler'.repeat(100) + '\\n').repeat(60));`);
        const out = bg ? await finished(ctx, await background(ctx, command)) : await BashTool.run({ command }, ctx);
        noFragments(out.content);
        noFragments(progress.join(""));
        const path = /Full output: (.+)/.exec(out.content)![1]!;
        noFragments(readFileSync(path, "utf8"));
    });
}

test("round 2: oversized raw head and tail redact secrets before stripping escapes", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write('\\x1b' + token + ' '); for (let i = 0; i < 145; i++) await write('x'.repeat(65536)); await write(' \\x1b[' + token + ' FINAL_ERROR\\n');`);
    const out = await BashTool.run({ command }, ctx);
    noFragments(out.content);
    expect(out.content).toContain("FINAL_ERROR");
    noFragments(readFileSync(/Saved output: (.+)/.exec(out.content)![1]!, "utf8"));
});

test("round 2: unterminated terminal strings recover at newline, CAN and SUB across background reads", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write(('filler'.repeat(100) + '\\n').repeat(60) + '\\x1b]oops\\n'); fs.writeFileSync('ready', ''); while (!fs.existsSync('continue')) await pause(); for (const escape of ['\\x1b]', '\\x1bP', '\\x1b[']) for (const end of ['\\n', '\\x18', '\\x1a']) await write(escape + '12;' + end + 'LATER_IMPORTANT ' + token + '\\n');`);
    const id = await background(ctx, command);
    for (let i = 0; i < 500 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(10);
    const first = await BashOutputTool.run({ bash_id: id }, ctx);
    const path = /Full output: (.+)/.exec(first.content)![1]!;
    writeFileSync(join(dir, "continue"), "");
    const out = await finished(ctx, id);
    expect(out.content.match(/LATER_IMPORTANT/g)).toHaveLength(9);
    expect(readFileSync(path, "utf8").match(/LATER_IMPORTANT/g)).toHaveLength(9);
    noFragments(out.content);
});

test("round 2: save failures are notes only for truncated output, with no nonexistent path", async () => {
    const { ctx } = setup();
    const warm = await BashTool.run({ command: "seq 1 10000" }, ctx);
    const path = /Full output: (.+)/.exec(warm.content)![1]!;
    // Removing the owner directory reliably breaks writes, even when tests run as root.
    rmSync(dirname(path), { recursive: true, force: true });
    for (const bg of [false, true]) {
        const small = bg ? await finished(ctx, await background(ctx, "echo hi")) : await BashTool.run({ command: "echo hi" }, ctx);
        expect(small.isError).toBeFalsy();
        expect(small.content).not.toContain("output:");
        expect(small.content).not.toContain("Could not save");
        const large = bg ? await finished(ctx, await background(ctx, "seq 1 10000")) : await BashTool.run({ command: "seq 1 10000" }, ctx);
        expect(large.isError).toBeFalsy();
        expect(large.content).toContain("Could not save complete output");
        expect(large.content).not.toMatch(/(?:Full|Saved) output:/);
        expect(large.content).toContain("10000");
    }
    expect((await BashTool.run({ command: "echo failure; exit 7" }, ctx)).isError).toBe(true);
});

test("round 2: exhausted session quota does not affect small outputs or keep their files", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `for (let i = 0; i < 8300; i++) await write('x'.repeat(1023) + '\\n');`);
    let path = "";
    let last = "";
    // Until the session's quota is used: each run saves just under 8 MiB, how far under depending on how the OS
    // hands the output over (a chunk that would cross the file limit isn't saved), so 8 runs aren't always 64 MiB.
    for (let i = 0; i < 12 && !last.includes("64 MiB session"); i++) {
        const out = await BashTool.run({ command }, ctx);
        path ||= /(?:Full|Saved) output: (.+)/.exec(out.content)![1]!;
        last = out.content;
    }
    expect(last).toContain("64 MiB session");
    const files = readdirSync(dirname(path));
    expect((await BashTool.run({ command: "echo hi" }, ctx)).content).toBe("hi");
    const bg = await finished(ctx, await background(ctx, "echo hi"));
    expect(bg.content).not.toContain("limit");
    expect(bg.content).not.toContain("output:");
    const boundary = await BashTool.run({ command: script(dir, `await write('x'.repeat(30000) + '\\n');`) }, ctx);
    expect(boundary.content).toBe("x".repeat(30000));
    expect(readdirSync(dirname(path))).toEqual(files);
}, 30000);

test("round 2: default Bash permission allows tail of saved output without a credentials prompt", async () => {
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { ctx, dir } = setup();
    const out = await BashTool.run({ command: "seq 1 10000" }, ctx);
    const path = /Full output: (.+)/.exec(out.content)![1]!;
    const checker = new PermissionChecker(() => ({ permissions: { allow: [], ask: [], deny: [] } }), dir, () => undefined);
    const command = `tail -n 2 ${quote(path)}`;
    expect(checker.check(BashTool, { command }, "default", dir).behavior).toBe("allow");
    expect((await BashTool.run({ command }, ctx)).content).toBe("9999\n10000");
});

test("round 2: filtered background reads do not replay output when the archive activates", async () => {
    const { ctx, dir } = setup();
    const id = await background(ctx, script(dir, `await write('MATCH_OLD\\n'); fs.writeFileSync('ready', ''); while (!fs.existsSync('continue')) await pause(); await write(('filler'.repeat(100) + '\\n').repeat(60) + 'MATCH_NEW\\n');`));
    for (let i = 0; i < 500 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(10);
    expect((await BashOutputTool.run({ bash_id: id, filter: "MATCH" }, ctx)).content).toContain("MATCH_OLD");
    writeFileSync(join(dir, "continue"), "");
    const sh = ctx.state.shells.get(id)!;
    for (let i = 0; i < 500 && sh.exitCode === null; i++) await Bun.sleep(10);
    const out = await BashOutputTool.run({ bash_id: id, filter: "MATCH" }, ctx);
    expect(out.content).toContain("MATCH_NEW");
    expect(out.content).not.toContain("MATCH_OLD");
});

for (const end of ["head", "tail"]) {
    test(`round 2: oversized ${end} cannot leak an ANSI-split secret across the raw window`, async () => {
        const { ctx, dir } = setup();
        const command = script(dir, `const colors = '\\x1b[31m'.repeat(4000); const split = token.slice(0, 8) + '\\x1b[' + '0'.repeat(100000) + 'm' + token.slice(8); const filler = 'x'.repeat(9 * 1024 * 1024); await write(${end === "head" ? "colors + split + filler" : "filler + split + colors"} + ' FINAL_ERROR\\n');`);
        const out = await BashTool.run({ command }, ctx);
        noFragments(out.content);
        expect(out.content).toContain("FINAL_ERROR");
        const path = /Saved output: (.+)/.exec(out.content)![1]!;
        noFragments(readFileSync(path, "utf8"));
    });
}

test("round 2: exhausted file quota does not create artifacts or notes for small commands", async () => {
    const { ctx } = setup();
    let path = "";
    for (let i = 0; i < 256; i++) {
        const out = await BashTool.run({ command: "printf '%030001d\\n' 0" }, ctx);
        path ||= /Full output: (.+)/.exec(out.content)![1]!;
    }
    const capped = await BashTool.run({ command: "printf '%030001d\\n' 0" }, ctx);
    expect(capped.content).toContain("Session output file limit (256)");
    expect(capped.content).not.toMatch(/(?:Full|Saved) output:/);
    expect(capped.isError).toBeFalsy();
    expect((await BashTool.run({ command: "echo hi" }, ctx)).content).toBe("hi");
    const bg = await finished(ctx, await background(ctx, "echo hi"));
    expect(bg.content).not.toContain("limit");
    expect(bg.content).not.toContain("output:");
    expect(readdirSync(dirname(path))).toHaveLength(256);
}, 30000);
