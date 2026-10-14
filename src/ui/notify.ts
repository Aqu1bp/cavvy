// Notifications: a long turn finished, the harness is waiting for you, or a
// turn stopped with an error. Only while the terminal window isn't focused
// (or focus is unknown), and never in -p mode.
//
// Which terminals show a desktop notification for which sequence, from each
// terminal's own docs and source:
//   OSC 9  (ESC ] 9 ; text): iTerm2 (iterm2.com/documentation-escape-codes.html),
//          WezTerm (wezterm.org/escape-sequences.html), Ghostty (ghostty.org/docs/vt/osc/9),
//          foot (README "OSC 9 - desktop notification"), and kitty as a legacy protocol.
//          Ended with BEL, which WezTerm and Ghostty document accepting as well as ST.
//   OSC 777 (ESC ] 777 ; notify ; title ; body): WezTerm and foot (same pages). Both
//          also support OSC 9, so 777 isn't used.
//   OSC 99 (ESC ] 99 ; ; text ESC \): kitty's own protocol, used there
//          (sw.kovidgoyal.net/kitty/desktop-notifications/).
// They're recognized by TERM_PROGRAM: "WezTerm" (wezterm config/src/config.rs),
// "ghostty" (ghostty src/termio/Exec.zig), "iTerm.app" (not in iTerm2's docs;
// widely relied on), or TERM: "xterm-kitty" (kitty FAQ), "xterm-ghostty"
// (Ghostty docs), "foot" (foot's default-terminfo). tmux sets TERM_PROGRAM to
// "tmux", so auto uses the bell there.

import type { TurnEndReason } from "../agent/agent";
import { fireHooks } from "../agent/hooks";
import { APP_TITLE } from "../config/paths";
import { NOTIFICATION_MODES, type NotificationMode, type Settings } from "../config/settings";
import { childEnv } from "../util/env";
import { formatDuration } from "./components";

export type NotifyKind = "done" | "permission" | "question" | "plan" | "error";

/** How a notification is delivered, once "auto" and "terminal" are resolved. */
export type Channel = "osc9" | "osc99" | "bell" | "system" | "off";

type Env = Record<string, string | undefined>;

const DEFAULT_AFTER_SECONDS = 30;

const TEXT: Record<NotifyKind, string> = {
    done: "done",
    permission: "waiting for your approval",
    question: "waiting for your answer",
    plan: "plan ready for your review",
    error: "stopped with an error",
};

export function notificationMode(s: Settings): NotificationMode {
    return s.notifications && NOTIFICATION_MODES.includes(s.notifications) ? s.notifications : "auto";
}

export function notifyAfterMs(s: Settings): number {
    const n = s.notifyAfterSeconds;
    return (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_AFTER_SECONDS) * 1000;
}

/**
 * Whether to notify. A finished turn needs to have taken at least `afterMs`;
 * everything else only needs the window not to be focused. Focus that was
 * never reported counts as not focused.
 */
export function shouldNotify(o: { kind: NotifyKind; focused: boolean | undefined; elapsedMs?: number; afterMs: number; interactive: boolean }): boolean {
    if (!o.interactive || o.focused === true) return false;
    if (o.kind === "done") return (o.elapsedMs ?? 0) >= o.afterMs;
    return true;
}

/** "done (2m 10s)". Never includes tool input. */
export function notificationText(kind: NotifyKind, elapsedMs?: number): string {
    return kind === "done" && elapsedMs !== undefined ? `done (${formatDuration(elapsedMs)})` : TEXT[kind];
}

/** "Harness: done (2m 10s)" */
export function notificationMessage(kind: NotifyKind, elapsedMs?: number): string {
    return clean(`${APP_TITLE}: ${notificationText(kind, elapsedMs)}`);
}

/** Control characters would end an escape sequence early or start another. */
export function clean(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 200);
}

/** The terminal's own notification sequence, if TERM_PROGRAM / TERM name one we know. */
export function terminalChannel(env: Env): "osc9" | "osc99" | undefined {
    const program = env.TERM_PROGRAM ?? "";
    const term = env.TERM ?? "";
    if (term === "xterm-kitty") return "osc99";
    if (program === "iTerm.app" || program === "WezTerm" || program === "ghostty") return "osc9";
    if (term === "xterm-ghostty" || /^foot(-|$)/.test(term)) return "osc9";
    return undefined;
}

export function resolveChannel(mode: NotificationMode, env: Env, platform: NodeJS.Platform): Channel {
    switch (mode) {
        case "off":
            return "off";
        case "bell":
            return "bell";
        case "system":
            return platform === "darwin" || platform === "linux" ? "system" : "bell";
        case "terminal":
            return terminalChannel(env) ?? "osc9";
        default:
            return terminalChannel(env) ?? "bell";
    }
}

/** The bytes to write for a terminal channel. Inside tmux, OSC sequences are wrapped for passthrough. */
export function terminalSequence(channel: "osc9" | "osc99" | "bell", message: string, env: Env): string {
    if (channel === "bell") return "\x07";
    const text = clean(message);
    const seq = channel === "osc99" ? `\x1b]99;;${text}\x1b\\` : `\x1b]9;${text}\x07`;
    return env.TMUX ? tmuxPassthrough(seq) : seq;
}

/** tmux hands a sequence to the outer terminal when it's wrapped like this (and allow-passthrough is on). */
export function tmuxPassthrough(seq: string): string {
    return `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

/** The desktop notifier command, titled "Harness". The text is an argument, never part of a script or shell string. */
export function systemCommand(body: string, platform: NodeJS.Platform): string[] | undefined {
    const text = clean(body);
    if (platform === "darwin") return ["osascript", "-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", text, APP_TITLE];
    if (platform === "linux") return ["notify-send", "--app-name", APP_TITLE, "--", APP_TITLE, text];
    return undefined;
}

async function runCommand(argv: string[]): Promise<boolean> {
    try {
        const proc = Bun.spawn(argv, { env: childEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5000 });
        return (await proc.exited) === 0;
    } catch {
        return false;
    }
}

export interface NotifierOptions {
    settings: () => Settings;
    /** The terminal's focus; undefined until it reports one. */
    focus: () => boolean | undefined;
    /** False in -p mode and without a terminal: never notify. */
    interactive: boolean;
    cwd: () => string;
    sessionId: () => string | undefined;
    warn: (msg: string) => void;
    write?: (s: string) => void;
    env?: Env;
    platform?: NodeJS.Platform;
    /** Runs the system notifier; true when it worked. */
    run?: (argv: string[]) => Promise<boolean>;
}

export class Notifier {
    constructor(private o: NotifierOptions) {}

    /** An interrupted turn doesn't notify: whoever pressed esc is right there. */
    turnEnded(reason: TurnEndReason, elapsedMs: number): Promise<boolean> {
        if (reason === "aborted") return Promise.resolve(false);
        return this.notify(reason === "error" ? "error" : "done", elapsedMs);
    }

    /**
     * Notify if the window isn't focused. Notification hooks run whenever a
     * notification would be shown, even with notifications off. Resolves
     * (to whether it notified) once the hooks and delivery are done.
     */
    async notify(kind: NotifyKind, elapsedMs?: number): Promise<boolean> {
        const s = this.o.settings();
        if (!shouldNotify({ kind, focused: this.o.focus(), elapsedMs, afterMs: notifyAfterMs(s), interactive: this.o.interactive })) return false;
        const message = notificationMessage(kind, elapsedMs);
        const hooks = fireHooks(s, "Notification", { session_id: this.o.sessionId(), message, kind }, this.o.cwd(), this.o.warn);
        const env = this.o.env ?? process.env;
        const write = this.o.write ?? ((x: string) => void process.stdout.write(x));
        const channel = resolveChannel(notificationMode(s), env, this.o.platform ?? process.platform);
        if (channel === "osc9" || channel === "osc99" || channel === "bell") write(terminalSequence(channel, message, env));
        else if (channel === "system") {
            const text = notificationText(kind, elapsedMs);
            const argv = systemCommand(text[0]!.toUpperCase() + text.slice(1), this.o.platform ?? process.platform)!;
            // No notifier installed (or it failed): the bell still gets attention.
            if (!(await (this.o.run ?? runCommand)(argv))) write("\x07");
        }
        await hooks;
        return true;
    }
}
