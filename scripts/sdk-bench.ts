// What the SDK costs: importing it, starting a query, and each turn, measured
// against the mock model (scripts/mock-llm.ts, no delay) so the numbers are
// the harness's own overhead rather than a provider's.
//
//   bun run sdk:bench [--turns 50]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { startMockLlm } from "./mock-llm";

const turns = Number(process.argv[process.argv.indexOf("--turns") + 1]) || 50;
const repo = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "harness-sdk-bench-"));
const home = join(root, "home");
const project = join(root, "project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
process.env.HARNESS_HOME = home;
process.env.HARNESS_NO_KEYCHAIN = "1";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (n: number) => `${n.toFixed(1)} ms`;
const env = { ...(process.env as Record<string, string>) };

/** Wall time of a fresh `bun -e` process, median of `n`. */
async function processMs(code: string, n = 7): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
        const t = performance.now();
        const p = Bun.spawn(["bun", "--no-env-file", "-e", code], { cwd: repo, env, stdout: "ignore", stderr: "inherit" });
        await p.exited;
        times.push(performance.now() - t);
    }
    return median(times);
}

try {
    // ---- import cost, in fresh processes
    const bare = await processMs("0");
    const entry = await processMs(`await import("./src/sdk/index.ts")`);
    const engine = await processMs(`await import("./src/sdk/runner.ts")`);
    const cli = await processMs(`await import("./src/headless.ts")`);

    // ---- a raw request to the mock: the floor for a turn
    const raw: number[] = [];
    for (let i = 0; i < 20; i++) {
        const t = performance.now();
        const r = await fetch(`${mock.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "mock-opus", messages: [{ role: "user", content: "hi" }], tools: [{}], stream: true }) });
        await r.text();
        raw.push(performance.now() - t);
    }

    const { query } = await import("../src/sdk/index");

    // ---- one-shot queries: setup + one turn + cleanup
    const oneShot: number[] = [];
    const firstMessage: number[] = [];
    for (let i = 0; i < 10; i++) {
        const t = performance.now();
        let first = 0;
        for await (const m of query({ prompt: "hello", options: { cwd: project, persistSession: false } })) {
            if (!first) first = performance.now() - t;
            if (m.type === "result" && m.is_error) throw new Error(`turn failed: ${m.errors.join("; ")}`);
        }
        oneShot.push(performance.now() - t);
        firstMessage.push(first);
    }

    // ---- turns in one streaming query
    const turnTimes: number[] = [];
    let mark = 0;
    async function* prompts() {
        for (let i = 0; i < turns; i++) {
            mark = performance.now();
            yield `hello ${i}`;
            await new Promise<void>((r) => (release = r));
        }
    }
    let release: () => void = () => {};
    for await (const m of query({ prompt: prompts(), options: { cwd: project, persistSession: false } })) {
        if (m.type === "result") {
            turnTimes.push(performance.now() - mark);
            release();
        }
    }

    // ---- the same prompt through `harness -p`, a process each
    const headless: number[] = [];
    for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const p = Bun.spawn(["bun", "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "src/index.ts"), "-p", "hello"], { cwd: project, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        await p.exited;
        headless.push(performance.now() - t);
    }

    const rows: [string, string][] = [
        ["bun process, nothing imported", ms(bare)],
        ["import my-own-harness/sdk (entry only)", `${ms(entry)} (+${ms(entry - bare)})`],
        ["import the engine (loaded on first query)", `${ms(engine)} (+${ms(engine - bare)})`],
        ["import headless.ts (harness -p), for comparison", `${ms(cli)} (+${ms(cli - bare)})`],
        ["raw streamed request to the mock", ms(median(raw))],
        ["query(): first message (setup)", ms(median(firstMessage))],
        ["query(): one-shot, start to end (incl. cleanup)", ms(median(oneShot))],
        [`one turn in a streaming query (median of ${turns})`, ms(median(turnTimes))],
        ["  overhead over the raw request", ms(median(turnTimes) - median(raw))],
        ["harness -p, a process per prompt", ms(median(headless))],
    ];
    const w = Math.max(...rows.map(([k]) => k.length));
    console.log(`Bun ${Bun.version}, ${process.platform}/${process.arch}\n`);
    for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
} finally {
    mock.stop();
    rmSync(root, { recursive: true, force: true });
}
process.exit(0);
