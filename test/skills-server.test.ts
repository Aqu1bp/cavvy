// Skills in the GUI server, end to end: a real server and WebSocket and the
// mock model. Listed for the composer's / and $ menus, run as /name, mentioned
// as $name, and loaded by the model with the Skill tool.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { secretsSnapshot } from "./helpers/secrets";

const iso = isolate();
const restoreSecrets = await secretsSnapshot();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { getProvider } = await import("../src/providers/registry");
const { clientFor } = await import("../src/providers/models");
import type { ProviderListing } from "../src/providers/models";
import type { CommandInfo, ServerEvent, SessionSnapshot, SessionState, Turn } from "../src/server/protocol";

const TOKEN = "test-token-skills-0123456789";
const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
const skill = (root: string, name: string, text: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), text);
};
const userSkills = join(iso.home, "skills");
skill(userSkills, "explain", "---\ndescription: Explain code simply\nargument-hint: <path>\n---\nExplain $ARGUMENTS to a newcomer.");
skill(userSkills, "release-notes", "---\ndescription: Write release notes\n---\nWrite release notes from the git log.");
skill(userSkills, "mine-only", "---\ndescription: Only I run this\ndisable-model-invocation: true\n---\nSecret sauce.");
skill(userSkills, "background", "---\ndescription: Background knowledge\nuser-invocable: false\n---\nKnow this.");

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
    const listings: ProviderListing[] = [{ provider: getProvider("mock")!, status: "ok", models: await (await clientFor("mock")).listModels() }];
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300, listModels: async () => listings });
    await srv.engine.refreshListings();
});
afterAll(async () => {
    await srv.stop();
    mock.stop();
    restoreSecrets();
    iso.cleanup();
});

const project = () => createDemoProject(tempDir("cavvy-skills-srv-"), { git: false });

class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, { state: SessionState; turns: Turn[]; agents: any[]; seq: number }>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();

    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
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

    async sessionIds(): Promise<string[]> {
        // Unloading changes summary fields and ordering, but doesn't create a session.
        return (await this.call<{ id: string }[]>("sessions.list")).map((s) => s.id).sort();
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

/** What the model got as the user's message in the latest turn request. */
const lastPrompt = () => mock.requests.filter((r) => r.kind === "turn").at(-1)!.prompt;
const lastTools = () => (JSON.parse(mock.requests.filter((r) => r.kind === "turn").at(-1)!.body).tools ?? []) as { function: { name: string; description: string } }[];

describe("skills in the GUI", () => {
    test("listed for the menus, marked as skills, model-only ones left out", async () => {
        const c = await client();
        const list = await c.call<CommandInfo[]>("commands.list", { cwd: project() });
        const skills = list.filter((x) => x.skill);
        expect(skills.map((s) => s.name)).toEqual(["explain", "mine-only", "release-notes"]);
        expect(skills[0]).toEqual({ name: "explain", description: "Explain code simply", args: "<path>", skill: true });
        // A /word a skill has isn't a typo on Home.
        expect((await c.call<CommandInfo[]>("commands.list", { cwd: project(), command: "explain" })).length).toBeGreaterThan(0);
        c.close();
    });

    test("Codex's own skills, once it has listed them, are skills in the menus; Claude Code's commands aren't", async () => {
        const c = await client();
        const cwd = project();
        srv.engine.cliCommandsReported("codex", cwd, ["imagegen", "explain"]);
        srv.engine.cliCommandsReported("claude-code", cwd, ["code-review"]);
        const codex = await c.call<CommandInfo[]>("commands.list", { cwd, provider: "codex" });
        expect(codex.filter((x) => x.name === "imagegen")).toEqual([{ name: "imagegen", description: "Codex's own skill", skill: true }]);
        // One Cavvy has itself is listed once, as Cavvy's.
        expect(codex.filter((x) => x.name === "explain")).toEqual([{ name: "explain", description: "Explain code simply", args: "<path>", skill: true }]);
        const claude = await c.call<CommandInfo[]>("commands.list", { cwd, provider: "claude-code" });
        expect(claude.find((x) => x.name === "code-review")).toEqual({ name: "code-review", description: "Claude Code's own command" });
        c.close();
    });

    test("/name runs it: the transcript shows the command, the model gets the instructions", async () => {
        const c = await client();
        const id = await c.create(project());
        expect(await c.call("session.send", { id, text: "/explain src/auth" })).toEqual({ queued: false });
        await c.until(() => done(c.view(id)));
        expect(c.view(id).turns[0]!.prompt).toMatchObject({ text: "/explain src/auth", command: true });
        expect(lastPrompt()).toContain('<skill name="explain">');
        expect(lastPrompt()).toContain("Explain src/auth to a newcomer.");
        // The session is named after the command and what the skill is for, not its instructions.
        const title = mock.requests.find((r) => r.kind === "title");
        expect(title?.prompt).toContain("Explain code simply: src/auth");
        expect(title?.prompt).not.toContain("Base directory");
        // The model-only one isn't a command.
        await expect(c.call("session.send", { id, text: "/background" })).rejects.toMatchObject({ code: "unknown_command" });
        c.close();
    });

    test("$name in a message brings the skill along; the transcript keeps what was typed", async () => {
        const c = await client();
        const id = await c.create(project());
        await c.call("session.send", { id, text: "draft them with $release-notes please, budget $5" });
        await c.until(() => done(c.view(id)));
        expect(c.view(id).turns[0]!.prompt.text).toBe("draft them with $release-notes please, budget $5");
        expect(lastPrompt()).toStartWith("draft them with $release-notes please, budget $5\n\n<skill name=\"release-notes\">");
        expect(lastPrompt()).toContain("Write release notes from the git log.");
        c.close();
    });

    test("the model sees the skills it may load, and loads one with the Skill tool", async () => {
        const c = await client();
        const id = await c.create(project());
        await c.call("session.send", { id, text: "use the release-notes skill" });
        await c.until(() => done(c.view(id)));
        const tool = lastTools().find((t) => t.function.name === "Skill")!;
        expect(tool.function.description).toContain("- release-notes: Write release notes");
        expect(tool.function.description).toContain("- background: Background knowledge");
        expect(tool.function.description).not.toContain("mine-only");
        const call = c.view(id).turns[0]!.blocks.find((b: any) => b.t === "tool" && b.name === "Skill") as any;
        expect(call).toMatchObject({ title: "Skill(release-notes)", status: "ok", summary: "Loaded skill release-notes" });
        expect(call.output).toContain("Write release notes from the git log.");
        expect(lastPrompt()).toBe("use the release-notes skill");
        const text = JSON.stringify(c.view(id).turns[0]!.blocks);
        expect(text).toContain("Following the skill. It starts: Write release notes from the git log.");
        c.close();
    });

    test("@paths in a skill's instructions don't attach the project's files; the user's own do", async () => {
        const c = await client();
        const cwd = project();
        writeFileSync(join(cwd, "reference.md"), "PROJECT REFERENCE CONTENT");
        skill(userSkills, "with-ref", "---\ndescription: Has a reference\n---\nSee @reference.md next to this skill.");
        try {
            await Bun.sleep(2100);
            const id = await c.create(cwd);
            await c.call("session.send", { id, text: "/with-ref" });
            await c.until(() => done(c.view(id)));
            expect(mock.requests.filter((r) => r.kind === "turn").at(-1)!.body).not.toContain("PROJECT REFERENCE CONTENT");
            await c.call("session.send", { id, text: "/with-ref @reference.md" });
            await c.until(() => done(c.view(id)) && c.view(id).turns.length === 2);
            await c.until(() => done(c.view(id)));
            expect(mock.requests.filter((r) => r.kind === "turn").at(-1)!.body).toContain("PROJECT REFERENCE CONTENT");
        } finally {
            rmSync(join(userSkills, "with-ref"), { recursive: true, force: true });
        }
        c.close();
    });

    test("a skill added while the server runs shows up and runs", async () => {
        const c = await client();
        const cwd = project();
        const id = await c.create(cwd);
        skill(userSkills, "brand-new", "---\ndescription: Just added\n---\nNew instructions.");
        try {
            await Bun.sleep(2100);
            expect((await c.call<CommandInfo[]>("commands.list", { cwd })).some((x) => x.name === "brand-new" && x.skill)).toBe(true);
            await c.call("session.send", { id, text: "/brand-new" });
            await c.until(() => done(c.view(id)));
            expect(lastPrompt()).toContain("New instructions.");
        } finally {
            rmSync(join(userSkills, "brand-new"), { recursive: true, force: true });
        }
        c.close();
    });

    test("a trusted project's skills, and not an untrusted one's", async () => {
        const c = await client();
        const cwd = project();
        skill(join(cwd, ".cavvy", "skills"), "project-only", "---\ndescription: From the repo\n---\nRepo instructions.");
        expect((await c.call<CommandInfo[]>("commands.list", { cwd })).some((x) => x.name === "project-only")).toBe(false);
        await c.call("projects.trust", { path: cwd, trust: true });
        await Bun.sleep(2100);
        expect((await c.call<CommandInfo[]>("commands.list", { cwd })).some((x) => x.name === "project-only")).toBe(true);
        c.close();
    });

    test("a skill keeps its bare name when a plugin has a command by the same name", async () => {
        const { addMarketplace } = await import("../src/plugins/marketplaces");
        const { installPlugin, removeMarketplace } = await import("../src/plugins/install");
        const mk = tempDir("cavvy-skills-mk-");
        writeFileSync(join(mk, "marketplace.json"), JSON.stringify({ name: "clash", plugins: [{ name: "doc", source: "./doc" }] }));
        mkdirSync(join(mk, "doc", "commands"), { recursive: true });
        writeFileSync(join(mk, "doc", "commands", "explain.md"), "The plugin's explain.");
        writeFileSync(join(mk, "doc", "commands", "polish.md"), "The plugin's polish.");
        const cwd = project();
        await addMarketplace(join(mk, "marketplace.json"), cwd);
        await installPlugin("doc", "user", cwd);
        try {
            const c = await client();
            const id = await c.create(cwd);
            await c.call("session.send", { id, text: "/explain src/auth" });
            await c.until(() => done(c.view(id)));
            expect(lastPrompt()).toContain('<skill name="explain">');
            expect(lastPrompt()).not.toContain("The plugin's explain.");
            // Its full name still runs the plugin's.
            await c.call("session.send", { id, text: "/doc:explain" });
            await c.until(() => done(c.view(id)) && c.view(id).turns.length === 2);
            expect(lastPrompt()).toContain("The plugin's explain.");
            // Nor does it take a name the session's agent CLI lists as its own: that goes to the CLI as typed.
            srv.engine.cliCommandsReported("mock", cwd, ["polish"]);
            await c.call("session.send", { id, text: "/polish it" });
            await c.until(() => done(c.view(id)) && c.view(id).turns.length === 3);
            expect(lastPrompt()).toContain("/polish it");
            expect(lastPrompt()).not.toContain("The plugin's polish.");
            c.close();
        } finally {
            removeMarketplace("clash", cwd);
        }
        // An install and three turns: more than the default 5 s on a loaded machine.
    }, 30_000);
});
