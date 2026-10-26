// MCP prompts run from the TUI's slash commands, with the real dialog stack and
// key routing. The MCP manager is a stand-in: the server side is covered elsewhere.
import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { KeyParser } = await import("../src/ui/keys");
const { runCommand } = await import("../src/commands/index");
afterAll(() => iso.cleanup());

function appForTest(runPrompt: (asker: any, signal: AbortSignal) => Promise<{ text: string; images: unknown[] }>) {
    const app: any = new App({ cwd: realpathSync(tempDir()), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    app.screen = { print() {}, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true };
    app.renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    app.notifier.notify = async () => {};
    const prompt = { command: "mcp__demo__greet", server: "demo", prompt: { name: "greet" }, description: "Greets" };
    app.mcp = { promptCommands: () => [prompt], runPrompt: (_c: string, _a: string, asker: any, signal: AbortSignal) => runPrompt(asker, signal) };
    const turns: string[] = [];
    app.startTurn = async (text: string) => { turns.push(text); };
    const type = (raw: string) => {
        const parser = new KeyParser();
        for (const key of [...parser.feed(raw), ...parser.flushEscape()]) app.onKey(key);
    };
    return { app, type, turns };
}

test("a prompt that asks a question shows it above the progress box and takes the answer", async () => {
    const { app, type, turns } = appForTest(async (asker) => {
        const answer = await asker.askQuestion("Who should I greet?", [], false);
        return { text: `Hello ${answer?.[0]}`, images: [] };
    });
    const run = runCommand(app, "/mcp__demo__greet");
    await Bun.sleep(20);
    try {
        // The question is on top, so it has the keys; the progress box waits under it.
        expect(app.dialogs).toHaveLength(2);
        expect(app.dialogQueue).toHaveLength(0);
        type("Ada\r");
        await run;
        expect(turns).toEqual(["Hello Ada"]);
        expect(app.dialogs).toHaveLength(0);
    } finally {
        for (const d of [...app.dialogs, ...app.dialogQueue]) d.cancel();
    }
});

test("escape on a prompt's question declines it without cancelling the prompt", async () => {
    const { app, type, turns } = appForTest(async (asker) => {
        const answer = await asker.askQuestion("Who should I greet?", [], false);
        return { text: answer ? `Hello ${answer[0]}` : "Hello stranger", images: [] };
    });
    const run = runCommand(app, "/mcp__demo__greet");
    await Bun.sleep(20);
    try {
        type("\x1b");
        await run;
        expect(turns).toEqual(["Hello stranger"]);
    } finally {
        for (const d of [...app.dialogs, ...app.dialogQueue]) d.cancel();
    }
});

test("a dialog unrelated to the prompt still waits its turn behind other dialogs", async () => {
    const { app } = appForTest(async () => ({ text: "", images: [] }));
    const first = app.askQuestion("First", [{ label: "a" }], false);
    const second = app.askQuestion("Second", [{ label: "b" }], false);
    await Bun.sleep(10);
    try {
        expect(app.dialogs).toHaveLength(1);
        expect(app.dialogQueue).toHaveLength(1);
    } finally {
        for (const d of [...app.dialogs, ...app.dialogQueue]) d.cancel();
        await Promise.all([first, second]);
    }
});
