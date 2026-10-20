// Exercise the actual Solid keyed boundary without a browser, and the TUI's
// real key routing. No real secrets or user configuration are used.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

const iso = isolate();
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { BashTool } = await import("../src/tools/bash");
const { KeyParser } = await import("../src/ui/keys");
afterAll(() => iso.cleanup());

test("the dock keeps a partially typed secret when unrelated interactions change", () => {
    const source = readFileSync(new URL("../gui/src/components/InteractionDock.tsx", import.meta.url), "utf8");
    const tab = source.slice(source.indexOf("export function InteractionTab"), source.indexOf("/** An option"));
    // Use the installed Solid compiler and client reactivity. The renderer only
    // needs to evaluate insertions: the regression is disposal, not DOM layout.
    const compiled = transformSync(tab, {
        filename: "InteractionTab.tsx",
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]],
        configFile: false,
        babelrc: false,
    })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;")
        .replace("export function InteractionTab", "function InteractionTab");
    const resolve = (value: any): any => typeof value === "function" ? resolve(value()) : value;
    const renderer = {
        ...solid,
        effect: solid.createRenderEffect,
        createElement: () => ({}),
        createTextNode: () => ({}),
        insertNode() {},
        setProp() {},
        insert: (_node: any, value: any) => solid.createRenderEffect(() => resolve(value)),
    };
    const mounted: { value: string }[] = [];
    const card = () => {
        const input = { value: "" };
        mounted.push(input);
        solid.onCleanup(() => { input.value = ""; });
        return input;
    };
    const InteractionTab = new Function("renderer", "SecretCard", "PermissionCard", "QuestionCard", "PlanCard", `${js}; return InteractionTab;`)(renderer, card, () => ({}), () => ({}), () => ({}));
    const secret = { id: "secret-1", kind: "secret", name: "DEMO_TOKEN", purpose: "Test the dock" };
    let dispose!: () => void;
    let update!: (items: any[]) => void;
    solid.createRoot((d: () => void) => {
        dispose = d;
        const [items, setItems] = solid.createSignal([secret]);
        update = setItems;
        const output = InteractionTab({ sessionId: "test-session", get items() { return items(); } });
        solid.createRenderEffect(() => resolve(output));
    });
    try {
        expect(mounted).toHaveLength(1);
        const input = mounted[0]!;
        input.value = "zq7Xv9Lr2Wm4";
        update([{ ...secret }, { id: "question-1", kind: "question" }]);
        expect(mounted).toHaveLength(1);
        expect(input.value).toBe("zq7Xv9Lr2Wm4");
        update([{ ...secret }]);
        expect(mounted).toHaveLength(1);
        expect(input.value).toBe("zq7Xv9Lr2Wm4");
        update([{ ...secret, id: "secret-2" }]);
        expect(mounted).toHaveLength(2);
        expect(input.value).toBe("");
        update([]);
        expect(mounted[1]!.value).toBe("");
    } finally {
        dispose();
    }
});

function appForTest() {
    const app: any = new App({ cwd: realpathSync(tempDir()), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    app.screen = { print() {}, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true };
    app.renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    app.notifier.notify = async () => {};
    const type = (raw: string) => {
        const parser = new KeyParser();
        for (const key of [...parser.feed(raw), ...parser.flushEscape()]) app.onKey(key);
    };
    const permission = (signal?: AbortSignal) => app.askPermission({
        tool: BashTool, input: { command: "echo test" }, title: "Bash(echo test)",
        decision: { behavior: "ask", suggestions: [] }, signal,
    });
    return { app, type, permission };
}

test("a permission and question cannot take keystrokes from an open masked prompt", async () => {
    const { app, type, permission } = appForTest();
    const secret = app.requestSecret("DEMO_TOKEN", "Test input routing", new AbortController().signal);
    await Bun.sleep(10);
    const prompt = app.dialogs[0];
    const permitted = permission();
    const question = app.askQuestion("Choose a value", [{ label: "one" }, { label: "two" }], false);
    await Bun.sleep(30);
    try {
        expect(app.dialogs).toEqual([prompt]);
        type("zq7Xv9Lr2Wm4Kp8T\r");
        expect(await secret).toBe("zq7Xv9Lr2Wm4Kp8T");
        // Answer queued dialogs only once the secret has completed.
        await Bun.sleep(10);
        type("\x1b");
        await Bun.sleep(10);
        type("\x1b");
        expect(await permitted).toEqual({ allow: false });
        expect(await question).toBeUndefined();
    } finally {
        for (const d of [...app.dialogs, ...(app.dialogQueue ?? [])]) d.cancel();
    }
});

test("a secret waits behind a question, and cancelled queued prompts never appear", async () => {
    const { app, type, permission } = appForTest();
    const question = app.askQuestion("Keep typing here", [{ label: "one" }], false);
    await Bun.sleep(10);
    const prompt = app.dialogs[0];
    const cancelSecret = new AbortController();
    const secret = app.requestSecret("DEMO_TOKEN", "Testing cancellation", cancelSecret.signal);
    const cancelPermission = new AbortController();
    const permitted = permission(cancelPermission.signal);
    await Bun.sleep(30);
    try {
        expect(app.dialogs).toEqual([prompt]);
        cancelSecret.abort();
        cancelPermission.abort();
        expect(await secret).toBeUndefined();
        expect(await permitted).toEqual({ allow: false });
        expect(app.dialogs).toEqual([prompt]);
        type("\r");
        expect(await question).toEqual(["one"]);
        expect(app.dialogs).toHaveLength(0);
        expect(app.dialogQueue ?? []).toHaveLength(0);
    } finally {
        for (const d of [...app.dialogs, ...(app.dialogQueue ?? [])]) d.cancel();
    }
});

test("an already cancelled secret request never opens a dialog", async () => {
    const { app } = appForTest();
    const cancel = new AbortController();
    cancel.abort();
    const secret = app.requestSecret("DEMO_TOKEN", "Testing cancellation", cancel.signal);
    try {
        expect(app.dialogs).toHaveLength(0);
        expect(await secret).toBeUndefined();
    } finally {
        for (const d of [...app.dialogs, ...(app.dialogQueue ?? [])]) d.cancel();
    }
});

test("interrupting a secret request also withdraws queued questions", async () => {
    const { app, type } = appForTest();
    app.busy = true;
    const cancel = new AbortController();
    app.abort = cancel;
    const secret = app.requestSecret("DEMO_TOKEN", "Testing interrupt", cancel.signal);
    const question = app.askQuestion("Queued question", [{ label: "one" }], false);
    await Bun.sleep(10);
    try {
        type("\x03");
        await secret;
        await Bun.sleep(10);
        expect(app.dialogs).toHaveLength(0);
        expect(app.dialogQueue).toHaveLength(0);
        expect(await question).toBeUndefined();
    } finally {
        for (const d of [...app.dialogs, ...(app.dialogQueue ?? [])]) d.cancel();
    }
});

test.each(["DEMO_TOKEN", "REDACTED"])("a marker collision keeps the masked terminal prompt open (%s)", async (value) => {
    const { app, type } = appForTest();
    const secret = app.requestSecret("DEMO_TOKEN", "Testing marker validation", new AbortController().signal);
    await Bun.sleep(10);
    const prompt = app.dialogs[0];
    try {
        type(`${value}\r`);
        await Bun.sleep(10);
        expect(app.dialogs).toEqual([prompt]);
        type("\x1b");
        expect(await secret).toBeUndefined();
    } finally {
        for (const d of [...app.dialogs, ...(app.dialogQueue ?? [])]) d.cancel();
    }
});
