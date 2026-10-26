// Seeds a running demo server (`bun run gui:demo --port N --token T`) with a long, realistic
// session for performance work: TURNS turns of reading, writing and long markdown answers, and
// one turn that changes 322 files. A second, shorter session gives session switching a target, and
// older one-turn sessions fill the rail.
//
//   bun scripts/perf-seed.ts <port> <token> <project folder> [turns=64] [older sessions=60]
//
// The project folder is the demo's ("demo project:" in its output).

const [port, token, cwd, turnsArg] = process.argv.slice(2);
if (!port || !token || !cwd) throw new Error("usage: perf-seed.ts <port> <token> <project folder> [turns]");
const TURNS = Number(turnsArg ?? 64);
const OLDER = Number(process.argv[6] ?? 60);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { protocols: ["harness.v1", `auth.${token}`] } as any);
let next = 1;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if ("event" in msg) return;
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w?.reject(new Error(msg.error.message));
    else w?.resolve(msg.result);
};
await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("connection failed"));
});
const call = <T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
};

await call("projects.trust", { path: cwd, trust: true });

// 322 committed files for the big turn to rewrite: +54096 −8050 across them, as a codegen run would.
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(`${cwd}/gen`, { recursive: true });
for (let i = 1; i <= 322; i++) writeFileSync(`${cwd}/gen/endpoint${i}.ts`, Array.from({ length: 25 }, (_, k) => `export const old${i}_${k} = 0;`).join("\n") + "\n");
const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.com" } });
git("add", "-A");
git("commit", "-qm", "Generated clients");

async function session(prompts: string[]) {
    const snap = await call("session.create", { cwd, mode: "bypassPermissions" });
    const id = snap.state.id as string;
    for (const [i, text] of prompts.entries()) {
        await call("session.send", { id, text });
        // Done once it's idle with this turn finished.
        for (;;) {
            await Bun.sleep(150);
            const s = await call("session.open", { id });
            // Allowed for the session, so later turns don't ask.
            for (const ask of s.state.interactions ?? []) if (ask.kind === "permission") await call("session.respond", { id, interactionId: ask.id, response: { kind: "permission", choice: ["session", "session-edits", "yes"].find((c) => ask.options.some((o: { id: string }) => o.id === c)) } }).catch(() => {});
            const last = s.turns.at(-1);
            if (!s.state.busy && s.turns.length > i && last?.status !== "running") break;
        }
        process.stderr.write(`\r${id}: ${i + 1}/${prompts.length}`);
    }
    process.stderr.write("\n");
    return id;
}

const LONG = "Please also keep in mind the constraints from before: the public API must not change, the tests must keep passing, and anything user-visible needs a note in the changelog. ";
const prompts = Array.from({ length: TURNS }, (_, i) => `perfturn ${i} — ${i % 3 === 0 ? LONG.repeat(3) : "next step of the refactor"}`);
// The big one sits a few turns from the end, so it's on the first page drawn.
prompts.splice(TURNS - 4, 0, "bulkchange: generate the endpoint clients");
// A rail with history: older one-turn sessions.
for (let i = 0; i < OLDER; i++) await session([`perfturn ${700 + i} — an older task`]);
await session(["perfturn 900 — a short session to switch to", "perfturn 901 — and one more turn"]);
const main = await session(prompts);
console.log(main);
ws.close();
process.exit(0);
