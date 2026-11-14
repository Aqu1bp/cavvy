// The terminal app's sign-in prompt: the same sign-in as the GUI's card, as text that changes in place, with the
// keys each kind takes. Run against the pretend CLI for real.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { acmeRecipe, fakeSignInCli } from "../scripts/fake-signin-cli";

const iso = isolate();
const acme = fakeSignInCli(tempDir("cavvy-tui-signin-cli-"));
process.env.PATH = `${acme.bin}:${process.env.PATH}`;
mkdirSync(iso.home, { recursive: true });
const recipes = [
    acmeRecipe("device", { token: { run: "acme login --token", url: "https://acme.example/tokens" } }),
    { ...acmeRecipe("paste"), id: "acme-paste", name: "Acme Paste", env: { ACME_SERVICE: "paste" } },
    { ...acmeRecipe("typed"), id: "acme-typed", name: "Acme Typed", env: { ACME_SERVICE: "typed" } },
    { ...acmeRecipe("browser"), id: "acme-browser", name: "Acme Browser", env: { ACME_SERVICE: "browser" } },
];
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ signIns: recipes }));

const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { KeyParser } = await import("../src/ui/keys");
const { stripAnsi } = await import("../src/ui/ansi");
const { runCommand } = await import("../src/commands/index");
const { SignInDialog } = await import("../src/ui/sign-in-dialog");
import type { SignInAnswer } from "../src/agent/sign-ins";

afterAll(() => iso.cleanup());
beforeEach(() => acme.reset());

function testApp() {
    const app = new App({ cwd: tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const printed: string[] = [];
    const screen = { print: (f: any) => (printed.push(...(typeof f === "function" ? f(100) : [f]).map(String)), {}), replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true as boolean | undefined };
    (app as any).screen = screen;
    (app as any).renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    app.session.setSystem("test system prompt");
    (app as any).notifier.notify = async () => {};
    const top = () => (app as any).dialogs.at(-1) as InstanceType<typeof SignInDialog> | undefined;
    const text = () => (top() ? stripAnsi(top()!.render(100).join("\n")) : "");
    const shows = async (what: string | RegExp) => {
        const end = Date.now() + 8000;
        while (Date.now() < end) {
            const t = text();
            if (typeof what === "string" ? t.includes(what) : what.test(t)) return t;
            await Bun.sleep(15);
        }
        throw new Error(`never showed ${what}; showing:\n${text()}`);
    };
    const ask = (target: string, signal = new AbortController().signal): Promise<SignInAnswer> => (app as any).requestSignIn({ targets: [{ target }] }, signal);
    return { app, printed, top, text, shows, ask };
}

function type(d: { onKey(k: any): void } | undefined, raw: string) {
    const p = new KeyParser();
    for (const k of p.feed(raw)) d!.onKey(k);
    for (const k of p.flushEscape()) d!.onKey(k);
}

describe("the terminal app's sign-in prompt", () => {
    test("the question, then the code and where to enter it; it closes by itself once signed in", async () => {
        const x = testApp();
        const answer = x.ask("acme");
        const q = await x.shows("Sign in to Acme?");
        expect(q).toContain("enter to sign in · t to use a token · esc for later");
        type(x.top(), "\r");
        const code = await x.shows("Code: WXYZ-1234");
        expect(code).toContain("Enter it at https://acme.example/device");
        acme.approve("me@example.com");
        expect((await answer).text).toBe("Signed in to Acme as me@example.com.");
        expect((x.app as any).dialogs).toHaveLength(0);
    });

    test("a token is typed hidden; a bad one says why and stays; esc goes back to the question", async () => {
        const x = testApp();
        const answer = x.ask("acme");
        await x.shows("Sign in to Acme?");
        type(x.top(), "t");
        const field = await x.shows("Token (input is hidden)");
        expect(field).toContain("Make one at https://acme.example/tokens");
        type(x.top(), "wrong-token-999");
        expect(x.text()).not.toContain("wrong-token-999");
        expect(x.text()).toContain("•".repeat(15));
        type(x.top(), "\r");
        const bad = await x.shows("Bad credentials");
        expect(bad).not.toContain("wrong-token-999");
        type(x.top(), "\x1b");
        await x.shows("enter to sign in");
        type(x.top(), "t");
        await x.shows("Token (input is hidden)");
        type(x.top(), "\x1b[200~good-token-123\x1b[201~\r");
        expect((await answer).text).toBe("Signed in to Acme as token-user.");
    });

    test("a code pasted back", async () => {
        const x = testApp();
        const answer = x.ask("acme-paste");
        await x.shows("Sign in to Acme Paste?");
        type(x.top(), "y");
        const paste = await x.shows("paste the code it gives you");
        expect(paste).toContain("https://acme.example/authorize?mode=paste");
        type(x.top(), "good-code\r");
        expect((await answer).signedIn).toBe(true);
    });

    test("the CLI's own prompts take the keys; a password isn't shown", async () => {
        const x = testApp();
        const answer = x.ask("acme-typed");
        await x.shows("Sign in to Acme Typed?");
        type(x.top(), "\r");
        await x.shows("Username:");
        type(x.top(), "octo\r");
        await x.shows("Password:");
        type(x.top(), "hunter22");
        expect(x.text()).not.toContain("hunter22");
        type(x.top(), "\r");
        expect((await answer).text).toBe("Signed in to Acme Typed as octo.");
    });

    test("a browser sign-in shows its link while it waits", async () => {
        const x = testApp();
        const answer = x.ask("acme-browser");
        await x.shows("Sign in to Acme Browser?");
        type(x.top(), "\r");
        const wait = await x.shows("Finish in your browser");
        expect(wait).toContain("https://acme.example/authorize?state=abc");
        acme.approve();
        expect((await answer).signedIn).toBe(true);
    });

    test("esc puts it off: the status line says what's signed out, and /sign-in brings the prompt back", async () => {
        const x = testApp();
        const answer = x.ask("acme-paste");
        await x.shows("Sign in to Acme Paste?");
        type(x.top(), "\x1b");
        expect((await answer).text).toContain("the user chose Later");
        expect((x.app as any).dialogs).toHaveLength(0);
        expect(x.app.toolState.watchers!.size).toBe(1);
        await runCommand(x.app, "/sign-in");
        // Past the question: it goes straight to what it needs.
        await x.shows("paste the code it gives you");
        type(x.top(), "good-code\r");
        const end = Date.now() + 5000;
        while (x.app.toolState.watchers!.size && Date.now() < end) await Bun.sleep(15);
        expect(x.app.toolState.watchers!.size).toBe(0);
        expect(x.app.toolState.wakes!.pending().map((w) => w.label)).toEqual(["Signed in to Acme Paste"]);
        x.app.toolState.wakes!.clear();
        await runCommand(x.app, "/sign-in");
        expect(x.printed.join("\n")).toContain("No sign-in is waiting.");
    });

    test("an interrupt withdraws it", async () => {
        const x = testApp();
        const stop = new AbortController();
        const answer = x.ask("acme", stop.signal);
        await x.shows("Sign in to Acme?");
        stop.abort();
        expect((await answer).text).toContain("interrupted");
        expect((x.app as any).dialogs).toHaveLength(0);
    });
});

describe("the prompt's other states", () => {
    const dialog = (view: Record<string, unknown>, o: { where?: string; open?: (u: string) => void } = {}) => {
        const sent: unknown[] = [];
        const d = new SignInDialog({ act: (a) => void sent.push(a), ...o });
        d.update(view as any);
        return { d, sent, text: () => stripAnsi(d.render(90).join("\n")) };
    };

    test("a server's sign-ins as a numbered list", () => {
        const x = dialog({ step: "list", machine: "box", rows: [{ target: "claude", name: "Claude Code", state: "out" }, { target: "codex", name: "Codex", state: "in", who: "me@example.com" }, { target: "gh", name: "GitHub", state: "out" }] });
        const t = x.text();
        expect(t).toContain("Sign in on box?");
        expect(t).toContain("1. Claude Code");
        expect(t).toContain("Codex  ✓ me@example.com");
        expect(t).toContain("2. GitHub");
        type(x.d, "2");
        expect(x.sent).toEqual([{ action: "pick", target: "gh" }]);
    });

    test("on a server it says where; an expired code offers a new one; a sign-in that gave up offers another try", () => {
        expect(dialog({ step: "ask", name: "GitHub", warning: "Agents there can push as you" }, { where: "on this server" }).text()).toContain("Sign in to GitHub on this server?");
        const old = dialog({ step: "code", name: "GitHub", code: "AAAA-BBBB", expired: true });
        expect(old.text()).toContain("This code expired.");
        type(old.d, "\r");
        expect(old.sent).toEqual([{ action: "retry" }]);
        const failed = dialog({ step: "browser", name: "AWS", ended: true, error: "aws: [ERROR]: access denied" });
        expect(failed.text()).toContain("aws: [ERROR]: access denied");
        expect(failed.text()).toContain("enter to try again");
        type(failed.d, "\r");
        expect(failed.sent).toEqual([{ action: "retry" }]);
    });

    test("a command Cavvy can't run is shown to run elsewhere; o opens a link only where there's a browser", () => {
        const cmd = dialog({ step: "command", name: "fly", target: "fly", command: "fly auth login", canSave: true });
        expect(cmd.text()).toContain("Run this in another terminal:");
        expect(cmd.text()).toContain("fly auth login");
        type(cmd.d, "s");
        expect(cmd.sent).toEqual([{ action: "done", save: true }]);
        const opened: string[] = [];
        const here = dialog({ step: "code", name: "GitHub", code: "AAAA-BBBB", url: "https://github.com/login/device" }, { open: (u) => void opened.push(u) });
        expect(here.text()).toContain("o to open it");
        type(here.d, "o");
        expect(opened).toEqual(["https://github.com/login/device"]);
        expect(dialog({ step: "code", name: "GitHub", code: "AAAA-BBBB", url: "https://github.com/login/device" }).text()).not.toContain("o to open it");
    });
});
