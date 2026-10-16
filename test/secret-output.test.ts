import { afterAll, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { ToolContext, ToolState } from "../src/tools/types";

const iso = isolate();
const { SecretStore } = await import("../src/agent/secrets");
const { BashTool, BashOutputTool, killAllShells } = await import("../src/tools/bash");
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
    const dir = realpathSync(tempDir("harness-output-"));
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

test("foreground cap redacts complete secrets before cutting its retained tail", async () => {
    const { ctx, dir, progress } = setup();
    // The old 8192-character cut lands six characters into a complete secret.
    const command = script(dir, `await write('a'.repeat(591803) + token + 'b'.repeat(599990 - 591803 - token.length)); await pause(); await write('b'.repeat(11)); await pause(); await write('end\\n');`);
    const out = await BashTool.run({ command }, ctx);
    noFragments(JSON.stringify(out));
    noFragments(progress.join(""));
    expect(out.content).toContain("aaaaaa");
});

test("background buffer never exposes a secret split by front eviction", async () => {
    const { ctx, dir } = setup();
    const command = script(dir, `await write('a'.repeat(40) + token + 'b'.repeat(1000048 - 40 - token.length));`);
    const out = await finished(ctx, await background(ctx, command));
    noFragments(JSON.stringify(out));
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
