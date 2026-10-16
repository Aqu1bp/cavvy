// "Open in editor": the argv each editor gets, and what's refused before any
// editor sees it (paths outside the session's folders, option-like paths,
// launchable files, odd line numbers).

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { EDITORS, checkPathInput, confinePath, detectEditor, detectEditors, editorArgv, editorById, opensAsProject, position } = await import("../src/server/editors");
import type { FoundEditor } from "../src/server/editors";

afterAll(() => iso.cleanup());

const ed = (id: string, o: Partial<FoundEditor> = {}): FoundEditor => ({ def: editorById(id)!, launcher: `/bin/${id}`, ...o });
const FILE = "/Users/me/My Project/src/a file.ts";

describe("argv per editor", () => {
    test("VS Code and Cursor: --goto file:line:col after --; no --goto without a line", () => {
        for (const id of ["vscode", "cursor"]) {
            expect(editorArgv(ed(id), { path: FILE, line: 780, col: 5, folder: false })).toEqual([`/bin/${id}`, "--goto", "--", `${FILE}:780:5`]);
            expect(editorArgv(ed(id), { path: FILE, line: 780, folder: false })).toEqual([`/bin/${id}`, "--goto", "--", `${FILE}:780`]);
            expect(editorArgv(ed(id), { path: FILE, folder: false })).toEqual([`/bin/${id}`, "--", FILE]);
        }
    });

    test("Zed: file:line:col; Sublime: the same after --", () => {
        expect(editorArgv(ed("zed"), { path: FILE, line: 3, col: 9, folder: false })).toEqual(["/bin/zed", `${FILE}:3:9`]);
        expect(editorArgv(ed("zed"), { path: FILE, folder: false })).toEqual(["/bin/zed", FILE]);
        expect(editorArgv(ed("sublime"), { path: FILE, line: 3, folder: false })).toEqual(["/bin/sublime", "--", `${FILE}:3`]);
    });

    test("JetBrains: --line and --column before the path; through `open -na … --args` when only the app is there", () => {
        expect(editorArgv(ed("idea"), { path: FILE, line: 42, col: 7, folder: false })).toEqual(["/bin/idea", "--line", "42", "--column", "7", FILE]);
        expect(editorArgv(ed("pycharm"), { path: FILE, folder: false })).toEqual(["/bin/pycharm", FILE]);
        const app = { launcher: undefined, app: "/Applications/WebStorm.app" };
        expect(editorArgv(ed("webstorm", app), { path: FILE, line: 42, folder: false })).toEqual(["open", "-na", "/Applications/WebStorm.app", "--args", "--line", "42", FILE]);
    });

    test("an app with no launcher opens with `open -a` (no line); Finder only reveals", () => {
        const app = { launcher: undefined, app: "/Applications/Zed.app" };
        expect(editorArgv(ed("zed", app), { path: FILE, line: 9, folder: false })).toEqual(["open", "-a", "/Applications/Zed.app", FILE]);
        expect(editorArgv(ed("finder", { launcher: undefined }), { path: FILE, line: 9, folder: false })).toEqual(["open", "-R", FILE]);
        expect(editorArgv(ed("finder", { launcher: undefined }), { path: "/Users/me/proj", folder: true })).toEqual(["open", "-R", "/Users/me/proj"]);
    });

    test("a project folder: no line, even if one was sent", () => {
        expect(editorArgv(ed("vscode"), { path: "/Users/me/proj", line: 4, folder: true })).toEqual(["/bin/vscode", "--", "/Users/me/proj"]);
        expect(editorArgv(ed("idea"), { path: "/Users/me/proj", line: 4, folder: true })).toEqual(["/bin/idea", "/Users/me/proj"]);
    });

    test("a column needs a line", () => {
        expect(editorArgv(ed("zed"), { path: FILE, col: 4, folder: false })).toEqual(["/bin/zed", FILE]);
        expect(editorArgv(ed("idea"), { path: FILE, col: 4, folder: false })).toEqual(["/bin/idea", FILE]);
    });

    test("refused: relative paths, launchable files through `open -a`, bundles as projects, names ending in :N for file:line launchers", () => {
        expect(() => editorArgv(ed("vscode"), { path: "src/a.ts", folder: false })).toThrow(/absolute/);
        expect(() => editorArgv(ed("vscode"), { path: "-rf", folder: false })).toThrow(/absolute/);
        const app = { launcher: undefined, app: "/Applications/Sublime Text.app" };
        for (const f of ["/p/run.command", "/p/x.terminal", "/p/Do.workflow", "/p/Evil.APP", "/p/s.scpt"]) {
            expect(() => editorArgv(ed("sublime", app), { path: f, folder: false })).toThrow(/could run/);
        }
        // Its own CLI opens such a file as text.
        expect(editorArgv(ed("vscode"), { path: "/p/run.command", folder: false })).toEqual(["/bin/vscode", "--", "/p/run.command"]);
        expect(() => editorArgv(ed("vscode"), { path: "/Applications/Evil.app", folder: true })).toThrow(/bundle/);
        expect(() => editorArgv(ed("zed"), { path: "/p/notes:12", line: 3, folder: false })).toThrow(/line number/);
    });

    test("workspace and project files aren't opened as files: they'd open as projects", () => {
        const refused = [
            ["vscode", "/p/evil.code-workspace"],
            ["cursor", "/p/x.CODE-WORKSPACE"],
            ["sublime", "/p/x.sublime-project"],
            ["sublime", "/p/x.sublime-workspace"],
            ["idea", "/p/x.ipr"],
            ["idea", "/p/pom.xml"],
            ["goland", "/p/build.gradle"],
            ["webstorm", "/p/build.gradle.kts"],
            ["pycharm", "/p/settings.gradle.kts"],
            ["rider", "/w/a.sln"],
            ["rider", "/w/a.slnx"],
            ["rider", "/w/a.slnf"],
            ["rider", "/w/App/App.csproj"],
            ["rider", "/w/Lib/Lib.fsproj"],
            ["rider", "/w/Old/Old.vbproj"],
            ["rider", "/w/pom.xml"],
        ] as const;
        for (const [id, f] of refused) expect(() => editorArgv(ed(id), { path: f, line: 2, folder: false })).toThrow(/as a project/);
        // Also when only the app is there (`open -na … --args`, `open -a`).
        expect(() => editorArgv(ed("rider", { launcher: undefined, app: "/Applications/Rider.app" }), { path: "/w/a.sln", folder: false })).toThrow(/as a project/);
        expect(() => editorArgv(ed("vscode", { launcher: undefined, app: "/Applications/Visual Studio Code.app" }), { path: "/p/x.code-workspace", folder: false })).toThrow(/as a project/);
        // An editor that opens it as text gets it: Zed has no project files, VS Code reads a .sln or pom.xml as text.
        expect(editorArgv(ed("zed"), { path: "/p/x.code-workspace", folder: false })).toEqual(["/bin/zed", "/p/x.code-workspace"]);
        expect(editorArgv(ed("vscode"), { path: "/w/a.sln", line: 3, folder: false })).toEqual(["/bin/vscode", "--goto", "--", "/w/a.sln:3"]);
        expect(editorArgv(ed("vscode"), { path: "/p/pom.xml", folder: false })).toEqual(["/bin/vscode", "--", "/p/pom.xml"]);
        // A name that only looks like one isn't: my-pom.xml, a.sln.txt.
        expect(editorArgv(ed("rider"), { path: "/w/my-pom.xml", folder: false })).toEqual(["/bin/rider", "/w/my-pom.xml"]);
        expect(editorArgv(ed("rider"), { path: "/w/a.sln.txt", folder: false })).toEqual(["/bin/rider", "/w/a.sln.txt"]);
        // With no editor chosen: anything any editor would open as a project.
        expect(opensAsProject(undefined, "/w/a.sln")).toBe(true);
        expect(opensAsProject(undefined, "/p/x.sublime-project")).toBe(true);
        expect(opensAsProject(undefined, "/p/a.ts")).toBe(false);
        // Finder only shows where it is.
        expect(editorArgv(ed("finder", { launcher: undefined }), { path: "/p/evil.code-workspace", folder: false })).toEqual(["open", "-R", "/p/evil.code-workspace"]);
    });

    test("position: whole numbers in range, or nothing", () => {
        expect(position(undefined, "line", 100)).toBeUndefined();
        expect(position(12, "line", 100)).toBe(12);
        for (const bad of [0, -1, 1.5, 101, "12", NaN, Infinity]) expect(() => position(bad, "line", 100)).toThrow(/whole number/);
    });

    test("every editor id is unique and known", () => {
        expect(new Set(EDITORS.map((e) => e.id)).size).toBe(EDITORS.length);
        expect(editorById("emacs; rm -rf /")).toBeUndefined();
    });
});

describe("detection", () => {
    test("a launcher on PATH, else (macOS) the app's own CLI, else the app", () => {
        const bin = tempDir("harness-ed-bin-");
        writeFileSync(join(bin, "zed"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "zed"), 0o755);
        const apps = tempDir("harness-ed-apps-");
        mkdirSync(join(apps, "Visual Studio Code.app/Contents/Resources/app/bin"), { recursive: true });
        writeFileSync(join(apps, "Visual Studio Code.app/Contents/Resources/app/bin/code"), "#!/bin/sh\n");
        mkdirSync(join(apps, "Sublime Text.app"), { recursive: true });
        const env = { platform: "darwin" as const, path: bin, appDirs: [apps] };
        expect(detectEditor(editorById("zed")!, env)?.launcher).toBe(join(bin, "zed"));
        expect(detectEditor(editorById("vscode")!, env)).toMatchObject({ launcher: join(apps, "Visual Studio Code.app/Contents/Resources/app/bin/code") });
        expect(detectEditor(editorById("sublime")!, env)).toEqual({ def: editorById("sublime")!, app: join(apps, "Sublime Text.app") });
        expect(detectEditor(editorById("cursor")!, env)).toBeUndefined();
        expect(detectEditor(editorById("finder")!, env)).toBeDefined();
        // Elsewhere: launchers only, and no Finder.
        const linux = detectEditors({ platform: "linux", path: bin, appDirs: [apps] }).map((f) => f.def.id);
        expect(linux).toEqual(["zed"]);
        // Windows launchers are .cmd scripts that need a shell: none.
        expect(detectEditors({ platform: "win32", path: bin, appDirs: [apps] })).toEqual([]);
    });
});

describe("confinement", () => {
    const root = realpathSync(tempDir("harness-ed-root-"));
    const outside = realpathSync(tempDir("harness-ed-out-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "x");
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "out"));

    test("relative paths resolve against the session's folder", () => {
        expect(confinePath("src/a.ts", root, [root])).toMatchObject({ path: join(root, "src/a.ts"), real: join(root, "src/a.ts"), dir: false });
        expect(confinePath(join(root, "src"), root, [root]).dir).toBe(true);
    });

    test("outside the roots is refused, including through .. and symlinks", () => {
        expect(() => confinePath("/etc/hosts", root, [root])).toThrow(/outside/);
        expect(() => confinePath(`../${outside.split("/").pop()}/secret.txt`, root, [root])).toThrow(/outside/);
        expect(() => confinePath("link.txt", root, [root])).toThrow(/outside/);
        expect(() => confinePath("out/secret.txt", root, [root])).toThrow(/outside/);
        // An extra root (additionalDirectories) lets it in.
        expect(confinePath("out/secret.txt", root, [root, outside]).real).toBe(join(outside, "secret.txt"));
    });

    test("missing files, option-like and odd input are refused", () => {
        expect(() => confinePath("src/nope.ts", root, [root])).toThrow(/doesn't exist/);
        expect(() => checkPathInput("-rf")).toThrow(/'-'/);
        expect(() => checkPathInput("  --help")).toThrow(/'-'/);
        expect(() => checkPathInput("")).toThrow();
        expect(() => checkPathInput(12)).toThrow();
        expect(() => checkPathInput("a\0b")).toThrow();
    });
});
