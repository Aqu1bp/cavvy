// Moving from Harness, Cavvy's old name (src/config/legacy.ts): the home folder
// and what stores paths into it, and what's still read by the old names.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { currentMcpName, fileIn, homeAliases, inProjectDir, LEGACY, legacyEnvNotes, moveLegacyHome, rewritePaths } from "../src/config/legacy";
import { backendMatcher, hookApplies } from "../src/agent/hooks";
import { parseAgentFile } from "../src/agent/agents";
import { parseRule, ruleMatches } from "../src/permissions/rules";
import { moveLegacyKeys } from "../gui/src/lib/legacy-storage";
import { fromLegacyKeychain } from "../src/auth/credentials";

let T: string;
beforeEach(() => {
    T = realpathSync(mkdtempSync(join(tmpdir(), "cavvy-legacy-")));
});
afterEach(() => {
    rmSync(T, { recursive: true, force: true });
});

const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** A Harness home with an account, a plugin and personal memory, as Harness left them. */
function harnessHome(): string {
    const old = join(T, ".harness");
    const account = join(old, "accounts", "claude-code", "work");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, LEGACY.accountMarker), "~/.claude\n");
    mkdirSync(join(old, "plugins"), { recursive: true });
    writeFileSync(join(old, "providers.json"), JSON.stringify({ agents: { "claude-code": { accounts: [{ id: "work", folder: account, managed: true }] } }, keychain: ["anthropic"] }));
    writeFileSync(join(old, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "x@m": [{ installPath: join(old, "plugins", "cache", "m", "x", "1"), version: "1" }] } }));
    writeFileSync(join(old, LEGACY.memory), "be brief\n");
    mkdirSync(join(old, "projects", "p"), { recursive: true });
    writeFileSync(join(old, "projects", "p", "s.jsonl"), `{"path":"${join(old, "projects", "p", "img.png")}"}\n`);
    return old;
}

describe("moving the home folder", () => {
    test("moves ~/.harness to ~/.cavvy and leaves a link where it was", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        const r = moveLegacyHome(home, old);
        expect(r.home).toBe(home);
        expect(lstatSync(home).isDirectory()).toBe(true);
        expect(lstatSync(old).isSymbolicLink()).toBe(true);
        expect(readlinkSync(old)).toBe(home);
        expect(r.notes[0]).toContain("Harness is now Cavvy");
    });

    test("rewrites the paths accounts and plugins check exactly, and leaves session logs to the link", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        moveLegacyHome(home, old);
        expect(json(join(home, "providers.json")).agents["claude-code"].accounts[0].folder).toBe(join(home, "accounts", "claude-code", "work"));
        expect(json(join(home, "providers.json")).keychain).toEqual(["anthropic"]);
        expect(json(join(home, "plugins", "installed_plugins.json")).plugins["x@m"][0].installPath).toBe(join(home, "plugins", "cache", "m", "x", "1"));
        // History isn't rewritten: its old paths still lead to the files, through the link.
        const line = readFileSync(join(home, "projects", "p", "s.jsonl"), "utf8");
        expect(line).toContain(join(old, "projects"));
    });

    test("renames the account markers and personal memory, and says Claude Code accounts sign in again", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        const r = moveLegacyHome(home, old);
        const account = join(home, "accounts", "claude-code", "work");
        expect(existsSync(join(account, ".cavvy-shared-from"))).toBe(true);
        expect(existsSync(join(account, LEGACY.accountMarker))).toBe(false);
        expect(readFileSync(join(home, "CAVVY.md"), "utf8")).toBe("be brief\n");
        expect(r.notes.some((n) => n.includes("sign-in again"))).toBe(true);
    });

    test("moves nothing when ~/.cavvy exists, and says both are there; nothing to do without ~/.harness", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        mkdirSync(home);
        const r = moveLegacyHome(home, old);
        expect(r.home).toBe(home);
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0]).toContain(`Both ${old} (Harness's) and ${home} exist`);
        expect(lstatSync(old).isDirectory()).toBe(true);
        expect(moveLegacyHome(join(T, "other"), join(T, "missing"))).toEqual({ home: join(T, "other"), notes: [] });
    });

    test("a second call (another process, or the next start) finds it done", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        moveLegacyHome(home, old);
        expect(existsSync(join(home, ".moving-from-harness.json"))).toBe(false);
        expect(moveLegacyHome(home, old)).toEqual({ home, notes: [] });
    });

    test("a move that stopped after the rename is finished by the next call", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        // As a process that renamed it and then crashed leaves it: the marker, no link, nothing rewritten.
        writeFileSync(join(old, ".moving-from-harness.json"), JSON.stringify({ from: old }));
        renameSync(old, home);
        const r = moveLegacyHome(home, old);
        expect(r.notes[0]).toContain("Harness is now Cavvy");
        expect(readlinkSync(old)).toBe(home);
        expect(json(join(home, "providers.json")).agents["claude-code"].accounts[0].folder).toBe(join(home, "accounts", "claude-code", "work"));
        expect(existsSync(join(home, "accounts", "claude-code", "work", ".cavvy-shared-from"))).toBe(true);
        expect(existsSync(join(home, ".moving-from-harness.json"))).toBe(false);
    });

    test("an accounts folder that can't be read leaves the move to be finished next time", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        chmodSync(join(old, "accounts", "claude-code"), 0o000);
        try {
            expect(moveLegacyHome(home, old).notes.join("\n")).toContain("isn't finished");
            expect(existsSync(join(home, ".moving-from-harness.json"))).toBe(true);
        } finally {
            chmodSync(join(home, "accounts", "claude-code"), 0o700);
        }
        expect(moveLegacyHome(home, old).notes[0]).toContain("Harness is now Cavvy");
        expect(existsSync(join(home, "accounts", "claude-code", "work", ".cavvy-shared-from"))).toBe(true);
    });

    test("an account folder that can't be looked into leaves the move to be finished next time", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        chmodSync(join(old, "accounts", "claude-code", "work"), 0o000);
        try {
            expect(moveLegacyHome(home, old).notes.join("\n")).toContain("isn't finished");
        } finally {
            chmodSync(join(home, "accounts", "claude-code", "work"), 0o700);
        }
        expect(moveLegacyHome(home, old).notes[0]).toContain("Harness is now Cavvy");
        expect(existsSync(join(home, "accounts", "claude-code", "work", ".cavvy-shared-from"))).toBe(true);
    });

    test("a ~/.harness that was a link elsewhere: stored paths become the real ones accounts are checked by", () => {
        const real = join(T, "volume", "harness-state");
        mkdirSync(join(real, "accounts", "codex", "w"), { recursive: true });
        const old = join(T, ".harness");
        symlinkSync(real, old);
        writeFileSync(join(real, "providers.json"), JSON.stringify({ agents: { codex: { accounts: [{ id: "w", folder: join(old, "accounts", "codex", "w") }, { id: "v", folder: join(real, "accounts", "codex", "v") }] } } }));
        const home = join(T, ".cavvy");
        moveLegacyHome(home, old);
        const accounts = json(join(real, "providers.json")).agents.codex.accounts;
        expect(accounts.map((a: { folder: string }) => a.folder)).toEqual([join(real, "accounts", "codex", "w"), join(real, "accounts", "codex", "v")]);
        expect(realpathSync(home)).toBe(real);
    });

    test("a step that fails leaves the move to be finished next time", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        writeFileSync(join(old, "providers.json"), "{ not json");
        const r = moveLegacyHome(home, old);
        expect(r.notes.join("\n")).toContain("isn't finished");
        expect(existsSync(join(home, ".moving-from-harness.json"))).toBe(true);
        writeFileSync(join(home, "providers.json"), JSON.stringify({ agents: { codex: { accounts: [{ id: "w", folder: join(old, "accounts", "codex", "w") }] } } }));
        expect(moveLegacyHome(home, old).notes[0]).toContain("Harness is now Cavvy");
        expect(json(join(home, "providers.json")).agents.codex.accounts[0].folder).toBe(join(home, "accounts", "codex", "w"));
        expect(existsSync(join(home, ".moving-from-harness.json"))).toBe(false);
    });

    test("keeps using ~/.harness when it can't be moved", () => {
        const old = harnessHome();
        // A home whose parent doesn't exist: the rename fails, and nothing is lost.
        const r = moveLegacyHome(join(T, "no", "such", ".cavvy"), old);
        expect(r.home).toBe(old);
        expect(r.notes[0]).toContain("Couldn't move");
        expect(lstatSync(old).isDirectory()).toBe(true);
        expect(existsSync(join(old, ".moving-from-harness.json"))).toBe(false);
    });

    test("an unchanged file isn't rewritten", () => {
        const f = join(T, "x.json");
        writeFileSync(f, '{"a":"/elsewhere"}');
        rewritePaths(f, [join(T, ".harness")], join(T, ".cavvy"));
        expect(readFileSync(f, "utf8")).toBe('{"a":"/elsewhere"}');
    });

    test("only whole path components match: ~/.harness-backup isn't inside ~/.harness", () => {
        const f = join(T, "x.json");
        const old = join(T, ".harness");
        writeFileSync(f, JSON.stringify({ a: old + "-backup/x", b: old, c: [join(old, "y")] }));
        rewritePaths(f, [old], join(T, ".cavvy"));
        expect(json(f)).toEqual({ a: old + "-backup/x", b: join(T, ".cavvy"), c: [join(T, ".cavvy", "y")] });
    });
});

describe("~/.harness, protected as the home", () => {
    test("the link at the old place, while it leads to the home", () => {
        const home = join(T, ".cavvy");
        mkdirSync(home);
        expect(homeAliases(home, T)).toEqual([]);
        symlinkSync(home, join(T, ".harness"));
        expect(homeAliases(home, T)).toEqual([join(T, ".harness")]);
        // Not a name for a home it doesn't lead to (CAVVY_HOME elsewhere).
        mkdirSync(join(T, "elsewhere"));
        expect(homeAliases(join(T, "elsewhere"), T)).toEqual([]);
    });

    test("Harness's own, left beside the default home: its credentials stay protected", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        mkdirSync(home);
        expect(homeAliases(home, T)).toEqual([old]);
        // Beside a home set elsewhere, it's no more Cavvy's than any folder.
        expect(homeAliases(join(T, "elsewhere"), T)).toEqual([]);
        // The home itself, when it couldn't be moved, isn't another name for itself.
        expect(homeAliases(old, T)).toEqual([]);
    });
});

describe("old names still read", () => {
    test("a project's .harness/, file by file: a .cavvy/ with other files doesn't hide its settings", () => {
        expect(inProjectDir(T, "settings.local.json")).toBe(join(T, ".cavvy", "settings.local.json"));
        mkdirSync(join(T, ".harness"));
        writeFileSync(join(T, ".harness", "settings.local.json"), '{"permissions":{"deny":["Bash(rm:*)"]}}');
        expect(inProjectDir(T, "settings.local.json")).toBe(join(T, ".harness", "settings.local.json"));
        mkdirSync(join(T, ".cavvy", "skills"), { recursive: true });
        expect(inProjectDir(T, "settings.local.json")).toBe(join(T, ".harness", "settings.local.json"));
        expect(inProjectDir(T, "skills")).toBe(join(T, ".cavvy", "skills"));
        writeFileSync(join(T, ".cavvy", "settings.local.json"), "{}");
        expect(inProjectDir(T, "settings.local.json")).toBe(join(T, ".cavvy", "settings.local.json"));
    });

    test("a file by its old name only when the new one isn't there", () => {
        writeFileSync(join(T, "HARNESS.md"), "");
        expect(fileIn(T, "CAVVY.md", "HARNESS.md")).toBe(join(T, "HARNESS.md"));
        writeFileSync(join(T, "CAVVY.md"), "");
        expect(fileIn(T, "CAVVY.md", "HARNESS.md")).toBe(join(T, "CAVVY.md"));
    });

    test("rules for Harness's MCP server cover Cavvy's, and still a server named harness", () => {
        expect(currentMcpName("mcp__harness__delegate", "cavvy")).toBe("mcp__cavvy__delegate");
        expect(currentMcpName("mcp__harness", "cavvy")).toBe("mcp__cavvy");
        expect(currentMcpName("mcp__harnessy__x", "cavvy")).toBe("mcp__harnessy__x");
        const rule = parseRule("mcp__harness__browser_act");
        expect(ruleMatches(rule, { toolName: "mcp__cavvy__browser_act" }, T, "deny")).toBe(true);
        expect(ruleMatches(rule, { toolName: "mcp__harness__browser_act" }, T, "deny")).toBe(true);
        expect(ruleMatches(rule, { toolName: "mcp__cavvy__delegate" }, T, "deny")).toBe(false);
        expect(ruleMatches(parseRule("mcp__harness"), { toolName: "mcp__cavvy__delegate" }, T, "deny")).toBe(true);
    });
});

describe("names of Harness's MCP tools elsewhere", () => {
    test("an agent's tools and disallowedTools cover Cavvy's", () => {
        const def = parseAgentFile("---\nname: a\ntools: Read, mcp__harness__delegate\ndisallowedTools: mcp__harness__browser_eval\n---\nHi", "a", "user");
        expect(def.tools).toEqual(["Read", "mcp__harness__delegate", "mcp__cavvy__delegate"]);
        expect(def.disallowedTools).toEqual(["mcp__harness__browser_eval", "mcp__cavvy__browser_eval"]);
    });

    test("a hook's matcher covers Cavvy's, run by Cavvy or by Claude Code", () => {
        const h = { type: "command" as const, command: "x", matcher: "mcp__harness__delegate" };
        expect(hookApplies(h, "PreToolUse", { tool_name: "mcp__cavvy__delegate" }, T)).toBe(true);
        expect(hookApplies(h, "PreToolUse", { tool_name: "mcp__cavvy__browser_act" }, T)).toBe(false);
        expect(hookApplies({ ...h, matcher: "mcp__harness__.*" }, "PreToolUse", { tool_name: "mcp__cavvy__x" }, T)).toBe(true);
        expect(backendMatcher("PreToolUse", "mcp__harness__delegate")).toBe("mcp__harness__delegate|mcp__cavvy__delegate");
        expect(backendMatcher("PreToolUse", "mcp__harness__.*")).toBe("(?:mcp__harness__.*)|(?:mcp__cavvy__.*)");
        expect(backendMatcher("PreToolUse", "^mcp__harness.*")).toBe("(?:^mcp__harness.*)|(?:^mcp__cavvy.*)");
        // A server of another name that starts the same isn't Harness's.
        expect(backendMatcher("PreToolUse", "mcp__harness_hooks__x")).toBe("mcp__harness_hooks__x");
        expect(backendMatcher("PreToolUse", "Bash")).toBe("Bash|Monitor");
        expect(backendMatcher("PreToolUse", "Edit")).toBe("Edit");
        expect(backendMatcher("SessionStart", "mcp__harness__x")).toBe("mcp__harness__x");
    });
});

describe("HARNESS_ variables", () => {
    test("each one set is named with its CAVVY_ name; the ones Cavvy sets for hooks aren't", () => {
        expect(legacyEnvNotes({})).toEqual([]);
        expect(legacyEnvNotes({ HARNESS_HOOK_EVENT: "Stop", HARNESS_PLUGIN_ROOT: "/p" })).toEqual([]);
        const [note] = legacyEnvNotes({ HARNESS_MODEL: "x", HARNESS_HOME: "/h" });
        expect(note).toContain("CAVVY_MODEL, CAVVY_HOME instead of HARNESS_MODEL, HARNESS_HOME");
        expect(note).toContain("(HARNESS_HOME still works meanwhile)");
        expect(legacyEnvNotes({ HARNESS_HOME: "/h", HARNESS_NO_KEYCHAIN: "1" })[0]).toContain("(HARNESS_HOME and HARNESS_NO_KEYCHAIN still work meanwhile)");
    });
});

describe("the GUI's saved state", () => {
    function storage(init: Record<string, string>) {
        const m = new Map(Object.entries(init));
        return {
            m,
            get length() {
                return m.size;
            },
            key: (i: number) => [...m.keys()][i] ?? null,
            getItem: (k: string) => m.get(k) ?? null,
            setItem: (k: string, v: string) => void m.set(k, v),
            removeItem: (k: string) => void m.delete(k),
        };
    }

    test("harness.* keys move to cavvy.*; one already set under the new name wins", () => {
        const s = storage({ "harness.prefs": '{"theme":"dark"}', "harness.seen": "{}", "cavvy.seen": '{"a":1}', other: "x" });
        moveLegacyKeys(s);
        expect(Object.fromEntries(s.m)).toEqual({ "cavvy.prefs": '{"theme":"dark"}', "cavvy.seen": '{"a":1}', other: "x" });
    });

    test("no storage, or nothing old in it, is fine", () => {
        moveLegacyKeys(undefined);
        const s = storage({ "cavvy.prefs": "{}" });
        moveLegacyKeys(s);
        expect(Object.fromEntries(s.m)).toEqual({ "cavvy.prefs": "{}" });
    });
});

describe("keychain items under Harness's name", () => {
    function keychain(init: Record<string, string>, failSet = false) {
        const items = new Map(Object.entries(init));
        const id = (o: { service: string; name: string }) => `${o.service}/${o.name}`;
        return {
            items,
            get: async (o: { service: string; name: string }) => items.get(id(o)) ?? null,
            set: async (o: { service: string; name: string; value: string }) => {
                if (failSet) throw new Error("denied");
                items.set(id(o), o.value);
            },
            delete: async (o: { service: string; name: string }) => items.delete(id(o)),
        };
    }

    test("one is copied to Cavvy's service when first read, and kept for a Harness still installed", async () => {
        const k = keychain({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key" });
        expect(await fromLegacyKeychain(k, "groq")).toBe("gsk_old_key");
        expect(Object.fromEntries(k.items)).toEqual({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key", "cavvy-cli/groq": "gsk_old_key" });
        expect(await fromLegacyKeychain(k, "openai")).toBeNull();
    });

    test("one that can't be stored under the new name is used as it is, and kept", async () => {
        const k = keychain({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key" }, true);
        expect(await fromLegacyKeychain(k, "groq")).toBe("gsk_old_key");
        expect(Object.fromEntries(k.items)).toEqual({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key" });
    });
});
