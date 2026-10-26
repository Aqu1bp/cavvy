// The GUI's keybindings: browser key events as strokes, matching (once per
// event, chords included), a broken save keeping the last good file, Enter-sends,
// labels; and the server sending the file and every save of it.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const { home: CAVVY_HOME, cleanup } = isolate();
const { eventStrokes } = await import("../gui/src/lib/keystrokes");
const kb = await import("../gui/src/state/keybindings");
const { os } = await import("../gui/src/lib/platform");
const { Engine } = await import("../src/server/engine");

afterAll(cleanup);

const MOD = os === "macos" ? { metaKey: true } : { ctrlKey: true };
const ev = (key: string, code: string, extra: Partial<KeyboardEvent> = {}) => {
    const e = { type: "keydown", key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
};
const fileOf = (blocks: unknown) => ({ path: "/k.json", text: JSON.stringify({ bindings: blocks }) });

describe("browser key events", () => {
    test("names, and the physical key as a second guess", () => {
        expect(eventStrokes(ev("k", "KeyK", { metaKey: true }))).toEqual(["cmd+k"]);
        expect(eventStrokes(ev("K", "KeyK", { ctrlKey: true, shiftKey: true }))).toEqual(["ctrl+shift+k"]);
        expect(eventStrokes(ev("ArrowUp", "ArrowUp", { altKey: true }))).toEqual(["alt+up"]);
        expect(eventStrokes(ev("Enter", "Enter"))).toEqual(["enter"]);
        expect(eventStrokes(ev(" ", "Space", { ctrlKey: true }))).toEqual(["ctrl+space"]);
        // Option+B on a Mac types ∫; Shift+/ types ?.
        expect(eventStrokes(ev("∫", "KeyB", { altKey: true }))).toEqual(["alt+∫", "alt+b"]);
        expect(eventStrokes(ev("?", "Slash", { shiftKey: true }))).toEqual(["shift+?", "?", "shift+/"]);
        expect(eventStrokes(ev("`", "Backquote", { ctrlKey: true }))).toEqual(["ctrl+`"]);
        // German layout: / is Shift+7, so Ctrl+Shift+7 is Ctrl+/ too.
        expect(eventStrokes(ev("/", "Digit7", { ctrlKey: true, shiftKey: true }))).toEqual(["ctrl+shift+/", "ctrl+/", "ctrl+shift+7"]);
        expect(eventStrokes(ev("F5", "F5"))).toEqual(["f5"]);
        // A modifier on its own, or a dead key on an unknown code, is nothing.
        expect(eventStrokes(ev("Shift", "ShiftLeft", { shiftKey: true }))).toEqual([]);
        expect(eventStrokes(ev("Dead", "IntlRo"))).toEqual([]);
    });
});

describe("the window's keymap", () => {
    test("defaults: the shortcuts the GUI always had", () => {
        kb.applyKeybindingsFile({ path: "/k.json" });
        expect(kb.actionOf(ev("k", "KeyK", MOD), ["Global"])).toBe("app:commandPalette");
        expect(kb.actionOf(ev("`", "Backquote", { ctrlKey: true }), ["Global"])).toBe("app:toggleTerminal");
        expect(kb.actionOf(ev("[", "BracketLeft", MOD), ["Global"])).toBe("app:previousSession");
        expect(kb.actionOf(ev("Escape", "Escape"), ["Global"])).toBe("app:interrupt");
        expect(kb.actionOf(ev("Enter", "Enter"), ["Chat", "Global"])).toBe("chat:submit");
        expect(kb.actionOf(ev("Enter", "Enter", { shiftKey: true }), ["Chat", "Global"])).toBe("chat:newline");
        expect(kb.actionOf(ev("Tab", "Tab", { shiftKey: true }), ["Chat", "Global"])).toBe("chat:cycleMode");
        // Mid-turn, steer or queue the other way; the composer asks for it.
        expect(kb.actionOf(ev("Enter", "Enter", { ...MOD, shiftKey: true }), ["Chat", "Global"])).toBe("chat:submitOtherWay");
        expect(kb.shortcut("chat:submitOtherWay")).toBe(os === "macos" ? "⇧+⌘+Enter" : "Ctrl+Shift+Enter");
        // Exact: a shifted Mod+K isn't the palette.
        expect(kb.actionOf(ev("K", "KeyK", { ...MOD, shiftKey: true }), ["Global"])).toBeUndefined();
    });

    test("the steer-or-queue key can be moved or taken away", () => {
        kb.applyKeybindingsFile(fileOf([{ context: "Chat", bindings: { "mod+shift+enter": null, "alt+enter": "chat:submitOtherWay" } }]));
        expect(kb.actionOf(ev("Enter", "Enter", { ...MOD, shiftKey: true }), ["Chat", "Global"])).toBeUndefined();
        expect(kb.actionOf(ev("Enter", "Enter", { altKey: true }), ["Chat", "Global"])).toBe("chat:submitOtherWay");
        expect(kb.shortcut("chat:submitOtherWay")).toBe(os === "macos" ? "⌥+Enter" : "Alt+Enter");
        kb.applyKeybindingsFile(fileOf([{ context: "Global", bindings: { "mod+shift+enter": null } }]));
        expect(kb.shortcut("chat:submitOtherWay")).toBeUndefined();
        // Taken away where it acts (the input box, where Chat's keys come first): no label either.
        kb.applyKeybindingsFile(fileOf([{ context: "Chat", bindings: { "mod+shift+enter": null } }]));
        expect(kb.actionOf(ev("Enter", "Enter", { ...MOD, shiftKey: true }), ["Chat", "Global"])).toBeUndefined();
        expect(kb.shortcut("chat:submitOtherWay")).toBeUndefined();
        // A Chat null doesn't hide an app-wide key that works outside the input box.
        kb.applyKeybindingsFile(fileOf([{ context: "Chat", bindings: { "mod+b": null } }]));
        expect(kb.shortcut("app:toggleSidebar")).toBe(os === "macos" ? "⌘+B" : "Ctrl+B");
        kb.applyKeybindingsFile({ path: "/k.json" });
    });

    test("one answer per event, however many handlers ask", () => {
        kb.applyKeybindingsFile(fileOf([{ context: "Global", bindings: { "ctrl+x ctrl+s": "app:settings" } }]));
        const first = ev("x", "KeyX", { ctrlKey: true });
        expect(kb.matchKey(first, ["Chat", "Global"])).toMatchObject({ kind: "pending" });
        // The prefix does nothing of its own (no cut in a text box).
        expect(first.defaultPrevented).toBe(true);
        expect(kb.matchKey(first, ["Global"])).toMatchObject({ kind: "pending" });
        const second = ev("s", "KeyS", { ctrlKey: true });
        expect(kb.actionOf(second, ["Chat", "Global"])).toBe("app:settings");
        // The window's own listener sees the same event after the input box: still the chord's action.
        expect(kb.actionOf(second, ["Global"])).toBe("app:settings");
    });

    test("keyup and IME composition never match", () => {
        kb.applyKeybindingsFile({ path: "/k.json" });
        expect(kb.actionOf(ev("k", "KeyK", { ...MOD, type: "keyup" } as never), ["Global"])).toBeUndefined();
        expect(kb.actionOf(ev("Enter", "Enter", { isComposing: true }), ["Chat"])).toBeUndefined();
        expect(kb.actionOf(ev("Enter", "Enter", { keyCode: 229 }), ["Chat"])).toBeUndefined();
    });

    test("rebinding shows in the labels; unbinding hides them", () => {
        kb.applyKeybindingsFile(fileOf([{ context: "Global", bindings: { "mod+b": null, "mod+shift+s": "app:toggleSidebar", "mod+k": null } }]));
        expect(kb.shortcut("app:toggleSidebar")).toBe(os === "macos" ? "⇧+⌘+S" : "Ctrl+Shift+S");
        expect(kb.withShortcut("Hide sidebar", "app:toggleSidebar")).toBe(os === "macos" ? "Hide sidebar (⇧⌘S)" : "Hide sidebar (Ctrl+Shift+S)");
        expect(kb.shortcut("app:commandPalette")).toBeUndefined();
        expect(kb.withShortcut("Search", "app:commandPalette")).toBe("Search");
        expect(kb.shortcutHint("app:commandPalette")).toBe("");
        expect(kb.keymap().customized.has("app:toggleSidebar")).toBe(true);
    });

    test("a save that isn't JSON keeps the bindings in force and says why", () => {
        kb.applyKeybindingsFile(fileOf([{ context: "Global", bindings: { "alt+s": "app:settings" } }]));
        expect(kb.applyKeybindingsFile({ path: "/k.json", text: '{ "bindings": [' }).fatal).toContain("isn't valid JSON");
        expect(kb.actionOf(ev("s", "KeyS", { altKey: true }), ["Global"])).toBe("app:settings");
        expect(kb.keymap().issues[0]!.message).toContain("The last good bindings stay in force");
        // Fixed: the error goes.
        kb.applyKeybindingsFile(fileOf([]));
        expect(kb.keymap().issues).toEqual([]);
        // Deleted: the defaults.
        kb.applyKeybindingsFile({ path: "/k.json" });
        expect(kb.keymap().customized.size).toBe(0);
    });

    test("Enter-sends off: Enter is a new line and Mod+Enter sends", () => {
        kb.applyKeybindingsFile({ path: "/k.json" });
        kb.setEnterSends(false);
        try {
            expect(kb.actionOf(ev("Enter", "Enter"), ["Chat"])).toBe("chat:newline");
            expect(kb.actionOf(ev("Enter", "Enter", MOD), ["Chat"])).toBe("chat:submit");
        } finally {
            kb.setEnterSends(true);
        }
        expect(kb.actionOf(ev("Enter", "Enter"), ["Chat"])).toBe("chat:submit");
    });

    test("the session list's keys: on in the rail only, labelled for Settings and tooltips, and the file can move them", () => {
        kb.applyKeybindingsFile({ path: "/k.json" });
        const del = os === "macos" ? ev("Backspace", "Backspace", MOD) : ev("Delete", "Delete");
        expect(kb.actionOf(del, ["Sidebar", "Global"])).toBe("sidebar:deleteSelected");
        expect(kb.actionOf(os === "macos" ? ev("Backspace", "Backspace", MOD) : ev("Delete", "Delete"), ["Chat", "Global"])).toBeUndefined();
        expect(kb.actionOf(ev("a", "KeyA", MOD), ["Sidebar", "Global"])).toBe("sidebar:selectAll");
        expect(kb.actionOf(ev("a", "KeyA", MOD), ["Global"])).toBeUndefined();
        expect(kb.actionOf(ev("S", "KeyS", { ...MOD, shiftKey: true }), ["Sidebar", "Global"])).toBe("sidebar:settleSelected");
        expect(kb.actionOf(ev("A", "KeyA", { ...MOD, shiftKey: true }), ["Sidebar", "Global"])).toBe("sidebar:archiveSelected");
        // Plain Backspace isn't bound: a stray one never asks to delete.
        expect(kb.actionOf(ev("Backspace", "Backspace"), ["Sidebar", "Global"])).toBeUndefined();
        // Global keys still work from the list.
        expect(kb.actionOf(ev("k", "KeyK", MOD), ["Sidebar", "Global"])).toBe("app:commandPalette");
        expect(kb.shortcut("sidebar:deleteSelected")).toBe(os === "macos" ? "⌘+Backspace" : "Delete");
        expect(kb.withShortcut("Settle 3 sessions", "sidebar:settleSelected")).toBe(os === "macos" ? "Settle 3 sessions (⇧⌘S)" : "Settle 3 sessions (Ctrl+Shift+S)");
        kb.applyKeybindingsFile(fileOf([{ context: "Sidebar", bindings: { "mod+backspace": null, delete: null, "alt+backspace": "sidebar:deleteSelected" } }]));
        expect(kb.actionOf(ev("Backspace", "Backspace", { altKey: true }), ["Sidebar", "Global"])).toBe("sidebar:deleteSelected");
        expect(kb.actionOf(os === "macos" ? ev("Backspace", "Backspace", MOD) : ev("Delete", "Delete"), ["Sidebar", "Global"])).toBeUndefined();
        expect(kb.shortcut("sidebar:deleteSelected")).toBe(os === "macos" ? "⌥+Backspace" : "Alt+Backspace");
        expect(kb.keymap().customized.has("sidebar:deleteSelected")).toBe(true);
        kb.applyKeybindingsFile({ path: "/k.json" });
    });

    test("an unreadable file shows as a problem", () => {
        kb.applyKeybindingsFile({ path: "/k.json", error: "Can't read /k.json: EACCES" });
        expect(kb.keymap().issues[0]!.message).toContain("EACCES");
        kb.applyKeybindingsFile({ path: "/k.json" });
    });
});

describe("server", () => {
    test("keybindings.get, keybindings.create, and every save sent to every window", async () => {
        const path = join(CAVVY_HOME, "keybindings.json");
        rmSync(path, { force: true });
        const engine = new Engine({ listModels: async () => [] });
        const events: any[] = [];
        const client = { subs: new Set<string>(), send: (e: unknown) => void events.push(e) };
        engine.clients.add(client as never);
        await engine.start();
        try {
            expect(await engine.handle(client as never, "keybindings.get", {})).toEqual({ path });
            expect(await engine.handle(client as never, "keybindings.create", {})).toEqual({ created: true, path });
            const created = (await engine.handle(client as never, "keybindings.get", {})) as { text: string };
            expect(created.text).toContain('"bindings"');
            expect(await engine.handle(client as never, "keybindings.create", {})).toEqual({ created: false, path });
            events.length = 0;
            writeFileSync(path, JSON.stringify({ bindings: [] }));
            for (let i = 0; i < 100 && !events.some((e) => e.type === "keybindings.changed"); i++) await Bun.sleep(20);
            const ev = events.find((e) => e.type === "keybindings.changed");
            expect(ev?.keybindings).toEqual({ path, text: JSON.stringify({ bindings: [] }) });
        } finally {
            await engine.stop();
        }
    });
});
