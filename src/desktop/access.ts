// Getting macOS's grants for the helper (src/desktop/session.ts) with as little of the person as possible: a card in
// their window whose one button opens the very page in System Settings, then notices the switch by itself and lets the
// action carry on. Checked only while a card waits for the switch: about once a second for Accessibility, which a
// running process sees change (with a freshly started helper every few seconds too, in case it doesn't), and every two
// seconds with a freshly started helper for Screen Recording, which macOS tells only a process that starts after it.

import { DesktopError, refuseRealInTests, type Grant } from "./helper";
import type { AccessInteraction, InteractionResponse } from "../server/protocol";
import { run } from "../simulator/simctl";

/** What a card shows (`page`: the link couldn't open System Settings there, so the page is named). */
export type AccessView = Omit<AccessInteraction, "kind" | "id" | "toolId">;

export type AccessAction = Extract<InteractionResponse, { kind: "access" }>["action"];

/** A card in the person's window, changed in place: what it shows, and what they do with it. */
export interface AccessCard {
    show(view: AccessView): void;
    /** The next button pressed: "close" once the card is closed or the turn stopped. */
    next(): Promise<AccessAction>;
    /** Takes the card away. */
    close(): void;
}

/**
 * A card over a window's own (the session's runtime puts it up and takes it down): presses queue until asked for, the
 * turn stopping or the card going from elsewhere counts as closed, and nothing is shown once it's over.
 */
export function windowCard(win: { show(view: AccessView, first: boolean): void; hide(): void }, signal: AbortSignal): { card: AccessCard; press(a: AccessAction): void } {
    const presses: AccessAction[] = [];
    let waiting: ((a: AccessAction) => void) | undefined;
    let shown = false;
    let over = false;
    const press = (a: AccessAction) => {
        if (over) return;
        const w = waiting;
        waiting = undefined;
        if (w) w(a);
        else presses.push(a);
    };
    const stop = () => press("close");
    signal.addEventListener("abort", stop, { once: true });
    const card: AccessCard = {
        show(view) {
            if (over) return;
            win.show(view, !shown);
            shown = true;
        },
        next: () => (presses.length ? Promise.resolve(presses.shift()!) : over ? Promise.resolve("close") : new Promise((resolve) => (waiting = resolve))),
        close() {
            if (over) return;
            press("close");
            over = true;
            signal.removeEventListener("abort", stop);
            if (shown) win.hide();
        },
    };
    return { card, press };
}

/** Where a session asks: its card (none where there's no window, the terminal's) and its turn's signal. */
export interface AccessAsker {
    card?: (signal: AbortSignal) => AccessCard;
    signal?: AbortSignal;
}

/** The page for each grant, as System Settings' link names it. */
export const SETTINGS_LINKS: Record<Grant, string> = {
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** Each card's question. */
export const ACCESS_TITLES: Record<Grant, string> = {
    accessibility: "Let Cavvy control apps on this Mac?",
    screen: "Let Cavvy take screenshots of apps?",
};

export const ACCESS_WAIT_MS = 5 * 60_000;

/** How the person's answer is waited for: tests make these instant. */
export interface AccessTiming {
    /** Between checks, for each grant. */
    everyMs: Record<Grant, number>;
    /** Accessibility: every this many checks, a freshly started helper is asked as well. */
    freshEvery: number;
    limitMs: number;
}

export const ACCESS_TIMING: AccessTiming = { everyMs: { accessibility: 1000, screen: 2000 }, freshEvery: 5, limitMs: ACCESS_WAIT_MS };

/** What getting a grant takes from the session: asking macOS, opening the page, and checking. */
export interface AccessDeps {
    /** Has macOS list the helper for that grant (and maybe show its own prompt). */
    request(g: Grant): Promise<void>;
    /** Opens the page; false if it couldn't. */
    open(g: Grant): Promise<boolean>;
    /** Whether the helper has the grant: the running one, or (`fresh`) one started for the check. */
    check(g: Grant, fresh: boolean): Promise<boolean>;
    timing?: AccessTiming;
}

/** Opens a System Settings page by its link. Never in tests (it would open System Settings on the Mac running them). */
export async function openSettingsPage(g: Grant): Promise<boolean> {
    refuseRealInTests("open System Settings");
    const r = await run(["/usr/bin/open", SETTINGS_LINKS[g]], { timeoutMs: 15_000 }).catch(() => undefined);
    return r?.code === 0;
}

/** How the grant was seen, for the log: by the running helper, or one started to check. */
export type Seen = "running" | "fresh";

/**
 * Shows the card and waits for the grant: resolves once the helper has it (and how it was seen), or throws what the
 * agent is told when the person closed the card, the turn stopped, or nothing changed within the limit.
 */
export async function obtain(g: Grant, card: AccessCard, deps: AccessDeps, o: { name: string; page: string; line: string; signal?: AbortSignal }): Promise<Seen> {
    const timing = deps.timing ?? ACCESS_TIMING;
    const view: AccessView = { grant: g, title: ACCESS_TITLES[g], step: "ask", name: o.name };
    card.show(view);
    try {
        let action = await card.next();
        while (action === "open") {
            await deps.request(g).catch(() => undefined);
            const opened = await deps.open(g).catch(() => false);
            card.show({ ...view, step: "waiting", ...(opened ? {} : { page: o.page }) });
            // The switch, or the person: whichever comes first. Another Open Settings opens the page again.
            const pressed = card.next();
            const seen = await untilGranted(g, deps, timing, pressed, o.signal);
            if (seen === "timeout") throw new DesktopError(`The switch wasn't turned on in ${Math.round(timing.limitMs / 60_000)} minutes. ${o.line}`, g);
            if (seen !== "pressed") return seen;
            action = await pressed;
        }
        throw new DesktopError(o.signal?.aborted ? "Interrupted by user." : `The user didn't turn on ${o.name}. ${o.line}`, o.signal?.aborted ? "cancelled" : g);
    } finally {
        card.close();
    }
}

/** Checks until the grant is there, the person presses something, the turn stops, or the limit passes. */
async function untilGranted(g: Grant, deps: AccessDeps, timing: AccessTiming, pressed: Promise<AccessAction>, signal?: AbortSignal): Promise<Seen | "pressed" | "timeout"> {
    let press = false;
    void pressed.then(() => (press = true));
    const end = Date.now() + timing.limitMs;
    for (let i = 1; ; i++) {
        const wait = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timing.everyMs[g]);
            void pressed.then(() => (clearTimeout(t), resolve()));
        });
        await wait;
        if (press || signal?.aborted) return "pressed";
        if (Date.now() >= end) return "timeout";
        // Screen Recording only shows in a process started after it; Accessibility, in the running one too.
        const fresh = g === "screen" || i % timing.freshEvery === 0;
        if (await deps.check(g, false).catch(() => false)) return "running";
        if (fresh && (await deps.check(g, true).catch(() => false))) return "fresh";
    }
}
