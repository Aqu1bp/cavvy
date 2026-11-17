// The Desktop tools (src/tools/desktop-tools.ts) without touching the Mac: which apps are never offered, what the
// session sends the helper (only approved apps' pids), what the helper's refusals become, the person taking over,
// stale refs, missing macOS grants, how the permission checker and the agent treat each call, and the setting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

isolate();
const { DesktopActTool, DesktopControlTool, DesktopScreenshotTool, DesktopSnapshotTool, DESKTOP_TOOLS, desktopAvailable, desktopServerTools, nativeDesktopCall, servedDesktopName, servedDesktopTool } = await import("../src/tools/desktop-tools");
const { stopServer } = await import("../src/mcp/server");
const { DesktopSession, setDesktopHelperStarter, setDesktopAccess, resetDesktop, parseKey, staleLine, ACCESSIBILITY_LINE, SCREEN_LINE, USED_NOTE, WATCH_LINE } = await import("../src/desktop/session");
const { ACCESS_TITLES, resetCommand, resetGrant, windowCard } = await import("../src/desktop/access");
type AccessCard = import("../src/desktop/access").AccessCard;
type AccessView = import("../src/desktop/access").AccessView;
type AccessAction = import("../src/desktop/access").AccessAction;
const { handshake, helperSource, sourceHash } = await import("../src/desktop/helper");
const { neverOffered, NEVER_OFFERED, NEVER_OFFERED_NAME_PATTERNS } = await import("../src/desktop/apps");
const { DesktopGrants } = await import("../src/desktop/grants");
const { setComputerUseServiceApp } = await import("../src/backends/codex-computer-use");
const { PermissionChecker } = await import("../src/permissions/checker");
const { loadSettings, desktopEnabled } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
type DesktopHelperLike = import("../src/desktop/helper").DesktopHelperLike;
type Reply = import("../src/desktop/helper").Reply;
type DesktopNode = import("../src/desktop/outline").DesktopNode;

const W = realpathSync(tempDir());

// ---------------------------------------------------------------------------
// A helper that answers as the Swift one does, from a Mac of its own.

const APPS = [
    { pid: 100, name: "TextEdit", bundleId: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app" },
    { pid: 200, name: "Terminal", bundleId: "com.apple.Terminal", path: "/System/Applications/Utilities/Terminal.app" },
    { pid: 300, name: "cavvy-desktop", bundleId: "dev.cavvy.desktop", path: "/Applications/Cavvy.app" },
    { pid: 400, name: "Notes", bundleId: "com.apple.Notes", path: "/System/Applications/Notes.app" },
    { pid: 500, name: "Ghostly", bundleId: "com.example.ghostly", path: "/Applications/Ghostly.app" },
];

const tree = (text = "Hello", button = "Bold"): DesktopNode => ({
    role: "AXApplication",
    title: "TextEdit",
    children: [{ role: "AXWindow", title: "Untitled", frame: [0, 0, 800, 600], children: [{ role: "AXButton", title: button, frame: [10, 10, 60, 20] }, { role: "AXTextArea", value: text, frame: [0, 40, 800, 560] }] }],
});

class FakeHelper implements DesktopHelperLike {
    running = true;
    pid = 9999;
    human = 0;
    /** The person's clicks, keys and scrolls into the apps a command names (as the helper sums them per command). */
    used = 0;
    ready = Promise.resolve({ accessibility: true } as Reply);
    calls: Record<string, unknown>[] = [];
    cancelled: string[] = [];
    front = 100;
    accessibility = true;
    screen = true;
    tree = tree();
    /** What the next call of an op answers, instead of what it would. */
    answers: Record<string, Reply | ((c: Record<string, unknown>) => Reply)> = {};
    /** The person's input, as the helper would count it by the time it answers the next call (all of it, and what was aimed elsewhere than Cavvy). */
    humanNext?: number;
    usedNext?: number;
    /** Each answer is this much later (ms). */
    delay = 0;
    private exits: (() => void)[] = [];

    async call(c: Record<string, unknown>): Promise<Reply> {
        this.calls.push(c);
        if (this.delay) await Bun.sleep(this.delay);
        if (this.humanNext !== undefined) {
            this.human = this.humanNext;
            this.humanNext = undefined;
        }
        if (this.usedNext !== undefined) {
            this.used = this.usedNext;
            this.usedNext = undefined;
        }
        const op = String(c.op);
        const given = this.answers[op];
        if (given) {
            delete this.answers[op];
            const r = typeof given === "function" ? given(c) : given;
            if (r.error) throw Object.assign(new (await import("../src/desktop/helper")).DesktopError(String(r.error), r.code as string | undefined));
            return { ...r, human: this.human, used: this.used };
        }
        const needAx = ["look", "open", "click", "drag", "scroll", "press", "type"].includes(op);
        const { DesktopError } = await import("../src/desktop/helper");
        if (needAx && !this.accessibility) throw new DesktopError("Accessibility isn't on.", "accessibility");
        switch (op) {
            case "status":
                return { accessibility: this.accessibility, screen: this.screen, human: this.human, used: this.used };
            case "apps":
                return { apps: APPS.map((a) => ({ ...a, front: a.pid === this.front })), ancestors: [300, 1234], human: this.human, used: this.used };
            case "find": {
                const want = String(c.name).toLowerCase();
                const app = APPS.find((a) => a.name.toLowerCase() === want || a.bundleId.toLowerCase() === want) ?? (want === "calculator" ? { name: "Calculator", bundleId: "com.apple.calculator", path: "/System/Applications/Calculator.app" } : want === "shellapp" ? APPS[1] : undefined);
                return app ? { found: true, app: { ...app, running: "pid" in app }, ancestors: [300, 1234], human: this.human, used: this.used } : { found: false, ancestors: [], human: this.human, used: this.used };
            }
            case "look":
                return { front: this.front, windows: [{ pid: 100, frame: [0, 0, 800, 600] }], ...(c.pid !== undefined ? { tree: this.tree } : {}), human: this.human, used: this.used };
            case "screenshot":
                if (!this.screen) throw new DesktopError("Screen Recording isn't on.", "screen");
                return { png: Buffer.from("png").toString("base64"), x: 0, y: 0, width: 800, height: 600, human: this.human, used: this.used };
            default:
                return { human: this.human, used: this.used };
        }
    }
    cancel(token: string) {
        this.cancelled.push(token);
    }
    stop() {
        this.running = false;
        for (const fn of this.exits) fn();
    }
    onExit(fn: () => void) {
        this.exits.push(fn);
    }
    sent(op: string) {
        return this.calls.filter((c) => c.op === op);
    }
}

let helper: FakeHelper;
let started = 0;
beforeEach(() => {
    helper = new FakeHelper();
    started = 0;
    setDesktopHelperStarter(async () => {
        started++;
        return helper;
    });
});
afterEach(() => {
    stopServer();
    resetDesktop();
    setDesktopHelperStarter(undefined);
    setDesktopAccess(undefined);
});

const session = () => new DesktopSession({ settleMs: 0 });
const ctxWith = (s = session(), signal = new AbortController().signal) => ({ state: { cwd: W, projectRoot: W, desktop: s }, settings: { desktop: { enabled: true } }, signal }) as any;

// ---------------------------------------------------------------------------

describe("apps that are never offered", () => {
    test("terminals, password managers and Cavvy, by name and by bundle id", () => {
        for (const name of ["Terminal", "iTerm2", "iTerm", "Ghostty", "Warp", "WezTerm", "Alacritty", "kitty", "Terminal.app", "/System/Applications/Utilities/Terminal.app", "com.apple.Terminal", "Cool Retro Term"]) expect(neverOffered({ name }), name).toBe("terminal");
        for (const name of ["Passwords", "Keychain Access", "1Password", "1Password 7", "Bitwarden", "KeePassXC", "com.apple.keychainaccess"]) expect(neverOffered({ name }), name).toBe("credentials");
        for (const name of ["Cavvy", "cavvy-desktop", "Cavvy.app"]) expect(neverOffered({ name }), name).toBe("cavvy");
        expect(neverOffered({ name: "Whatever", bundleId: "com.googlecode.iterm2" })).toBe("terminal");
        expect(neverOffered({ name: "Whatever", bundleId: "com.1password.1password" })).toBe("credentials");
        expect(neverOffered({ name: "Electron", bundleId: "dev.cavvy.desktop" })).toBe("cavvy");
        // Whatever Cavvy runs in: a dev build called Electron, the terminal `cavvy` was started in.
        expect(neverOffered({ name: "Electron", bundleId: "com.github.Electron", own: true })).toBe("cavvy");
    });

    test("everyday apps are offered", () => {
        for (const name of ["TextEdit", "Calculator", "Notes", "Safari", "Preview", "Cloudflare WARP", "Hyper Backup"]) expect(neverOffered({ name }), name).toBeUndefined();
        expect(neverOffered({ name: "Notes", bundleId: "com.apple.Notes" })).toBeUndefined();
    });
});

describe("asking for an app", () => {
    test("one that's never offered is refused before the user is asked, without starting the helper", async () => {
        const ctx = ctxWith();
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "Terminal" }, ctx)).toMatch(/Terminal can't be used: it's a terminal/);
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "1Password" }, ctx)).toMatch(/password manager/);
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "Cavvy" }, ctx)).toMatch(/Cavvy itself/);
        expect(started).toBe(0);
    });

    test("one found to be never offered (another name for a terminal, found by its bundle id) is refused too", async () => {
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "Shellapp" }, ctxWith())).toMatch(/Terminal can't be used/);
    });

    test("one that isn't on the Mac is refused before asking; one that is is named as it's installed", async () => {
        const ctx = ctxWith();
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "Nopeapp" }, ctx)).toBe("There's no app called Nopeapp on this Mac.");
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "textedit" }, ctx)).toBeUndefined();
        expect(await DesktopControlTool.preview!({ action: "request_access", app: "textedit" }, ctx)).toEqual({ summary: "Use TextEdit" });
        expect(await DesktopControlTool.validate!({ action: "request_access" }, ctx)).toMatch(/needs app/);
    });

    test("an app without a bundle id, or one Cavvy runs in, is refused before asking; opening an app not given too", async () => {
        const ctx = ctxWith();
        helper.answers.find = { found: true, app: { pid: 700, name: "TkApp", running: true }, ancestors: [] };
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "TkApp" }, ctx)).toBe("TkApp can't be used.");
        helper.answers.find = { found: true, app: { pid: 1234, name: "Visual Studio Code", bundleId: "com.microsoft.VSCode", running: true }, ancestors: [300, 1234] };
        expect(await DesktopControlTool.validate!({ action: "request_access", app: "Visual Studio Code" }, ctx)).toMatch(/^Visual Studio Code can't be used: it's where Cavvy runs\./);
        expect(await DesktopControlTool.validate!({ action: "open", app: "Notes" }, ctx)).toBe("Notes isn't an app you may use: ask with DesktopControl action=request_access app=Notes.");
        expect(helper.sent("open")).toHaveLength(0);
    });

    test("the app given is the one the person was asked about, however long they took", async () => {
        const s = session();
        const ctx = ctxWith(s);
        expect(await DesktopControlTool.preview!({ action: "request_access", app: "TextEdit" }, ctx)).toEqual({ summary: "Use TextEdit" });
        // Two minutes later, the name finds another app.
        (s as any).found.get("textedit").at -= 120_000;
        helper.answers.find = { found: true, app: { pid: 400, name: "TextEdit", bundleId: "com.apple.Notes", running: true }, ancestors: [] };
        await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctx);
        expect(s.approved()).toEqual([{ name: "TextEdit", bundleId: "com.apple.TextEdit" }]);
    });

    test("a yes lasts the session; an app that isn't running says how to start it", async () => {
        const s = session();
        const r = await DesktopControlTool.run({ action: "request_access", app: "Calculator" }, ctxWith(s));
        expect(r.content).toBe("You can use Calculator until this session ends. It isn't running: DesktopControl action=open starts it.");
        expect(s.approved()).toEqual([{ name: "Calculator", bundleId: "com.apple.calculator" }]);
    });

    test("without Accessibility, the yes holds and the result says in one line what to turn on, after macOS's own prompt", async () => {
        helper.accessibility = false;
        const s = session();
        const r = await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
        expect(r.content).toBe(`You can use TextEdit until this session ends. ${ACCESSIBILITY_LINE}`);
        // Newer macOS calls the list Device Control and Data Access.
        expect(ACCESSIBILITY_LINE).toBe("Turn on Cavvy Desktop Control in System Settings → Privacy & Security → Accessibility (on newer macOS, Device Control and Data Access), then try again.");
        expect(helper.calls.filter((c) => c.op === "status" && c.ask === "accessibility")).toHaveLength(1);
        // A snapshot says the same, and doesn't show the prompt again.
        const snap = await DesktopSnapshotTool.run({}, ctxWith(s));
        expect(snap).toMatchObject({ isError: true, content: ACCESSIBILITY_LINE });
        expect(helper.calls.filter((c) => c.op === "status" && c.ask === "accessibility")).toHaveLength(1);
    });
});

describe("what reaches the Mac", () => {
    const granted = async (...names: string[]) => {
        const s = session();
        for (const n of names) await s.grant(n);
        return s;
    };

    test("an action ends once the app is still, though the helper lists each element's fields in any order", async () => {
        const s = new DesktopSession({ settleMs: 1500 });
        await s.grant("TextEdit");
        // As Swift's dictionaries come out: the same tree, its keys in another order each read.
        let reads = 0;
        const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reorder(x)] as const).sort(() => (reads % 2 ? 1 : -1))) : v);
        const call = helper.call.bind(helper);
        helper.call = async (c, t) => {
            const r = await call(c, t);
            if (c.op === "look" && r.tree) (reads++, (r.tree = reorder(r.tree)));
            return r;
        };
        const t0 = Date.now();
        await DesktopActTool.run({ action: "type", text: "hi" }, ctxWith(s));
        // A pause, then two reads alike: not the whole 1.5 s.
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(reads).toBeGreaterThanOrEqual(2);
    });

    test("with no app given, nothing is read or done", async () => {
        const s = session();
        const r = await DesktopSnapshotTool.run({}, ctxWith(s));
        expect(r).toMatchObject({ isError: true, content: "No app is yours to use yet: ask with DesktopControl action=request_access app=<name>." });
        const act = await DesktopActTool.run({ action: "click", x: 10, y: 10 }, ctxWith(s));
        expect(act.isError).toBe(true);
        expect(helper.sent("click")).toHaveLength(0);
        expect(helper.sent("look").filter((c) => c.pid !== undefined)).toHaveLength(0);
    });

    test("only the given apps' pids go with a read or an action, never another app's (Notes, the terminal, Cavvy)", async () => {
        const s = await granted("TextEdit");
        const snap = await s.snapshot();
        expect(snap).toStartWith("Apps you may use: TextEdit (in front).\nApp: TextEdit");
        await DesktopActTool.run({ action: "click", x: 20, y: 20 }, ctxWith(s));
        await DesktopActTool.run({ action: "type", text: "hi" }, ctxWith(s));
        await DesktopActTool.run({ action: "press", key: "Meta+S" }, ctxWith(s));
        for (const op of ["click", "type", "press"]) {
            expect(helper.sent(op).length, op).toBeGreaterThan(0);
            for (const c of helper.sent(op)) expect(c.pids, op).toEqual([100]);
        }
        for (const c of helper.sent("look")) expect(c.pid === undefined || c.pid === 100).toBe(true);
        expect(helper.sent("press")[0]).toMatchObject({ key: "s", modifiers: ["cmd"] });
    });

    test("an app not given can't be read by name or opened", async () => {
        const s = await granted("TextEdit");
        expect(await DesktopSnapshotTool.run({ app: "Notes" }, ctxWith(s))).toMatchObject({ isError: true, content: "Notes isn't an app you may use: ask with DesktopControl action=request_access app=Notes." });
        expect(await DesktopControlTool.run({ action: "open", app: "Notes" }, ctxWith(s))).toMatchObject({ isError: true, content: "Notes isn't an app you may use: ask with DesktopControl action=request_access app=Notes." });
        expect(helper.sent("open")).toHaveLength(0);
    });

    test("a click outside an approved app's window is refused by the helper, and the agent is told", async () => {
        const s = await granted("TextEdit");
        helper.answers.click = { error: "Not done: 900,700 isn't on a window of an app you may use.", code: "outside" };
        const r = await DesktopActTool.run({ action: "click", x: 900, y: 700 }, ctxWith(s));
        expect(r).toMatchObject({ isError: true, content: "Not done: 900,700 isn't on a window of an app you may use." });
    });

    test("a keystroke while another app is in front is refused, and a snapshot says to bring one forward", async () => {
        const s = await granted("TextEdit");
        helper.front = 400;
        helper.answers.type = { error: "Not done: an app you may use isn't in front, so keys would go elsewhere.", code: "front" };
        const r = await DesktopActTool.run({ action: "type", text: "secret" }, ctxWith(s));
        expect(r).toMatchObject({ isError: true, content: "Not done: an app you may use isn't in front, so keys would go elsewhere." });
        expect(await s.snapshot()).toContain("Another app is in front: keys reach only an app you may use, so bring one to the front first (DesktopControl action=open)");
    });

    test("when the user uses the Mac during an action, it stops and says so, with the app as it is", async () => {
        const s = await granted("TextEdit");
        helper.answers.type = { error: "Stopped: the user used the Mac.", code: "human:3" };
        const r = await DesktopActTool.run({ action: "type", text: "hello world" }, ctxWith(s));
        expect(r.isError).toBe(true);
        expect(r.content).toStartWith("Stopped: the user used the Mac (the mouse or keyboard) during this action, so it's unfinished. Take a new snapshot before going on. (3 characters were typed.)");
        expect(r.content).toContain("App: TextEdit");
    });

    test("Esc stops an action under way: the helper is told to stop", async () => {
        const s = await granted("TextEdit");
        const ac = new AbortController();
        helper.answers.type = () => {
            ac.abort();
            return { error: "Stopped.", code: "cancelled" };
        };
        const r = await DesktopActTool.run({ action: "type", text: "hello" }, ctxWith(s, ac.signal));
        expect(r).toMatchObject({ isError: true, content: "Interrupted by user" });
        expect(helper.cancelled).toHaveLength(1);
        expect(helper.sent("type")[0]!.token).toBe(helper.cancelled[0]);
    });

    test("a ref is refused, with nothing sent, when the user used the Mac since the agent looked", async () => {
        const s = await granted("TextEdit");
        const snap = await s.snapshot();
        const ref = /"Bold" \[(e\d+)\]/.exec(snap)![1]!;
        helper.humanNext = 2;
        helper.usedNext = 2;
        const r = await DesktopActTool.run({ action: "click", ref }, ctxWith(s));
        expect(r.isError).toBe(true);
        expect(r.content).toStartWith(`Not done: ${ref} may not be what it was.`);
        expect(r.content).toContain(USED_NOTE);
        expect(helper.sent("click")).toHaveLength(0);
    });

    test("answering Cavvy's own prompt isn't using the Mac: an approved ref goes", async () => {
        const s = await granted("TextEdit");
        const ref = /"Bold" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        // The person moved the mouse to Cavvy and clicked Allow: input, but none of it aimed elsewhere.
        helper.humanNext = 5;
        const r = await DesktopActTool.run({ action: "click", ref }, ctxWith(s));
        expect(r.content).toStartWith(`Clicked "Bold" [${ref}].`);
        expect(helper.sent("click")).toHaveLength(1);
    });

    test("after the helper restarted (idle), a ref goes when what it stood for is still there", async () => {
        const s = await granted("TextEdit");
        const ref = /"Bold" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        helper.pid = 4242;
        helper.used = 0;
        const r = await DesktopActTool.run({ action: "click", ref }, ctxWith(s));
        expect(r.content).toStartWith(`Clicked "Bold" [${ref}].`);
    });

    test("Esc before anything is sent: nothing is sent, and the helper is told to stop that action", async () => {
        const s = await granted("TextEdit");
        const ac = new AbortController();
        helper.delay = 30;
        setTimeout(() => ac.abort(), 10);
        const r = await DesktopActTool.run({ action: "click", x: 20, y: 20 }, ctxWith(s, ac.signal));
        expect(r).toMatchObject({ isError: true, content: "Interrupted by user" });
        expect(helper.sent("click")).toHaveLength(0);
        expect(helper.cancelled).toHaveLength(1);
    });

    test("Esc partway through clear, type and submit: nothing after it is sent", async () => {
        const s = await granted("TextEdit");
        const ac = new AbortController();
        helper.answers.press = () => {
            ac.abort();
            return {};
        };
        const r = await DesktopActTool.run({ action: "type", text: "hello", clear: true, submit: true }, ctxWith(s, ac.signal));
        expect(r.content).toBe("Interrupted by user");
        expect(helper.sent("press")).toHaveLength(1);
        expect(helper.sent("type")).toHaveLength(0);
    });

    test("each action's commands carry a token of its own; a stop with a count is still a stop", async () => {
        const s = await granted("TextEdit");
        await DesktopActTool.run({ action: "type", text: "a", clear: true }, ctxWith(s));
        const tokens = new Set([...helper.sent("press"), ...helper.sent("type")].map((c) => c.token));
        expect(tokens.size).toBe(1);
        await DesktopActTool.run({ action: "press", key: "Enter" }, ctxWith(s));
        expect(helper.sent("press").at(-1)!.token).not.toBe([...tokens][0]);
        helper.answers.type = { error: "Stopped.", code: "cancelled:4" };
        expect((await DesktopActTool.run({ action: "type", text: "hello" }, ctxWith(s))).content).toBe("Interrupted by user.");
    });

    test("a refusal partway through typing says how much went; one that can't watch says what to check", async () => {
        const s = await granted("TextEdit");
        helper.answers.type = { error: "Not done: an app you may use isn't in front, so keys would go elsewhere.", code: "front:3" };
        expect((await DesktopActTool.run({ action: "type", text: "hello" }, ctxWith(s))).content).toBe("Not done: an app you may use isn't in front, so keys would go elsewhere. (3 characters were typed.)");
        helper.answers.click = { error: "Not done: Cavvy Desktop Control can't watch for the user's mouse and keyboard, so it won't act.", code: "watch" };
        expect((await DesktopActTool.run({ action: "click", x: 1, y: 1 }, ctxWith(s))).content).toBe(`Not done: Cavvy Desktop Control can't watch for the user's mouse and keyboard, so it won't act. ${WATCH_LINE}`);
    });

    test("an action the Mac doesn't answer in time is told to stop", async () => {
        const s = await granted("TextEdit");
        helper.answers.type = { error: "The Mac didn't answer in time.", code: "timeout" };
        const r = await DesktopActTool.run({ action: "type", text: "hello" }, ctxWith(s));
        expect(r).toMatchObject({ isError: true, content: "The Mac didn't answer in time." });
        expect(helper.cancelled).toEqual([helper.sent("type")[0]!.token as string]);
    });

    test("an action's prompt names what its ref stands for", async () => {
        const s = await granted("TextEdit");
        const ref = /"Bold" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        expect(await DesktopActTool.preview!({ action: "click", ref }, ctxWith(s))).toEqual({ summary: `Click button "Bold" (${ref}) in TextEdit` });
        expect(await DesktopActTool.preview!({ action: "click", ref: "e999" }, ctxWith(s))).toEqual({ summary: "Click e999 in TextEdit" });
    });

    test("a static text is named as the outline names it; clear is refused, with nothing sent, where there's no text field", async () => {
        helper.tree = { role: "AXApplication", title: "Calculator", children: [{ role: "AXWindow", title: "Calculator", frame: [0, 0, 230, 400], children: [{ role: "AXStaticText", label: "Edit field", value: "11,111", frame: [120, 10, 90, 36] }, { role: "AXTextField", title: "Memo", frame: [10, 60, 200, 20] }] }] };
        const s = await granted("TextEdit");
        const shown = await s.snapshot();
        const display = /text "Edit field"[^\n]*\[(e\d+)\]/.exec(shown)![1]!;
        expect(await DesktopActTool.preview!({ action: "type", ref: display, text: "6*7=", clear: true }, ctxWith(s))).toMatchObject({ summary: expect.stringContaining(`into text "Edit field" (${display})`) });
        const r = await DesktopActTool.run({ action: "type", ref: display, text: "6*7=", clear: true }, ctxWith(s));
        expect(r).toMatchObject({ isError: true, content: `Not done: clear empties a text field, and "Edit field" [${display}] isn't one. Type without clear, or clear it the app's own way.` });
        expect([...helper.sent("click"), ...helper.sent("press"), ...helper.sent("type")]).toHaveLength(0);
        // A text field is cleared as before.
        const memo = /textfield "Memo"[^\n]*\[(e\d+)\]/.exec(await s.snapshot())![1]!;
        await DesktopActTool.run({ action: "type", ref: memo, text: "x", clear: true }, ctxWith(s));
        expect(helper.sent("press").map((c) => c.key)).toEqual(["a", "backspace"]);
    });

    test("a ref is refused, with nothing sent, when what it stood for has gone; and is good for one action", async () => {
        const s = await granted("TextEdit");
        let ref = /"Bold" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        helper.tree = tree("Hello", "Italic");
        const r = await DesktopActTool.run({ action: "click", ref }, ctxWith(s));
        expect(r.content).toStartWith(`Not done: ${ref} isn't there any more: the app has changed.`);
        expect(helper.sent("click")).toHaveLength(0);
        // The outline that came back has new refs: one of them works, once.
        ref = /"Italic" \[(e\d+)\]/.exec(r.content)![1]!;
        const ok = await DesktopActTool.run({ action: "click", ref }, ctxWith(s));
        expect(ok.content).toStartWith(`Clicked "Italic" [${ref}].`);
        expect(helper.sent("click")[0]).toMatchObject({ x: 40, y: 20, pids: [100] });
    });

    test("a screenshot has only the given apps' windows; without Screen Recording, one line says what to turn on", async () => {
        const s = await granted("TextEdit");
        const shot = await DesktopScreenshotTool.run({}, ctxWith(s));
        expect(shot.content).toStartWith("Screenshot of TextEdit (in front), 800×600");
        expect(helper.sent("screenshot")[0]).toMatchObject({ pids: [100] });
        helper.screen = false;
        const none = await DesktopScreenshotTool.run({}, ctxWith(s));
        expect(none).toMatchObject({ isError: true, content: SCREEN_LINE });
        expect(SCREEN_LINE).toBe("Turn on Cavvy Desktop Control in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.");
        // The helper starts again for the next call: a new grant shows only to a new process.
        expect(helper.running).toBe(false);
    });

    test("a rebuilt helper whose switches macOS no longer counts: each line says to take it out and add it again", async () => {
        const record = join(paths.home(), "desktop", "build.json");
        mkdirSync(dirname(record), { recursive: true });
        try {
            // A screenshot that works notes the build that had Screen Recording, as a snapshot does Accessibility.
            writeFileSync(record, JSON.stringify({ hash: "old" }));
            const s = await granted("TextEdit");
            await DesktopSnapshotTool.run({}, ctxWith(s));
            await DesktopScreenshotTool.run({}, ctxWith(s));
            expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ hash: "old", trusted: "old", screen: "old" });
            // Built again: both switches still show on, and neither works.
            writeFileSync(record, JSON.stringify({ hash: "new", trusted: "old", screen: "old" }));
            helper.screen = false;
            expect(await DesktopScreenshotTool.run({}, ctxWith(s))).toMatchObject({ isError: true, content: staleLine("screen") });
            expect(staleLine("screen")).toBe(`Cavvy Desktop Control was updated, and macOS no longer counts its switch: in System Settings → Privacy & Security → Screen & System Audio Recording, remove it with −, add it again with + (Cavvy Desktop Control.app, in ${join(paths.home(), "desktop")}) and turn it on, then try again.`);
            helper.accessibility = false;
            expect(await DesktopSnapshotTool.run({}, ctxWith(s))).toMatchObject({ isError: true, content: staleLine("accessibility") });
            expect(staleLine("accessibility")).toContain("in System Settings → Privacy & Security → Accessibility (on newer macOS, Device Control and Data Access), remove it with −");
        } finally {
            rmSync(record, { force: true });
        }
    });
});

describe("keys", () => {
    test("names and combinations as the agent writes them", () => {
        expect(parseKey("Enter")).toEqual({ key: "enter", modifiers: [] });
        expect(parseKey("Meta+Shift+Z")).toEqual({ key: "z", modifiers: ["cmd", "shift"] });
        expect(parseKey("a", ["Control"])).toEqual({ key: "a", modifiers: ["ctrl"] });
        expect(parseKey("Esc")).toEqual({ key: "escape", modifiers: [] });
        expect(parseKey("+")).toEqual({ key: "+", modifiers: [] });
        expect(parseKey("Meta++")).toEqual({ key: "+", modifiers: ["cmd"] });
        expect(parseKey("Hyper+A")).toMatch(/Unknown modifier/);
        expect(parseKey("Banana")).toMatch(/Unknown key/);
    });
});

// ---------------------------------------------------------------------------

describe("permissions", () => {
    const checker = (settings: object = {}) => new PermissionChecker(() => settings as any, W);
    const ask = { action: "request_access", app: "TextEdit" };

    test("asking for an app goes to the user in every mode, past rules that allow it, and offers nothing wider", () => {
        for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const) {
            const d = checker().check(DesktopControlTool, ask, mode, W);
            expect(d, mode).toMatchObject({ behavior: "ask", appGrant: "TextEdit", everyTime: true });
            expect(d.needsClassifier, mode).toBeUndefined();
        }
        for (const rule of ["DesktopControl", "DesktopControl(request_access)"]) expect(checker({ permissions: { allow: [rule] } }).check(DesktopControlTool, ask, "bypassPermissions", W).behavior, rule).toBe("ask");
        const c = checker();
        const d = c.check(DesktopControlTool, ask, "default", W);
        expect(c.withGrant(DesktopControlTool, ask, d, W).grant).toBeUndefined();
        // A yes isn't remembered as one: each ask is the user's.
        c.approve(DesktopControlTool, ask, W);
        expect(c.check(DesktopControlTool, ask, "default", W).behavior).toBe("ask");
        expect(c.recentApprovals()).toEqual([]);
        // A deny rule still wins.
        expect(checker({ permissions: { deny: ["DesktopControl(request_access)"] } }).check(DesktopControlTool, ask, "default", W).behavior).toBe("deny");
    });

    test("reading never asks; acting asks like other tools that execute, and the reviewer decides in auto mode", () => {
        const c = checker();
        expect(c.check(DesktopSnapshotTool, {}, "default", W).behavior).toBe("allow");
        expect(c.check(DesktopScreenshotTool, {}, "default", W).behavior).toBe("allow");
        expect(c.check(DesktopControlTool, { action: "list" }, "default", W).behavior).toBe("allow");
        expect(c.check(DesktopActTool, { action: "wait" }, "default", W).behavior).toBe("allow");
        const click = c.check(DesktopActTool, { action: "click", ref: "e1" }, "default", W);
        expect(click).toMatchObject({ behavior: "ask", suggestions: ["DesktopAct"] });
        expect(c.withGrant(DesktopActTool, { action: "click", ref: "e1" }, click, W).grant).toEqual({ label: "actions in the apps you gave", rules: ["DesktopAct"] });
        expect(c.check(DesktopActTool, { action: "click", ref: "e1" }, "auto", W)).toMatchObject({ behavior: "ask", needsClassifier: true });
        expect(c.check(DesktopActTool, { action: "click", ref: "e1" }, "bypassPermissions", W).behavior).toBe("allow");
        // A yes to a click covers that click: the same ref on the next screen asks again.
        c.approve(DesktopActTool, { action: "click", ref: "e1" }, W);
        expect(c.check(DesktopActTool, { action: "click", ref: "e1" }, "default", W).behavior).toBe("ask");
        const open = c.check(DesktopControlTool, { action: "open", app: "TextEdit" }, "default", W);
        expect(open).toMatchObject({ behavior: "ask", suggestions: ["DesktopControl(open)"] });
        expect(checker({ permissions: { allow: ["DesktopControl(open)"] } }).check(DesktopControlTool, { action: "open", app: "TextEdit" }, "default", W).behavior).toBe("allow");
    });

    test("a shell command that names Cavvy's helper asks the person, in every mode, past rules; others don't", () => {
        const { BashTool } = require("../src/tools/bash");
        const { homedir } = require("os");
        const { paths } = require("../src/config/paths");
        const c = checker({ permissions: { allow: ["Bash(ls:*)", "Bash"] } });
        for (const command of ["ls ~/.cavvy/desktop", `ls "$HOME/.cavvy/desktop"`, `${homedir()}/.cavvy/desktop/Cavvy\\ Desktop\\ Control < cmds`, `"${paths.home()}/desktop/Cavvy Desktop Control"`]) {
            for (const mode of ["default", "auto", "bypassPermissions"] as const) {
                const d = c.check(BashTool, { command }, mode, W);
                expect(d, `${mode} ${command}`).toMatchObject({ behavior: "ask", personOnly: true, dangerous: true });
            }
            // Nothing wider is offered, and a yes isn't remembered.
            expect(c.withGrant(BashTool, { command }, c.check(BashTool, { command }, "default", W), W).grant).toBeUndefined();
            c.approve(BashTool, { command }, W);
            expect(c.check(BashTool, { command }, "bypassPermissions", W).behavior).toBe("ask");
        }
        expect(c.check(BashTool, { command: "ls ~/Desktop" }, "bypassPermissions", W).behavior).toBe("allow");
        expect(c.check(BashTool, { command: "git status" }, "bypassPermissions", W).behavior).toBe("allow");
        // A deny rule still wins.
        expect(checker({ permissions: { deny: ["Bash(ls:*)"] } }).check(BashTool, { command: "ls ~/.cavvy/desktop" }, "bypassPermissions", W).behavior).toBe("deny");
    });

    test("auto mode's sandbox can't read, list or run the helper's folder", () => {
        const { sandboxPolicy } = require("../src/permissions/sandbox");
        const { realpathSync } = require("fs");
        const { paths } = require("../src/config/paths");
        mkdirSync(join(paths.home(), "desktop"), { recursive: true });
        const p = sandboxPolicy([W], { cavvyHome: paths.home() });
        expect(p.unreadable).toContain(join(realpathSync(paths.home()), "desktop"));
    });

    test("plan mode reads the apps but doesn't open, click or type", () => {
        const c = checker();
        expect(c.check(DesktopSnapshotTool, {}, "plan", W).behavior).toBe("allow");
        expect(c.check(DesktopControlTool, { action: "list" }, "plan", W).behavior).toBe("allow");
        for (const [tool, input] of [
            [DesktopActTool, { action: "click", x: 1, y: 1 }],
            [DesktopActTool, { action: "type", text: "x" }],
            [DesktopControlTool, { action: "open", app: "TextEdit" }],
        ] as const) {
            const d = c.check(tool, input, "plan", W);
            expect(d.behavior).toBe("deny");
            expect(d.reason).toMatch(/can be read .* but not opened, clicked or typed into/);
        }
    });
});

// ---------------------------------------------------------------------------

const makeAgent = async (settings: object, mode: "default" | "bypassPermissions", provider = "anthropic", answer = true) => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { BUILTIN_TOOLS } = await import("../src/tools/index");
    const asked: any[] = [];
    const s = session();
    const agent = new Agent({
        session: Session.create(W, { persist: false }),
        model: { provider, id: "default" },
        client: {} as any,
        settings: () => settings as any,
        checker: new PermissionChecker(() => settings as any, W),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: () => undefined },
        toolState: { cwd: W, projectRoot: W, fileState: new Map(), todos: [], shells: new Map(), desktop: s },
        helpers: { resolveModel: async () => undefined } as any,
        listings: () => [],
        host: {
            emit: () => undefined,
            // Someone to sign in: Cavvy's MCP server has a tool for every CLI, so it's there for each.
            ui: { requestSignIn: async () => ({ signedIn: false }) },
            askPermission: async (req: any) => {
                asked.push(req);
                return { allow: answer };
            },
        },
    } as any);
    return { agent, asked, s };
};
const on = { desktop: { enabled: true } };

describe("the agent", () => {
    test("an app is the user's to give: not a mode, a rule that allows the tool, or a hook", async () => {
        const run = async (settings: object, mode: "default" | "bypassPermissions", tool: any, input: Record<string, unknown>, answer = true) => {
            const { agent, asked, s } = await makeAgent(settings, mode, "anthropic", answer);
            // The checks a call of the agent's own goes through (runLent is runServed: prepare, then run).
            const r = await agent.runLent(tool, input, new AbortController().signal);
            return { r, asked, s };
        };
        // Asked for in bypass mode, with a rule allowing the tool; the prompt reads "Use TextEdit".
        const given = await run({ ...on, permissions: { allow: ["DesktopControl"] } }, "bypassPermissions", DesktopControlTool, { action: "request_access", app: "TextEdit" });
        expect(given.asked).toHaveLength(1);
        expect(given.asked[0].decision).toMatchObject({ appGrant: "TextEdit" });
        expect(given.asked[0].preview).toEqual({ summary: "Use TextEdit" });
        expect(given.s.approved().map((a) => a.name)).toEqual(["TextEdit"]);
        // Declined: no app.
        const declined = await run(on, "default", DesktopControlTool, { action: "request_access", app: "TextEdit" }, false);
        expect(declined.r.isError).toBe(true);
        expect(declined.s.approved()).toEqual([]);
        // A hook that allows the tool doesn't give an app away.
        const allowAll = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`;
        const hooked = await run({ ...on, hooks: { PreToolUse: [{ matcher: "DesktopControl", command: allowAll }] } }, "default", DesktopControlTool, { action: "request_access", app: "TextEdit" });
        expect(hooked.asked).toHaveLength(1);
        // Nor one that answers permission requests.
        const answers = `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`;
        const answered = await run({ ...on, hooks: { PermissionRequest: [{ matcher: "DesktopControl", command: answers }] } }, "default", DesktopControlTool, { action: "request_access", app: "TextEdit" });
        expect(answered.asked).toHaveLength(1);
        // Nor a hook that answers permission requests, for a command naming Cavvy's helper.
        const { BashTool } = await import("../src/tools/bash");
        const named = await run({ ...on, permissions: { allow: ["Bash"] }, hooks: { PermissionRequest: [{ matcher: "Bash", command: answers }] } }, "bypassPermissions", BashTool, { command: "ls ~/.cavvy/desktop" }, false);
        expect(named.asked).toHaveLength(1);
        expect(named.r.isError).toBe(true);
        // Never offered: refused before the user is asked.
        const terminal = await run(on, "bypassPermissions", DesktopControlTool, { action: "request_access", app: "Terminal" });
        expect(terminal.asked).toHaveLength(0);
        expect(terminal.r.text).toMatch(/Terminal can't be used/);
    });
});

describe("Claude Code", () => {
    test("gets the tools as mcp__cavvy__desktop_*, mapped back to Cavvy's for the transcript and hooks", () => {
        expect(servedDesktopName("DesktopAct")).toBe("desktop_act");
        expect(servedDesktopName("Read")).toBeUndefined();
        expect(nativeDesktopCall("desktop_control", { action: "list" })).toEqual({ name: "DesktopControl", input: { action: "list" } });
        expect(servedDesktopTool("cavvy", "mcp__cavvy__desktop_snapshot")).toBe(true);
        expect(servedDesktopTool("cavvy", "mcp__cavvy__simulator_act")).toBe(false);
        expect(desktopServerTools(async () => ({ text: "" })).map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
            ["desktop_control", false],
            ["desktop_snapshot", true],
            ["desktop_act", false],
            ["desktop_screenshot", true],
        ]);
    });

    test("Cavvy's MCP server offers them to Claude Code with the setting on; to Codex only in place of its own computer use, and not with it off", async () => {
        // As on a Mac, wherever the test runs (CI runs on Linux, where the tools are never offered).
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { value: "darwin" });
        afterEach(() => Object.defineProperty(process, "platform", platform));
        const served = async (provider: string, settings: object) => ((await makeAgent(settings, "default", provider)).agent as any).orchestrator()?.tools ?? [];
        const names = ["desktop_control", "desktop_snapshot", "desktop_act", "desktop_screenshot"];
        expect(await served("claude-code", on)).toEqual(expect.arrayContaining(names));
        // Codex where the ChatGPT app's computer use isn't installed (as in tests): Cavvy's in its place.
        expect(await served("codex", on)).toEqual(expect.arrayContaining(names));
        // Where it is: its own, never both.
        const app = join(tempDir("cu-service-"), "Codex Computer Use.app");
        mkdirSync(app);
        setComputerUseServiceApp(app);
        afterEach(() => setComputerUseServiceApp(undefined));
        for (const [provider, settings] of [
            ["claude-code", {}],
            ["codex", on],
            ["codex", {}],
        ] as const) {
            const tools: string[] = await served(provider, settings);
            // The server is there (with the user's other tools), just without these.
            expect(tools.length, provider).toBeGreaterThan(0);
            expect(tools.filter((t) => t.startsWith("desktop_")), `${provider} ${JSON.stringify(settings)}`).toEqual([]);
        }
    });

    test("its calls go through Cavvy's checks: a rule naming the served tool holds, and an app is still the user's to give", async () => {
        const run = async (settings: object, mode: "default" | "bypassPermissions", tool: any, input: Record<string, unknown>) => {
            const { agent, asked, s } = await makeAgent(settings, mode, "claude-code");
            const r = await (agent as any).runServed(tool, input, new AbortController().signal);
            return { r, asked, s };
        };
        // An allow rule for the served name, in bypass mode: the app is still asked about.
        const given = await run({ ...on, permissions: { allow: ["mcp__cavvy__desktop_control"] } }, "bypassPermissions", DesktopControlTool, { action: "request_access", app: "TextEdit" });
        expect(given.asked).toHaveLength(1);
        expect(given.asked[0].decision).toMatchObject({ appGrant: "TextEdit" });
        expect(given.s.approved().map((a) => a.name)).toEqual(["TextEdit"]);
        // A deny rule naming the served tool refuses the call before anything runs.
        const denied = await run({ ...on, permissions: { deny: ["mcp__cavvy__desktop_act"] } }, "bypassPermissions", DesktopActTool, { action: "click", x: 1, y: 1 });
        expect(denied.r).toMatchObject({ isError: true });
        expect(denied.r.text).toMatch(/Denied by permission rule mcp__cavvy__desktop_act/);
        expect(helper.sent("click")).toHaveLength(0);
    });
});

describe("for other agents' computer use", () => {
    test("the never-offered apps are listed by bundle id, with names", () => {
        const ids = NEVER_OFFERED.map((a) => a.bundleId);
        for (const id of ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "com.apple.Passwords", "com.apple.keychainaccess", "com.1password.1password", "com.bitwarden.desktop", "dev.cavvy.desktop"]) expect(ids).toContain(id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const a of NEVER_OFFERED) expect(neverOffered({ name: "Anything", bundleId: a.bundleId }), a.bundleId).toBe(a.reason);
    });

    test("the helper is sent the list right after the secret, and is built from its own code alone", () => {
        const [hello, never, ...rest] = handshake("a".repeat(64));
        expect(rest).toEqual([]);
        expect(JSON.parse(hello!)).toEqual({ op: "hello", secret: "a".repeat(64) });
        const list = JSON.parse(never!);
        expect(list.op).toBe("never");
        expect(list.ids).toEqual(NEVER_OFFERED.map((a) => a.bundleId.toLowerCase()));
        expect(list.patterns).toEqual(NEVER_OFFERED_NAME_PATTERNS.map((r) => r.source));
        // The list isn't in what's built, nor in what decides a rebuild: a change to it needs none.
        const file = readFileSync(join(import.meta.dir, "../src/desktop/helper.swift"), "utf8");
        expect(helperSource()).toBe(file);
        expect(sourceHash()).toBe(new Bun.CryptoHasher("sha256").update(file).digest("hex").slice(0, 16));
        for (const a of NEVER_OFFERED) expect(file).not.toContain(JSON.stringify(a.bundleId.toLowerCase()));
    });

    test("the grants are kept by bundle id, and can't hold an app that's never offered", () => {
        const g = new DesktopGrants();
        g.add({ name: "TextEdit", bundleId: "com.apple.TextEdit" });
        g.add({ name: "TextEdit", bundleId: "com.apple.textedit" });
        expect(g.bundleIds()).toEqual(["com.apple.textedit"]);
        expect(g.has("COM.APPLE.TEXTEDIT")).toBe(true);
        expect(() => g.add({ name: "Terminal", bundleId: "com.apple.Terminal" })).toThrow();
        expect(g.size).toBe(1);
    });
});

// ---------------------------------------------------------------------------

test("off unless the user's own settings turn it on; any settings file turns it off", () => {
    expect(desktopEnabled({})).toBe(false);
    expect(desktopEnabled({ desktop: { enabled: true } })).toBe(true);
    expect(desktopEnabled({ desktop: "yes" } as any)).toBe(false);
    const load = (user: object, project?: object, local?: object) => {
        const cwd = realpathSync(tempDir("cavvy-desktop-settings-"));
        mkdirSync(dirname(paths.userSettings()), { recursive: true });
        writeFileSync(paths.userSettings(), JSON.stringify(user));
        for (const [file, s] of [
            [paths.projectSettings(cwd), project],
            [paths.localSettings(cwd), local],
        ] as const) {
            if (!s) continue;
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(s));
        }
        return desktopEnabled(loadSettings(cwd));
    };
    expect(load({})).toBe(false);
    expect(load({ desktop: { enabled: true } })).toBe(true);
    // A project can't hand the Mac over.
    expect(load({}, { desktop: { enabled: true } })).toBe(false);
    expect(load({}, undefined, { desktop: { enabled: true } })).toBe(false);
    expect(load({ desktop: { enabled: true } }, { desktop: { enabled: false } })).toBe(false);
    expect(load({ desktop: { enabled: true } }, undefined, { desktop: { enabled: false } })).toBe(false);
    expect(desktopAvailable({ desktop: { enabled: true } })).toBe(process.platform === "darwin");
    expect(desktopAvailable({})).toBe(false);
    expect(DESKTOP_TOOLS.every((t) => t.enabled!({ settings: {} }) === false)).toBe(true);
});

// ---------------------------------------------------------------------------

/** A card as the window shows it: what it was shown, in order, and the person's presses. */
class FakeCard implements AccessCard {
    views: AccessView[] = [];
    closed = false;
    private presses: AccessAction[] = [];
    private waiting?: (a: AccessAction) => void;
    show(v: AccessView) {
        this.views.push(v);
    }
    next(): Promise<AccessAction> {
        const a = this.presses.shift();
        return a ? Promise.resolve(a) : new Promise((r) => (this.waiting = r));
    }
    close() {
        this.closed = true;
    }
    press(a: AccessAction) {
        const w = this.waiting;
        this.waiting = undefined;
        if (w) w(a);
        else this.presses.push(a);
    }
    get last() {
        return this.views.at(-1);
    }
}

describe("asking for macOS's grants with a card", () => {
    const fast = { everyMs: { accessibility: 5, screen: 5 }, freshEvery: 1000, limitMs: 2000 };
    let opened: string[];
    let card: FakeCard | undefined;
    let cards: number;
    beforeEach(() => {
        opened = [];
        card = undefined;
        cards = 0;
        setDesktopAccess({ open: async (g) => (opened.push(g), true), timing: fast });
    });
    const ctxCard = (s: InstanceType<typeof DesktopSession>, signal = new AbortController().signal) => ({ ...ctxWith(s, signal), ui: { accessCard: () => (cards++, (card = new FakeCard())) } });
    const until = async (ok: () => boolean) => {
        for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(5);
        expect(ok()).toBe(true);
    };
    const checks = () => helper.calls.filter((c) => c.op === "status" && c.ask === undefined).length;

    test("Open Settings opens the page and asks macOS; the card notices the switch by itself, and the action carries on", async () => {
        const s = session();
        await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
        helper.accessibility = false;
        const snap = DesktopSnapshotTool.run({}, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        expect(card!.last).toEqual({ grant: "accessibility", title: "Let Cavvy control apps on this Mac?", step: "ask", name: "Cavvy Desktop Control" });
        // Nothing is checked until the person has something to switch on.
        const before = checks();
        await Bun.sleep(30);
        expect(checks()).toBe(before);
        card!.press("open");
        await until(() => card!.last?.step === "waiting");
        expect(opened).toEqual(["accessibility"]);
        // macOS is asked once Open Settings is pressed: that lists the helper for its switch.
        expect(helper.calls.filter((c) => c.op === "status" && c.ask === "accessibility")).toHaveLength(1);
        expect(card!.last).toEqual({ grant: "accessibility", title: ACCESS_TITLES.accessibility, step: "waiting", name: "Cavvy Desktop Control" });
        await until(() => checks() > before + 2);
        expect(card!.closed).toBe(false);
        helper.accessibility = true;
        const r = await snap;
        expect(r.isError).toBeUndefined();
        expect(r.content).toContain('button "Bold"');
        expect(card!.closed).toBe(true);
        // Once it's closed, nothing more is checked.
        const after = checks();
        await Bun.sleep(30);
        expect(checks()).toBe(after);
        expect(cards).toBe(1);
    });

    test("when the link can't open the page, the card names it", async () => {
        setDesktopAccess({ open: async () => false, timing: fast });
        const s = session();
        await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
        helper.accessibility = false;
        const snap = DesktopSnapshotTool.run({}, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        card!.press("open");
        await until(() => card!.last?.step === "waiting");
        expect(card!.last?.page).toBe("System Settings → Privacy & Security → Accessibility (on newer macOS, Device Control and Data Access)");
        helper.accessibility = true;
        expect((await snap).isError).toBeUndefined();
    });

    test("asked at request_access: the yes holds, and once the switch is on the result says the app is ready", async () => {
        helper.accessibility = false;
        const s = session();
        const asked = DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        card!.press("open");
        await until(() => card!.last?.step === "waiting");
        helper.accessibility = true;
        expect((await asked).content).toBe("You can use TextEdit until this session ends.");
    });

    test("closed, or the turn stopped, the card goes and the agent is told", async () => {
        helper.accessibility = false;
        const s = session();
        await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
        const snap = DesktopSnapshotTool.run({}, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        card!.press("open");
        await until(() => card!.last?.step === "waiting");
        card!.press("close");
        expect(await snap).toMatchObject({ isError: true, content: `The user didn't turn on Cavvy Desktop Control. ${ACCESSIBILITY_LINE}` });
        expect(card!.closed).toBe(true);
        const after = checks();
        await Bun.sleep(30);
        expect(checks()).toBe(after);
        // Stopped: the turn's signal closes it.
        const stop = new AbortController();
        const again = DesktopSnapshotTool.run({}, ctxCard(s, stop.signal));
        await until(() => cards === 2 && Boolean(card?.views.length));
        card!.press("open");
        await until(() => card!.last?.step === "waiting");
        stop.abort();
        card!.press("close");
        expect(await again).toMatchObject({ isError: true, content: "Interrupted by user" });
        expect(card!.closed).toBe(true);
    });

    test("left waiting, the card stops checking after its time and says what to turn on", async () => {
        setDesktopAccess({ open: async () => true, timing: { ...fast, limitMs: 60 } });
        helper.accessibility = false;
        const s = session();
        await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
        const snap = DesktopSnapshotTool.run({}, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        card!.press("open");
        const r = await snap;
        expect(r).toMatchObject({ isError: true });
        expect(r.content).toEndWith(ACCESSIBILITY_LINE);
        expect(card!.closed).toBe(true);
    });

    test("Accessibility the running helper doesn't see: a helper started every few checks does, and the call runs on a new one", async () => {
        setDesktopAccess({ open: async () => true, timing: { ...fast, freshEvery: 2 } });
        const fresh: FakeHelper[] = [];
        setDesktopHelperStarter(async () => {
            started++;
            if (started === 1) return helper;
            const h = new FakeHelper();
            fresh.push(h);
            return h;
        });
        const s = session();
        await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
        helper.accessibility = false;
        const snap = DesktopSnapshotTool.run({}, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        card!.press("open");
        const r = await snap;
        expect(r.isError).toBeUndefined();
        // Checked with a new helper on the second check, then the snapshot ran on the next one started.
        expect(fresh.length).toBe(2);
        expect(fresh[0]!.running).toBe(false);
        expect(fresh[1]!.sent("look").length).toBeGreaterThan(0);
        expect(helper.running).toBe(false);
    });

    test("Screen Recording, which only a new process sees: checked with a helper started for it, then the call runs on a new one", async () => {
        const fresh: FakeHelper[] = [];
        setDesktopHelperStarter(async () => {
            started++;
            if (started === 1) return helper;
            const h = new FakeHelper();
            h.ready = Promise.resolve({ accessibility: true, screen: false });
            fresh.push(h);
            return h;
        });
        const s = await (async () => {
            const x = session();
            await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(x));
            return x;
        })();
        helper.screen = false;
        const shot = DesktopScreenshotTool.run({}, ctxCard(s));
        await until(() => Boolean(card?.views.length));
        expect(card!.last).toMatchObject({ grant: "screen", title: "Let Cavvy take screenshots of apps?", step: "ask" });
        card!.press("open");
        await until(() => card!.last?.step === "waiting");
        expect(opened).toEqual(["screen"]);
        expect(helper.calls.filter((c) => c.op === "status" && c.ask === "screen")).toHaveLength(1);
        // Each check starts a helper and stops it.
        await until(() => fresh.length >= 2);
        expect(fresh.slice(0, -1).every((h) => !h.running)).toBe(true);
        // Turned on: a new process sees it, the running helper never does.
        const probes = fresh.length;
        setDesktopHelperStarter(async () => {
            started++;
            const h = new FakeHelper();
            h.ready = Promise.resolve({ accessibility: true, screen: true });
            fresh.push(h);
            return h;
        });
        const r = await shot;
        expect(r.isError).toBeUndefined();
        expect(r.content).toStartWith("Screenshot of TextEdit");
        // The screenshot was taken by a helper started after the grant; the old one is stopped.
        expect(fresh.length).toBeGreaterThan(probes);
        expect(helper.running).toBe(false);
        expect(fresh.at(-1)!.sent("screenshot")).toHaveLength(1);
    });
});

test("a window's card: presses wait to be asked for, it shows and goes once, and the turn stopping closes it", async () => {
    const shown: [string, boolean][] = [];
    let hidden = 0;
    const stop = new AbortController();
    const { card, press } = windowCard({ show: (v, first) => shown.push([v.step, first]), hide: () => hidden++ }, stop.signal);
    const view = { grant: "accessibility" as const, title: ACCESS_TITLES.accessibility, step: "ask" as const, name: "Cavvy Desktop Control" };
    card.show(view);
    press("open");
    expect(await card.next()).toBe("open");
    card.show({ ...view, step: "waiting" });
    expect(shown).toEqual([["ask", true], ["waiting", false]]);
    const next = card.next();
    stop.abort();
    expect(await next).toBe("close");
    card.close();
    card.close();
    expect(hidden).toBe(1);
    // Over: nothing more is shown, and it's closed to whoever asks.
    card.show(view);
    expect(shown).toHaveLength(2);
    expect(await card.next()).toBe("close");
});

describe("Reset access, for a switch macOS no longer counts", () => {
    test("tccutil is only ever told the helper's own bundle id, and the grant's service", async () => {
        expect(resetCommand("accessibility", "dev.cavvy.desktop.control")).toEqual(["/usr/bin/tccutil", "reset", "Accessibility", "dev.cavvy.desktop.control"]);
        expect(resetCommand("screen", "dev.cavvy.desktop.control")).toEqual(["/usr/bin/tccutil", "reset", "ScreenCapture", "dev.cavvy.desktop.control"]);
        // Never without an id (every app's grant), nor for another app, nor one that only starts the same.
        for (const id of ["", "com.apple.Terminal", "dev.cavvy.desktop", "dev.cavvy.desktop.control.other", "dev.cavvy.desktop.control ", " dev.cavvy.desktop.control", "All"]) {
            expect(() => resetCommand("accessibility", id)).toThrow("Not done: access is reset only for");
            await expect(resetGrant("accessibility", id)).rejects.toThrow("Not done");
        }
        // Not run in tests: refused, and counted (test/preload.ts would fail this test, so it's taken back here).
        await expect(resetGrant("accessibility", "dev.cavvy.desktop.control")).rejects.toMatchObject({ code: "test" });
        const { REAL_HELPER_REFUSED } = await import("../src/desktop/helper");
        const g = globalThis as Record<symbol, number>;
        expect(g[REAL_HELPER_REFUSED]).toBe(1);
        g[REAL_HELPER_REFUSED] = 0;
    });

    test("the card offers Reset access; once it's done, it asks as the first time, and the action carries on", async () => {
        const record = join(paths.home(), "desktop", "build.json");
        mkdirSync(dirname(record), { recursive: true });
        const resets: [string, string][] = [];
        let fail: string | undefined = "tccutil: No such bundle identifier";
        const opened: string[] = [];
        setDesktopAccess({ open: async (g) => (opened.push(g), true), reset: async (g, id) => (resets.push([g, id]), fail), timing: { everyMs: { accessibility: 5, screen: 5 }, freshEvery: 1000, limitMs: 2000 } });
        let card: FakeCard | undefined;
        const ctx = (s: InstanceType<typeof DesktopSession>) => ({ ...ctxWith(s), ui: { accessCard: () => (card = new FakeCard()) } });
        const until = async (ok: () => boolean) => {
            for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(5);
            expect(ok()).toBe(true);
        };
        try {
            writeFileSync(record, JSON.stringify({ hash: "new", trusted: "old" }));
            const s = session();
            await DesktopControlTool.run({ action: "request_access", app: "TextEdit" }, ctxWith(s));
            helper.accessibility = false;
            const snap = DesktopSnapshotTool.run({}, ctx(s));
            await until(() => Boolean(card?.views.length));
            expect(card!.last).toMatchObject({ grant: "accessibility", step: "stale", name: "Cavvy Desktop Control" });
            // It didn't work: said on the card, which still offers it.
            card!.press("reset");
            await until(() => card!.views.length === 2);
            expect(card!.last).toMatchObject({ step: "stale", error: "tccutil: No such bundle identifier" });
            fail = undefined;
            card!.press("reset");
            await until(() => card!.views.length === 3);
            expect(card!.last).toMatchObject({ step: "ask" });
            expect(card!.last?.error).toBeUndefined();
            expect(resets).toEqual([["accessibility", "dev.cavvy.desktop.control"], ["accessibility", "dev.cavvy.desktop.control"]]);
            // A first time again: this build's lack of it isn't a stale switch any more.
            expect(JSON.parse(readFileSync(record, "utf8")).trusted).toBeUndefined();
            card!.press("open");
            await until(() => card!.last?.step === "waiting");
            expect(opened).toEqual(["accessibility"]);
            helper.accessibility = true;
            expect((await snap).isError).toBeUndefined();
        } finally {
            rmSync(record, { force: true });
        }
    });
});
