// Preferences: older saved appearance migrates the same way before the first
// paint (gui/public/theme-boot.js) and in the app (state/prefs-core.ts via
// state/prefs.ts), and both put the same attributes and properties on <html>.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { runInNewContext } from "vm";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import { ACCENTS, applyAppearance, migratePrefs, PREF_DEFAULTS, type Prefs } from "../gui/src/state/prefs-core";

const BOOT = readFileSync(new URL("../gui/public/theme-boot.js", import.meta.url), "utf8");
const PREFS = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(new URL("../gui/src/state/prefs.ts", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "")
        .replace(/^export \{[^}]*\} from .*;\r?\n/gm, "")
        .replace(/^export /gm, ""),
);

/** <html>, localStorage and matchMedia as a page has them. */
function page(stored: string | null | undefined, dark: boolean, storageThrows = false) {
    let value = stored;
    const dataset: Record<string, string> = {};
    const style: Record<string, string> = {};
    let onSchemeChange: ((e: { matches: boolean }) => void) | undefined;
    return {
        dataset,
        style,
        stored: () => value,
        systemChanges: (matches: boolean) => onSchemeChange?.({ matches }),
        globals: {
            document: { documentElement: { dataset, style: { setProperty: (k: string, v: string) => { style[k] = v; } } } },
            localStorage: {
                getItem: (_k: string) => { if (storageThrows) throw new Error("storage unavailable"); return value ?? null; },
                setItem: (_k: string, v: string) => { if (storageThrows) throw new Error("storage unavailable"); value = v; },
            },
            matchMedia: () => ({ matches: dark, addEventListener: (_: string, fn: typeof onSchemeChange) => { onSchemeChange = fn; } }),
        },
    };
}

/** A Solid store stand-in on the client build's signals (the store package would bind to Solid's server build under Bun). */
function createStore<T extends object>(initial: T): [T, (key: keyof T, value: unknown) => void] {
    const signals = new Map<PropertyKey, ReturnType<typeof solid.createSignal<unknown>>>();
    const store = {} as T;
    for (const key of new Set([...Object.keys(initial), "accent"])) {
        const signal = solid.createSignal<unknown>((initial as Record<string, unknown>)[key]);
        signals.set(key, signal);
        Object.defineProperty(store, key, { enumerable: true, get: signal[0] });
    }
    return [store, (key, value) => signals.get(key)![1](() => value)];
}

function boot(stored: string | null | undefined, dark: boolean, storageThrows = false) {
    const p = page(stored, dark, storageThrows);
    runInNewContext(BOOT, { ...p.globals });
    return p;
}

function app(stored: string | null | undefined, dark: boolean, storageThrows = false) {
    const p = page(stored, dark, storageThrows);
    const native: string[] = [];
    const deps = {
        ...p.globals,
        createEffect: solid.createEffect,
        createRoot: solid.createRoot,
        createSignal: solid.createSignal,
        createStore,
        setNativeTheme: async (scheme: string) => { native.push(scheme); },
        applyAppearance,
        migratePrefs,
        PREF_DEFAULTS,
    };
    const api = new Function(...Object.keys(deps), `${PREFS}\nreturn { prefs, setPrefs, activeTheme };`)(...Object.values(deps)) as {
        prefs: Prefs;
        setPrefs: (key: keyof Prefs, value: unknown) => void;
        activeTheme: () => string;
    };
    return { ...p, ...api, native, saved: () => JSON.parse(p.stored() ?? "{}") };
}

const LEGACY: [theme: string, scheme: string, contrast: string][] = [
    ["light", "light", "standard"],
    ["paper", "light", "standard"],
    ["dark", "dark", "standard"],
    ["midnight", "dark", "standard"],
    ["dusk", "dark", "standard"],
    ["contrast", "dark", "high"],
    ["system", "system", "standard"],
];

describe("migrating saved appearance", () => {
    for (const [theme, scheme, contrast] of LEGACY) {
        test(`${theme} becomes scheme ${scheme}, contrast ${contrast}; the per-scheme themes go; the rest stays`, () => {
            const saved = { theme, lightTheme: "paper", darkTheme: "midnight", accent: "teal", fontSize: 16, sidebar: false, favoriteModels: ["a/b"], chatWidth: "wide", motion: "smooth" };
            expect(migratePrefs(saved)).toEqual({
                scheme,
                ...(contrast === "high" ? { contrast } : {}),
                accent: "teal",
                fontSize: 16,
                sidebar: false,
                favoriteModels: ["a/b"],
                chatWidth: "wide",
                motion: "smooth",
            } as Partial<Prefs>);
        });
    }

    test("no saved theme: the defaults (system, glass, clear tint, standard)", () => {
        expect({ ...PREF_DEFAULTS, ...migratePrefs({ fontSize: 15 }) }).toMatchObject({ scheme: "system", glass: "glass", tint: "clear", contrast: "standard", fontSize: 15 });
    });

    test("today's settings are kept as they are, and migrating twice changes nothing", () => {
        const saved = { scheme: "light", glass: "solid", tint: "ocean", contrast: "high", accent: "graphite", density: "compact" };
        expect(migratePrefs(saved)).toEqual(saved as Partial<Prefs>);
        expect(migratePrefs(migratePrefs({ theme: "contrast", darkTheme: "dusk" }))).toEqual({ scheme: "dark", contrast: "high" });
    });

    test("unknown appearance values are dropped so the defaults apply", () => {
        expect(migratePrefs({ scheme: "dusk", glass: "frosted", tint: "sunset", contrast: "max", accent: "chartreuse", theme: "neon" })).toEqual({});
        for (const tint of ["", "Ocean", null, 1, {}]) expect(migratePrefs({ tint })).toEqual({});
        for (const tint of ["clear", "ocean", "accent"] as const) expect(migratePrefs({ tint })).toEqual({ tint });
        expect(migratePrefs({ accent: undefined })).toEqual({});
    });

    test("anything that isn't an object is no preferences", () => {
        for (const saved of [null, undefined, 3, "light", [], true]) expect(migratePrefs(saved)).toEqual({});
    });
});

describe("first paint and the app agree", () => {
    const cases: [string, unknown][] = [
        ...LEGACY.map(([theme]): [string, unknown] => [`legacy ${theme}`, { theme, lightTheme: "paper", darkTheme: "contrast", fontSize: 16, sidebarWidth: 300, reviewWidth: 800, chatWidth: "narrow", motion: "smooth", density: "compact" }]),
        ["empty", {}],
        ["unknown values", { scheme: "bad", glass: "bad", tint: "bad", contrast: "bad", accent: "bad", chatWidth: "bad" }],
        ...ACCENTS.map((a): [string, unknown] => [`accent ${a.id}`, { scheme: "dark", accent: a.id }]),
        ...(["glass", "tinted", "solid"] as const).flatMap((glass) => (["standard", "high"] as const).map((contrast): [string, unknown] => [`${glass}/${contrast}`, { scheme: "light", glass, contrast }])),
        ...(["clear", "ocean", "accent"] as const).flatMap((tint) => (["glass", "solid"] as const).map((glass): [string, unknown] => [`tint ${tint}/${glass}`, { scheme: "dark", tint, glass, accent: "teal" }])),
    ];
    for (const [name, saved] of cases) {
        for (const dark of [false, true]) {
            test(`${name}, system ${dark ? "dark" : "light"}`, () => {
                const stored = JSON.stringify(saved);
                const early = boot(stored, dark);
                const later = app(stored, dark);
                expect(early.dataset).toEqual(later.dataset);
                expect(early.style).toEqual(later.style);
                expect(later.native).toEqual([later.dataset.theme!]);
                expect(later.dataset.scheme).toBe(later.dataset.theme!);
            });
        }
    }

    for (const [name, stored, storageThrows] of [["nothing saved", null, false], ["corrupt JSON", "{", false], ["JSON null", "null", false], ["storage unavailable", "{}", true]] as const) {
        test(`${name}: both follow the system with the defaults`, () => {
            for (const dark of [false, true]) {
                const early = boot(stored, dark, storageThrows);
                const later = app(stored, dark, storageThrows);
                expect(early.dataset).toEqual(later.dataset);
                expect(early.style).toEqual(later.style);
                expect(later.dataset).toEqual({ theme: dark ? "dark" : "light", scheme: dark ? "dark" : "light", glass: "glass", tint: "clear", contrast: "standard", density: "comfortable", motion: "instant" });
            }
        });
    }
});

describe("the app's preferences", () => {
    test("a migrated theme is saved back in today's shape", () => {
        const later = app(JSON.stringify({ theme: "contrast", lightTheme: "paper", darkTheme: "dusk", sidebar: false }), false);
        expect(later.prefs.scheme).toBe("dark");
        expect(later.prefs.contrast).toBe("high");
        const saved = later.saved();
        expect(saved).not.toHaveProperty("theme");
        expect(saved).not.toHaveProperty("lightTheme");
        expect(saved).not.toHaveProperty("darkTheme");
        expect(saved).toMatchObject({ scheme: "dark", contrast: "high", glass: "glass", sidebar: false });
        expect(later.dataset).toMatchObject({ theme: "dark", contrast: "high" });
    });

    test("changes show at once; System follows the system, a fixed scheme doesn't", () => {
        const later = app(JSON.stringify({ scheme: "system" }), false);
        expect(later.dataset.theme).toBe("light");
        later.systemChanges(true);
        expect(later.dataset.theme).toBe("dark");
        expect(later.activeTheme()).toBe("dark");
        expect(later.native.at(-1)).toBe("dark");

        later.setPrefs("scheme", "light");
        later.systemChanges(true);
        expect(later.dataset).toMatchObject({ theme: "light", scheme: "light" });
        expect(later.native.at(-1)).toBe("light");

        later.setPrefs("glass", "tinted");
        later.setPrefs("contrast", "high");
        later.setPrefs("accent", "pink");
        later.setPrefs("tint", "ocean");
        expect(later.dataset).toMatchObject({ glass: "tinted", tint: "ocean", contrast: "high", accent: "pink" });
        later.setPrefs("tint", "accent");
        expect(later.dataset.tint).toBe("accent");
        later.setPrefs("accent", undefined);
        expect(later.dataset).not.toHaveProperty("accent");
        expect(later.saved()).toMatchObject({ scheme: "light", glass: "tinted", tint: "accent", contrast: "high" });
    });
});
