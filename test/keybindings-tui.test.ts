// The terminal app with a keybindings file: rebinding, unbinding, chords,
// reserved keys, live reload, and the help and /keybindings that show them.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { runCommand } = await import("../src/commands/index");
const { KeyParser } = await import("../src/ui/keys");
const { stripAnsi } = await import("../src/ui/ansi");
const { CHORD_TIMEOUT_MS } = await import("../src/keybindings/core");

afterAll(cleanup);

const FILE = join(HARNESS_HOME, "keybindings.json");
const write = (blocks: unknown) => writeFileSync(FILE, JSON.stringify({ bindings: blocks }));
afterEach(() => rmSync(FILE, { force: true }));

function testApp() {
    const app = new App({ cwd: tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(120) : Array.isArray(l) ? l : [l])), {});
    let cleared = 0;
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen: () => void cleared++, suspend: async (f: () => void) => f() };
    (app as any).renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    const a = app as any;
    const calls: string[] = [];
    a.externalEditor = async () => void calls.push("editor");
    a.pasteClipboardImage = async () => void calls.push("image");
    const parser = new KeyParser();
    const press = (...chunks: string[]) => {
        for (const c of chunks) for (const k of parser.feed(c)) a.onKey(k);
    };
    return { app, a, press, calls, cleared: () => cleared, text: () => printed.map(stripAnsi).join("\n") };
}

describe("defaults (no file)", () => {
    test("every default key still does what it did", () => {
        const { app, a, press, calls, cleared } = testApp();
        press("\x07");
        expect(calls).toEqual(["editor"]);
        press("\x16");
        expect(calls).toEqual(["editor", "image"]);
        const todos = a.showTodos;
        press("\x14");
        expect(a.showTodos).toBe(!todos);
        press("\x0f");
        expect(a.verbose).toBe(true);
        press("\x0c");
        expect(cleared()).toBe(1);
        press("\x1b[Z");
        expect(app.mode).toBe("acceptEdits");
        press("a", "\x1b\r", "b", "\n", "c", "\x1b[13;2u", "d");
        expect(app.editor.text).toBe("a\nb\nc\nd");
        press("\x1f");
        expect(app.editor.text).toBe("a\nb\nc\n");
        // Unbound modified Enters still add a line, as before.
        press("\x1b[13;6u");
        expect(app.editor.text).toBe("a\nb\nc\n\n");
        // Editing keys aren't bindings and keep working.
        app.editor.clear();
        press("abc", "\x01", "X");
        expect(app.editor.text).toBe("Xabc");
    });

    test("ctrl+c clears and ctrl+d exits on an empty prompt, whatever the file says", () => {
        write([{ context: "Global", bindings: { "ctrl+c": "app:toggleTodos" } }]);
        const { app, a, press } = testApp();
        expect(a.keys.keymap.issues[0].message).toContain("can't be rebound");
        let exited = 0;
        a.exit = async () => void exited++;
        const todos = a.showTodos;
        press("draft", "\x03");
        expect(app.editor.text).toBe("");
        expect(a.showTodos).toBe(todos);
        press("\x04");
        expect(exited).toBe(1);
    });
});

describe("a keybindings file", () => {
    test("an explicitly unbound Tab prefix stays unsent after its chord times out", async () => {
        write([{ context: "Chat", bindings: { tab: null, "tab t": "chat:externalEditor" } }]);
        const { app, a, press } = testApp();
        const sent: boolean[] = [];
        a.busy = true;
        a.submit = async (opposite: boolean) => void sent.push(opposite);
        app.editor.set("unsent follow-up");
        press("\t");
        await Bun.sleep(CHORD_TIMEOUT_MS + 80);
        expect(sent).toEqual([]);
        expect(app.editor.text).toBe("unsent follow-up");
    });

    test("the steer-or-queue key is an action: Tab by default, rebindable, and only while a turn runs", () => {
        write([{ context: "Global", bindings: { tab: null, "ctrl+s": "chat:submitOtherWay" } }]);
        const { app, a, press } = testApp();
        const sent: boolean[] = [];
        a.submit = async (opposite: boolean) => void sent.push(opposite);
        app.editor.set("follow-up");
        // Idle, the key does nothing.
        press("\x13");
        expect(sent).toEqual([]);
        a.busy = true;
        press("\t");
        expect(sent).toEqual([]);
        press("\x13");
        expect(sent).toEqual([true]);
        // Nothing typed: nothing to send.
        app.editor.clear();
        press("\x13");
        expect(sent).toEqual([true]);
        expect(a.keys.label("chat:submitOtherWay")).toBe("ctrl+s");
        expect(stripAnsi(a.renderInput(160).join("\n"))).toContain("ctrl+s to queue it for after");
    });

    test("unbound in Chat, the steer-or-queue key is gone from the help and the placeholder too", () => {
        write([{ context: "Chat", bindings: { tab: null } }]);
        const { app, a, press } = testApp();
        const sent: boolean[] = [];
        a.busy = true;
        a.submit = async (opposite: boolean) => void sent.push(opposite);
        app.editor.set("follow-up");
        press("\t");
        expect(sent).toEqual([]);
        expect(a.keys.label("chat:submitOtherWay")).toBeUndefined();
        app.editor.clear();
        const shown = stripAnsi(a.renderInput(160).join("\n"));
        expect(shown).toContain("Steer the current turn (enter)");
        expect(shown).not.toContain("tab to");
    });

    test("a Tab chord that goes nowhere still sends the other way, as Tab did before it was bindable", async () => {
        write([{ context: "Chat", bindings: { "tab t": "chat:externalEditor" } }]);
        const { app, a, press } = testApp();
        const sent: boolean[] = [];
        a.busy = true;
        a.submit = async (opposite: boolean) => void sent.push(opposite);
        app.editor.set("follow-up");
        press("\t");
        expect(sent).toEqual([]);
        await Bun.sleep(CHORD_TIMEOUT_MS + 80);
        expect(sent).toEqual([true]);
    });

    test("mid-turn Tab respects a custom action or explicit unbinding", () => {
        for (const action of [null, "chat:externalEditor"]) {
            write([{ context: "Chat", bindings: { tab: action } }]);
            const { app, a, press, calls } = testApp();
            const sent: boolean[] = [];
            a.busy = true;
            a.submit = async (opposite: boolean) => void sent.push(opposite);
            app.editor.set("follow-up");
            press("\t");
            expect(sent).toEqual([]);
            expect(calls).toEqual(action ? ["editor"] : []);
            expect(app.editor.text).toBe("follow-up");
        }
    });

    test("rebinding moves the action and frees the old key", () => {
        write([{ context: "Chat", bindings: { "ctrl+g": null, "ctrl+e": "chat:externalEditor" } }]);
        const { app, press, calls } = testApp();
        press("hello", "\x01", "\x07");
        expect(calls).toEqual([]);
        // ctrl+e no longer goes to the end of the line: it opens the editor.
        press("\x05");
        expect(calls).toEqual(["editor"]);
        expect(app.editor.cursor).toBe(0);
    });

    test("a binding takes over a built-in editing key", () => {
        write([{ context: "Chat", bindings: { "ctrl+k": "app:toggleTodos" } }]);
        const { app, a, press } = testApp();
        const todos = a.showTodos;
        press("abc", "\x01", "\x0b");
        expect(app.editor.text).toBe("abc");
        expect(a.showTodos).toBe(!todos);
    });

    test("submit and newline can swap", () => {
        write([{ context: "Chat", bindings: { enter: "chat:newline", "alt+enter": "chat:submit" } }]);
        const { app, a, press } = testApp();
        let submitted = 0;
        a.submit = async () => void submitted++;
        press("one", "\r", "two");
        expect(app.editor.text).toBe("one\ntwo");
        press("\x1b\r");
        expect(submitted).toBe(1);
    });

    test("unbinding Esc leaves a running turn alone", () => {
        write([{ context: "Chat", bindings: { escape: null, "ctrl+x ctrl+c": "chat:cancel" } }]);
        const { a, press } = testApp();
        let interrupts = 0;
        a.interrupt = () => void interrupts++;
        a.busy = true;
        press("\x1b[27u");
        expect(interrupts).toBe(0);
        press("\x18", "\x03");
        // ctrl+c is never part of a chord: it interrupts at once, and the chord is dropped.
        expect(interrupts).toBe(1);
    });

    test("chords: complete, and an unfinished one hands its keys back", () => {
        write([{ context: "Chat", bindings: { "ctrl+x ctrl+e": "chat:externalEditor", "ctrl+k ctrl+t": "app:toggleTodos" } }]);
        const { app, a, press, calls } = testApp();
        press("\x18");
        expect(a.flash.text).toContain("ctrl+x … (waiting for the next key)");
        press("\x05");
        expect(calls).toEqual(["editor"]);
        expect(a.flash).toBeUndefined();
        // ctrl+x isn't a key of its own: the next key just does its thing.
        press("\x18", "a");
        expect(app.editor.text).toBe("a");
        // ctrl+k is (kill to end): it still kills when the chord goes nowhere.
        press("bcd", "\x01", "\x06", "\x0b", "z");
        expect(app.editor.text).toBe("az");
        const todos = a.showTodos;
        press("\x0b", "\x14");
        expect(a.showTodos).toBe(!todos);
    });

    test("a chord left waiting runs its keys on their own after the timeout", async () => {
        write([{ context: "Chat", bindings: { "ctrl+k ctrl+t": "app:toggleTodos" } }]);
        const { app, press } = testApp();
        press("abcd", "\x01", "\x06", "\x0b");
        expect(app.editor.text).toBe("abcd");
        await Bun.sleep(CHORD_TIMEOUT_MS + 80);
        expect(app.editor.text).toBe("a");
    });

    test("a null meant for the GUI doesn't take away a terminal editing key", () => {
        write([{ context: "Global", bindings: { "mod+f": null, "mod+k": null } }]);
        const { app, press } = testApp();
        press("abc", "\x01", "\x06", "\x0b");
        // ctrl+f moved right, ctrl+k killed the rest.
        expect(app.editor.text).toBe("a");
    });

    test("Enter on the menu takes the suggestion even when Enter is bound to a new line", () => {
        write([{ context: "Chat", bindings: { enter: "chat:newline" } }]);
        const { app, a, press } = testApp();
        let ran = 0;
        a.applyCompletion = () => void ran++;
        press("/hel", "\r");
        expect(ran).toBe(1);
        expect(app.editor.text).toBe("/hel");
    });

    test("a chord timing out under a dialog isn't typed into the prompt", async () => {
        write([{ context: "Chat", bindings: { "ctrl+x b c": "app:toggleTodos" } }]);
        const { app, a, press } = testApp();
        press("\x18", "b");
        a.dialogs.push({ onKey() {}, cancel() {} });
        await Bun.sleep(CHORD_TIMEOUT_MS + 80);
        expect(app.editor.text).toBe("");
        expect(a.chordHeld).toEqual([]);
    });

    test("autocomplete keys can be rebound", () => {
        write([{ context: "Autocomplete", bindings: { tab: null, "ctrl+y": "autocomplete:accept" } }]);
        const { app, press } = testApp();
        press("/hel", "\t");
        expect(app.editor.text).toBe("/hel");
        press("\x19");
        expect(app.editor.text).toBe("/help");
    });

    test("live reload applies a save and reports problems", async () => {
        const { a, press, calls, text } = testApp();
        a.keys.watch((km: any, s: any) => a.reportKeybindings(km, s));
        try {
            write([{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor" } }]);
            for (let i = 0; i < 100 && !text().includes("Keybindings reloaded"); i++) await Bun.sleep(20);
            expect(text()).toContain("Keybindings reloaded (1 customized)");
            press("\x05");
            expect(calls).toEqual(["editor"]);
            writeFileSync(FILE, "{ oops");
            for (let i = 0; i < 100 && !text().includes("not reloaded"); i++) await Bun.sleep(20);
            expect(text()).toContain("Keybindings not reloaded, the last good ones stay");
            expect(text()).toContain("isn't valid JSON");
            press("\x05");
            expect(calls).toEqual(["editor", "editor"]);
        } finally {
            a.keys.close();
        }
    });
});

describe("what the app shows", () => {
    test("? help names the bound keys", () => {
        write([{ context: "Chat", bindings: { "ctrl+g": null, "ctrl+e": "chat:externalEditor" } }]);
        const { a } = testApp();
        a.showHelp = true;
        const help = stripAnsi(a.renderInput(160).join("\n"));
        expect(help).toContain("ctrl+e to edit in $EDITOR");
        expect(help).toContain("double esc to clear or rewind");
        expect(help).not.toContain("ctrl+g");
        expect(help).toContain("tab: steer or queue the other way");
    });

    test("/help and /keybindings show the live keys and the file's problems", async () => {
        write([{ context: "Chat", bindings: { "ctrl+g": null, "ctrl+e": "chat:externalEditor", "ctl+x": "chat:undo" } }]);
        const { app, text } = testApp();
        await runCommand(app, "/help");
        expect(text()).toContain("ctrl+e edit the prompt in $editor *");
        expect(text()).toContain("tab while a turn runs: send the other way (steer or queue)");
        await runCommand(app, "/keybindings");
        const out = text();
        expect(out).toContain("chat:externalEditor");
        expect(out).toContain('"ctl" is not a modifier');
        expect(out).toContain("Did you mean \"ctrl+x\"?");
    });

    test("/keybindings only looks; /keybindings edit creates the file from the template", async () => {
        const { app, text } = testApp();
        await runCommand(app, "/keybindings");
        expect(existsSync(FILE)).toBe(false);
        expect(text()).toContain("not created yet");
        const editor = process.env.EDITOR;
        process.env.EDITOR = "true";
        delete process.env.VISUAL;
        try {
            await runCommand(app, "/keybindings edit");
        } finally {
            process.env.EDITOR = editor;
        }
        expect(existsSync(FILE)).toBe(true);
    });

    test("startup reports a broken file", async () => {
        writeFileSync(FILE, "not json");
        const { a, text } = testApp();
        a.reportKeybindings(a.keys.keymap, "start");
        expect(text()).toContain("Problems in your keybindings (1 error)");
    });
});
