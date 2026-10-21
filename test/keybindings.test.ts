import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ACTIONS, CHORD_TIMEOUT_MS, KEYBINDINGS_TEMPLATE, KeyMatcher, formatKeys, keyLabel, loadKeymap, parseKeybindingsText, parseStroke, strokeId, stripJsonComments } from "../src/keybindings/core";
import { ensureKeybindingsFile, readKeybindings, watchKeybindings } from "../src/keybindings/file";
import { TuiKeybindings, hostPlatform, tuiStroke } from "../src/keybindings/tui";
import { KeyParser } from "../src/ui/keys";

const file = (blocks: unknown) => JSON.stringify({ bindings: blocks });
const errors = (km: { issues: { level: string; message: string }[] }) => km.issues.filter((i) => i.level === "error").map((i) => i.message);
const warnings = (km: { issues: { level: string; message: string }[] }) => km.issues.filter((i) => i.level === "warning").map((i) => i.message);
const parse = (bytes: string) => new KeyParser().feed(bytes);

describe("keystrokes", () => {
    test("modifiers and aliases normalize to one id", () => {
        const id = (s: string, app: "tui" | "gui" = "gui", p: "macos" | "linux" = "linux") => {
            const r = parseStroke(s, app, p);
            return "error" in r ? r.error : strokeId(r);
        };
        expect(id("Ctrl+Shift+K")).toBe("ctrl+shift+k");
        expect(id("shift+control+k")).toBe("ctrl+shift+k");
        expect(id("opt+enter")).toBe("alt+enter");
        expect(id("meta+enter")).toBe("alt+enter");
        expect(id("option+Return")).toBe("alt+enter");
        expect(id("esc")).toBe("escape");
        expect(id("command+k")).toBe("cmd+k");
        expect(id("ctrl++")).toBe("ctrl++");
        expect(id("ctrl+plus")).toBe("ctrl++");
        expect(id("ArrowUp")).toBe("up");
        expect(id("f12")).toBe("f12");
    });

    test("mod is Cmd in the Mac GUI and Ctrl everywhere else", () => {
        expect(strokeId(parseStroke("mod+k", "gui", "macos") as never)).toBe("cmd+k");
        expect(strokeId(parseStroke("mod+k", "gui", "linux") as never)).toBe("ctrl+k");
        expect(strokeId(parseStroke("mod+k", "gui", "windows") as never)).toBe("ctrl+k");
        expect(strokeId(parseStroke("mod+k", "tui", "macos") as never)).toBe("ctrl+k");
    });

    test("terminal: cmd arrives like alt, ctrl+j is ctrl+enter", () => {
        expect(strokeId(parseStroke("cmd+p", "tui", "macos") as never)).toBe("alt+p");
        expect(strokeId(parseStroke("ctrl+j", "tui", "linux") as never)).toBe("ctrl+enter");
        expect(strokeId(parseStroke("ctrl+j", "gui", "linux") as never)).toBe("ctrl+j");
    });

    test("a typo in a modifier is an error with a suggestion, never another key", () => {
        const r = parseStroke("ctl+k", "tui", "linux");
        expect("error" in r && r.error).toContain('Did you mean "ctrl+k"?');
        const two = parseStroke("ctrl+x+ctrl+e", "tui", "linux");
        expect("error" in two).toBe(true);
    });

    test("unknown key names are errors", () => {
        const r = parseStroke("ctrl+entr", "tui", "linux");
        expect("error" in r && r.error).toContain('Did you mean "enter"?');
        expect("error" in parseStroke("", "tui", "linux")).toBe(true);
    });
});

describe("terminal key events as strokes", () => {
    const id = (bytes: string) => {
        const k = parse(bytes)[0]!;
        const s = tuiStroke(k);
        return s && strokeId(s);
    };
    test("legacy bytes", () => {
        expect(id("\x07")).toBe("ctrl+g");
        expect(id("\r")).toBe("enter");
        expect(id("\n")).toBe("ctrl+enter"); // ctrl+j
        expect(id("\x1b\r")).toBe("alt+enter");
        expect(id("\x1bb")).toBe("alt+b");
        expect(id("\x1b[Z")).toBe("shift+tab");
        expect(id("\x1b[A")).toBe("up");
        expect(id("\x1f")).toBe("ctrl+_");
        expect(id("\x00")).toBe("ctrl+space");
    });
    test("kitty / CSI u", () => {
        expect(id("\x1b[13;2u")).toBe("shift+enter");
        expect(id("\x1b[107;6u")).toBe("ctrl+shift+k");
        expect(id("\x1b[106;5u")).toBe("ctrl+enter"); // ctrl+j stays LF's meaning
    });
    test("alt+space from ESC-prefixed terminals, and F5–F12", () => {
        expect(id("\x1b ")).toBe("alt+space");
        expect(id("\x1b[15~")).toBe("f5");
        expect(id("\x1b[24;5~")).toBe("ctrl+f12");
    });
    test("text: one character is a stroke, a typed run or paste isn't", () => {
        expect(id("x")).toBe("x");
        expect(id("X")).toBe("shift+x");
        expect(id("ab")).toBeUndefined();
        expect(tuiStroke({ name: "paste", paste: "hi" })).toBeUndefined();
        expect(tuiStroke({ name: "focus-in" })).toBeUndefined();
    });
});

describe("the file", () => {
    test("no file: the defaults, no problems", () => {
        const km = loadKeymap(undefined, "tui", "linux");
        expect(km.issues).toEqual([]);
        expect(km.table.get("Chat")!.get("ctrl+g")).toBe("chat:externalEditor");
        expect(km.table.get("Global")!.get("ctrl+t")).toBe("app:toggleTodos");
        expect(km.customized.size).toBe(0);
    });

    test("every default parses on every platform without problems", () => {
        for (const app of ["tui", "gui"] as const)
            for (const p of ["macos", "linux", "windows"] as const) {
                const km = loadKeymap(undefined, app, p);
                expect(km.issues).toEqual([]);
                for (const a of ACTIONS) if (a.defaults[app]) expect(km.keysOf.get(a.id)!.length).toBeGreaterThan(0);
            }
    });

    test("rebind: null the old key and bind a new one", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+g": null, "ctrl+e": "chat:externalEditor" } }]), "tui", "linux");
        expect(km.issues).toEqual([]);
        expect(km.table.get("Chat")!.get("ctrl+g")).toBeNull();
        expect(km.table.get("Chat")!.get("ctrl+e")).toBe("chat:externalEditor");
        expect(km.keysOf.get("chat:externalEditor")).toEqual(["ctrl+e"]);
        expect(km.customized.has("chat:externalEditor")).toBe(true);
    });

    test("an added key keeps the default too", () => {
        const km = loadKeymap(file([{ context: "Global", bindings: { "alt+t": "app:toggleTodos" } }]), "tui", "linux");
        expect(km.keysOf.get("app:toggleTodos")).toEqual(["alt+t", "ctrl+t"]);
    });

    test("binding a key used by another action takes it over (only there)", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+g": "app:toggleTodos" } }]), "tui", "linux");
        expect(km.keysOf.get("chat:externalEditor")).toEqual([]);
        expect(km.keysOf.get("app:toggleTodos")).toEqual(["ctrl+g", "ctrl+t"]);
        expect(km.customized.has("chat:externalEditor")).toBe(true);
    });

    test("comments are allowed (the template has them)", () => {
        expect(stripJsonComments('{ "a": "http://x // not a comment" } // yes')).toBe('{ "a": "http://x // not a comment" } \n');
        const km = loadKeymap(KEYBINDINGS_TEMPLATE, "tui", "linux");
        expect(km.issues).toEqual([]);
        expect("fatal" in km && km.fatal).toBeFalsy();
    });

    test("not JSON: fatal, defaults stay", () => {
        const km = loadKeymap("{ bindings: [", "tui", "linux");
        expect(km.fatal).toContain("isn't valid JSON");
        expect(km.table.get("Chat")!.get("ctrl+g")).toBe("chat:externalEditor");
    });

    test("wrong shapes are fatal with how to fix it", () => {
        expect(loadKeymap("[]", "tui", "linux").fatal).toContain('"bindings" array');
        expect(loadKeymap('{"Chat": {}}', "tui", "linux").fatal).toContain('"bindings" array');
        expect(loadKeymap('{"bindings": {}}', "tui", "linux").fatal).toContain("must be an array");
    });

    test("empty file is the defaults", () => {
        expect(loadKeymap("  \n", "tui", "linux").issues).toEqual([]);
    });

    test("bad entries are skipped, good ones in the same file still apply", () => {
        const km = loadKeymap(
            file([
                { context: "chat", bindings: { "ctrl+e": "chat:externalEditor" } },
                { context: "Nope", bindings: {} },
                "not a block",
                { context: "Chat" },
                { context: "Chat", bindings: { "ctrl+e": "chat:externalEditr", "ctrl+r": 5, "ctl+y": "chat:undo", "alt+u": "chat:undo", "ctrl+q": "autocomplete:accept" } },
            ]),
            "tui",
            "linux",
        );
        const errs = errors(km);
        expect(errs.some((e) => e.includes('unknown context "chat"') && e.includes('did you mean "Chat"'))).toBe(true);
        expect(errs.some((e) => e.includes('unknown context "Nope"'))).toBe(true);
        expect(errs.some((e) => e.includes("bindings[2] must be an object"))).toBe(true);
        expect(errs.some((e) => e.includes('"bindings" must be an object'))).toBe(true);
        expect(errs.some((e) => e.includes('unknown action "chat:externalEditr"') && e.includes("chat:externalEditor"))).toBe(true);
        expect(errs.some((e) => e.includes("must be a string"))).toBe(true);
        expect(errs.some((e) => e.includes('"ctl" is not a modifier'))).toBe(true);
        expect(errs.some((e) => e.includes("only works in the Autocomplete context"))).toBe(true);
        expect(km.table.get("Chat")!.get("alt+u")).toBe("chat:undo");
    });

    test("plain typing keys can't be bound", () => {
        const km = loadKeymap(file([{ context: "Global", bindings: { q: "app:toggleTodos", "shift+q": "app:toggleTodos", space: "app:toggleTodos" } }]), "tui", "linux");
        expect(errors(km)).toHaveLength(3);
        expect(errors(km)[1]).toContain('typing "Q"');
        expect(km.table.get("Global")!.has("q")).toBe(false);
    });

    test("terminal-reserved keys", () => {
        const km = loadKeymap(file([{ context: "Global", bindings: { "ctrl+c": "app:toggleTodos", "ctrl+shift+c": "app:toggleTodos", "ctrl+d": "app:redraw", "ctrl+m": "app:redraw", "ctrl+[": "app:redraw", "ctrl+i": "app:redraw", "ctrl+h": "app:redraw", "ctrl+z": "app:redraw", "cmd+t": "app:toggleTodos" } }]), "tui", "linux");
        expect(errors(km)).toHaveLength(7);
        expect(warnings(km)).toHaveLength(2);
        expect(km.table.get("Global")!.get("ctrl+z")).toBe("app:redraw");
        expect(km.table.get("Global")!.get("alt+t")).toBe("app:toggleTodos");
    });

    test("GUI: clipboard keys warn, macOS system keys are errors", () => {
        const mac = loadKeymap(file([{ context: "Global", bindings: { "mod+c": "app:toggleSidebar", "cmd+q": "app:settings", "ctrl+c": "app:settings" } }]), "gui", "macos");
        expect(warnings(mac)).toEqual([expect.stringContaining("replaces copy")]);
        expect(errors(mac)).toEqual([expect.stringContaining("belongs to macOS")]);
        // ctrl+c on a Mac isn't copy.
        expect(mac.table.get("Global")!.get("ctrl+c")).toBe("app:settings");
        const linux = loadKeymap(file([{ context: "Global", bindings: { "mod+v": "app:toggleSidebar" } }]), "gui", "linux");
        expect(warnings(linux)).toEqual([expect.stringContaining("replaces paste")]);
    });

    test("the same key twice in a block warns; last wins", () => {
        const km = loadKeymap(file([{ context: "Global", bindings: { "ctrl+K": "app:toggleTodos", "Ctrl+k": "app:redraw" } }]), "tui", "linux");
        expect(warnings(km)).toEqual([expect.stringContaining("are the same key")]);
        expect(km.table.get("Global")!.get("ctrl+k")).toBe("app:redraw");
    });

    test("the other app's actions are ignored, not errors, and leave the key alone", () => {
        const tui = loadKeymap(file([{ context: "Global", bindings: { "ctrl+t": "app:commandPalette" } }]), "tui", "linux");
        expect(tui.issues).toEqual([]);
        expect(tui.table.get("Global")!.get("ctrl+t")).toBe("app:toggleTodos");
        const gui = loadKeymap(file([{ context: "Global", bindings: { "ctrl+t": "app:commandPalette" } }]), "gui", "linux");
        expect(gui.table.get("Global")!.get("ctrl+t")).toBe("app:commandPalette");
    });

    test("a key that also starts a chord warns and waits for the chord", () => {
        const km = loadKeymap(file([{ context: "Global", bindings: { "ctrl+x": "app:toggleTodos", "ctrl+x ctrl+t": "app:redraw" } }]), "tui", "linux");
        expect(warnings(km)).toEqual([expect.stringContaining('"ctrl+x" starts a chord')]);
        expect(km.keysOf.get("app:toggleTodos")).toEqual(["ctrl+t"]);
    });

    test("a chord in a more specific context hiding a Global key warns too", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+x ctrl+e": "chat:externalEditor" } }, { context: "Global", bindings: { "ctrl+x": "app:redraw" } }]), "tui", "linux");
        expect(warnings(km)).toEqual([expect.stringContaining('Chat: "ctrl+x" starts a chord, so it no longer runs app:redraw (Global) on its own where Chat applies')]);
    });

    test("chord keys after the first may be plain", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+x b": "chat:externalEditor" } }]), "tui", "linux");
        expect(km.issues).toEqual([]);
        expect(km.prefixes.get("Chat")!.has("ctrl+x")).toBe(true);
    });

    test("GUI Enter-sends off: the defaults move", () => {
        const km = loadKeymap(undefined, "gui", "macos", { defaults: { "chat:submit": ["mod+enter"], "chat:newline": ["enter", "shift+enter"] } });
        expect(km.table.get("Chat")!.get("enter")).toBe("chat:newline");
        expect(km.table.get("Chat")!.get("cmd+enter")).toBe("chat:submit");
    });

    test("parseKeybindingsText keeps context and keys as written", () => {
        expect(parseKeybindingsText(file([{ context: "Chat", bindings: { "Ctrl+E": "chat:externalEditor" } }])).bindings).toEqual([{ context: "Chat", keys: "Ctrl+E", action: "chat:externalEditor" }]);
    });
});

describe("matching", () => {
    test("most specific context first; null unbinds there", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+t": null } }]), "tui", "linux");
        const m = new KeyMatcher(km);
        expect(m.match("ctrl+t", ["Chat", "Global"])).toEqual({ kind: "none", unbound: true, abandoned: 0 });
        expect(m.match("ctrl+t", ["Global"])).toMatchObject({ kind: "action", action: "app:toggleTodos" });
        expect(m.match("ctrl+g", ["Chat", "Global"])).toMatchObject({ kind: "action", action: "chat:externalEditor", context: "Chat" });
        expect(m.match("ctrl+q", ["Chat", "Global"])).toEqual({ kind: "none", abandoned: 0 });
    });

    test("autocomplete beats chat while the menu is open", () => {
        const m = new KeyMatcher(loadKeymap(undefined, "tui", "linux"));
        expect(m.match("up", ["Autocomplete", "Chat", "Global"])).toMatchObject({ action: "autocomplete:previous" });
        expect(m.match("up", ["Chat", "Global"])).toMatchObject({ action: "history:previous" });
    });

    test("chords: complete, wrong second key, timeout", () => {
        let now = 1000;
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+x ctrl+e": "chat:externalEditor", "ctrl+x b": "app:toggleTodos" } }]), "tui", "linux");
        const m = new KeyMatcher(km, () => now);
        expect(m.match("ctrl+x", ["Chat", "Global"])).toMatchObject({ kind: "pending", keys: "ctrl+x" });
        expect(m.waiting).toBe("ctrl+x");
        expect(m.match("ctrl+e", ["Chat", "Global"])).toMatchObject({ kind: "action", action: "chat:externalEditor", abandoned: 0 });
        expect(m.waiting).toBeUndefined();
        m.match("ctrl+x", ["Chat"]);
        expect(m.match("b", ["Chat"])).toMatchObject({ action: "app:toggleTodos" });
        // A key that isn't part of it: the first key is given back, the second does its own thing.
        m.match("ctrl+x", ["Chat", "Global"]);
        expect(m.match("ctrl+t", ["Chat", "Global"])).toMatchObject({ kind: "action", action: "app:toggleTodos", abandoned: 1 });
        m.match("ctrl+x", ["Chat"]);
        expect(m.match("q", ["Chat"])).toEqual({ kind: "none", abandoned: 1 });
        // Too slow.
        m.match("ctrl+x", ["Chat"]);
        now += CHORD_TIMEOUT_MS + 1;
        expect(m.waiting).toBeUndefined();
        expect(m.match("ctrl+e", ["Chat"])).toEqual({ kind: "none", abandoned: 1 });
        // A prefix again restarts the chord, giving back the old one.
        m.match("ctrl+x", ["Chat"]);
        expect(m.match("ctrl+x", ["Chat"])).toMatchObject({ kind: "pending", abandoned: 1 });
    });

    test("GUI candidates: the typed character or the physical key", () => {
        const km = loadKeymap(file([{ context: "Global", bindings: { "alt+b": "app:toggleSidebar" } }]), "gui", "macos");
        // Option+B types "∫" on a Mac: the key on the keyboard still matches.
        expect(new KeyMatcher(km).match(["alt+∫", "alt+b"], ["Global"])).toMatchObject({ action: "app:toggleSidebar" });
    });
});

describe("display", () => {
    test("GUI on a Mac uses symbols, elsewhere names; terminal keeps the file's spelling", () => {
        expect(formatKeys("cmd+k", "gui", "macos")).toBe("⌘+K");
        expect(formatKeys("ctrl+alt+shift+cmd+up", "gui", "macos")).toBe("⌃+⌥+⇧+⌘+↑");
        expect(formatKeys("ctrl+k ctrl+s", "gui", "linux")).toBe("Ctrl+K Ctrl+S");
        expect(formatKeys("ctrl++", "gui", "linux")).toBe("Ctrl+Plus");
        expect(formatKeys("ctrl+enter", "tui", "linux")).toBe("ctrl+j");
        expect(formatKeys("alt+enter", "tui", "linux")).toBe("alt+enter");
    });
    test("keyLabel follows the file", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+g": null, "ctrl+e": "chat:externalEditor" } }]), "tui", "linux");
        expect(keyLabel(km, "chat:externalEditor")).toBe("ctrl+e");
        const none = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+g": null } }]), "tui", "linux");
        expect(keyLabel(none, "chat:externalEditor")).toBeUndefined();
    });
    test("host platform", () => {
        expect(hostPlatform("darwin")).toBe("macos");
        expect(hostPlatform("win32")).toBe("windows");
        expect(hostPlatform("freebsd")).toBe("other");
    });
});

describe("file on disk and live reload", () => {
    const tmp = () => mkdtempSync(join(tmpdir(), "harness-keys-"));
    const until = async (cond: () => boolean, ms = 3000) => {
        const end = Date.now() + ms;
        while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        return cond();
    };

    test("read: missing file is no text and no error", () => {
        const dir = tmp();
        expect(readKeybindings(join(dir, "keybindings.json"))).toEqual({});
        expect(readKeybindings(dir).error).toContain("Can't read");
        rmSync(dir, { recursive: true });
    });

    test("ensure creates the template once", () => {
        const dir = tmp();
        const p = join(dir, "sub", "keybindings.json");
        expect(ensureKeybindingsFile(p)).toBe(true);
        expect(readKeybindings(p).text).toBe(KEYBINDINGS_TEMPLATE);
        expect(ensureKeybindingsFile(p)).toBe(false);
        rmSync(dir, { recursive: true });
    });

    test("save, atomic rename, broken save and delete all reload", async () => {
        const dir = tmp();
        const p = join(dir, "keybindings.json");
        const keys = new TuiKeybindings("linux", p);
        const events: string[] = [];
        keys.watch((_km, status) => events.push(status));
        try {
            writeFileSync(p, file([{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor" } }]));
            expect(await until(() => keys.keymap.table.get("Chat")!.get("ctrl+e") === "chat:externalEditor")).toBe(true);
            expect(keys.matcher.keymap).toBe(keys.keymap);

            // Editors that save by renaming a temp file over the original.
            writeFileSync(join(dir, "tmp.json"), file([{ context: "Chat", bindings: { "ctrl+r": "chat:externalEditor" } }]));
            renameSync(join(dir, "tmp.json"), p);
            expect(await until(() => keys.keymap.table.get("Chat")!.get("ctrl+r") === "chat:externalEditor")).toBe(true);

            // Half-written JSON: the last good bindings stay, and the error is reported.
            writeFileSync(p, '{ "bindings": [');
            expect(await until(() => events.includes("kept"))).toBe(true);
            expect(keys.keymap.table.get("Chat")!.get("ctrl+r")).toBe("chat:externalEditor");
            expect(errors(keys.keymap)[0]).toContain("isn't valid JSON");

            rmSync(p);
            expect(await until(() => !keys.keymap.table.get("Chat")!.has("ctrl+r"))).toBe(true);
            expect(keys.keymap.issues).toEqual([]);
        } finally {
            keys.close();
            rmSync(dir, { recursive: true });
        }
    });

    test("watcher ignores changes to other files in the folder", async () => {
        const dir = tmp();
        const p = join(dir, "keybindings.json");
        let calls = 0;
        const stop = watchKeybindings(() => calls++, p, 10);
        writeFileSync(join(dir, "settings.json"), "{}");
        await new Promise((r) => setTimeout(r, 150));
        stop();
        expect(calls).toBe(0);
        rmSync(dir, { recursive: true });
    });
});

describe("performance", () => {
    test("matching a key takes microseconds", () => {
        const km = loadKeymap(file([{ context: "Chat", bindings: { "ctrl+x ctrl+e": "chat:externalEditor" } }]), "tui", "linux");
        const m = new KeyMatcher(km);
        const keys = parse("abc\x07\x1b[A\r\x14x");
        const N = 200_000;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
            const k = keys[i % keys.length]!;
            const s = tuiStroke(k);
            if (s) m.match(s, ["Chat", "Global"]);
        }
        const perKeyUs = ((performance.now() - t0) * 1000) / N;
        console.log(`keybindings: ${perKeyUs.toFixed(3)} µs per key (stroke + match)`);
        expect(perKeyUs).toBeLessThan(5);
    });

    test("loading the keymap is fast enough to do on every save", () => {
        const text = file([{ context: "Chat", bindings: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`ctrl+alt+f${(i % 12) + 1} ctrl+${String.fromCharCode(97 + (i % 26))}`, "chat:externalEditor"])) }]);
        const t0 = performance.now();
        for (let i = 0; i < 100; i++) loadKeymap(text, "gui", "macos");
        const ms = (performance.now() - t0) / 100;
        console.log(`keybindings: ${ms.toFixed(3)} ms to load a 50-binding file`);
        expect(ms).toBeLessThan(10);
    });
});
