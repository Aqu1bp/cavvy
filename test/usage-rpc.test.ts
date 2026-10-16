// The Usage view's and plan meter's RPCs, and the GUI server's guard on
// slash commands, end to end: a real server and WebSocket, the mock model,
// and the fake Codex (test/fixtures) for plan limits.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { FAKE, isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { getProvider, saveAgentConfig } = await import("../src/providers/registry");
const { getKey, removeKey, setKey } = await import("../src/auth/credentials");
const { clientFor } = await import("../src/providers/models");
import type { ProviderListing } from "../src/providers/models";
import type { PlanLimits, ServerEvent, SessionSnapshot, SessionState, Turn, UsageSummary } from "../src/server/protocol";

const TOKEN = "test-token-usage-0123456789";
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(join(iso.home, "commands"), { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
// A user's own command, as ~/.harness/commands/hello.md.
writeFileSync(join(iso.home, "commands", "hello.md"), "---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.");

let srv: Awaited<ReturnType<typeof startServer>>;
let modelListings: ProviderListing[];
beforeAll(async () => {
    // Real discovery can outlive startup and overwrite the fallback fixture (or query machine providers).
    modelListings = [{ provider: getProvider("mock")!, status: "ok", models: await (await clientFor("mock")).listModels() }];
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300, listModels: async () => modelListings });
    await srv.engine.refreshListings();
});
afterAll(async () => {
    await srv.stop();
    mock.stop();
    iso.cleanup();
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const project = () => createDemoProject(tempDir("harness-usage-proj-"), { git: false });

class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, { state: SessionState; turns: Turn[]; agents: any[]; seq: number }>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();

    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["harness.v1", `auth.${TOKEN}`] } as any);
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) {
                const ev = msg.event as ServerEvent;
                this.events.push(ev);
                if (ev.type === "session.ops") {
                    const v = this.views.get(ev.sessionId);
                    if (v && ev.seq > v.seq) {
                        for (const op of ev.ops) applyOp(v, op);
                        v.seq = ev.seq;
                    }
                }
                for (const l of this.listeners) l();
                return;
            }
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            if (msg.error) w?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
            else w?.resolve(msg.result);
        };
    }

    opened(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error("connection failed"));
        });
    }

    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    }

    async create(cwd: string): Promise<string> {
        const snap = await this.call<SessionSnapshot>("session.create", { cwd });
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        return snap.state.id;
    }

    view(id: string) {
        return this.views.get(id)!;
    }

    until(pred: () => boolean, ms = 15_000): Promise<void> {
        return new Promise((resolve, reject) => {
            const check = () => {
                if (!pred()) return;
                this.listeners.delete(check);
                clearTimeout(t);
                resolve();
            };
            const t = setTimeout(() => {
                this.listeners.delete(check);
                reject(new Error("timed out"));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }

    close() {
        this.ws.close();
    }
}

async function client(): Promise<Client> {
    const c = new Client();
    await c.opened();
    return c;
}

const done = (v: { state: SessionState; turns: Turn[] }) => !v.state.busy && v.turns.length > 0 && v.turns[v.turns.length - 1]!.status !== "running";
const prompts = (v: { turns: Turn[] }) => v.turns.flatMap((t) => (t.prompt ? [t.prompt.text] : []));

describe("usage.summary", () => {
    test("the offered ranges, from the transcripts", async () => {
        const c = await client();
        const id = await c.create(project());
        await c.call("session.send", { id, text: "hello there" });
        await c.until(() => done(c.view(id)));
        const s = await c.call<UsageSummary>("usage.summary", { days: 1 });
        expect(s.days).toBe(1);
        const mock = s.rows.find((r) => r.provider === "mock" && r.model === "mock-opus")!;
        expect(mock.sessions).toBe(1);
        expect(mock.inputTokens + mock.outputTokens).toBeGreaterThan(0);
        expect(s.sessions).toBeGreaterThanOrEqual(1);
        // Every new record is dated.
        expect(s.approxDated).toBe(0);
        c.close();
    });

    test("anything else is the client's mistake", async () => {
        const c = await client();
        for (const days of [3, "7", null]) {
            const e = await c.call("usage.summary", { days }).catch((x) => x);
            expect(e).toBeInstanceOf(Error);
            expect(e.message).toBe("days must be one of 1, 7, 30");
            expect(e.code).toBe("bad_request");
        }
        c.close();
    });
});

describe("plan limits", () => {
    test("after a Codex turn, every client has its windows, and limits.get returns them", async () => {
        const bin = tempDir("harness-usage-cli-");
        writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-codex.ts")}" "$@"\n`);
        chmodSync(join(bin, "codex"), 0o755);
        for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
        saveAgentConfig("codex", { path: join(bin, "codex") });
        process.env.FAKE_SCENARIO = "web";
        process.env.FAKE_RATE_LIMITS = join(import.meta.dir, "fixtures", "limits", "codex-read.json");
        process.env.FAKE_LIMIT_UPDATE = join(import.meta.dir, "fixtures", "limits", "codex-update-normal.json");
        try {
            const c = await client();
            const other = await client();
            expect(await c.call<PlanLimits[]>("limits.get", {})).toEqual([]);
            const id = await c.create(project());
            await c.call("session.setModel", { id, ref: "codex:default", persist: false });
            await c.call("session.send", { id, text: "search the web" });
            await c.until(() => done(c.view(id)), 30_000);
            const limits = await c.call<PlanLimits[]>("limits.get", {});
            expect(limits.length).toBe(1);
            // The read (weekly 14%) and then the update's windows (5-hour 62%, weekly 30%), whichever came last for each slot.
            expect(limits[0]!.provider).toBe("codex");
            expect(limits[0]!.windows.map((w) => w.label).sort()).toEqual(["5-hour", "Weekly"]);
            const seen = other.events.filter((e): e is Extract<ServerEvent, { type: "limits" }> => e.type === "limits");
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.at(-1)!.limits).toEqual(limits[0]!);
            c.close();
            other.close();
        } finally {
            for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
        }
    });
});

describe("slash commands the server doesn't know", () => {
    test("/nonsense isn't sent to the model; sent as a message, it is", async () => {
        const c = await client();
        const id = await c.create(project());
        await expect(c.call("session.send", { id, text: "/nonsense please" })).rejects.toMatchObject({ code: "unknown_command", message: "Unknown command /nonsense" });
        // From an older GUI that doesn't handle it itself, /cost isn't a prompt either.
        await expect(c.call("session.send", { id, text: "/cost" })).rejects.toMatchObject({ code: "unknown_command" });
        await Bun.sleep(100);
        expect(c.view(id).turns).toEqual([]);
        expect(c.view(id).state.busy).toBe(false);
        expect(c.view(id).state.queued).toEqual([]);
        await c.call("session.send", { id, text: "/nonsense please", literal: true });
        await c.until(() => done(c.view(id)));
        expect(prompts(c.view(id))).toEqual(["/nonsense please"]);
        c.close();
    });

    test("a refused first message leaves the session idle for a corrected message", async () => {
        const c = await client();
        const id = await c.create(project());
        await expect(c.call("session.send", { id, text: "/mistyped" })).rejects.toMatchObject({ code: "unknown_command" });
        // Read the server snapshot as well: refusal never starts or queues a turn.
        const snap = await c.call<SessionSnapshot>("session.open", { id });
        expect(snap.turns).toEqual([]);
        expect(snap.state.busy).toBe(false);
        expect(snap.state.queued).toEqual([]);
        await c.call("session.send", { id, text: "corrected message" });
        await c.until(() => done(c.view(id)));
        expect(prompts(c.view(id))).toEqual(["corrected message"]);
        c.close();
    });

    test("a message that starts with a path is a prompt", async () => {
        const c = await client();
        const id = await c.create(project());
        expect(await c.call("session.send", { id, text: "/Users/me/app.ts fails to build" })).toEqual({ queued: false });
        await c.until(() => done(c.view(id)));
        expect(prompts(c.view(id))).toEqual(["/Users/me/app.ts fails to build"]);
        c.close();
    });

    test("a Home typo is refused before any session is created", async () => {
        const c = await client();
        const cwd = project();
        const before = await c.call("sessions.list");
        await expect(c.call("commands.list", { cwd, command: "nonsense" })).rejects.toMatchObject({ code: "unknown_command", message: "Unknown command /nonsense" });
        expect(await c.call("sessions.list")).toEqual(before);
        c.close();
    });

    test("custom commands still run, and are listed before a session opens the project", async () => {
        const c = await client();
        const cwd = project();
        expect((await c.call<{ name: string }[]>("commands.list", { cwd, command: "hello" })).map((x) => x.name)).toEqual(expect.arrayContaining(["hello", "cost", "context", "compact"]));
        const id = await c.create(cwd);
        expect(await c.call("session.send", { id, text: "/hello world" })).toEqual({ queued: false });
        await c.until(() => done(c.view(id)));
        expect(c.view(id).turns[0]!.prompt).toMatchObject({ text: "/hello world", command: true });
        c.close();
    });
});

describe("Claude Code's own commands", () => {
    test("in a Claude Code session, those it listed go to it as the prompt, from a new session's first message on", async () => {
        const bin = tempDir("harness-usage-cli-");
        writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
        chmodSync(join(bin, "claude"), 0o755);
        for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
        saveAgentConfig("claude-code", { path: join(bin, "claude") });
        process.env.FAKE_SCENARIO = "silent";
        process.env.FAKE_LOG = join(bin, "log.jsonl");
        const prompts = () =>
            existsSync(process.env.FAKE_LOG!)
                ? readFileSync(process.env.FAKE_LOG!, "utf-8")
                      .trim()
                      .split("\n")
                      .map((l) => JSON.parse(l).received)
                      .filter((m) => m?.type === "user")
                      .flatMap((m) => m.message.content.filter((x: any) => x.type === "text").map((x: any) => x.text as string))
                : [];
        try {
            const c = await client();
            const cwd = project();
            const override = project();
            mkdirSync(join(override, ".harness"));
            writeFileSync(join(override, ".harness", "settings.json"), JSON.stringify({ model: "claude-code:default" }));
            // The global default is Mock. Home must use the trusted project's Claude Code override.
            await c.call("projects.trust", { path: override, trust: true });
            const before = await c.call("sessions.list");
            await expect(c.call("commands.list", { cwd: override, command: "project-skill" })).resolves.toBeArray();
            expect(await c.call("sessions.list")).toEqual(before);
            await expect(c.call("commands.list", { cwd: override, provider: "mock", command: "project-skill" })).rejects.toMatchObject({ code: "unknown_command" });
            const listings = modelListings;
            try {
                modelListings = [{ provider: getProvider("claude-code")!, status: "ok", models: [{ provider: "claude-code", id: "default" }] }];
                await srv.engine.refreshListings();
                for (const [model, hasKey] of [
                    ["removed-provider:old-model", false],
                    ["anthropic:claude-sonnet-5-5", false],
                    ["anthropic:claude-sonnet-5-5", true],
                    ["anthropic:claude-sonnet-5-5", false],
                ] as const) {
                    // isolate() clears env and disk state, but other files can leave a cached key.
                    if (hasKey) await setKey("anthropic", FAKE.anthropic);
                    else await removeKey("anthropic");
                    expect((await getKey("anthropic"))?.value).toBe(hasKey ? FAKE.anthropic : undefined);
                    const fallback = project();
                    mkdirSync(join(fallback, ".harness"));
                    writeFileSync(join(fallback, ".harness", "settings.json"), JSON.stringify({ model }));
                    await c.call("projects.trust", { path: fallback, trust: true });
                    const before = await c.call("sessions.list");
                    // A usable API provider stays selected even when the listing offers only Claude Code.
                    const unknown = { code: "unknown_command", message: "Unknown command /project-skill" };
                    if (hasKey) await expect(c.call("commands.list", { cwd: fallback, command: "project-skill" })).rejects.toMatchObject(unknown);
                    else expect(await c.call("commands.list", { cwd: fallback, command: "project-skill" })).toBeArray();
                    expect(await c.call("sessions.list")).toEqual(before);
                    const id = await c.create(fallback);
                    expect(c.view(id).state.model?.provider).toBe(hasKey ? "anthropic" : "claude-code");
                    if (hasKey) await expect(c.call("session.send", { id, text: "/project-skill" })).rejects.toMatchObject(unknown);
                }
            } finally {
                await removeKey("anthropic");
                modelListings = listings;
                await srv.engine.refreshListings();
            }
            const claude = async (dir = cwd) => {
                const id = await c.create(dir);
                await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
                return id;
            };
            // Before this workspace reports its list, Claude Code resolves commands itself.
            const first = await claude();
            expect(await c.call("session.send", { id: first, text: "/code-review" })).toEqual({ queued: false });
            await c.until(() => done(c.view(first)), 30_000);

            const id = await claude();
            expect(await c.call("session.send", { id, text: "/code-review src" })).toEqual({ queued: false });
            await c.until(() => done(c.view(id)), 30_000);
            // As the prompt, first (the harness's reminders, as for any prompt, come after it).
            expect(prompts().some((t) => t.startsWith("/code-review src"))).toBe(true);
            expect((await c.call<{ name: string }[]>("commands.list", { cwd, provider: "claude-code" })).map((x) => x.name)).toEqual(expect.arrayContaining(["code-review", "design:ux-copy"]));
            expect((await c.call<{ name: string }[]>("commands.list", { cwd })).map((x) => x.name)).not.toContain("code-review");

            // A second workspace has its own list. Its first command is allowed even
            // though A already reported a list; its init then replaces only B's list.
            const cwdB = project();
            process.env.FAKE_SLASH_COMMANDS = JSON.stringify(["project-b"]);
            const b = await claude(cwdB);
            expect(await c.call("session.send", { id: b, text: "/project-b" })).toEqual({ queued: false });
            await c.until(() => done(c.view(b)), 30_000);
            expect((await c.call<{ name: string }[]>("commands.list", { cwd: cwdB, provider: "claude-code" })).map((x) => x.name)).toContain("project-b");
            expect((await c.call<{ name: string }[]>("commands.list", { cwd, provider: "claude-code" })).map((x) => x.name)).toContain("code-review");
            await expect(c.call("commands.list", { cwd, provider: "claude-code", command: "code-review" })).resolves.toBeArray();
            await expect(c.call("commands.list", { cwd: cwdB, provider: "claude-code", command: "code-review" })).rejects.toMatchObject({ code: "unknown_command" });
            const newA = await claude();
            await expect(c.call("session.send", { id: newA, text: "/project-b" })).rejects.toMatchObject({ code: "unknown_command" });
            await expect(c.call("session.send", { id: b, text: "/code-review" })).rejects.toMatchObject({ code: "unknown_command" });
            // A known empty list is different from a workspace not initialized yet.
            process.env.FAKE_SLASH_COMMANDS = "[]";
            const empty = await claude(override);
            await c.call("session.send", { id: empty, text: "/first-command" });
            await c.until(() => done(c.view(empty)), 30_000);
            await expect(c.call("commands.list", { cwd: override, command: "first-command" })).rejects.toMatchObject({ code: "unknown_command" });
            await expect(c.call("session.send", { id: empty, text: "/first-command" })).rejects.toMatchObject({ code: "unknown_command" });

            // On another model it's still not a command.
            const other = await c.create(cwd);
            await expect(c.call("session.send", { id: other, text: "/code-review" })).rejects.toMatchObject({ code: "unknown_command" });
            c.close();
        } finally {
            for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
        }
    });
});
