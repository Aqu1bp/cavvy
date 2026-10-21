// The terminal app's side of keybindings: its key events as strokes, and the
// keymap kept up to date with the file.

import type { Key } from "../ui/keys";
import { KeyMatcher, formatKeys, keyLabel, loadKeymap, type Keymap, type KeyPlatform, type Stroke } from "./core";
import { keybindingsPath, readKeybindings, watchKeybindings } from "./file";

export function hostPlatform(p: string = process.platform): KeyPlatform {
    return p === "darwin" ? "macos" : p === "win32" ? "windows" : p === "linux" ? "linux" : "other";
}

const NOT_KEYS = new Set(["paste", "unknown", "focus-in", "focus-out"]);

/** A terminal key event as a stroke; undefined for pastes, typed runs of text and the like. */
export function tuiStroke(k: Key): Stroke | undefined {
    if (NOT_KEYS.has(k.name)) return undefined;
    if (k.name === "text") {
        const t = k.text ?? "";
        if ([...t].length !== 1) return undefined;
        const lower = t.toLowerCase();
        return { key: t === " " ? "space" : lower, shift: t !== lower || undefined };
    }
    // Alt+Space arrives from ESC-prefixed terminals as a meta " ".
    return { key: k.name === " " ? "space" : k.name, ctrl: k.ctrl, alt: k.meta, shift: k.shift };
}

/** The terminal's keymap, its matcher, and the watch that keeps them current. */
export class TuiKeybindings {
    keymap: Keymap;
    readonly matcher: KeyMatcher;
    private stopWatch?: () => void;

    constructor(
        private platform = hostPlatform(),
        readonly path = keybindingsPath(),
    ) {
        this.keymap = this.read().keymap;
        this.matcher = new KeyMatcher(this.keymap);
    }

    private read(r = readKeybindings(this.path)): { keymap: Keymap } {
        const keymap = loadKeymap(r.text, "tui", this.platform);
        if (r.error) keymap.issues.unshift({ level: "error", message: r.error });
        return { keymap };
    }

    /** Re-reads the file on every save; `onReload` gets the new keymap. A broken file keeps the last good bindings. */
    watch(onReload: (km: Keymap, status: "applied" | "kept") => void) {
        this.stopWatch?.();
        this.stopWatch = watchKeybindings((r) => {
            const km = this.read(r).keymap as Keymap & { fatal?: string };
            if (km.fatal) {
                // Not JSON (a save halfway through an edit): keep what works, and say why.
                this.keymap = { ...this.keymap, issues: km.issues };
                this.matcher.keymap = this.keymap;
                return onReload(this.keymap, "kept");
            }
            this.keymap = km;
            this.matcher.keymap = km;
            this.matcher.reset();
            onReload(km, "applied");
        }, this.path);
    }

    close() {
        this.stopWatch?.();
    }

    /** The first key bound to `action`, as the terminal shows it ("ctrl+g"); undefined when unbound. */
    label(action: string): string | undefined {
        return keyLabel(this.keymap, action);
    }

    all(action: string): string[] {
        return (this.keymap.keysOf.get(action) ?? []).map((k) => formatKeys(k, "tui", this.platform));
    }
}
