// This machine's skills and commands kept on its servers (src/servers/sync.ts): what's sent, what a server takes,
// and what it leaves alone (its own files, and ones it was given that changed there).

import { afterAll, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { applySync, localSyncFiles, readSynced, syncablePath, syncedWatchTargets, syncTo } = await import("../src/servers/sync");

afterAll(() => iso.cleanup());

const claude = process.env.CLAUDE_CONFIG_DIR!;
const put = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
};
/** A server's home, and a sync to it over a pretend connection that runs its side here. */
const server = tempDir("cavvy-sync-home-");
const sent: { method: string; params: any }[] = [];
const ask = async (method: string, params: any) => {
    sent.push({ method, params });
    if (method === "sync.files") return readSynced();
    return applySync(params.files, params.remove, server);
};

test("only the synced folders' and single files' plain paths are taken", () => {
    for (const ok of [
        ".cavvy/skills/a/SKILL.md",
        ".claude/skills/a/refs/x.md",
        ".codex/skills/a/SKILL.md",
        ".agents/skills/a/SKILL.md",
        ".cavvy/commands/fix.md",
        ".claude/commands/review.md",
        ".cavvy/agents/reviewer.md",
        ".claude/agents/qa.md",
        ".cavvy/agent-memory/reviewer/MEMORY.md",
        ".cavvy/themes/ocean.json",
        ".claude/rules/style.md",
        ".cavvy/CAVVY.md",
        ".claude/CLAUDE.md",
        ".codex/AGENTS.md",
        ".codex/AGENTS.override.md",
        ".cavvy/keybindings.json",
    ]) expect(syncablePath(ok)).toBe(true);
    for (const bad of [
        ".cavvy/settings.json",
        ".cavvy/providers.json",
        ".cavvy/credentials.json",
        ".claude/.credentials.json",
        ".claude/.claude.json",
        ".codex/auth.json",
        // A CLI's own, which it keeps level itself on each machine.
        ".claude/skills/synced/org_user/pdf/SKILL.md",
        ".codex/skills/.system/imagegen/SKILL.md",
        ".cavvy/skills/a/.env",
        ".cavvy/skills/a/id_ed25519",
        ".cavvy/skills/../settings.json",
        "/etc/passwd",
        ".cavvy/skills//x",
        ".cavvy/skills/a\\b",
        ".ssh/authorized_keys",
        ".claude/skills/synced/org_user/pdf/SKILL.md",
        7,
    ]) expect(syncablePath(bad)).toBe(false);
    expect(syncablePath(".claude/skills/synced-notes/SKILL.md")).toBe(true);
});

test("a server gets this machine's skills and commands, not a file that holds a key, and is brought level after", async () => {
    put(join(iso.home, "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview it.");
    put(join(claude, "skills", "ship", "SKILL.md"), "---\nname: ship\n---\nShip it.");
    put(join(iso.home, "commands", "fix.md"), "Fix the bug.");
    // Claude Code's own, from the account it's signed in to: it keeps those level itself on each machine. A skill
    // of the user's that happens to hold a folder called that is theirs.
    put(join(claude, "skills", "synced", "org_user", "pdf", "SKILL.md"), "From the account.");
    put(join(process.env.CODEX_HOME!, "skills", ".system", "imagegen", "SKILL.md"), "Codex's own.");
    put(join(claude, "skills", "ship", "synced", "notes.md"), "Mine.");
    put(join(iso.home, "skills", "deploy", "SKILL.md"), "Use the key AKIAIOSFODNN7EXAMPLE to deploy.");
    put(join(iso.home, "skills", "deploy", ".env"), "X=1");
    const mine = localSyncFiles();
    expect([...mine.keys()].sort()).toEqual([".cavvy/commands/fix.md", ".cavvy/skills/review/SKILL.md", ".claude/skills/ship/SKILL.md", ".claude/skills/ship/synced/notes.md"]);

    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/skills/review/SKILL.md"), "utf-8")).toContain("Review it.");
    expect(readFileSync(join(server, ".claude/skills/ship/SKILL.md"), "utf-8")).toContain("Ship it.");
    expect(existsSync(join(server, ".cavvy/skills/deploy"))).toBe(false);
    // Level now: the next sync only asks what it has.
    sent.length = 0;
    await syncTo(ask);
    expect(sent.map((s) => s.method)).toEqual(["sync.files"]);

    // Changed here: changed there. Deleted here: deleted there, folder and all.
    put(join(iso.home, "skills", "review", "SKILL.md"), "Review it twice.");
    (await import("fs")).rmSync(join(claude, "skills", "ship"), { recursive: true });
    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/skills/review/SKILL.md"), "utf-8")).toBe("Review it twice.");
    expect(existsSync(join(server, ".claude/skills/ship"))).toBe(false);
});

test("a server's own skills, and ones it was given that changed there, are left as they are", async () => {
    // Its own, by a name this machine also has: kept, and not taken over.
    put(join(server, ".cavvy/commands/mine.md"), "The server's own.");
    put(join(iso.home, "commands", "mine.md"), "This machine's.");
    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/commands/mine.md"), "utf-8")).toBe("The server's own.");
    // Given, then changed there by an agent: kept when it changes here, and when it's deleted here.
    put(join(server, ".cavvy/commands/fix.md"), "Fixed on the server.");
    put(join(iso.home, "commands", "fix.md"), "Fix the bug, again.");
    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/commands/fix.md"), "utf-8")).toBe("Fixed on the server.");
    (await import("fs")).rmSync(join(iso.home, "commands", "fix.md"));
    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/commands/fix.md"), "utf-8")).toBe("Fixed on the server.");
});

test("a server writes nothing through a link below the synced folder, nor outside it", () => {
    const elsewhere = tempDir("cavvy-sync-elsewhere-");
    mkdirSync(join(server, ".cavvy/skills"), { recursive: true });
    symlinkSync(elsewhere, join(server, ".cavvy/skills/linked"));
    const r = applySync(
        [
            { path: ".cavvy/skills/linked/SKILL.md", data: Buffer.from("x").toString("base64") },
            { path: ".cavvy/skills/../../.bashrc", data: Buffer.from("x").toString("base64") },
        ],
        [],
        server,
    );
    expect(r.written).toBe(0);
    expect(existsSync(join(elsewhere, "SKILL.md"))).toBe(false);
    expect(existsSync(join(server, ".bashrc"))).toBe(false);
});

test("what the one-time copy left there, as this machine has it, is kept level after; the app's copy leaves skills to this", async () => {
    put(join(iso.home, "skills", "copied", "SKILL.md"), "Copied once.");
    put(join(server, ".cavvy/skills/copied/SKILL.md"), "Copied once.");
    await syncTo(ask);
    expect(readSynced()[".cavvy/skills/copied/SKILL.md"]).toBeDefined();
    put(join(iso.home, "skills", "copied", "SKILL.md"), "Changed here.");
    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/skills/copied/SKILL.md"), "utf-8")).toBe("Changed here.");
    const { planCopy } = await import("../src/servers/copy");
    const plan = planCopy(undefined, { skills: false });
    try {
        expect([plan.counts.skills, plan.counts.commands]).toEqual([0, 0]);
    } finally {
        plan.cleanup();
    }
});

test("a file still here but left out of a scan isn't removed there", async () => {
    put(join(iso.home, "skills", "kept", "SKILL.md"), "Kept.");
    await syncTo(ask);
    // Now holds a key: not sent, but not gone here either.
    put(join(iso.home, "skills", "kept", "SKILL.md"), "Kept. AKIAIOSFODNN7EXAMPLE");
    await syncTo(ask);
    expect(readFileSync(join(server, ".cavvy/skills/kept/SKILL.md"), "utf-8")).toBe("Kept.");
});

test("memory, agents, themes, keybindings and symlinked skills sync while links to CLI credentials are refused", async () => {
    const extSkill = tempDir("cavvy-linked-skill-");
    put(join(extSkill, "SKILL.md"), "---\nname: linked-skill\n---\nFrom dotfiles.");
    mkdirSync(join(iso.home, "skills"), { recursive: true });
    symlinkSync(extSkill, join(iso.home, "skills", "linked-skill"));
    // A symlink or hard link under an allowed name pointing to a CLI credential file must never be read or synced.
    const creds = join(claude, ".credentials.json");
    put(creds, '{"token":"plain-text-that-does-not-match-regex"}');
    mkdirSync(join(iso.home, "commands"), { recursive: true });
    symlinkSync(creds, join(iso.home, "commands", "leak.md"));
    linkSync(creds, join(iso.home, "commands", "hardlink.md"));

    put(join(iso.home, "CAVVY.md"), "Be brief.");
    put(join(claude, "CLAUDE.md"), "Claude rules.");
    put(join(claude, "rules", "ts.md"), "Strict TS.");
    put(join(iso.home, "agents", "reviewer.md"), "---\nname: reviewer\n---\nCheck diffs.");
    put(join(iso.home, "themes", "night.json"), '{"name":"night"}');
    put(join(iso.home, "keybindings.json"), '{"bindings":[]}');

    const targets = syncedWatchTargets();
    expect(targets.recursive).toContain(realpathSync(extSkill));
    expect(targets.shallow.some((s) => s.dir === iso.home && s.names.has("settings.json") && s.names.has("CAVVY.md") && s.names.has("providers.json"))).toBe(true);

    const mine = localSyncFiles();
    expect(mine.has(".cavvy/commands/leak.md")).toBe(false);
    expect(mine.has(".cavvy/commands/hardlink.md")).toBe(false);

    const res = await syncTo(ask);
    expect(res.written).toBeGreaterThanOrEqual(7);
    expect(existsSync(join(server, ".cavvy/commands/leak.md"))).toBe(false);
    expect(existsSync(join(server, ".cavvy/commands/hardlink.md"))).toBe(false);
    expect(readFileSync(join(server, ".cavvy/skills/linked-skill/SKILL.md"), "utf-8")).toContain("From dotfiles.");
    expect(readFileSync(join(server, ".cavvy/CAVVY.md"), "utf-8")).toBe("Be brief.");
    expect(readFileSync(join(server, ".claude/CLAUDE.md"), "utf-8")).toBe("Claude rules.");
    expect(readFileSync(join(server, ".claude/rules/ts.md"), "utf-8")).toBe("Strict TS.");
    expect(readFileSync(join(server, ".cavvy/agents/reviewer.md"), "utf-8")).toContain("Check diffs.");
    expect(readFileSync(join(server, ".cavvy/themes/night.json"), "utf-8")).toBe('{"name":"night"}');
    expect(readFileSync(join(server, ".cavvy/keybindings.json"), "utf-8")).toBe('{"bindings":[]}');
});

test("a server whose sync isn't on gets skills and commands only, as servers always did", async () => {
    put(join(iso.home, "skills", "basic-skill", "SKILL.md"), "---\nname: basic-skill\n---\nA skill.");
    put(join(iso.home, "commands", "basic.md"), "A command.");
    put(join(iso.home, "themes", "basic-theme.json"), '{"name":"basic-theme"}');
    put(join(iso.home, "CAVVY.md"), "Basic memory.");
    sent.length = 0;
    await syncTo(ask, { basic: true });
    const paths = sent.filter((s) => s.method === "sync.apply").flatMap((s) => (s.params.files as { path: string }[]).map((f) => f.path));
    expect(paths).toContain(".cavvy/skills/basic-skill/SKILL.md");
    expect(paths).toContain(".cavvy/commands/basic.md");
    expect(paths.filter((p) => !/^\.(cavvy|claude)\/skills\/|^\.cavvy\/commands\//.test(p))).toEqual([]);
    expect(existsSync(join(server, ".cavvy/themes/basic-theme.json"))).toBe(false);
});
