// #408 in the terminal app: an account switch lets the CLI's process go, and the turns it started by itself that
// wait to be taken over go with it. What they reported is still shown and told to the model (#305); a message of
// the user's one of them answers goes back to the prompt, once.

import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { AssistantMessage, ChatRequest } from "../src/providers/types";
import type { BackendWake } from "../src/backends/types";

const { cleanup } = isolate();
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { addAccount } = await import("../src/providers/accounts");
const { stripAnsi } = await import("../src/ui/ansi");
afterAll(cleanup);

const MODEL = { provider: "test", id: "m1", name: "Test model" } as any;
const work = addAccount("claude-code", { id: "work-408", name: "Work" });

/** An app on a fake model that answers each request, keeping what it was sent. */
function testApp() {
    const cwd = realpathSync(tempDir("wakes-tui-account-"));
    const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
    (app as any).renderLive = () => {};
    app.session = Session.create(cwd, { persist: false });
    const requests: ChatRequest[] = [];
    app.model = MODEL;
    app.client = {
        stream: async (req: ChatRequest): Promise<AssistantMessage> => {
            requests.push(req);
            return { role: "assistant", content: [{ type: "text", text: "Done." }], provider: "test", model: "m1", stopReason: "end_turn" };
        },
        listModels: async () => [],
    } as any;
    app.makeAgent();
    const sent = () => JSON.stringify(requests.at(-1)?.messages ?? []);
    return { app, a: app as any, sent, text: () => printed.map(stripAnsi).join("\n") };
}

async function until(what: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!what()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(5);
    }
}

/** A switch under way meanwhile: the app can't start a turn, and the CLI's turn waits to be taken over. */
function waiting(a: any, w: BackendWake) {
    a.switching = new Promise(() => {});
    a.adoptWake(w);
}

test("a report waiting to be taken over is shown, and goes to the model with the next prompt", async () => {
    const { app, a, sent, text } = testApp();
    waiting(a, { provider: "claude-code", ref: "turn-r", label: "Background task finished: Map auth", report: "AUTH-REPORT-408" });
    await app.setAccount("claude-code", work.id);
    a.switching = undefined;
    expect(text()).toContain("AUTH-REPORT-408");
    expect(app.session.notices.some((n) => n.text.includes("Claude Code started a turn of its own") && n.text.includes("AUTH-REPORT-408"))).toBe(true);
    // Past wake's 1s deferral: it isn't taken over.
    await Bun.sleep(1300);
    expect(app.session.messages.some((m) => m.meta?.kind === "wake")).toBe(false);
    await app.startTurn("and now?");
    await until(() => !app.busy);
    expect(sent()).toContain("AUTH-REPORT-408");
});

test("the user's message one of them answers goes back to the prompt once, and isn't sent", async () => {
    const { app, a, sent } = testApp();
    waiting(a, { provider: "claude-code", ref: "turn-p", label: "fix the flaky test 408", prompt: true });
    await app.setAccount("claude-code", work.id);
    a.switching = undefined;
    await Bun.sleep(1300);
    expect(a.editor.text).toBe("fix the flaky test 408");
    expect(app.session.messages.some((m) => JSON.stringify(m).includes("fix the flaky test 408"))).toBe(false);
    expect(sent()).not.toContain("fix the flaky test 408");
});

test("with two switches overlapping, a turn that comes after the second ends but before the first's release does is still not taken over", async () => {
    const codex = addAccount("codex", { id: "work-408-cx", name: "Work" });
    const { app, a, sent } = testApp();
    let finishFirst!: () => void;
    let calls = 0;
    app.agent!.releaseAccountProcess = async () => {
        if (calls++ === 0) await new Promise<void>((r) => (finishFirst = r));
        return 0;
    };
    const first = app.setAccount("codex", codex.id);
    await app.setAccount("codex", "default");
    a.adoptWake({ provider: "codex", ref: "turn-g", label: "Background command finished: bun test", report: "GAP-REPORT-408" });
    finishFirst();
    await first;
    await Bun.sleep(1300);
    expect(app.session.messages.some((m) => m.meta?.kind === "wake")).toBe(false);
    expect(app.session.notices.some((n) => n.text.includes("Codex started a turn of its own") && n.text.includes("GAP-REPORT-408"))).toBe(true);
    await app.startTurn("and now?");
    await until(() => !app.busy);
    expect(sent()).toContain("GAP-REPORT-408");
});

test("turns the earlier process starts while it's being let go of get the same: none is taken over", async () => {
    const { app, a, sent } = testApp();
    const agent = app.agent!;
    const release = agent.releaseAccountProcess.bind(agent);
    agent.releaseAccountProcess = async (provider: string) => {
        a.adoptWake({ provider: "claude-code", ref: "turn-x", label: "Background command finished: bun test", report: "TESTS-REPORT-408" });
        a.adoptWake({ provider: "claude-code", ref: "turn-y", label: "send this now 408", prompt: true });
        await Bun.sleep(1200);
        return release(provider);
    };
    await app.setAccount("claude-code", work.id);
    await Bun.sleep(1300);
    expect(app.session.messages.some((m) => m.meta?.kind === "wake" || JSON.stringify(m).includes("send this now 408"))).toBe(false);
    expect(a.editor.text).toBe("send this now 408");
    expect(app.session.notices.some((n) => n.text.includes("TESTS-REPORT-408"))).toBe(true);
    a.editor.set("");
    await app.startTurn("and now?");
    await until(() => !app.busy);
    expect(sent()).toContain("TESTS-REPORT-408");
});
