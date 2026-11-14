// The terminal app's sign-in card: the same sign-in the GUI's card shows
// (src/agent/sign-in.ts), as a prompt that changes in place. The question
// first, then what this kind needs: a link to open, a code to enter, a code to
// paste back, a token, the CLI's own prompts, or a command to run yourself.

import type { SignInAction, SignInInteraction } from "../server/protocol";
import { bold, theme, wrapLine } from "./ansi";
import { frame, frameInner, type Dialog } from "./dialogs";
import { Editor } from "./editor";
import type { Key } from "./keys";

type View = Omit<SignInInteraction, "kind" | "id" | "toolId">;

export interface SignInDialogOptions {
    act(a: SignInAction): void;
    /** Opens a link in this machine's browser. Left out where there's none to open (the app runs on a server). */
    open?: (url: string) => void;
    /** Said after the name when the card names no server: "on this server". */
    where?: string;
}

export class SignInDialog implements Dialog {
    private view: View = { step: "ask" };
    private editor = new Editor();
    private problem?: string;
    private finish!: () => void;
    readonly done: Promise<void>;

    constructor(private o: SignInDialogOptions) {
        this.done = new Promise((r) => (this.finish = r));
    }

    /** The sign-in moved on: what's shown changes, and a field starts empty. */
    update(view: View) {
        const field = (v: View) => (v.step === "paste" || v.step === "token" ? v.step : undefined);
        if (field(view) !== field(this.view) || (!view.busy && this.view.busy && !view.error)) this.editor.clear();
        this.editor.secret = view.step === "token";
        this.editor.keepSpaces = true;
        this.view = view;
        this.problem = undefined;
    }

    /** The sign-in is over: the prompt goes. */
    close() {
        this.editor.clear();
        this.finish();
    }

    /** Dismissed from outside (Ctrl+C): put off, as Esc. */
    cancel() {
        this.act({ action: "later" });
    }

    private act(a: SignInAction) {
        try {
            this.o.act(a);
        } catch (e) {
            this.problem = e instanceof Error ? e.message : String(e);
        }
    }

    private title(): string {
        const v = this.view;
        const on = v.machine ? ` on ${v.machine}` : this.o.where ? ` ${this.o.where}` : "";
        return v.step === "list" || !v.name ? `Sign in${on}?` : `Sign in to ${v.name}${on}?`;
    }

    private outRows() {
        return (this.view.rows ?? []).filter((r) => r.state === "out");
    }

    onKey(k: Key) {
        const v = this.view;
        const n = k.name;
        const text = n === "text" ? (k.text ?? "") : "";
        // At the CLI's own prompt every key is the CLI's, but Esc.
        if (v.step === "typed" && !v.ended) {
            if (n === "escape") return this.act({ action: "later" });
            const keys = n === "paste" ? (k.paste ?? "").replace(/\r?\n/g, "\r") : n === "enter" ? "\r" : n === "backspace" ? "\x7f" : n === "tab" ? "\t" : k.ctrl && /^[a-z]$/.test(n) ? String.fromCharCode(n.charCodeAt(0) - 96) : text;
            if (keys) this.act({ action: "keys", value: keys });
            return;
        }
        if (n === "escape" || (k.ctrl && n === "c")) return this.act({ action: v.step === "token" && v.back ? "back" : "later" });
        if (v.ended || v.expired) {
            if (n === "enter" || text === "r") this.act({ action: "retry" });
            return;
        }
        if (v.busy) return;
        switch (v.step) {
            case "list": {
                const row = this.outRows()[Number(text) - 1];
                if (row) this.act({ action: "pick", target: row.target });
                return;
            }
            case "ask":
                if (n === "enter" || text.toLowerCase() === "y") this.act({ action: "start" });
                else if (text.toLowerCase() === "t" && v.canToken) this.act({ action: "token" });
                else if (text.toLowerCase() === "n") this.act({ action: "later" });
                return;
            case "browser":
            case "code":
                if ((text === "o" || n === "enter") && v.url) this.o.open?.(v.url);
                return;
            case "command":
                if (n === "enter") this.act({ action: "done" });
                else if (text === "s" && v.canSave) this.act({ action: "done", save: true });
                return;
            case "paste":
            case "token": {
                const e = this.editor;
                if (n === "enter") {
                    const value = e.value().trim();
                    if (value) this.act({ action: "submit", value });
                    return;
                }
                if (n === "paste" && k.paste) return e.paste(k.paste);
                if (n === "text" && k.text) return e.insert(k.text);
                if (n === "backspace") return k.meta || k.ctrl ? e.killWordLeft() : e.backspace();
                if (n === "delete") return e.del();
                if (n === "left") return e.left();
                if (n === "right") return e.right();
                if (n === "home" || (k.ctrl && n === "a")) return e.home();
                if (n === "end" || (k.ctrl && n === "e")) return e.end();
                if (k.ctrl && n === "u") return e.killToStart();
                return;
            }
        }
    }

    render(cols: number): string[] {
        const v = this.view;
        const color = theme.info;
        const inner = frameInner(cols);
        const out: string[] = [color(bold(this.title()))];
        const hint = (s: string) => out.push(theme.subtle(s));
        const later = v.back && v.step !== "list" ? "esc to go back" : "esc for later";
        if (v.ended) {
            if (v.step === "typed" && v.term) out.push(...v.term.split("\n"));
            else if (v.error) out.push(...v.error.split("\n").map((l) => theme.error(l)));
            hint(`enter to try again · ${later}`);
            return frame(out, cols, color);
        }
        switch (v.step) {
            case "list": {
                let i = 0;
                for (const r of v.rows ?? []) out.push(r.state === "in" ? `   ${r.name}  ${theme.success("✓")} ${theme.muted(r.who ?? "signed in")}` : `${++i}. ${r.name}`);
                hint(`${i > 1 ? `1-${i}` : "1"} to sign in · esc for later`);
                break;
            }
            case "ask":
                if (v.warning) out.push(theme.muted(v.warning));
                if (v.busy) out.push(theme.muted("Starting…"));
                else hint(`enter to sign in${v.canToken ? " · t to use a token" : ""} · ${later}`);
                break;
            case "browser":
                if (v.busy && !v.url) out.push(theme.muted("Starting…"));
                else {
                    out.push(v.open ? "Open this link in your browser:" : "Finish in your browser. If it didn't open:");
                    if (v.url) out.push(...wrapLine(v.url, inner));
                }
                hint(`${v.url && this.o.open ? "o to open it · " : ""}${later}`);
                break;
            case "code":
                out.push(`Code: ${bold(v.code ?? "")}`);
                if (v.expired) out.push(theme.warning("This code expired."));
                else out.push(`Enter it at ${v.url ?? v.site ?? "the page"}`);
                hint(v.expired ? `enter for a new code · ${later}` : `${v.url && this.o.open ? "o to open it · " : ""}${later}`);
                break;
            case "paste":
            case "token": {
                if (v.step === "paste") {
                    out.push("Open this link, then paste the code it gives you:");
                    if (v.url) out.push(...wrapLine(v.url, inner));
                } else if (v.tokenUrl) out.push(theme.muted(`Make one at ${v.tokenUrl}`));
                const r = this.editor.render(inner, "> ", "  ", { showCursor: !v.busy, placeholder: v.step === "token" ? "Token (input is hidden)" : "Code" });
                out.push(...r.lines);
                if (v.error) out.push(...v.error.split("\n").map((l) => theme.error(l)));
                hint(v.busy ? "Checking…" : `enter to ${v.step === "token" ? "sign in" : "continue"} · ${v.step === "token" && v.back ? "esc to go back" : later}`);
                break;
            }
            case "typed":
                out.push(...(v.term ?? "").split("\n"));
                hint(`type at its prompt · ${later}`);
                break;
            case "command":
                out.push("Run this in another terminal:");
                out.push(`  ${bold(v.command ?? "")}`);
                hint(`enter when it's done${v.canSave ? " · s to also remember it" : ""} · ${later}`);
                break;
        }
        if (this.problem) out.push(theme.error(this.problem));
        return frame(out, cols, color);
    }
}
