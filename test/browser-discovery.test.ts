// Finding the browser to run (installed ones on each system, what the setting and the environment name), when a profile is
// held by another browser, and the browser settings: where they may come from.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const chrome = await import("../src/browser/chrome");
const settings = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
type Env = import("../src/browser/chrome").ChromeEnvironment;

afterAll(iso.cleanup);

/** A machine: what's installed (paths that exist), what's on PATH (program -> where), and its variables. */
function machine(platform: NodeJS.Platform, o: { files?: string[]; path?: Record<string, string>; env?: Record<string, string>; home?: string } = {}): Env {
    const files = new Set(o.files ?? []);
    const path = o.path ?? {};
    return { platform, env: o.env ?? {}, home: o.home ?? "/home/ada", exists: (p) => files.has(p), which: (name) => path[name] ?? null };
}
const found = (r: ReturnType<typeof chrome.findChrome>) => (r.ok ? { path: r.path, source: r.source } : r.error);

describe("finding an installed browser", () => {
    test("on a Mac, the apps in /Applications, Chrome first", () => {
        const chromium = "/Applications/Chromium.app/Contents/MacOS/Chromium";
        const google = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        expect(found(chrome.findChrome(undefined, machine("darwin", { files: [chromium, google] })))).toEqual({ path: google, source: "installed" });
        expect(found(chrome.findChrome(undefined, machine("darwin", { files: [chromium] })))).toEqual({ path: chromium, source: "installed" });
        const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
        const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
        expect(found(chrome.findChrome(undefined, machine("darwin", { files: [brave, edge] })))).toMatchObject({ path: edge });
    });

    test("an app in the user's own Applications folder counts, after the system's", () => {
        const mine = "/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        expect(found(chrome.findChrome(undefined, machine("darwin", { files: [mine], home: "/Users/ada" })))).toEqual({ path: mine, source: "installed" });
        const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        expect(found(chrome.findChrome(undefined, machine("darwin", { files: [mine, system], home: "/Users/ada" })))).toMatchObject({ path: system });
    });

    test("on Linux, the usual places, then programs on PATH", () => {
        expect(found(chrome.findChrome(undefined, machine("linux", { files: ["/snap/bin/chromium"] })))).toEqual({ path: "/snap/bin/chromium", source: "installed" });
        expect(found(chrome.findChrome(undefined, machine("linux", { path: { "chromium-browser": "/usr/bin/chromium-browser" } })))).toEqual({ path: "/usr/bin/chromium-browser", source: "installed" });
        // google-chrome before chromium
        const both = machine("linux", { path: { chromium: "/usr/bin/chromium", "google-chrome": "/usr/bin/google-chrome" } });
        expect(found(chrome.findChrome(undefined, both))).toMatchObject({ path: "/usr/bin/google-chrome" });
        expect(chrome.installedNames({ platform: "linux" })).toContain("microsoft-edge");
    });

    test("on Windows, under each Program Files and the user's AppData, spelled with backslashes", () => {
        const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" };
        const paths = chrome.installedPaths({ platform: "win32", env, home: "C:\\Users\\ada" });
        expect(paths[0]).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
        expect(paths).toContain("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
        expect(paths).toContain("C:\\Users\\ada\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe");
        expect(paths).toContain("C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe");
        const local = "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
        expect(found(chrome.findChrome(undefined, machine("win32", { files: [local], env })))).toEqual({ path: local, source: "installed" });
        // no variables, nowhere to look; and no program names to look up on PATH
        expect(chrome.installedPaths({ platform: "win32", env: {}, home: "C:\\" })).toEqual([]);
        expect(chrome.installedNames({ platform: "win32" })).toEqual([]);
    });

    test("with nothing, an error that says what to install and how to name one", () => {
        for (const platform of ["darwin", "linux", "win32"] as const) {
            const r = chrome.findChrome(undefined, machine(platform));
            expect(r.ok).toBe(false);
            const error = found(r) as string;
            expect(error).toContain("No Chrome, Chromium, Edge or Brave was found");
            expect(error).toContain("browser.executable");
            expect(error).toContain("HARNESS_BROWSER");
        }
    });
});

describe("naming a browser", () => {
    const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    test("the environment variable wins over the setting, which wins over what is installed", () => {
        const env = machine("darwin", { files: [system, "/opt/env-chrome", "/opt/setting-chrome"], env: { HARNESS_BROWSER: "/opt/env-chrome" } });
        expect(found(chrome.findChrome("/opt/setting-chrome", env))).toEqual({ path: "/opt/env-chrome", source: "HARNESS_BROWSER" });
        expect(found(chrome.findChrome("/opt/setting-chrome", { ...env, env: {} }))).toEqual({ path: "/opt/setting-chrome", source: "browser.executable" });
        expect(found(chrome.findChrome(undefined, { ...env, env: {} }))).toMatchObject({ source: "installed" });
    });

    test("a name without a folder is looked up on PATH, one with a folder or a ~ is a path (~ is the home folder)", () => {
        const env = machine("linux", { files: [join(homedir(), "bin", "chrome"), "/usr/local/bin/mychrome"], path: { mychrome: "/usr/local/bin/mychrome" } });
        expect(found(chrome.findChrome("mychrome", env))).toEqual({ path: "/usr/local/bin/mychrome", source: "browser.executable" });
        expect(found(chrome.findChrome("~/bin/chrome", env))).toEqual({ path: join(homedir(), "bin", "chrome"), source: "browser.executable" });
        expect(found(chrome.findChrome("/usr/local/bin/mychrome", env))).toMatchObject({ path: "/usr/local/bin/mychrome" });
        expect(found(chrome.findChrome("  mychrome  ", env))).toMatchObject({ path: "/usr/local/bin/mychrome" });
    });

    test("one that isn't there is an error naming where it came from, not a reason to use another", () => {
        const env = machine("darwin", { files: [system] });
        const setting = found(chrome.findChrome("/opt/gone", env)) as string;
        expect(setting).toBe('The browser.executable setting names "/opt/gone", which isn\'t an installed browser. Fix or remove it.');
        const variable = found(chrome.findChrome(undefined, { ...env, env: { HARNESS_BROWSER: "nothing-by-this-name" } })) as string;
        expect(variable).toBe('The HARNESS_BROWSER environment variable names "nothing-by-this-name", which isn\'t an installed browser. Fix or remove it.');
        // the variable is the one complained of even when the setting is fine
        expect(found(chrome.findChrome(system, { ...env, env: { HARNESS_BROWSER: "/opt/gone" } }))).toContain("HARNESS_BROWSER");
    });

    test("empty, or only spaces, names nothing", () => {
        const env = machine("darwin", { files: [system], env: { HARNESS_BROWSER: "  " } });
        expect(found(chrome.findChrome("", env))).toEqual({ path: system, source: "installed" });
        expect(found(chrome.findChrome("   ", env))).toEqual({ path: system, source: "installed" });
    });

    test("the real machine's answer is remembered for a moment, per name, and can be forgotten", () => {
        const saved = process.env.HARNESS_BROWSER;
        try {
            const a = join(tempDir("harness-browser-find-"), "chrome-a");
            const b = join(dirname(a), "chrome-b");
            writeFileSync(a, "");
            writeFileSync(b, "");
            process.env.HARNESS_BROWSER = a;
            chrome.forgetChromeLookup();
            const first = chrome.cachedChrome(undefined);
            expect(first).toEqual({ ok: true, path: a, source: "HARNESS_BROWSER" });
            expect(chrome.cachedChrome(undefined)).toBe(first);
            // a different variable or setting is a different question
            process.env.HARNESS_BROWSER = b;
            expect(chrome.cachedChrome(undefined)).toMatchObject({ path: b });
            expect(chrome.cachedChrome("/elsewhere")).toMatchObject({ path: b });
            // and a file that goes isn't noticed until the answer expires or is forgotten
            process.env.HARNESS_BROWSER = a;
            const again = chrome.cachedChrome(undefined);
            expect(again).toMatchObject({ path: a });
            chrome.forgetChromeLookup();
            expect(chrome.cachedChrome(undefined)).not.toBe(again);
        } finally {
            process.env.HARNESS_BROWSER = saved;
            chrome.forgetChromeLookup();
        }
    });
});

describe("a profile folder another browser holds", () => {
    const folder = () => tempDir("harness-browser-profile-");
    const lock = (dir: string, target: string) => symlinkSync(target, join(dir, "SingletonLock"));

    test("is one whose lock names a running process on this machine", () => {
        const dir = folder();
        expect(chrome.profileInUse(dir)).toBe(false);
        lock(dir, `${hostname()}-${process.pid}`);
        expect(chrome.profileInUse(dir)).toBe(true);
    });

    test("isn't when the process is gone, it's another machine's, or the lock isn't one", () => {
        const gone = folder();
        // a process id no machine has
        lock(gone, `${hostname()}-2147483000`);
        expect(chrome.profileInUse(gone)).toBe(false);
        const elsewhere = folder();
        lock(elsewhere, `some-other-machine-${process.pid}`);
        expect(chrome.profileInUse(elsewhere)).toBe(false);
        const file = folder();
        writeFileSync(join(file, "SingletonLock"), `${hostname()}-${process.pid}`);
        expect(chrome.profileInUse(file)).toBe(false);
        const odd = folder();
        lock(odd, "not-a-lock");
        expect(chrome.profileInUse(odd)).toBe(false);
        expect(chrome.profileInUse(join(folder(), "missing"))).toBe(false);
    });
});

describe("the browser settings", () => {
    const root = tempDir("harness-browser-settings-");
    let n = 0;
    const project = () => {
        const d = join(root, `p${++n}`);
        mkdirSync(d, { recursive: true });
        return d;
    };
    const write = (file: string, data: unknown) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data));
    };
    /** The merged settings of a project, from the user's file and the project's two. */
    function load(user: object | undefined, shared?: object, local?: object, trusted = true) {
        const cwd = project();
        write(paths.userSettings(), user ?? {});
        if (shared) write(paths.projectSettings(cwd), shared);
        if (local) write(paths.localSettings(cwd), local);
        return settings.loadSettings(cwd, { trusted });
    }

    test("default to on, headless, with no program of their own", () => {
        expect(settings.browserSettings({})).toEqual({ enabled: true, headless: true });
        expect(load(undefined).browser).toBeUndefined();
    });

    test("malformed ones are the defaults", () => {
        for (const browser of ["yes", 5, null, [], { enabled: "no", executable: 5, headless: "off" }, { executable: "   " }]) {
            expect(settings.browserSettings({ browser } as never), JSON.stringify(browser)).toEqual({ enabled: true, headless: true });
        }
        expect(settings.browserSettings({ browser: { executable: "  /opt/chrome  ", enabled: false, headless: false } })).toEqual({ enabled: false, executable: "/opt/chrome", headless: false });
    });

    test("the user's own say what runs and whether it shows", () => {
        const s = load({ browser: { executable: "/opt/chrome", headless: false, enabled: true } });
        expect(s.browser).toEqual({ enabled: true, executable: "/opt/chrome", headless: false });
    });

    test("a project can turn the browser off, never on, and never choose what runs", () => {
        const shared = { browser: { enabled: false, executable: "/tmp/evil", headless: false } };
        expect(load({ browser: { enabled: true, executable: "/opt/chrome" } }, shared).browser).toEqual({ enabled: false, executable: "/opt/chrome" });
        expect(load(undefined, shared).browser).toEqual({ enabled: false });
        // the committed file and the personal one alike
        expect(load(undefined, undefined, { browser: { enabled: false } }).browser).toEqual({ enabled: false });
        // turned off by the user, a project's yes means nothing
        expect(load({ browser: { enabled: false } }, { browser: { enabled: true } }).browser).toEqual({ enabled: false });
        // and a project's program or window doesn't count, with or without the rest
        const program = load({}, { browser: { executable: "/tmp/evil", headless: false } });
        expect(program.browser).toBeUndefined();
        expect(settings.browserSettings(program)).toEqual({ enabled: true, headless: true });
    });

    test("a folder not trusted contributes nothing, as for the rest of the settings", () => {
        const s = load({ browser: { executable: "/opt/chrome" } }, { browser: { enabled: false, executable: "/tmp/evil" } }, undefined, false);
        expect(s.browser).toEqual({ executable: "/opt/chrome" });
    });
});
