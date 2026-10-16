// "Open in editor" through the GUI server's requests: the editor list, the
// preference in user settings, fs.exists for link candidates and fs.open,
// with fake launchers on a PATH of their own and the launch recorded instead
// of run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { SessionSnapshot } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));

// Fake editors: a `code` launcher on PATH, and a Sublime Text app with no CLI.
const bin = tempDir("harness-ed-bin-");
writeFileSync(join(bin, "code"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "code"), 0o755);
const apps = tempDir("harness-ed-apps-");
mkdirSync(join(apps, "Sublime Text.app"));

const extra = realpathSync(tempDir("harness-ed-extra-"));
writeFileSync(join(extra, "notes.md"), "x");
const outside = realpathSync(tempDir("harness-ed-out-"));
writeFileSync(join(outside, "secret.txt"), "x");

writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { additionalDirectories: [extra] } }));

const launched: string[][] = [];
const engine = new Engine({
    editorEnv: () => ({ platform: "darwin", path: bin, appDirs: [apps] }),
    launchEditor: async (argv) => void launched.push(argv),
});
const c = { subs: new Set<string>(), send() {} };
engine.clients.add(c);
const call = (method: string, params: unknown) => engine.handle(c, method as never, params);

let cwd: string;
let id: string;

beforeAll(async () => {
    cwd = realpathSync(createDemoProject(tempDir("harness-ed-proj-"), { git: false }));
    mkdirSync(join(cwd, "dir with space"));
    writeFileSync(join(cwd, "dir with space/a b.ts"), "x");
    writeFileSync(join(cwd, "run.command"), "#!/bin/sh\n");
    writeFileSync(join(cwd, "evil.code-workspace"), JSON.stringify({ folders: [{ path: outside }] }));
    symlinkSync(join(outside, "secret.txt"), join(cwd, "leak.txt"));
    const snap = (await call("session.create", { cwd })) as SessionSnapshot;
    id = snap.state.id;
});

afterAll(async () => {
    await engine.stop();
    mock.stop();
    iso.cleanup();
});

async function rejects(p: Promise<unknown>, code: string, message?: RegExp) {
    const e = (await p.then(() => undefined, (e) => e)) as { code?: string; message: string } | undefined;
    expect(e).toBeDefined();
    expect(e!.code).toBe(code);
    if (message) expect(e!.message).toMatch(message);
}

describe("the editor preference", () => {
    test("editors.list says which editors this machine has", async () => {
        const r = (await call("editors.list", {})) as { editors: { id: string; installed: boolean; lines: boolean }[]; selected?: string };
        const by = Object.fromEntries(r.editors.map((e) => [e.id, e]));
        expect(by.vscode).toMatchObject({ installed: true, lines: true });
        expect(by.sublime).toMatchObject({ installed: true, lines: false });
        expect(by.cursor).toMatchObject({ installed: false });
        expect(by.finder).toMatchObject({ installed: true });
        expect(r.selected).toBeUndefined();
    });

    test("with none chosen, opening says how to choose one", async () => {
        await rejects(call("fs.open", { sessionId: id, path: "package.json" }), "no_editor", /Settings/);
        expect(launched).toEqual([]);
    });

    test("only a known id is saved, in the user's settings", async () => {
        await rejects(call("settings.update", { patch: { editor: "/bin/sh" } }), "invalid");
        const s = (await call("settings.update", { patch: { editor: "vscode" } })) as { editor?: string };
        expect(s.editor).toBe("vscode");
        expect(JSON.parse(readFileSync(join(iso.home, "settings.json"), "utf8")).editor).toBe("vscode");
        expect(((await call("editors.list", {})) as { selected?: string }).selected).toBe("vscode");
    });
});

describe("fs.open", () => {
    test("a file in the project, at a line and column, as one argv entry even with spaces", async () => {
        launched.length = 0;
        expect(await call("fs.open", { sessionId: id, path: "dir with space/a b.ts", line: 780, col: 3 })).toEqual({ editor: "VS Code" });
        expect(launched).toEqual([[join(bin, "code"), "--goto", "--", `${cwd}/dir with space/a b.ts:780:3`]]);
    });

    test("the project folder", async () => {
        launched.length = 0;
        await call("fs.open", { sessionId: id, path: cwd, folder: true });
        expect(launched).toEqual([[join(bin, "code"), "--", cwd]]);
        await rejects(call("fs.open", { sessionId: id, path: "package.json", folder: true }), "invalid", /isn't a folder/);
        await rejects(call("fs.open", { sessionId: id, path: "dir with space" }), "invalid", /is a folder/);
    });

    test("an additional directory is inside the roots", async () => {
        launched.length = 0;
        await call("fs.open", { sessionId: id, path: join(extra, "notes.md") });
        expect(launched).toEqual([[join(bin, "code"), "--", join(extra, "notes.md")]]);
    });

    test("refused: outside the roots, through a symlink, option-like, odd lines, unknown editors, missing files", async () => {
        launched.length = 0;
        await rejects(call("fs.open", { sessionId: id, path: "/etc/hosts" }), "outside");
        await rejects(call("fs.open", { sessionId: id, path: join("..", outside.split("/").pop()!, "secret.txt") }), "outside");
        await rejects(call("fs.open", { sessionId: id, path: "leak.txt" }), "outside");
        await rejects(call("fs.open", { sessionId: id, path: "-n" }), "refused");
        await rejects(call("fs.open", { sessionId: id, path: "package.json", line: 0 }), "invalid");
        await rejects(call("fs.open", { sessionId: id, path: "package.json", line: "12" }), "invalid");
        await rejects(call("fs.open", { sessionId: id, path: "package.json", line: 1.5 }), "invalid");
        await rejects(call("fs.open", { sessionId: id, path: "package.json", editor: "sh -c id" }), "invalid", /Unknown editor/);
        await rejects(call("fs.open", { sessionId: id, path: "package.json", editor: "cursor" }), "not_installed");
        await rejects(call("fs.open", { sessionId: id, path: "nope.ts" }), "not_found");
        await rejects(call("fs.open", { sessionId: id, path: "evil.code-workspace" }), "refused", /workspace/);
        expect(launched).toEqual([]);
    });

    test("an app opened with `open -a` gets no launchable file", async () => {
        launched.length = 0;
        await rejects(call("fs.open", { sessionId: id, path: "run.command", editor: "sublime" }), "refused", /could run/);
        await call("fs.open", { sessionId: id, path: "package.json", line: 4, editor: "sublime" });
        expect(launched).toEqual([["open", "-a", join(apps, "Sublime Text.app"), join(cwd, "package.json")]]);
    });

    test("a folder must be open in Harness to be used instead of a session", async () => {
        launched.length = 0;
        await call("fs.open", { cwd, path: "package.json" });
        expect(launched).toHaveLength(1);
        await rejects(call("fs.open", { cwd: outside, path: "secret.txt" }), "not_open");
        await rejects(call("fs.open", { sessionId: "nope", path: "package.json" }), "not_open");
    });
});

test("on Windows it says it isn't supported, rather than that nothing is installed", async () => {
    const win = new Engine({ editorEnv: () => ({ platform: "win32", path: bin, appDirs: [] }), launchEditor: async () => void launched.push(["nope"]) });
    win.clients.add(c);
    await rejects(win.handle(c, "fs.open" as never, { cwd, path: "package.json", editor: "vscode" } as never), "unsupported");
    await win.stop();
});

describe("fs.exists", () => {
    test("files inside the roots resolve; missing, outside and folders are null", async () => {
        const r = await call("fs.exists", { sessionId: id, paths: ["package.json", "nope.ts", "/etc/hosts", "leak.txt", "dir with space", join(extra, "notes.md"), "-rf", 7, "evil.code-workspace"] });
        expect(r).toEqual([join(cwd, "package.json"), null, null, null, null, join(extra, "notes.md"), null, null, null]);
    });

    test("at most 200 at a time", async () => {
        await rejects(call("fs.exists", { sessionId: id, paths: Array(201).fill("a.ts") }), "limit");
        await rejects(call("fs.exists", { sessionId: id, paths: "a.ts" }), "invalid");
    });
});
