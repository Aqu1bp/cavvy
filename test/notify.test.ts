// Notifications (a long turn finished, the harness is waiting, a turn
// failed) and the terminal focus reporting that decides whether to send them.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { Notifier, shouldNotify, notificationMessage, notificationMode, notifyAfterMs, resolveChannel, terminalSequence, tmuxPassthrough, systemCommand, clean } = await import("../src/ui/notify");
const { KeyParser } = await import("../src/ui/keys");
const { Screen } = await import("../src/ui/screen");
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
import type { NotifierOptions, NotifyKind } from "../src/ui/notify";

afterAll(cleanup);

const MIN = 30_000;

describe("when to notify", () => {
    const decide = (kind: NotifyKind, focused: boolean | undefined, elapsedMs?: number, interactive = true) => shouldNotify({ kind, focused, elapsedMs, afterMs: MIN, interactive });

    test("never while the window is focused", () => {
        for (const kind of ["done", "permission", "question", "plan", "error"] as const) expect(decide(kind, true, 10 * MIN)).toBe(false);
    });
    test("unfocused: waiting and errors always notify; a finished turn only after the threshold", () => {
        for (const kind of ["permission", "question", "plan", "error"] as const) expect(decide(kind, false, 0)).toBe(true);
        expect(decide("done", false, MIN - 1)).toBe(false);
        expect(decide("done", false, MIN)).toBe(true);
    });
    test("focus never reported counts as unfocused, with the same threshold for a finished turn", () => {
        for (const kind of ["permission", "question", "plan", "error"] as const) expect(decide(kind, undefined)).toBe(true);
        expect(decide("done", undefined, 5_000)).toBe(false);
        expect(decide("done", undefined, MIN + 1)).toBe(true);
    });
    test("never in -p mode (not interactive)", () => {
        for (const kind of ["done", "permission", "question", "plan", "error"] as const) {
            expect(decide(kind, false, 10 * MIN, false)).toBe(false);
            expect(decide(kind, undefined, 10 * MIN, false)).toBe(false);
        }
    });
    test("settings: invalid values fall back to the defaults", () => {
        expect(notificationMode({})).toBe("auto");
        expect(notificationMode({ notifications: "bell" })).toBe("bell");
        expect(notificationMode({ notifications: "loud" as any })).toBe("auto");
        expect(notifyAfterMs({})).toBe(30_000);
        expect(notifyAfterMs({ notifyAfterSeconds: 5 })).toBe(5_000);
        expect(notifyAfterMs({ notifyAfterSeconds: 0 })).toBe(0);
        expect(notifyAfterMs({ notifyAfterSeconds: -1 })).toBe(30_000);
        expect(notifyAfterMs({ notifyAfterSeconds: "10" as any })).toBe(30_000);
    });
});

describe("messages", () => {
    test("short, with the duration for a finished turn", () => {
        expect(notificationMessage("done", 130_000)).toBe("Harness: done (2m 10s)");
        expect(notificationMessage("permission")).toBe("Harness: waiting for your approval");
        expect(notificationMessage("question")).toBe("Harness: waiting for your answer");
        expect(notificationMessage("plan")).toBe("Harness: plan ready for your review");
        expect(notificationMessage("error")).toBe("Harness: stopped with an error");
    });
    test("control characters are stripped", () => {
        expect(clean("a\x1b]0;x\x07b\nc\x9bd")).toBe("a ]0;x b c d");
        expect(terminalSequence("osc9", "hi\x07\x1b\\there", {})).toBe("\x1b]9;hi \\there\x07");
    });
});

describe("what gets written", () => {
    const iterm = { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" };
    test("auto: the terminal's sequence where it's known to work, otherwise the bell", () => {
        expect(resolveChannel("auto", iterm, "darwin")).toBe("osc9");
        expect(resolveChannel("auto", { TERM_PROGRAM: "WezTerm" }, "linux")).toBe("osc9");
        expect(resolveChannel("auto", { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }, "darwin")).toBe("osc9");
        expect(resolveChannel("auto", { TERM: "foot" }, "linux")).toBe("osc9");
        expect(resolveChannel("auto", { TERM: "xterm-kitty" }, "linux")).toBe("osc99");
        expect(resolveChannel("auto", { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, "darwin")).toBe("bell");
        expect(resolveChannel("auto", { TERM_PROGRAM: "vscode" }, "darwin")).toBe("bell");
        // tmux replaces TERM_PROGRAM with its own name.
        expect(resolveChannel("auto", { TERM_PROGRAM: "tmux", TERM: "tmux-256color", TMUX: "/tmp/tmux-501/default,1,0" }, "darwin")).toBe("bell");
        expect(resolveChannel("auto", {}, "darwin")).toBe("bell");
    });
    test("the other modes", () => {
        expect(resolveChannel("terminal", {}, "darwin")).toBe("osc9");
        expect(resolveChannel("terminal", { TERM: "xterm-kitty" }, "darwin")).toBe("osc99");
        expect(resolveChannel("bell", iterm, "darwin")).toBe("bell");
        expect(resolveChannel("system", {}, "darwin")).toBe("system");
        expect(resolveChannel("system", {}, "linux")).toBe("system");
        expect(resolveChannel("system", {}, "win32")).toBe("bell");
        expect(resolveChannel("off", iterm, "darwin")).toBe("off");
    });
    test("OSC 9, OSC 99 (kitty) and BEL", () => {
        expect(terminalSequence("osc9", "Harness: done (2m 10s)", {})).toBe("\x1b]9;Harness: done (2m 10s)\x07");
        expect(terminalSequence("osc99", "Harness: done (2m 10s)", {})).toBe("\x1b]99;;Harness: done (2m 10s)\x1b\\");
        expect(terminalSequence("bell", "Harness: done", {})).toBe("\x07");
    });
    test("inside tmux, OSC sequences are wrapped for passthrough with every ESC doubled; the bell isn't", () => {
        const tmux = { TMUX: "/tmp/tmux-501/default,1,0" };
        expect(terminalSequence("osc9", "Harness: done", tmux)).toBe("\x1bPtmux;\x1b\x1b]9;Harness: done\x07\x1b\\");
        expect(terminalSequence("osc99", "Harness: done", tmux)).toBe("\x1bPtmux;\x1b\x1b]99;;Harness: done\x1b\x1b\\\x1b\\");
        expect(terminalSequence("bell", "Harness: done", tmux)).toBe("\x07");
        expect(tmuxPassthrough("\x1b]1337;X\x07")).toBe("\x1bPtmux;\x1b\x1b]1337;X\x07\x1b\\");
    });
    test("system: the text is an argument, never part of the script", () => {
        const body = `Done "x" & do shell script "rm -rf ~"`;
        const mac = systemCommand(body, "darwin")!;
        expect(mac[0]).toBe("osascript");
        expect(mac.filter((a) => a.includes("rm -rf"))).toEqual([body]);
        expect(mac.at(-2)).toBe(body);
        expect(mac.at(-1)).toBe("Harness");
        const linux = systemCommand(body, "linux")!;
        expect(linux).toEqual(["notify-send", "--app-name", "Harness", "--", "Harness", body]);
        expect(systemCommand(body, "win32")).toBeUndefined();
    });
});

/** A Notifier writing into an array; the hook settings and focus are adjustable. */
function notifier(over: Partial<NotifierOptions> & { focus?: () => boolean | undefined } = {}) {
    const written: string[] = [];
    const warnings: string[] = [];
    const ran: string[][] = [];
    const n = new Notifier({
        settings: () => ({}),
        focus: () => undefined,
        interactive: true,
        cwd: () => tempDir(),
        sessionId: () => "sess-1",
        warn: (m) => warnings.push(m),
        write: (s) => void written.push(s),
        env: { TERM_PROGRAM: "iTerm.app" },
        platform: "darwin",
        run: async (argv) => (ran.push(argv), true),
        ...over,
    });
    return { n, written, warnings, ran };
}

describe("Notifier", () => {
    test("a long turn writes OSC 9 in iTerm2; a short one and a focused window write nothing", async () => {
        const { n, written } = notifier();
        expect(await n.turnEnded("done", 130_000)).toBe(true);
        expect(await n.turnEnded("done", 2_000)).toBe(false);
        expect(written).toEqual(["\x1b]9;Harness: done (2m 10s)\x07"]);
        const focused = notifier({ focus: () => true });
        expect(await focused.n.turnEnded("done", 130_000)).toBe(false);
        expect(await focused.n.notify("permission")).toBe(false);
        expect(focused.written).toEqual([]);
    });
    test("each trigger: errors and waiting notify at once; an interrupted turn never does", async () => {
        const { n, written } = notifier({ focus: () => false });
        await n.turnEnded("error", 1_000);
        await n.notify("permission");
        await n.notify("question");
        await n.notify("plan");
        expect(await n.turnEnded("aborted", 10 * MIN)).toBe(false);
        expect(written.map((w) => w.slice(4, -1))).toEqual(["Harness: stopped with an error", "Harness: waiting for your approval", "Harness: waiting for your answer", "Harness: plan ready for your review"]);
    });
    test("other ends of a turn (denied, max turns, blocked) count as done", async () => {
        const { n, written } = notifier();
        for (const r of ["denied", "max_turns", "blocked"] as const) await n.turnEnded(r, MIN);
        expect(written).toHaveLength(3);
        expect(written.every((w) => w.includes("Harness: done (30s)"))).toBe(true);
    });
    test("-p mode (not interactive) never writes", async () => {
        const { n, written, ran } = notifier({ interactive: false, settings: () => ({ notifications: "system" }) });
        await n.turnEnded("error", MIN);
        await n.notify("permission");
        expect(written).toEqual([]);
        expect(ran).toEqual([]);
    });
    test("bell, off, and tmux", async () => {
        const bell = notifier({ settings: () => ({ notifications: "bell" }) });
        await bell.n.notify("error");
        expect(bell.written).toEqual(["\x07"]);
        const off = notifier({ settings: () => ({ notifications: "off" }) });
        expect(await off.n.notify("error")).toBe(true);
        expect(off.written).toEqual([]);
        const tmux = notifier({ settings: () => ({ notifications: "terminal" }), env: { TERM_PROGRAM: "tmux", TMUX: "/tmp/x,1,0" } });
        await tmux.n.notify("permission");
        expect(tmux.written).toEqual(["\x1bPtmux;\x1b\x1b]9;Harness: waiting for your approval\x07\x1b\\"]);
    });
    test("system runs the notifier, and rings the bell when it fails", async () => {
        const ok = notifier({ settings: () => ({ notifications: "system" }) });
        await ok.n.notify("permission");
        expect(ok.ran).toHaveLength(1);
        expect(ok.ran[0]!.at(-2)).toBe("Waiting for your approval");
        expect(ok.written).toEqual([]);
        const failing = notifier({ settings: () => ({ notifications: "system" }), platform: "linux", run: async () => false });
        await failing.n.notify("permission");
        expect(failing.written).toEqual(["\x07"]);
    });
    test("the Notification hook gets message and kind, even with notifications off, and only when it would notify", async () => {
        const dir = tempDir();
        const out = join(dir, "hook.jsonl");
        const settings = { notifications: "off" as const, hooks: { Notification: [{ command: `cat >> '${out}'; echo >> '${out}'` }] } };
        let focused: boolean | undefined = true;
        const { n, written } = notifier({ settings: () => settings, focus: () => focused, cwd: () => dir });
        await n.notify("permission"); // focused: no hook
        focused = false;
        await n.turnEnded("done", 1_000); // too short: no hook
        await n.notify("permission");
        await n.turnEnded("done", 61_000);
        expect(written).toEqual([]);
        const lines = (await Bun.file(out).text()).trim().split("\n").map((l) => JSON.parse(l));
        expect(lines).toEqual([
            { hook_event_name: "Notification", cwd: dir, session_id: "sess-1", message: "Harness: waiting for your approval", kind: "permission" },
            { hook_event_name: "Notification", cwd: dir, session_id: "sess-1", message: "Harness: done (1m 1s)", kind: "done" },
        ]);
    });
    test("a failing Notification hook is reported, not thrown", async () => {
        const { n, warnings, written } = notifier({ settings: () => ({ hooks: { Notification: [{ command: "echo nope >&2; exit 2" }] } }) });
        expect(await n.notify("error")).toBe(true);
        expect(written).toHaveLength(1);
        expect(warnings).toEqual(['Notification hook "echo nope >&2; exit 2" exited with 2: nope']);
    });
});

describe("focus reporting", () => {
    const parse = (...chunks: string[]) => {
        const p = new KeyParser();
        return chunks.flatMap((c) => p.feed(c));
    };
    test("CSI I and CSI O are focus events, never text", () => {
        expect(parse("\x1b[I")).toEqual([{ name: "focus-in" }]);
        expect(parse("\x1b[O")).toEqual([{ name: "focus-out" }]);
        expect(parse("ab\x1b[Icd\x1b[Oe")).toEqual([{ name: "text", text: "ab" }, { name: "focus-in" }, { name: "text", text: "cd" }, { name: "focus-out" }, { name: "text", text: "e" }]);
        // split across reads
        expect(parse("\x1b", "[", "O")).toEqual([{ name: "focus-out" }]);
        // still keys: SS3 "O" sequences and CSI with parameters
        expect(parse("\x1bOA")).toEqual([{ name: "up" }]);
        expect(parse("\x1b[1;5D")).toEqual([{ name: "left", ctrl: true }]);
    });

    test("the screen tracks focus and the events never reach the prompt", () => {
        const app = new App({ cwd: tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        (app as any).renderLive = () => {};
        app.session = Session.create(app.cwd, { persist: false });
        const screen = new Screen();
        const keys: string[] = [];
        // Not a terminal here, so start() only sets the handler.
        screen.start((k) => {
            keys.push(k.name);
            (app as any).onKey(k);
        });
        const data = (s: string) => (screen as any).onData(s);
        expect(screen.focus).toBeUndefined();
        data("he\x1b[O");
        expect(screen.focus).toBe(false);
        data("llo\x1b[I");
        expect(screen.focus).toBe(true);
        data("\x1b[O\x1b[I\x1b[O");
        expect(screen.focus).toBe(false);
        expect(app.editor.text).toBe("hello");
        expect(keys.every((k) => k === "text")).toBe(true);
    });
});

describe("the terminal modes the screen sets", () => {
    const realWrite = process.stdout.write;
    const stdin = process.stdin as any;
    const saved = { setRawMode: stdin.setRawMode, resume: stdin.resume, pause: stdin.pause };
    afterEach(() => {
        process.stdout.write = realWrite;
        Object.assign(stdin, saved);
    });

    function started() {
        let out = "";
        process.stdout.write = ((s: string | Uint8Array) => ((out += typeof s === "string" ? s : new TextDecoder().decode(s)), true)) as typeof process.stdout.write;
        stdin.setRawMode = () => stdin;
        stdin.resume = () => stdin;
        stdin.pause = () => stdin;
        const screen = new Screen();
        (screen as any).interactive = true;
        screen.start(() => {});
        return { screen, out: () => out, reset: () => (out = "") };
    }

    test("focus reporting is on while running and off on exit", () => {
        const { screen, out, reset } = started();
        expect(out()).toContain("\x1b[?1004h");
        expect(out()).not.toContain("\x1b[?1004l");
        reset();
        screen.stop();
        expect(out()).toContain("\x1b[?1004l");
        expect(out()).not.toContain("\x1b[?1004h");
        // like bracketed paste, it's turned off before the terminal goes back to the shell
        expect(out().indexOf("\x1b[?1004l")).toBeLessThan(out().indexOf("\x1b[?2004l"));
    });

    test("off while another program has the terminal ($EDITOR), on again after; focus is unknown again", async () => {
        const { screen, out, reset } = started();
        (screen as any).onData("\x1b[O");
        expect(screen.focus).toBe(false);
        reset();
        let during = "";
        await screen.suspend(() => {
            during = out();
        });
        expect(during).toContain("\x1b[?1004l");
        expect(during).not.toContain("\x1b[?1004h");
        expect(out().slice(during.length)).toContain("\x1b[?1004h");
        expect(screen.focus).toBeUndefined();
        screen.stop();
    });
});

describe("the app notifies at the right moments", () => {
    /** An App with the screen stubbed out (unfocused) and its notifier writing into an array. */
    function testApp() {
        const app = new App({ cwd: tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        const screen = { print: () => ({}), replace() {}, redraw() {}, setLive() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: false as boolean | undefined };
        (app as any).screen = screen;
        (app as any).renderLive = () => {};
        app.session = Session.create(app.cwd, { persist: false });
        app.session.setSystem("test system prompt");
        const written: string[] = [];
        Object.assign((app.notifier as any).o, { interactive: true, write: (s: string) => void written.push(s), env: { TERM_PROGRAM: "iTerm.app" }, platform: "darwin" });
        return { app, screen, written };
    }
    const msg = (text: string) => `\x1b]9;Harness: ${text}\x07`;

    test("a turn that ends with an error, or takes longer than the threshold", async () => {
        const { app, written } = testApp();
        app.agent = { run: async () => "error" } as any;
        await app.startTurn("hi");
        app.agent = { run: async () => (((app as any).turnStart -= 45_000), "done") } as any;
        await app.startTurn("again");
        app.agent = {
            run: async () => {
                throw new Error("boom");
            },
        } as any;
        await app.startTurn("crash");
        await Bun.sleep(20);
        expect(written).toEqual([msg("stopped with an error"), msg("done (45s)"), msg("stopped with an error")]);
    });
    test("not for a short turn, an interrupted one, or while the window is focused", async () => {
        const { app, screen, written } = testApp();
        app.agent = { run: async () => "done" } as any;
        await app.startTurn("quick");
        app.agent = { run: async () => (((app as any).turnStart -= 45_000), "aborted") } as any;
        await app.startTurn("interrupted");
        screen.focus = true;
        app.agent = { run: async () => "error" } as any;
        await app.startTurn("watched");
        await Bun.sleep(20);
        expect(written).toEqual([]);
    });
    test("a permission prompt, a question and a plan approval notify while they wait", async () => {
        const { app, written } = testApp();
        const top = () => (app as any).dialogs.at(-1);
        const perm = (app as any).permissionDialog({ tool: { name: "Bash", category: "execute" }, input: { command: "ls" }, title: "Bash(ls)", decision: { behavior: "ask" } });
        await Bun.sleep(100);
        expect(written).toEqual([msg("waiting for your approval")]);
        top().cancel();
        expect(await perm).toEqual({ allow: false });
        const question = (app as any).askQuestion("Which one?", [{ label: "A" }, { label: "B" }], false);
        await Bun.sleep(20);
        expect(written.at(-1)).toBe(msg("waiting for your answer"));
        top().cancel();
        expect(await question).toBeUndefined();
        const plan = (app as any).approvePlan("## Plan\n1. Do it");
        await Bun.sleep(20);
        expect(written.at(-1)).toBe(msg("plan ready for your review"));
        top().cancel();
        expect(await plan).toEqual({ approved: false });
        expect(written).toHaveLength(3);
    });
});
