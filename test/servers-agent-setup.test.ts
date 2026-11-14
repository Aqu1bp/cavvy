// An agent sets a server up for the user: ServerKey (the user's yes to the price, and Cavvy's keys), ServerAdd
// (no key file, no trust question, the server's sign-ins) and ServerRemove (the machine deleted too, after
// another yes). Run for real against the pretend server (test/helpers/fake-ssh.ts) and pretend provider CLIs:
// the keys and the start-up script, the tools on their own, and the whole thing from a window.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

const iso = isolate();
const fake = fakeSsh();
const A = "aaaaaaaaaaaa-1";

// Pretend CLIs. On the pretend server: gh (signed out until its page is "finished"), Claude Code (signed in) and
// Codex (signed out). On this machine: the provider's own, which deletes the machine and is signed out at first.
const there = join(dirname(fake.bin), "bin");
const shim = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
};
shim(there, "gh", `case "$1 $2" in
"auth status") [ -e "$HOME/gh-in" ] && { echo "✓ Logged in to github.com account octo (keyring)"; exit 0; }; echo "You are not logged into any GitHub hosts. To log in, run: gh auth login"; exit 1 ;;
"auth login") echo "! First copy your one-time code: ABCD-1234"; echo "Open this URL to continue in your web browser: https://github.com/login/device"; i=0; while [ ! -e "$HOME/gh-approve" ]; do sleep 0.05; i=$((i+1)); [ $i -gt 400 ] && exit 1; done; touch "$HOME/gh-in"; exit 0 ;;
esac
exit 0`);
shim(there, "claude", `[ "$1 $2" = "auth status" ] && echo '{ "loggedIn": true, "email": "me@example.com" }'; exit 0`);
shim(there, "codex", `[ "$1 $2" = "login status" ] && echo "Not logged in"; exit 0`);
const mine = tempDir("cavvy-agent-setup-bin-");
const cloud = join(mine, "cloud");
mkdirSync(cloud);
shim(mine, "aws", `d=${JSON.stringify(cloud)}
echo "$*" >> "$d/calls"
case "$1 $2" in
"sts get-caller-identity") [ -e "$d/in" ] && { echo 123456789012; exit 0; }; echo "aws: [ERROR]: Unable to locate credentials. You can configure credentials by running \\"aws login\\"."; exit 253 ;;
"login ") echo "Attempting to open your default browser."; echo "https://us-east-1.signin.aws.amazon.com/v1/authorize?x=1"; i=0; while [ ! -e "$d/approve" ]; do sleep 0.05; i=$((i+1)); [ $i -gt 400 ] && exit 1; done; touch "$d/in"; exit 0 ;;
"lightsail delete-instance") [ -e "$d/in" ] || { echo "aws: [ERROR]: Unable to locate credentials."; exit 253; }; [ -e "$d/refuse" ] && { echo "An error occurred (AccessDeniedException): not allowed"; exit 254; }; echo deleted >> "$d/deleted"; exit 0 ;;
esac
exit 0`);
process.env.PATH = `${mine}:${process.env.PATH}`;

const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { expectHostKey, forgetServerKey, madeKey, makeServerKey, serverKeysDir, startupScript } = await import("../src/servers/keys");
const { setupTiming } = await import("../src/servers/agent-setup");
const { ownKnownHosts } = await import("../src/servers/ssh");
const { checkedCloud, getServer, listServers } = await import("../src/servers/store");
const { ServerAddTool, ServerKeyTool, ServerRemoveTool, serverServerTools } = await import("../src/tools/server-tools");
import type { BuildSource } from "../src/servers/build";
import type { ConfirmInteraction, ServerEvent, SessionSnapshot, SessionState, SignInInteraction, Turn } from "../src/server/protocol";
import type { ServerSetup } from "../src/tools/server-tools";
import type { ConfirmRequest, ToolContext } from "../src/tools/types";

// A new machine is looked at often, and what it installs isn't waited for long: nothing installs on the pretend one.
Object.assign(setupTiming, { readyMs: 15_000, settledMs: 300, everyMs: 100 });

const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { allowBypass: true } }));
const source: BuildSource = { id: A, gui: true, build: async () => fake.bundle(A, { gui: true }), compare: (theirs: string) => (theirs === A ? "same" : "older") } as BuildSource;
const srv = await startServer({ token: "mine", serverBuilds: source, log: () => undefined });

afterEach(() => fake.fail());
afterAll(async () => {
    await srv.stop().catch(() => undefined);
    mock.stop();
    fake.cleanup();
    iso.cleanup();
});

describe("the keys Cavvy makes for a new server", () => {
    test("a sign-in key only Cavvy reads, the server's own identity, and a start-up script that installs both", async () => {
        const made = await makeServerKey("keys-one");
        expect(made.identityFile).toBe(join(serverKeysDir(), "keys-one"));
        expect(statSync(made.identityFile).mode & 0o777).toBe(0o600);
        expect(statSync(serverKeysDir()).mode & 0o777).toBe(0o700);
        expect(made.publicKey).toMatch(/^ssh-ed25519 \S+ cavvy-keys-one$/);
        expect(made.hostPublicKey).toMatch(/^ssh-ed25519 \S+ cavvy-keys-one-host$/);
        const script = readFileSync(made.userDataFile, "utf-8");
        expect(statSync(made.userDataFile).mode & 0o777).toBe(0o600);
        expect(script.startsWith("#!/bin/sh\n")).toBe(true);
        expect(script).toContain(made.publicKey);
        expect(script).toContain(made.hostPublicKey);
        // The server's private host key is in it (that's how the server gets it), and nowhere else here; Cavvy's own private key never is.
        expect(script).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
        // (Its first lines are the same in every key of this kind: the ones after hold the key.)
        for (const line of readFileSync(made.identityFile, "utf-8").split("\n").slice(2, 5)) expect(script).not.toContain(line);
        expect(existsSync(join(serverKeysDir(), "keys-one.host"))).toBe(false);
        expect(script).toContain("PasswordAuthentication no");
        // Asked again for the same name: new keys, and the old script is gone.
        const again = await makeServerKey("keys-one");
        expect(again.publicKey).not.toBe(made.publicKey);
        expect(existsSync(made.userDataFile)).toBe(false);
        await expect(makeServerKey("Not A Name")).rejects.toThrow("lowercase");
    });

    test("the identity made for it is the only one its address may show; forgetting it leaves nothing", async () => {
        const made = await makeServerKey("keys-two");
        writeFileSync(ownKnownHosts(), "203.0.113.9 ssh-ed25519 AAAAoldmachine\nother.example ssh-ed25519 AAAAother\n");
        expect(expectHostKey("keys-two", "203.0.113.9")).toBe(ownKnownHosts());
        const [type, data] = made.hostPublicKey.split(" ");
        // An address handed on from a machine that's gone doesn't keep that machine's key.
        expect(readFileSync(ownKnownHosts(), "utf-8")).toBe(`other.example ssh-ed25519 AAAAother\n203.0.113.9 ${type} ${data}\n`);
        expectHostKey("keys-two", "203.0.113.9", 2222);
        expect(readFileSync(ownKnownHosts(), "utf-8")).toContain(`[203.0.113.9]:2222 ${type} ${data}`);
        expect(madeKey("keys-two")).toMatchObject({ identityFile: made.identityFile });
        forgetServerKey("keys-two", "203.0.113.9");
        expect(madeKey("keys-two")).toBeUndefined();
        expect(existsSync(made.identityFile)).toBe(false);
        expect(existsSync(made.userDataFile)).toBe(false);
        expect(readFileSync(ownKnownHosts(), "utf-8")).not.toMatch(/^203\.0\.113\.9 /m);
        expect(() => expectHostKey("never-made", "x.example")).toThrow("No key was made");
    });

    test("the script signs in the image's own user, and installs what agents use after the sign-in works", () => {
        const s = startupScript("ssh-ed25519 PUB cavvy-x", "-----BEGIN OPENSSH PRIVATE KEY-----\nHOSTPRIV\n-----END OPENSSH PRIVATE KEY-----\n", "ssh-ed25519 HOSTPUB cavvy-x-host");
        expect(s.indexOf("authorized_keys")).toBeLessThan(s.indexOf("apt-get"));
        expect(s.indexOf("systemctl restart ssh")).toBeLessThan(s.indexOf("apt-get"));
        expect(s).toContain("$3 == 1000");
        expect(s).toContain("touch /var/lib/cavvy-setup-done");
    });

    test("a rented machine's details: one short line each, and teardown commands that are words", () => {
        expect(checkedCloud({ provider: " AWS Lightsail ", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "x"]] })).toEqual({ provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "x"]] });
        expect(() => checkedCloud({ provider: "a\nb" })).toThrow("one short line");
        expect(() => checkedCloud({ provider: "AWS", teardown: [["sh", "-c", "rm -rf ~"]] })).toThrow("plain words");
        expect(() => checkedCloud({ provider: "AWS", teardown: [["/tmp/evil", "x"]] })).toThrow("plain words");
        expect(() => checkedCloud({ provider: "AWS", teardown: [["aws", "$(id)"]] })).toThrow("plain words");
    });
});

describe("the tools, by themselves", () => {
    const servers = (over: Partial<ServerSetup> = {}): ServerSetup => ({
        get: async () => undefined,
        names: async () => [],
        hasKey: async () => false,
        makeKey: async () => ({ userDataFile: "/tmp/cavvy-x/user-data.sh" }),
        add: async () => ({ lacks: [] }),
        copy: async () => "3 skills",
        remove: async () => undefined,
        ...over,
    });
    const ctx = (o: { servers?: ServerSetup | null; confirm?: (req: ConfirmRequest) => "yes" | "other" | "no"; mode?: string; signIns?: unknown[] } = {}) => {
        const asked: ConfirmRequest[] = [];
        const c = {
            state: { servers: o.servers === null ? undefined : (o.servers ?? servers()) },
            settings: { signIns: o.signIns },
            signal: new AbortController().signal,
            mode: () => o.mode ?? "bypassPermissions",
            ui: { confirm: o.confirm ? async (req: ConfirmRequest) => (asked.push(req), o.confirm!(req)) : undefined },
        } as unknown as ToolContext;
        return { c, asked };
    };
    const key = { name: "aws-mumbai", provider: "AWS Lightsail", where: "Mumbai", size: "2 CPUs · 2 GB · 60 GB", system: "Ubuntu 24.04", price: "$12/month" };

    test("ServerKey asks with the price in the question, in Bypass too, and makes keys only on Create", async () => {
        let made = 0;
        const s = servers({ makeKey: async () => (made++, { userDataFile: "/tmp/cavvy-x/user-data.sh" }) });
        const yes = ctx({ servers: s, confirm: () => "yes", mode: "bypassPermissions" });
        const r = await ServerKeyTool.run(key, yes.c);
        expect(yes.asked).toEqual([{ title: "Create a server for $12/month", facts: [["Name", "aws-mumbai"], ["Where", "AWS Lightsail · Mumbai"], ["Size", "2 CPUs · 2 GB · 60 GB"], ["System", "Ubuntu 24.04"]], yes: "Create", other: "Change…", no: "Cancel" }]);
        expect(r.content).toContain("The user approved: aws-mumbai at AWS Lightsail for $12/month.");
        expect(r.content).toContain("--user-data file:///tmp/cavvy-x/user-data.sh");
        expect(made).toBe(1);

        const change = await ServerKeyTool.run(key, ctx({ servers: s, confirm: () => "other" }).c);
        expect(change.content).toContain("Ask them what to change");
        const no = await ServerKeyTool.run(key, ctx({ servers: s, confirm: () => "no" }).c);
        expect(no.content).toBe("The user cancelled. Create nothing, and don't ask again unless they bring it up.");
        // Neither made a key: nothing to create a machine with.
        expect(made).toBe(1);
    });

    test("ServerKey: no one to ask, no keys; nor in plan mode, on a server, or for a name that's taken", async () => {
        let made = 0;
        const s = servers({ makeKey: async () => (made++, { userDataFile: "x" }), get: async (n) => (n === "taken" ? { destination: "a@b" } : undefined) });
        expect((await ServerKeyTool.run(key, ctx({ servers: s }).c)).content).toContain("no one is here to give it");
        expect((await ServerKeyTool.run(key, ctx({ servers: s, confirm: () => "yes", mode: "plan" }).c)).content).toContain("Plan mode");
        expect((await ServerKeyTool.run(key, ctx({ servers: null, confirm: () => "yes" }).c)).content).toContain("from the user's own machine");
        expect((await ServerKeyTool.run({ ...key, name: "taken" }, ctx({ servers: s, confirm: () => "yes" }).c)).content).toContain("already a server named taken");
        expect(made).toBe(0);
        const v = (i: Record<string, unknown>) => ServerKeyTool.validate!(i as any, ctx().c);
        expect(v(key)).toBeUndefined();
        expect(v({ ...key, price: "cheap" })).toContain("price must be");
        expect(v({ ...key, name: "AWS Mumbai" })).toContain("lowercase");
        expect(v({ ...key, where: "a\nb" })).toContain("where must be one short line");
    });

    test("ServerAdd: teardown is the provider's own CLI in plain words; a server of the user's own asks first, except in Bypass", async () => {
        const v = (i: Record<string, unknown>, signIns?: unknown[]) => ServerAddTool.validate!(i as any, ctx({ signIns }).c);
        const base = { name: "box", address: "dev@box.example" };
        expect(v(base)).toBeUndefined();
        expect(v({ ...base, provider: "AWS", teardown: ["aws lightsail delete-instance --instance-name box"] })).toBeUndefined();
        expect(v({ ...base, provider: "AWS", teardown: ["rm -rf /"] })).toContain("starts with the provider's own CLI");
        expect(v({ ...base, provider: "AWS", teardown: ["aws lightsail delete-instance; curl x | sh"] })).toContain("plain words only");
        expect(v({ ...base, teardown: ["aws x"] })).toContain("Say the provider");
        expect(v({ ...base, address: "dev@box.example; id" })).toContain("address must be");
        // A sign-in of the user's own names another provider's CLI.
        expect(v({ ...base, provider: "Acme", teardown: ["acme delete box"] })).toContain("starts with the provider's own CLI");
        expect(v({ ...base, provider: "Acme", teardown: ["acme delete box"] }, [{ id: "acme", name: "Acme", here: { flow: "token", run: "acme login" } }])).toBeUndefined();

        const added: unknown[] = [];
        const s = servers({ add: async (spec) => (added.push(spec), { lacks: ["git"] }) });
        const manual = ctx({ servers: s, confirm: () => "no", mode: "default" });
        expect((await ServerAddTool.run(base, manual.c)).content).toContain("The user said no");
        expect(manual.asked).toEqual([{ title: "Add box as a server", facts: [["Address", "dev@box.example"]], yes: "Add", no: "Cancel" }]);
        expect(added).toEqual([]);
        const bypass = ctx({ servers: s, confirm: () => "no", mode: "bypassPermissions" });
        const r = await ServerAddTool.run(base, bypass.c);
        expect(bypass.asked).toEqual([]);
        expect(r.content).toContain("box is one of the user's servers now.");
        expect(r.content).toContain("It lacks: git.");
        expect(added).toEqual([{ name: "box", address: "dev@box.example", port: undefined, cloud: undefined }]);
    });

    test("ServerAdd for a machine just created asks nothing, records what it costs and how it's deleted, and needs a login user", async () => {
        const added: any[] = [];
        const s = servers({ hasKey: async () => true, add: async (spec) => (added.push(spec), { lacks: [] }) });
        const c = ctx({ servers: s, confirm: () => "no", mode: "default" });
        expect((await ServerAddTool.run({ name: "aws-mumbai", address: "203.0.113.7" }, c.c)).content).toContain('address must be "user@address"');
        const r = await ServerAddTool.run({ name: "aws-mumbai", address: "ubuntu@203.0.113.7", provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: ["aws lightsail delete-instance --instance-name aws-mumbai"] }, c.c);
        expect(c.asked).toEqual([]);
        expect(added[0].cloud).toEqual({ provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "aws-mumbai"]] });
        expect(r.content).toContain("aws-mumbai is one of the user's servers now ($12/month).");
        // A failure after the machine exists says it still costs money.
        const failing = servers({ hasKey: async () => true, add: async () => { throw new Error("it didn't let Cavvy in"); } });
        expect((await ServerAddTool.run({ name: "aws-mumbai", address: "ubuntu@203.0.113.7" }, ctx({ servers: failing }).c)).content).toContain("still costs money");
    });

    test("ServerRemove shows what will be deleted and the commands, and does nothing on Cancel", async () => {
        const removed: string[] = [];
        const rented = { destination: "ubuntu@203.0.113.7", cloud: { provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "aws-mumbai"]] } };
        const s = servers({ get: async (n) => (n === "aws-mumbai" ? rented : n === "box" ? { destination: "dev@box.example" } : undefined), names: async () => ["aws-mumbai", "box"], remove: async (n) => void removed.push(n) });
        const no = ctx({ servers: s, confirm: () => "no", mode: "bypassPermissions" });
        expect((await ServerRemoveTool.run({ name: "aws-mumbai" }, no.c)).content).toContain("aws-mumbai is untouched");
        expect(no.asked).toEqual([{ title: "Delete aws-mumbai", facts: [["Where", "AWS Lightsail · Mumbai"], ["Cost", "$12/month"]], commands: ["aws lightsail delete-instance --instance-name aws-mumbai"], yes: "Delete", no: "Cancel", danger: true }]);
        expect(removed).toEqual([]);
        const yes = await ServerRemoveTool.run({ name: "aws-mumbai" }, ctx({ servers: s, confirm: () => "yes" }).c);
        expect(yes.content).toContain("aws-mumbai is deleted");
        // One that's only forgotten: asked in a mode that asks, not in Bypass.
        const manual = ctx({ servers: s, confirm: () => "yes", mode: "default" });
        expect((await ServerRemoveTool.run({ name: "box" }, manual.c)).content).toContain("box is forgotten here. Nothing on the server was touched");
        expect(manual.asked[0]).toMatchObject({ title: "Remove box from Cavvy", yes: "Remove" });
        const quiet = ctx({ servers: s, mode: "bypassPermissions" });
        await ServerRemoveTool.run({ name: "box" }, quiet.c);
        expect(quiet.asked).toEqual([]);
        expect(removed).toEqual(["aws-mumbai", "box", "box"]);
        expect((await ServerRemoveTool.run({ name: "nope" }, ctx({ servers: s }).c)).content).toBe("No server is called nope. The user's servers: aws-mumbai, box.");
    });

    test("served to Claude Code and Codex under their own names", () => {
        const tools = serverServerTools(async () => ({ text: "Call ServerAdd next, after RequestSignIn." }));
        expect(tools.map((t) => t.name)).toEqual(["server_key", "server_add", "server_remove"]);
        for (const t of tools) expect(t.description).not.toMatch(/ServerKey|ServerAdd|ServerRemove|RequestSignIn/);
        expect(tools[2]!.annotations).toMatchObject({ destructiveHint: true });
    });
});

/** A window on this machine's Cavvy. */
class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, { state: SessionState; turns: Turn[]; agents: any[]; seq: number }>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();
    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", "auth.mine"] } as any);
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) {
                const ev = msg.event as ServerEvent;
                this.events.push(ev);
                if (ev.type === "session.ops") {
                    const v = this.views.get(ev.sessionId);
                    if (v && ev.seq > v.seq) {
                        for (const op of ev.ops) applyOp(v as any, op);
                        v.seq = ev.seq;
                    }
                }
                for (const l of this.listeners) l();
                return;
            }
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            if (msg.error) w?.reject(new Error(msg.error.message));
            else w?.resolve(msg.result);
        };
    }
    opened() {
        return new Promise<void>((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error("connection failed"));
        });
    }
    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    }
    async session(cwd: string, mode: string) {
        const snap = await this.call<SessionSnapshot>("session.create", { cwd });
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        await this.call("session.setMode", { id: snap.state.id, mode });
        return snap.state.id;
    }
    view(id: string) {
        return this.views.get(id)!;
    }
    until(id: string, pred: (v: { state: SessionState; turns: Turn[] }) => boolean, what: string, ms = 30_000): Promise<void> {
        return new Promise((resolve, reject) => {
            const check = () => {
                const v = this.views.get(id);
                if (!v || !pred(v)) return;
                this.listeners.delete(check);
                clearTimeout(t);
                resolve();
            };
            const t = setTimeout(() => {
                this.listeners.delete(check);
                reject(new Error(`timed out waiting for ${what}; card ${JSON.stringify(this.views.get(id)?.state.interactions[0])}; last ${JSON.stringify(this.views.get(id)?.turns.at(-1)?.blocks.at(-1)).slice(0, 600)}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }
    async card<K extends "confirm" | "signin">(id: string, kind: K, ok: (i: any) => boolean = () => true): Promise<K extends "confirm" ? ConfirmInteraction : SignInInteraction> {
        const find = (v: { state: SessionState }) => v.state.interactions.find((i) => i.kind === kind && ok(i));
        await this.until(id, (v) => Boolean(find(v)), `a ${kind} card`);
        return find(this.view(id)) as any;
    }
}

const lastTurn = (v: { turns: Turn[] }) => v.turns[v.turns.length - 1]!;
const done = (v: { state: SessionState; turns: Turn[] }) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const said = (t: Turn) => t.blocks.filter((b): b is Extract<Turn["blocks"][number], { t: "text" }> => b.t === "text").map((b) => b.text).join("\n");

describe("from a window, with an agent doing it", () => {
    test("create: the price is asked in Bypass, the new machine is waited for and added with no key file and no trust question, and its sign-ins are offered", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        await c.call("session.send", { id, text: "newserver aws-mumbai dev@new.example" });

        const price = await c.card(id, "confirm");
        expect(price).toMatchObject({ title: "Create a server for $12/month", yes: "Create", other: "Change…", no: "Cancel", facts: [["Name", "aws-mumbai"], ["Where", "AWS Lightsail · Mumbai"], ["Size", "2 CPUs · 2 GB · 60 GB"], ["System", "Ubuntu 24.04"]] });
        expect(c.view(id).state.status).toBe("waiting");
        // Nothing exists until the user says so.
        expect(madeKey("aws-mumbai")).toBeUndefined();
        await c.call("session.respond", { id, interactionId: price.id, response: { kind: "confirm", choice: "yes" } });

        // The machine "starts": at first it shows the identity its image came with, then the one it was given.
        const until = Date.now() + 10_000;
        while (!madeKey("aws-mumbai") && Date.now() < until) await Bun.sleep(20);
        const made = madeKey("aws-mumbai")!;
        await Bun.sleep(400);
        expect(getServer("aws-mumbai")).toBeUndefined();
        fake.showHostKey(made.hostPublicKey);

        // Its sign-ins, in one card: what's signed in says who, what isn't offers to.
        const list = await c.card(id, "signin", (i) => i.step === "list");
        expect(list.machine).toBe("aws-mumbai");
        expect(list.rows).toEqual([{ target: "claude", name: "Claude Code", state: "in", who: "me@example.com" }, { target: "codex", name: "Codex", state: "out" }, { target: "gh", name: "GitHub", state: "out" }]);
        // It's listed already, with what it costs: the sign-ins aren't what adds it.
        const entry = getServer("aws-mumbai")!;
        expect(entry).toMatchObject({ destination: "dev@new.example", identityFile: made.identityFile, knownHostsFile: ownKnownHosts(), cloud: { provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "aws-mumbai"]] } });
        expect((await c.call("servers.list")).servers).toEqual([{ name: "aws-mumbai", destination: "dev@new.example", connected: false, cost: "$12/month", rented: true }]);
        expect(c.events.some((e) => e.type === "servers.changed" && e.count === 1)).toBe(true);
        // No trust question was asked, and the user's own known_hosts wasn't touched: the identity was known beforehand.
        expect(c.view(id).turns.flatMap((t) => t.blocks).some((b) => JSON.stringify(b).includes("Trust "))).toBe(false);
        expect(fake.knownHosts()).not.toContain("new.example");
        // The script, with the server's private key in it, is gone once it's added.
        expect(readFileSync(join(serverKeysDir(), "aws-mumbai.host.pub"), "utf-8")).toContain("ssh-ed25519");
        expect(existsSync(join(serverKeysDir(), "aws-mumbai.script"))).toBe(false);

        // GitHub there: it can take a token, so it asks how; then the code, and back to the list with who.
        const step = (action: Record<string, unknown>) => c.call("session.respond", { id, interactionId: list.id, response: { kind: "signin", ...action } });
        await step({ action: "pick", target: "gh" });
        const ask = await c.card(id, "signin", (i) => i.step === "ask");
        expect(ask).toMatchObject({ name: "GitHub", machine: "aws-mumbai", warning: "Agents there can push as you", canToken: true, back: true });
        await step({ action: "start" });
        expect(await c.card(id, "signin", (i) => i.step === "code")).toMatchObject({ code: "ABCD-1234", site: "github.com/login/device" });
        writeFileSync(join(fake.home, "gh-approve"), "");
        const back = await c.card(id, "signin", (i) => i.step === "list" && i.rows?.find((r: any) => r.target === "gh")?.state === "in");
        expect(back.rows!.find((r) => r.target === "gh")).toEqual({ target: "gh", name: "GitHub", state: "in", who: "octo" });
        await step({ action: "later" });

        await c.until(id, done, "the turn's end");
        const text = said(lastTurn(c.view(id)));
        expect(text).toContain("aws-mumbai is one of the user's servers now ($12/month). Sessions there run without asking (Bypass).");
        expect(text).toContain("Signed in to Claude Code on aws-mumbai as me@example.com.");
        expect(text).toContain("Signed in to GitHub on aws-mumbai as octo.");
        expect(text).toContain("Not signed in to Codex on aws-mumbai: the user chose Later.");
        // What was put off stays reachable.
        expect(c.view(id).state.watches).toEqual([{ id: "sign-in:aws-mumbai:codex", kind: "sign-in", label: "Sign in to Codex on aws-mumbai" }]);
        await c.call("session.stopWatch", { id, watchId: "sign-in:aws-mumbai:codex" });
        c.ws.close();
    });

    test("Change… and Cancel create nothing", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        await c.call("session.send", { id, text: "newserver other-one dev@other.example" });
        const price = await c.card(id, "confirm");
        await c.call("session.respond", { id, interactionId: price.id, response: { kind: "confirm", choice: "other" } });
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toBe("A small one in Mumbai fits.\nWhat would you like instead?");
        expect(madeKey("other-one")).toBeUndefined();
        await c.call("session.send", { id, text: "newserver other-one dev@other.example" });
        const again = await c.card(id, "confirm");
        // Esc, or a window closing the card, is a no. So is an answer the card didn't offer.
        await expect(c.call("session.respond", { id, interactionId: again.id, response: { kind: "permission", choice: "yes" } })).rejects.toThrow("doesn't match");
        await c.call("session.respond", { id, interactionId: again.id, response: { kind: "confirm", choice: "maybe" } });
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toContain("Nothing was created.");
        expect(madeKey("other-one")).toBeUndefined();
        expect(getServer("other-one")).toBeUndefined();
        c.ws.close();
    });

    test("a server the user already has: its key is shown for their word, and without it nothing is added", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        fake.restoreHostKey();
        await c.call("session.send", { id, text: "addserver box dev@box.example" });
        const trust = await c.card(id, "confirm");
        expect(trust).toMatchObject({ title: "Trust box.example", yes: "Trust", no: "Cancel", facts: [["Key", expect.stringMatching(/^SHA256:\S+ \(ED25519\)$/)]] });
        await c.call("session.respond", { id, interactionId: trust.id, response: { kind: "confirm", choice: "no" } });
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toContain("box wasn't added: The user didn't trust box.example's key.");
        expect(getServer("box")).toBeUndefined();

        await c.call("session.send", { id, text: "addserver box dev@box.example" });
        const again = await c.card(id, "confirm");
        await c.call("session.respond", { id, interactionId: again.id, response: { kind: "confirm", choice: "yes" } });
        // Then its sign-ins, as for any server.
        const list = await c.card(id, "signin", (i) => i.step === "list");
        await c.call("session.respond", { id, interactionId: list.id, response: { kind: "signin", action: "later" } });
        await c.until(id, done, "the turn's end");
        expect(getServer("box")).toMatchObject({ destination: "dev@box.example" });
        expect(getServer("box")!.identityFile).toBeUndefined();
        expect(fake.knownHosts()).toContain("box.example ");
        for (const w of c.view(id).state.watches ?? []) await c.call("session.stopWatch", { id, watchId: w.id });
        c.ws.close();
    });

    test("delete: asked in Bypass with the commands shown; the provider's sign-in is asked for on the way; then the machine, the server and its keys are gone", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        const made = madeKey("aws-mumbai") ?? { hostPublicKey: readFileSync(join(serverKeysDir(), "aws-mumbai.host.pub"), "utf-8") };
        fake.showHostKey(made.hostPublicKey);
        await c.call("session.send", { id, text: "deleteserver aws-mumbai" });
        const ask = await c.card(id, "confirm");
        expect(ask).toMatchObject({ title: "Delete aws-mumbai", danger: true, yes: "Delete", no: "Cancel", facts: [["Where", "AWS Lightsail · Mumbai"], ["Cost", "$12/month"]], commands: ["aws lightsail delete-instance --instance-name aws-mumbai"] });
        expect(existsSync(join(cloud, "calls"))).toBe(false);
        await c.call("session.respond", { id, interactionId: ask.id, response: { kind: "confirm", choice: "yes" } });

        // The provider's CLI is signed out: its card, then the same command again.
        const signIn = await c.card(id, "signin", (i) => i.step === "ask");
        expect(signIn).toMatchObject({ name: "AWS", target: "aws" });
        expect(signIn.machine).toBeUndefined();
        await c.call("session.respond", { id, interactionId: signIn.id, response: { kind: "signin", action: "start" } });
        await c.card(id, "signin", (i) => i.step === "browser" && Boolean(i.url));
        writeFileSync(join(cloud, "approve"), "");
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toContain("aws-mumbai is deleted");
        expect(readFileSync(join(cloud, "deleted"), "utf-8")).toBe("deleted\n");
        expect(readFileSync(join(cloud, "calls"), "utf-8").split("\n").filter((l) => l.startsWith("lightsail delete-instance"))).toEqual(["lightsail delete-instance --instance-name aws-mumbai", "lightsail delete-instance --instance-name aws-mumbai"]);
        expect(getServer("aws-mumbai")).toBeUndefined();
        expect(existsSync(join(serverKeysDir(), "aws-mumbai"))).toBe(false);
        expect(readFileSync(ownKnownHosts(), "utf-8")).not.toMatch(/^new\.example /m);
        expect(listServers().map((s) => s.name)).toEqual(["box"]);
        expect(c.events.filter((e) => e.type === "servers.changed").at(-1)).toMatchObject({ count: 1 });
        c.ws.close();
    });

    test("a teardown that fails leaves the server listed, with the provider's own words", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        const { saveServer } = await import("../src/servers/store");
        saveServer({ ...getServer("box")!, name: "rented", cloud: { provider: "AWS Lightsail", cost: "$5/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "rented"]] } });
        writeFileSync(join(cloud, "refuse"), "");
        await c.call("session.send", { id, text: "deleteserver rented" });
        const ask = await c.card(id, "confirm");
        await c.call("session.respond", { id, interactionId: ask.id, response: { kind: "confirm", choice: "yes" } });
        await c.until(id, done, "the turn's end");
        const text = said(lastTurn(c.view(id)));
        expect(text).toContain("rented wasn't removed: `aws lightsail delete-instance --instance-name rented` failed:");
        expect(text).toContain("AccessDeniedException");
        expect(text).toContain("still costs money");
        expect(getServer("rented")).toBeDefined();
        c.ws.close();
    });
});
