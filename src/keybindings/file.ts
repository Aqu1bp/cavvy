// The keybindings file on disk: read it, and watch it so a save applies at once.

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "fs";
import { basename, dirname, join } from "path";
import { harnessHome } from "../config/paths";
import { KEYBINDINGS_TEMPLATE } from "./core";

export const keybindingsPath = () => join(harnessHome(), "keybindings.json");

/** The file's text, or undefined when there's none (or it can't be read; `error` says why). */
export function readKeybindings(path = keybindingsPath()): { text?: string; error?: string } {
    try {
        return { text: readFileSync(path, "utf8") };
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return {};
        return { error: `Can't read ${path}: ${(e as Error).message}` };
    }
}

/** Creates the file from the template when there's none. True when it was created. */
export function ensureKeybindingsFile(path = keybindingsPath()): boolean {
    if (existsSync(path)) return false;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, KEYBINDINGS_TEMPLATE, { flag: "wx" });
    return true;
}

/**
 * Calls `onChange` with the file's text after it's saved, created or deleted.
 * Watches the folder, not the file: editors save by renaming a new file over
 * the old one, which a watch on the file itself stops seeing.
 */
export function watchKeybindings(onChange: (r: { text?: string; error?: string }) => void, path = keybindingsPath(), debounceMs = 60): () => void {
    const dir = dirname(path);
    const name = basename(path);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = readKeybindings(path).text;
    let watcher: FSWatcher | undefined;
    const fire = () => {
        timer = undefined;
        const r = readKeybindings(path);
        // Editors write in steps; only a change of content counts.
        if (r.text === last && !r.error) return;
        last = r.text;
        onChange(r);
    };
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        watcher = watch(dir, { persistent: false }, (_event, file) => {
            if (file && file.toString() !== name) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(fire, debounceMs);
        });
        watcher.on("error", () => undefined);
    } catch {
        // No watching (an unusual file system): the bindings apply on the next start.
    }
    return () => {
        if (timer) clearTimeout(timer);
        watcher?.close();
    };
}
