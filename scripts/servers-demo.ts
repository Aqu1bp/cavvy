// Try what a window shows of the user's servers, without a server: this computer's Cavvy in a throwaway home, and
// two pretend servers (test/helpers/fake-ssh.ts) it's connected to and keeps in sync, for real. Nothing of this
// machine's own is read or signed in: the CLIs are stand-ins (test/fixtures/fake-claude.ts, fake-codex.ts).
//
//   bun run gui:build && bun scripts/servers-demo.ts        then open the printed link
//   bun scripts/servers-demo.ts --port 4610 --token <16+ characters>
//
// What it sets up:
//   here          Claude Code (two accounts: Default and Work) and Codex, turned on and signed in; an Anthropic key
//   on "vps"      Claude Code installed, neither account signed in; no Codex; key sync off
//   on "box"      Claude Code and Codex, signed in
// So Settings → Providers offers the three machines, with a mark on vps. On vps, Sign in runs the pretend sign-in
// there (it finishes by itself), and "Sync keys" sends the key. The Machines menu's key and sync buttons work
// against the pretend servers too.

import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { isolate } from "../test/helpers/isolate";
import { fakeSsh } from "../test/helpers/fake-ssh";
import type { BuildSource } from "../src/servers/build";
import type { ServerEntry } from "../src/servers/store";

const args = process.argv.slice(2);
const arg = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};

// Before anything of src is loaded: it reads where its home is as it starts.
const iso = isolate();
const repo = resolve(import.meta.dir, "..");
// Each pretend server has its own stand-in for ssh: one program in front picks by the address it's given.
const servers = { vps: fakeSsh(), box: fakeSsh() };
const front = join(iso.home, "demo-ssh");
writeFileSync(front, `#!/bin/sh\ncase " $* " in *box.example*) exec ${JSON.stringify(servers.box.bin)} "$@" ;; esac\nexec ${JSON.stringify(servers.vps.bin)} "$@"\n`);
chmodSync(front, 0o755);
process.env.CAVVY_SSH = front;

const { startMockLlm } = await import("./mock-llm");
const { startServer } = await import("../src/server/server");
const { setUpServer } = await import("../src/servers/install");
const { stopRemote } = await import("../src/servers/service");
const { saveServer } = await import("../src/servers/store");
const { saveAgentConfig } = await import("../src/providers/registry");
const { addAccount } = await import("../src/providers/accounts");
const { setKey } = await import("../src/auth/credentials");

const mock = startMockLlm({ delayMs: 14 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock (demo)", baseUrl: mock.url, requiresKey: false }] }, null, 2));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }, null, 2));

// This computer's CLIs: the tests' stand-ins, signed in.
const bin = join(iso.home, "demo-bin");
mkdirSync(bin, { recursive: true });
const standIn = (fixture: string) => `exec "${process.execPath}" --no-env-file "${join(repo, "test", "fixtures", fixture)}" "$@"`;
for (const [provider, fixture] of [["claude-code", "fake-claude.ts"], ["codex", "fake-codex.ts"]] as const) {
    const file = join(bin, provider);
    writeFileSync(file, `#!/bin/sh\n${standIn(fixture)}\n`);
    chmodSync(file, 0o700);
    saveAgentConfig(provider, { path: file });
}
addAccount("claude-code", { id: "work", name: "Work" });
await setKey("anthropic", "sk-ant-api03-demo-key-that-opens-nothing-0000000000");

// vps's Claude Code: signed out until its sign-in is run, which shows a link and finishes by itself.
servers.vps.install(
    "claude",
    [
        'flag="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.demo-signed-in"',
        'if [ "$1 $2" = "auth login" ]; then',
        '  echo "Open this link to sign in: https://claude.example/device?code=DEMO-1234"',
        "  sleep 4",
        '  mkdir -p "$(dirname "$flag")" && : > "$flag"',
        '  echo "Signed in as me@example.com"',
        "  exit 0",
        "fi",
        'if [ -f "$flag" ]; then printf \'{"loggedIn":true,"email":"me@example.com"}\\n\'; else printf \'{"loggedIn":false}\\n\'; fi',
    ].join("\n"),
);
// box has both, signed in: the tests' stand-ins again.
servers.box.install("claude", standIn("fake-claude.ts"));
servers.box.install("codex", standIn("fake-codex.ts"));

const BUILD = "demodemodemo-1";
const entries: ServerEntry[] = [];
let source: BuildSource | undefined;
for (const [name, fake] of Object.entries(servers)) {
    // Both run this checkout, under one build's name: this machine's Cavvy takes either for its own build.
    const made = { id: BUILD, gui: true, build: async () => fake.bundle(BUILD, { gui: true }), compare: (theirs: string) => (theirs === BUILD ? "same" : "older") } as BuildSource;
    const entry: ServerEntry = { name, destination: `dev@${name}.example`, addedAt: new Date().toISOString() };
    fake.trust(`${name}.example`);
    await setUpServer(entry, { source: made });
    saveServer(entry);
    entries.push(entry);
    source ??= made;
}

const token = arg("--token") ?? "servers-demo-token-0000";
const mine = await startServer({ token, port: Number(arg("--port") ?? 4610), serverBuilds: source, staticDir: join(repo, "gui", "dist") });
process.stderr.write(`\n  open:        http://127.0.0.1:${mine.port}/#token=${token}\n  this home:   ${iso.home}\n  vps's home:  ${servers.vps.home}\n  box's home:  ${servers.box.home}\n\n`);

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    await mine.stop().catch(() => undefined);
    for (const e of entries) await stopRemote(e).catch(() => undefined);
    mock.stop();
    for (const fake of Object.values(servers)) fake.cleanup();
    iso.cleanup();
    process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
