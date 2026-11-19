// The user's own themes: one JSON file each in ~/.cavvy/themes, named by the theme's id. Written by the theme tools
// (an agent made it), by hand, or copied from someone else. Read whole and checked on every change: a file that
// doesn't check out is listed with what's wrong, and isn't shown.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "fs";
import { join } from "path";
import { cavvyHome } from "../config/paths";
import { checkTheme, ID, type Theme, type ThemeEntry } from "./format";
import { BUILTIN_IDS } from "./builtin";

export const themesDir = () => join(cavvyHome(), "themes");

/** A theme file at most this big is read: a bigger one is listed as too big. */
const MAX_FILE = 1_200_000;

export function readThemeFile(id: string, dir = themesDir()): ThemeEntry {
    const path = join(dir, `${id}.json`);
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        return { id, problems: [`can't be read: ${(e as Error).message}`] };
    }
    if (text.length > MAX_FILE) return { id, problems: [`is ${text.length} characters; a theme is at most ${MAX_FILE}`] };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return { id, problems: [`isn't JSON: ${(e as Error).message}`] };
    }
    const { theme, problems } = checkTheme(raw);
    return theme ? { id, theme } : { id, problems };
}

/** Every theme file, by id; a built-in's id can't be taken by a file (it's listed with that problem). */
export function listThemes(dir = themesDir()): ThemeEntry[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.endsWith(".json") && !n.startsWith("."))
        .map((n) => n.slice(0, -5))
        .filter((id) => ID.test(id))
        .sort()
        .map((id) => (BUILTIN_IDS.has(id) ? { id, problems: [`has the id of a built-in theme; rename the file`] } : readThemeFile(id, dir)));
}

/** A theme as its file holds it. */
export const themeText = (theme: Theme) => `${JSON.stringify(theme, null, 2)}\n`;

/** A theme file's text as it is, or undefined when there's none (or it can't be read). */
export function themeFileText(id: string, dir = themesDir()): string | undefined {
    try {
        return readFileSync(join(dir, `${id}.json`), "utf8");
    } catch {
        return undefined;
    }
}

/** Writes a theme file whole, all at once: a window watching never reads half a file. */
function writeWhole(id: string, text: string, dir: string): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${id}.json`);
    const temp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
    return path;
}

/** Writes a checked theme under its id. */
export function saveTheme(id: string, theme: Theme, dir = themesDir()): string {
    return writeWhole(id, themeText(theme), dir);
}

/** Deletes a theme's file; answers what it held, for Undo, or undefined when there was none. */
export function removeTheme(id: string, dir = themesDir()): string | undefined {
    if (!ID.test(id)) return undefined;
    const path = join(dir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    return text;
}

/** Puts back what removeTheme answered, or (`replace`) what an agent's theme replaced. */
export function restoreTheme(id: string, text: string, dir = themesDir(), replace = false): void {
    if (!ID.test(id) || BUILTIN_IDS.has(id)) throw new Error("not a theme id");
    if (replace) return void writeWhole(id, text, dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.json`), text, { flag: "wx", mode: 0o600 });
}

/**
 * Calls `onChange` once a run of changes in the folder has settled: a file saved, added, renamed or deleted. Watches
 * the folder (an editor saves by renaming over the file), made if there's none so the first theme is seen too.
 */
export function watchThemes(onChange: () => void, dir = themesDir(), debounceMs = 120): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: FSWatcher | undefined;
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        watcher = watch(dir, { persistent: false }, (_event, name) => {
            // Our own temporary files come and go on every save.
            if (typeof name === "string" && name.startsWith(".")) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                onChange();
            }, debounceMs);
        });
        watcher.on("error", () => undefined);
    } catch {
        // No watching here: themes are read again when a window asks.
    }
    return () => {
        if (timer) clearTimeout(timer);
        watcher?.close();
    };
}
