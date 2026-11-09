// Launch: the desktop window is created hidden and comes up on a drawn first screen, so its
// glass never shows only the blurred desktop; Home's entrance doesn't play over a window just shown.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRules } from "./helpers/contrast";
import { componentCode, node } from "./gui-component-harness";

const root = join(import.meta.dir, "..");

for (const mode of ["data", "unauthorized", "fallback", "browser"]) {
    test(`the page shows the window when its first screen is ready (${mode})`, async () => {
        const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-window-show.ts", import.meta.url)), mode], { stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    });
}

test("the window is created hidden, and nothing but the page (or the fallback) shows it", () => {
    const conf = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.app.windows[0].visible).toBe(false);
    const lib = readFileSync(join(root, "desktop/src-tauri/src/lib.rs"), "utf8");
    // The window-state plugin would show it as it restores its visibility.
    expect(lib).toContain("tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() - StateFlags::VISIBLE)");
    expect(lib).toMatch(/generate_handler!\[[^\]]*\bwindow_ready\b/);
    // Shown anyway if the page never asks.
    expect(lib).toMatch(/sleep\(SHOW_ANYWAY\)\.await;\s*show_window\(&app\);/);
});

test("a second launch that raises the window marks it shown, so neither the page nor the fallback raises it again", () => {
    const lib = readFileSync(join(root, "desktop/src-tauri/src/lib.rs"), "utf8");
    const body = (name: string) => lib.slice(lib.indexOf(`fn ${name}(`), lib.indexOf("\n}\n", lib.indexOf(`fn ${name}(`)));
    // Every way the window is shown goes through raise_window, which sets the latch first.
    expect(body("raise_window")).toMatch(/Shown>\(\)\.0\.store\(true[^)]*\);[\s\S]*\.show\(\)/);
    expect(body("show_window")).toMatch(/if app\.state::<Shown>\(\)\.0\.load\([^)]*\) \{\s*return;\s*\}\s*raise_window\(app\);/);
    expect(lib).toMatch(/single_instance::init\(\|app, _args, _cwd\| raise_window\(app\)\)/);
    // Nothing else shows it.
    expect(lib.match(/\.show\(\)/g)).toHaveLength(1);
});

test("Home's entrance is short, and doesn't play when Home was drawn before the window came up", () => {
    const rules = parseRules(readFileSync(join(root, "gui/src/styles/home.css"), "utf8"));
    // The question, the composer, its drawer and the terminal list. The cards before the first message rise as
    // request cards do: they come once the folder has been looked at.
    const entrance = rules.filter((r) => /^home-(in|drawer) /.test(r.decls.get("animation") ?? ""));
    expect(entrance.map((r) => r.selectors.join()).sort()).toEqual([".cli-sessions", ".composer-strip", ".home-composer", ".home-q"]);
    for (const r of entrance) {
        // Its duration, then its delay if it has one.
        const [duration, delay = 0] = [...r.decls.get("animation")!.matchAll(/\b(\d+)ms\b/g)].map((m) => Number(m[1]));
        expect(duration! + delay).toBeLessThanOrEqual(450);
    }
    const instant = rules.find((r) => r.selectors.some((s) => s.startsWith(".home.instant")));
    expect(instant?.decls.get("animation")).toBe("none");
    // One :is() list (which the parser splits at its commas) naming every element that enters.
    const named = instant!.selectors.join(",").replace(/^\.home\.instant :is\(|\)$/g, "").split(",").map((s) => s.trim());
    expect(named.sort()).toEqual(entrance.flatMap((r) => r.selectors).sort());
});

test("Home drawn before the window is shown is marked to skip its entrance; one drawn after isn't", () => {
    let shown = false;
    const stub = () => null;
    const Home = componentCode("Home", {
        node, createSignal: (v: unknown) => [() => v, stub], createResource: () => [() => ({ needsTrust: [], git: false }), { refetch: stub }], For: stub, Show: stub, onCleanup: stub, onMount: stub,
        React: { Fragment: "Fragment" },
        ChevronDown: stub, Folder: stub, FolderGit2: stub, FolderOpen: stub, KeyRound: stub, Plug: stub, ShieldAlert: stub,
        app: { conn: "open", homeCwd: "/project", providers: [], projects: [], models: [] }, refreshProjects: stub, reportError: stub, rpc: {}, chooseProject: stub, connectCli: stub, openProject: stub, trustAndContinue: stub,
        requestComposerFocus: stub, setSettingsTab: stub, columnHeight: () => "800px", shellLayout: () => ({ column: { h: 800 } }), sp: (n: number) => n,
        ago: stub, basename: (p: string) => p, tildify: (p: string) => p, now: stub, isWindowShown: () => shown,
        CliSessions: stub, Composer: stub, ErrorCards: stub, Menu: stub, ProviderIcon: stub, WorktreePicker: stub,
    }) as () => { tag: string; props: { class: string; classList?: Record<string, boolean> } };
    const atLaunch = Home();
    expect(atLaunch.props.class).toBe("home");
    expect(atLaunch.props.classList).toEqual({ instant: true, glide: false });
    shown = true;
    expect(Home().props.classList).toEqual({ instant: false, glide: false });
});
