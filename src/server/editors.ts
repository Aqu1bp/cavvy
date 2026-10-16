// "Open in editor": a fixed list of editors Harness knows, how to find each one
// on this machine, and the argv that opens a file at a line in it.
//
// Trust: the GUI names an editor only by its id from this list, and the paths
// come from agent text, so nothing here takes a program name or arguments from
// the client. Paths are confined to the session's folders, every launch is an
// argv array (no shell), and nothing is handed to the system's default handler:
// `open` without -a runs .command, .app and .workflow files, so it's never used
// that way. Finder only reveals.

import { existsSync, realpathSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { homedir } from "os";
import { RpcError } from "./rpc-error";
import { canonical, expandPath, isInside } from "../util/files";

/** How an editor takes a line: `--goto file:line:col`, `file:line:col`, `--line N --column C file`, or not at all (Finder). */
type LineStyle = "goto" | "suffix" | "jetbrains" | "reveal";

export interface EditorDef {
    id: string;
    name: string;
    /** Command-line launchers looked up on PATH. */
    launchers: string[];
    /** macOS app bundles looked up in /Applications and ~/Applications. */
    apps: string[];
    /** The launcher inside the bundle, used when it isn't on PATH. */
    bundleCli?: string;
    style: LineStyle;
    /** The launcher reads `--` as the end of its options. */
    dashdash?: boolean;
    /** Files it opens as a project or workspace rather than as text (see "Files each editor opens as a project" above EDITORS). */
    projects?: ProjectFiles;
}

/** File extensions (lowercase, with the dot) and exact names (lowercase). */
interface ProjectFiles {
    ext?: string[];
    names?: string[];
}

// Flags, from each launcher's docs:
//   VS Code: `code -g, --goto <file:line[:character]>`; its CLI parses with
//     minimist, which takes everything after `--` as a path. Cursor is a VS
//     Code fork with the same CLI.
//   Zed: `zed path:line:column` (zed.dev/docs/reference/cli).
//   Sublime Text: `subl file:line:column`, and `subl -- files` for names that
//     start with '-' (sublimetext.com/docs/command_line.html).
//   JetBrains: `idea --line N --column C path`; on macOS without a launcher,
//     `open -na "IntelliJ IDEA.app" --args ...`, which passes the path as an
//     argument to the IDE, not as a document for Launch Services to open.
// Zed and the JetBrains launchers don't document `--`, so they get none: every
// path reaching them is absolute (starts with "/"), never an option.
// Files each editor opens as a project or workspace rather than as text. One
// can name folders outside the session's (a workspace's folders, a solution's
// projects, a build's modules), so "open this file" mustn't open one: only
// folders open as projects. From the docs where they say so, and otherwise
// erring towards refusing:
//   VS Code, Cursor: .code-workspace (multi-root workspace files).
//   Sublime Text: .sublime-project and .sublime-workspace.
//   JetBrains: a file opens in LightEdit "unless ... there is special logic to
//     automatically open or create a project (for example, in case of Maven or
//     Gradle files)" (jetbrains.com/help/idea/opening-files-from-command-line);
//     .ipr is the old project file. Rider also opens solutions (.sln, .slnx,
//     .slnf) and MSBuild projects (.csproj, .fsproj, .vbproj, .proj); its docs
//     only say "the path to a file or directory" opens it, so those are refused
//     on the side of caution.
//   Zed: nothing; its docs describe folders as its only projects.
const VSCODE_PROJECTS: ProjectFiles = { ext: [".code-workspace"] };
const JETBRAINS_PROJECTS: ProjectFiles = { ext: [".ipr"], names: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"] };
const RIDER_PROJECTS: ProjectFiles = { ext: [...JETBRAINS_PROJECTS.ext!, ".sln", ".slnx", ".slnf", ".csproj", ".fsproj", ".vbproj", ".proj"], names: JETBRAINS_PROJECTS.names };

const JETBRAINS: [string, string, string[]][] = [
    ["idea", "IntelliJ IDEA", ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"]],
    ["webstorm", "WebStorm", ["WebStorm.app"]],
    ["pycharm", "PyCharm", ["PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app", "PyCharm Community Edition.app"]],
    ["goland", "GoLand", ["GoLand.app"]],
    ["clion", "CLion", ["CLion.app"]],
    ["rubymine", "RubyMine", ["RubyMine.app"]],
    ["phpstorm", "PhpStorm", ["PhpStorm.app"]],
    ["rider", "Rider", ["Rider.app"]],
];

export const EDITORS: EditorDef[] = [
    { id: "vscode", name: "VS Code", launchers: ["code"], apps: ["Visual Studio Code.app"], bundleCli: "Contents/Resources/app/bin/code", style: "goto", dashdash: true, projects: VSCODE_PROJECTS },
    { id: "cursor", name: "Cursor", launchers: ["cursor"], apps: ["Cursor.app"], bundleCli: "Contents/Resources/app/bin/cursor", style: "goto", dashdash: true, projects: VSCODE_PROJECTS },
    { id: "zed", name: "Zed", launchers: ["zed"], apps: ["Zed.app"], bundleCli: "Contents/MacOS/cli", style: "suffix" },
    { id: "sublime", name: "Sublime Text", launchers: ["subl"], apps: ["Sublime Text.app"], bundleCli: "Contents/SharedSupport/bin/subl", style: "suffix", dashdash: true, projects: { ext: [".sublime-project", ".sublime-workspace"] } },
    ...JETBRAINS.map(([id, name, apps]): EditorDef => ({ id, name, launchers: [id], apps, style: "jetbrains", projects: id === "rider" ? RIDER_PROJECTS : JETBRAINS_PROJECTS })),
    { id: "finder", name: "Finder (reveal)", launchers: [], apps: [], style: "reveal" },
];

export const EDITOR_IDS = EDITORS.map((e) => e.id);

export function editorById(id: string): EditorDef | undefined {
    return EDITORS.find((e) => e.id === id);
}

/** An editor found on this machine: its launcher, or (macOS) only its app. */
export interface FoundEditor {
    def: EditorDef;
    launcher?: string;
    app?: string;
}

export interface DetectEnv {
    platform: NodeJS.Platform;
    /** The PATH to search (the login-shell PATH once the server adopted it). */
    path: string;
    /** Folders holding app bundles (macOS). */
    appDirs: string[];
}

export function defaultDetectEnv(): DetectEnv {
    const home = homedir();
    return {
        platform: process.platform,
        path: process.env.PATH ?? "",
        appDirs: process.platform === "darwin" ? ["/Applications", join(home, "Applications")] : [],
    };
}

export function detectEditor(def: EditorDef, env: DetectEnv): FoundEditor | undefined {
    // Windows launchers are .cmd scripts, which need a shell to start: not supported.
    if (env.platform === "win32") return undefined;
    if (def.style === "reveal") return env.platform === "darwin" ? { def } : undefined;
    // JetBrains Toolbox writes its launchers here rather than onto PATH.
    const extra = env.platform === "darwin" && def.style === "jetbrains" ? [join(homedir(), "Library/Application Support/JetBrains/Toolbox/scripts")] : [];
    const path = [env.path, ...extra].filter(Boolean).join(":");
    for (const name of def.launchers) {
        const found = Bun.which(name, { PATH: path });
        if (found) return { def, launcher: found };
    }
    if (env.platform !== "darwin") return undefined;
    for (const dir of env.appDirs)
        for (const app of def.apps) {
            const bundle = join(dir, app);
            if (!existsSync(bundle)) continue;
            const cli = def.bundleCli && join(bundle, def.bundleCli);
            return cli && existsSync(cli) ? { def, launcher: cli, app: bundle } : { def, app: bundle };
        }
    return undefined;
}

export function detectEditors(env: DetectEnv): FoundEditor[] {
    return EDITORS.map((d) => detectEditor(d, env)).filter((f): f is FoundEditor => f !== undefined);
}

/** Whether a found editor can go to a line (an app opened with `open -a` can't). */
export function takesLines(f: FoundEditor): boolean {
    return f.def.style !== "reveal" && (f.launcher !== undefined || f.def.style === "jetbrains");
}

// ---------------------------------------------------------------------------
// What to open

export const MAX_LINE = 10_000_000;
export const MAX_COL = 100_000;

export interface OpenTarget {
    /** Absolute, confined path (see confinePath). */
    path: string;
    line?: number;
    col?: number;
    folder: boolean;
}

/** Line or column from the client: absent, or a positive integer within a sane range. */
export function position(v: unknown, name: string, max: number): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new RpcError(`${name} must be a whole number from 1 to ${max}`, "invalid");
    return v;
}

// Files macOS runs, or installs, when "opened": refused on the one route that
// goes through Launch Services with a document (`open -a`), even though -a
// names the app. Folders that are bundles are refused everywhere.
const LAUNCHABLE = new Set([".app", ".command", ".terminal", ".workflow", ".action", ".tool", ".scpt", ".scptd", ".applescript", ".pkg", ".mpkg", ".prefpane", ".saver", ".bundle", ".framework", ".kext", ".plugin", ".webloc", ".inetloc", ".fileloc"]);

function launchable(path: string): boolean {
    return LAUNCHABLE.has(extname(path).toLowerCase());
}

/**
 * Whether `def` would open this file as a project (see "Files each editor opens as a project").
 * With no editor, whether any of them would: what isn't linked before one is chosen.
 */
export function opensAsProject(def: EditorDef | undefined, path: string): boolean {
    if (!def) return EDITORS.some((d) => opensAsProject(d, path));
    const ext = extname(path).toLowerCase();
    const name = basename(path).toLowerCase();
    return Boolean(def.projects?.ext?.includes(ext) || def.projects?.names?.includes(name));
}

/** The argv that opens `t` in `f`. Throws RpcError for what that editor must not be handed. */
export function editorArgv(f: FoundEditor, t: OpenTarget): string[] {
    const { def } = f;
    if (!t.path.startsWith("/")) throw new RpcError("The path must be absolute", "invalid");
    if (t.folder && launchable(t.path)) throw new RpcError(`${basename(t.path)} is an app or bundle, not a project folder`, "refused");
    if (!t.folder && opensAsProject(def, t.path)) throw new RpcError(`${def.name} would open ${basename(t.path)} as a project, which can reach outside this session's folders`, "refused");
    const line = t.folder ? undefined : t.line;
    const col = line === undefined ? undefined : t.col;
    // A name already ending in ":12" would be read as a line by launchers that take file:line.
    if ((def.style === "goto" || def.style === "suffix") && f.launcher && /:\d+$/.test(t.path)) throw new RpcError(`${def.name} would read the end of ${basename(t.path)} as a line number`, "refused");
    const at = line === undefined ? t.path : `${t.path}:${line}${col === undefined ? "" : `:${col}`}`;
    const end = def.dashdash ? ["--"] : [];
    if (def.style === "reveal") return ["open", "-R", t.path];
    const jb = [...(line === undefined ? [] : ["--line", String(line)]), ...(col === undefined ? [] : ["--column", String(col)])];
    if (f.launcher) {
        if (def.style === "goto") return line === undefined ? [f.launcher, ...end, t.path] : [f.launcher, "--goto", ...end, at];
        if (def.style === "suffix") return [f.launcher, ...end, at];
        return [f.launcher, ...jb, t.path];
    }
    if (!f.app) throw new RpcError(`${def.name} isn't installed`, "not_installed");
    // JetBrains' documented macOS launcher: the path is an argument to the IDE.
    if (def.style === "jetbrains") return ["open", "-na", f.app, "--args", ...jb, t.path];
    if (launchable(t.path)) throw new RpcError(`Harness doesn't hand ${basename(t.path)} to macOS to open: it could run`, "refused");
    return ["open", "-a", f.app, t.path];
}

// ---------------------------------------------------------------------------
// Confinement

/** A path from agent text or the GUI, checked before anything else looks at it. */
export function checkPathInput(path: unknown): string {
    if (typeof path !== "string" || !path.trim()) throw new RpcError("path must be a non-empty string", "invalid");
    if (path.length > 4096 || path.includes("\0")) throw new RpcError("That isn't a usable path", "invalid");
    if (path.trimStart().startsWith("-")) throw new RpcError("Paths starting with '-' aren't opened", "refused");
    return path;
}

/**
 * Resolves `path` against `cwd` and returns it if it exists inside one of
 * `roots` once symlinks are followed (so a link inside the project can't lead
 * out of it). Returns the path as written, made absolute, for display; the
 * check uses its real location.
 */
export function confinePath(path: string, cwd: string, roots: string[]): { path: string; real: string; dir: boolean } {
    const abs = expandPath(checkPathInput(path), cwd);
    let real: string;
    let dir: boolean;
    try {
        real = realpathSync(abs);
        dir = statSync(real).isDirectory();
    } catch {
        throw new RpcError(`${path} doesn't exist`, "not_found");
    }
    const inside = roots.map((r) => canonical(r)).some((r) => isInside(real, r));
    if (!inside) throw new RpcError(`${path} is outside this session's folders, so it isn't opened`, "outside");
    return { path: abs, real, dir };
}
