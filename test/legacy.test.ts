// Moving from Harness, Cavvy's old name (src/config/legacy.ts): the home folder
// and what stores paths into it, and what's still read by the old names.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { currentMcpName, fileIn, homeAliases, LEGACY, legacyEnvNotes, moveLegacyHome, projectDirIn, rewritePaths } from "../src/config/legacy";
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

    test("does nothing when ~/.cavvy exists, or there's no ~/.harness", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        mkdirSync(home);
        expect(moveLegacyHome(home, old)).toEqual({ home, notes: [] });
        expect(lstatSync(old).isDirectory()).toBe(true);
        expect(moveLegacyHome(join(T, "other"), join(T, "missing"))).toEqual({ home: join(T, "other"), notes: [] });
    });

    test("a second call (another process, or the next start) finds it done", () => {
        const old = harnessHome();
        const home = join(T, ".cavvy");
        moveLegacyHome(home, old);
        expect(moveLegacyHome(home, old)).toEqual({ home, notes: [] });
    });

    test("keeps using ~/.harness when it can't be moved", () => {
        const old = harnessHome();
        // A home whose parent doesn't exist: the rename fails, and nothing is lost.
        const r = moveLegacyHome(join(T, "no", "such", ".cavvy"), old);
        expect(r.home).toBe(old);
        expect(r.notes[0]).toContain("Couldn't move");
        expect(lstatSync(old).isDirectory()).toBe(true);
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

describe("the link at the old place", () => {
    test("is another name for the home folder while it leads there", () => {
        const home = join(T, ".cavvy");
        mkdirSync(home);
        expect(homeAliases(home, T)).toEqual([]);
        symlinkSync(home, join(T, ".harness"));
        expect(homeAliases(home, T)).toEqual([join(T, ".harness")]);
        // Not a name for a home it doesn't lead to.
        mkdirSync(join(T, "elsewhere"));
        expect(homeAliases(join(T, "elsewhere"), T)).toEqual([]);
    });
});

describe("old names still read", () => {
    test("a project's .harness/ until it has a .cavvy/", () => {
        expect(projectDirIn(T)).toBe(join(T, ".cavvy"));
        mkdirSync(join(T, ".harness"));
        expect(projectDirIn(T)).toBe(join(T, ".harness"));
        mkdirSync(join(T, ".cavvy"));
        expect(projectDirIn(T)).toBe(join(T, ".cavvy"));
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

describe("HARNESS_ variables", () => {
    test("each one set is named with its CAVVY_ name; the ones Cavvy sets for hooks aren't", () => {
        expect(legacyEnvNotes({})).toEqual([]);
        expect(legacyEnvNotes({ HARNESS_HOOK_EVENT: "Stop", HARNESS_PLUGIN_ROOT: "/p" })).toEqual([]);
        const [note] = legacyEnvNotes({ HARNESS_MODEL: "x", HARNESS_HOME: "/h" });
        expect(note).toContain("CAVVY_MODEL, CAVVY_HOME instead of HARNESS_MODEL, HARNESS_HOME");
        expect(note).toContain("HARNESS_HOME is still used");
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

    test("one is moved to Cavvy's service when first read, then the old one deleted", async () => {
        const k = keychain({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key" });
        expect(await fromLegacyKeychain(k, "groq")).toBe("gsk_old_key");
        expect(Object.fromEntries(k.items)).toEqual({ "cavvy-cli/groq": "gsk_old_key" });
        expect(await fromLegacyKeychain(k, "openai")).toBeNull();
    });

    test("one that can't be stored under the new name is used as it is, and kept", async () => {
        const k = keychain({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key" }, true);
        expect(await fromLegacyKeychain(k, "groq")).toBe("gsk_old_key");
        expect(Object.fromEntries(k.items)).toEqual({ [`${LEGACY.keychainService}/groq`]: "gsk_old_key" });
    });
});
