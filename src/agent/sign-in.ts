// Signing the user in to something, run by Cavvy itself. An agent (or a
// feature that found something signed out) names what and where; the flow
// here checks whether it's already signed in, shows the card, runs the
// recipe's command outside the agent's reach, reads the link or code from
// what it prints, and decides it worked by the recipe's own status check,
// never by the sign-in command's exit. Nothing the command prints, and nothing
// the user types, goes back to the model: only "signed in as <who>" or not.

import type { SignInAction, SignInInteraction, SignInRow } from "../server/protocol";
import type { SignInRecipe, SignInWay } from "./sign-in-recipes";

/** What the card shows: the interaction without what the session adds (its id, the tool call, the machine's name). */
export type SignInView = Omit<SignInInteraction, "kind" | "id" | "toolId" | "machine">;

export interface SignInProcess {
    write(text: string): void;
    kill(): void;
    exited: Promise<number>;
}

/** The machine a sign-in happens on: this one, or a server reached over SSH. */
export interface SignInHost {
    /** The person's browser is on another machine than this one. */
    readonly away: boolean;
    /** Each of its commands is a connection of its own (a server reached over SSH): its status is looked at less often. */
    readonly far?: boolean;
    /** Runs one of a recipe's commands to its end. `missing`: its program isn't installed there. */
    run(recipe: SignInRecipe, words: string[], o?: { stdin?: string; timeoutMs?: number }): Promise<{ code: number; out: string; missing?: boolean }>;
    /** Starts one in a terminal of its own. `opens`: it may open the browser itself. */
    start(recipe: SignInRecipe, words: string[], o: { opens: boolean; onData(text: string): void }): SignInProcess;
    /** The line that runs a command there from a terminal on the user's own machine. Left out: the command itself does. */
    typed?(recipe: SignInRecipe | undefined, words: string[]): string;
    /** Called once one is signed in, before the card goes: what the machine does with a new sign-in (offers an agent CLI's models). */
    signedIn?(recipe: SignInRecipe): Promise<void>;
    /** Brings a port of that machine here, for a page that ends by calling it. Left out: there's no way to. */
    forward?(port: number): Promise<{ close(): void }>;
}

export interface SignInResult {
    target: string;
    name: string;
    /** in: signed in. out: not. none: its CLI isn't installed. unverified: the user says so, nothing could check. unknown: no recipe, and no command to offer. */
    state: "in" | "out" | "none" | "unverified" | "unknown";
    who?: string;
    /** Cavvy can tell when it's signed in later (it has a status command): put off, the agent is told when that happens. */
    watched?: boolean;
}

export interface SignInOutcome {
    /** done: nothing is left signed out. later: the user put it off. stopped: the turn was interrupted. */
    end: "done" | "later" | "stopped";
    results: SignInResult[];
}

export interface SignInWant {
    target: string;
    recipe?: SignInRecipe;
    /** For one Cavvy has no recipe for: the command to show the user, who runs it. */
    command?: string;
}

export interface SignInFlowOptions {
    wants: SignInWant[];
    host: SignInHost;
    /** Called with each change of the card; the first call puts it up. */
    show(view: SignInView): void;
    /** Keeps a sign-in Cavvy didn't know as the user's own. Left out: not offered. */
    save?(want: SignInWant): void;
    /** The windows showing the card can bring a port of this machine to the user's (the card's `forward`): used where the host has no way of its own. */
    windowForwards?: boolean;
    /** The user already said to sign in (they came back to one they'd put off): the card starts past its question. */
    asked?: boolean;
    /** How often the status is checked while the card is up. */
    pollMs?: number;
    now?: () => number;
}

const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Terminal output as the text it shows: no escapes, no control characters but line ends. */
export function plain(text: string): string {
    return text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** The last few lines a prompt-driven CLI shows: enough of a terminal for "Username:" and what's typed after it. */
export class SmallScreen {
    private lines: string[] = [""];
    private col = 0;
    private pending = "";
    constructor(private rows = 8, private cols = 200) {}

    write(data: string) {
        // An escape may arrive in two pieces: its start waits for the rest.
        let text = this.pending + data;
        this.pending = "";
        const cut = text.lastIndexOf("\x1b");
        if (cut >= 0 && cut > text.length - 16 && !/^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/.test(text.slice(cut))) {
            this.pending = text.slice(cut);
            text = text.slice(0, cut);
        }
        for (const part of text.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/)) {
            if (!part) continue;
            if (part.startsWith("\x1b")) {
                // Erase to the end of the line (K), or the whole line (2K): what a prompt redraws with.
                const m = /^\x1b\[(\d*)K$/.exec(part);
                if (m) this.lines[this.lines.length - 1] = m[1] === "2" ? "" : this.line().slice(0, this.col);
                if (m?.[1] === "2") this.col = 0;
                if (/^\x1b\[\d*G$/.test(part)) this.col = Math.max(0, Number(part.slice(2, -1) || 1) - 1);
                continue;
            }
            for (const ch of part) {
                if (ch === "\n") {
                    this.lines.push("");
                    this.col = 0;
                    if (this.lines.length > this.rows) this.lines.shift();
                } else if (ch === "\r") this.col = 0;
                else if (ch === "\b") this.col = Math.max(0, this.col - 1);
                else if (ch >= " " && ch !== "\x7f" && this.col < this.cols) {
                    const l = this.line();
                    this.lines[this.lines.length - 1] = l.slice(0, this.col).padEnd(this.col) + ch + l.slice(this.col + 1);
                    this.col++;
                }
            }
        }
    }

    private line(): string {
        return this.lines[this.lines.length - 1]!;
    }

    text(): string {
        return this.lines.join("\n");
    }
}

const words = (command: string) => command.split(" ").filter(Boolean);

/**
 * What a failed command said, short enough for a card: its last lines, without what the user typed (`hide`) and
 * without the lines the card already showed (`shown`: the code, the link).
 */
function said(output: string, hide: string[] = [], shown: (string | undefined)[] = [], prompt?: string): string {
    let text = plain(output);
    // Its prompt, printed again before what it has to say, isn't part of that.
    if (prompt) try { text = text.replace(new RegExp(prompt, "gi"), "\n"); } catch {}
    const all = text.split("\n").map((l) => l.trim()).filter((l) => l && !shown.some((x) => x && l.includes(x)));
    // A line that echoes what was typed (the prompt it was typed at) says nothing more; if that's all there is, the value is blanked.
    const without = all.filter((l) => !hide.some((h) => h && l.includes(h)));
    const lines = without.length ? without : all.map((l) => hide.reduce((t, h) => (h ? t.split(h).join("•••") : t), l));
    return lines.slice(-3).join("\n").slice(-300);
}

function first(pattern: string | undefined, text: string): string | undefined {
    if (!pattern) return undefined;
    try {
        const m = new RegExp(pattern, "m").exec(text);
        return m ? (m[1] ?? m[0]) : undefined;
    } catch {
        return undefined;
    }
}

/** The last thing a pattern finds: a CLI prints what it's about (a link to its docs) before the link that matters. */
function last(pattern: string, text: string): string | undefined {
    try {
        let found: string | undefined;
        for (const m of text.matchAll(new RegExp(pattern, "gm"))) found = m[1] ?? m[0];
        return found;
    } catch {
        return undefined;
    }
}

/** "github.com/login/device" for the card; a long address is cut to its host. */
export function siteOf(url: string): string {
    try {
        const u = new URL(url);
        const path = u.pathname === "/" ? "" : u.pathname;
        return u.host.replace(/^www\./, "") + (path.length <= 24 ? path : "");
    } catch {
        return url;
    }
}

/** Whether a recipe's service is signed in on that machine, by its status command: the one thing that decides. */
export async function signInStatus(host: SignInHost, r: SignInRecipe): Promise<{ state: "in" | "out" | "none"; who?: string }> {
    if (!r.status.run) return { state: "out" };
    const res = await host.run(r, words(r.status.run), { timeoutMs: 30_000 }).catch(() => ({ code: 1, out: "", missing: false }));
    if (res.missing) return { state: "none" };
    const out = plain(res.out);
    const signedIn = r.status.signedIn ? Boolean(first(r.status.signedIn, out)) : res.code === 0;
    if (!signedIn) return { state: "out" };
    const who = first(r.status.who, out)?.slice(0, 80);
    return { state: "in", ...(who ? { who } : {}) };
}

interface Entry extends SignInWant {
    name: string;
    state: SignInResult["state"];
    who?: string;
}

/** Longer than any code is good for: a sign-in command still running then is taken as stuck on an old code. */
const CODE_LIFE_MS = 14 * 60_000;

export class SignInFlow {
    private entries: Entry[];
    private current: Entry | undefined;
    private view: SignInView = { step: "ask" };
    private shown = false;
    private proc: SignInProcess | undefined;
    /** Counts runs of a sign-in command: what an older one reports is ignored. */
    private run_ = 0;
    private output = "";
    /** How much of the output the card has already shown or answered (the link, the code, what was pasted): what comes after is why it failed. */
    private heardTo = 0;
    private complaint: ReturnType<typeof setTimeout> | undefined;
    private screen: SmallScreen | undefined;
    private forwarded: { close(): void } | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private checking: Promise<boolean> | undefined;
    private answered = new Set<string>();
    private sent: string[] = [];
    private startedAt = 0;
    private finish!: (o: SignInOutcome) => void;
    private over = false;
    private readonly done: Promise<SignInOutcome>;
    private readonly pollMs: number;
    private readonly now: () => number;

    constructor(private o: SignInFlowOptions) {
        this.entries = o.wants.map((w) => ({ ...w, name: w.recipe?.name ?? w.target, state: w.recipe || w.command ? "out" : "unknown" }));
        this.pollMs = o.pollMs ?? (o.host.far ? 15_000 : o.host.away ? 5000 : 2500);
        this.now = o.now ?? Date.now;
        this.done = new Promise((resolve) => { this.finish = resolve; });
    }

    /** Whether a card is up. */
    get showing(): boolean {
        return this.shown && !this.over;
    }

    /** Checks what's already signed in, then shows the card for the rest. Resolves when it's over; `signal` stops it. */
    async run(signal?: AbortSignal): Promise<SignInOutcome> {
        const stop = () => this.end("stopped");
        signal?.addEventListener("abort", stop, { once: true });
        try {
            await Promise.all(this.entries.map((e) => this.refresh(e)));
            if (signal?.aborted) this.end("stopped");
            else if (!this.entries.some((e) => e.state === "out")) this.end("done");
            else if (this.entries.length === 1) this.open(this.entries[0]!, this.o.asked);
            else this.list();
            return await this.done;
        } finally {
            signal?.removeEventListener("abort", stop);
        }
    }

    /** A step the user took in the card. Throws what the card should say when it can't be taken. */
    act(a: SignInAction) {
        if (this.over) return;
        const e = this.current;
        switch (a.action) {
            case "pick": {
                const picked = this.entries.find((x) => x.target === a.target && x.state === "out");
                if (!picked || this.view.step !== "list") return;
                this.open(picked, true);
                return;
            }
            case "start":
                if (e && (this.view.step === "ask" || this.view.ended)) void this.start(e);
                return;
            case "retry":
                if (e) void this.start(e);
                return;
            case "token":
                if (e?.recipe?.token && this.view.step === "ask") this.set({ step: "token", tokenUrl: e.recipe.token.url, canToken: undefined, error: undefined, back: true });
                return;
            case "back":
                this.stopCommand();
                // From the token field to the question it came from; from one of a list's, to the list.
                if (this.view.step === "token" && e && this.way(e)?.flow !== "token") this.open(e);
                else if (this.entries.length > 1) this.list();
                else if (e) this.open(e);
                return;
            case "later":
                // From one of a list's, back to the list: the others can still be signed in.
                if (this.entries.length > 1 && this.view.step !== "list") {
                    this.stopCommand();
                    this.list();
                } else this.end("later");
                return;
            case "submit":
                if (typeof a.value !== "string" || !a.value.trim() || a.value.length > 8192 || /[\x00-\x1f\x7f]/.test(a.value)) throw new Error("That isn't something that can be sent.");
                if (this.view.step === "token" && e) void this.token(e, a.value.trim());
                else if (this.view.step === "paste" && this.proc) {
                    this.sent.push(a.value.trim());
                    this.heardTo = this.output.length;
                    this.proc.write(`${a.value.trim()}\r`);
                    this.set({ busy: true, error: undefined });
                }
                return;
            case "keys":
                if (this.view.step === "typed" && this.proc && typeof a.value === "string" && a.value.length <= 4096) this.proc.write(a.value);
                return;
            case "ran":
                if (this.view.step === "command") this.set({ ran: true });
                return;
            case "port":
                this.ported?.(a.error);
                return;
            case "done":
                if (this.view.step !== "command" || !e) return;
                if (a.save && this.view.canSave) this.o.save?.(e);
                e.state = "unverified";
                this.next();
                return;
        }
    }

    /** What "Open in terminal" types, while the card shows a command for the user to run. */
    typed(): string | undefined {
        if (this.over || this.view.step !== "command" || !this.view.command) return undefined;
        const w = words(this.view.command);
        return this.o.host.typed ? this.o.host.typed(this.current?.recipe, w) : w.join(" ");
    }

    /** How one stands now, by its status check. */
    private async refresh(e: Entry): Promise<boolean> {
        if (!e.recipe?.status.run) return false;
        const now = await signInStatus(this.o.host, e.recipe);
        if (this.over) return false;
        if (now.state === "out" && e.state === "unverified") return false;
        e.state = now.state;
        e.who = now.who;
        return now.state === "in";
    }

    private way(e: Entry): SignInWay | undefined {
        const r = e.recipe;
        if (!r) return undefined;
        if (!this.o.host.away) return r.here.flow === "callback" ? { ...r.here, flow: "browser" } : r.here;
        if (r.away) return r.away;
        // Its command for a browser on the same machine can't reach one from here.
        if (r.here.flow === "browser") return undefined;
        return r.here;
    }

    private set(patch: Partial<SignInView>) {
        if (this.over) return;
        const next = { ...this.view, ...patch } as Record<string, unknown>;
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
        this.view = next as unknown as SignInView;
        this.shown = true;
        this.o.show(this.view);
    }

    private rows(): SignInRow[] {
        return this.entries.filter((e) => e.state === "in" || e.state === "out").map((e) => ({ target: e.target, name: e.name, state: e.state as "in" | "out", ...(e.who ? { who: e.who } : {}) }));
    }

    private list() {
        this.current = undefined;
        this.view = { step: "list" };
        this.set({ rows: this.rows() });
        this.watch();
    }

    /** The first card for one: the question, or what it needs at once. `picked`: Sign in was already pressed (in a list, or on one put off). */
    private open(e: Entry, picked = false) {
        this.current = e;
        // Somewhere to go back to: the list this one was picked from.
        const back = this.entries.length > 1 ? true : undefined;
        const base = { target: e.target, name: e.name, back, warning: this.o.host.away ? e.recipe?.warning : undefined };
        const way = this.way(e);
        if (!way) {
            // Nothing Cavvy can run: the command, for the user to run in a terminal.
            this.view = { step: "command" };
            this.set({ ...base, warning: undefined, command: e.recipe ? e.recipe.here.run : e.command, canSave: !e.recipe && this.o.save ? true : undefined });
        } else if (way.flow === "token") {
            this.view = { step: "token" };
            this.set({ ...base, tokenUrl: e.recipe!.token?.url });
        } else if (picked && !e.recipe!.token) {
            this.view = { step: "ask" };
            this.set({ ...base, busy: true });
            void this.start(e);
            return;
        } else {
            this.view = { step: "ask" };
            this.set({ ...base, canToken: e.recipe!.token ? true : undefined });
        }
        this.watch();
    }

    /** Runs the sign-in command and follows what it prints. */
    private async start(e: Entry) {
        const way = this.way(e);
        const r = e.recipe;
        if (!way || !r) return;
        if (way.flow === "token") return this.set({ step: "token", error: undefined });
        this.stopCommand();
        const run = ++this.run_;
        this.output = "";
        this.heardTo = 0;
        this.answered.clear();
        this.sent = [];
        this.startedAt = this.now();
        const base = { target: e.target, name: e.name, back: this.entries.length > 1 ? true : undefined, warning: this.view.warning };
        this.view = { step: way.flow === "typed" ? "typed" : "browser" };
        this.set({ ...base, busy: way.flow === "typed" ? undefined : true, term: way.flow === "typed" ? "" : undefined });
        if (way.flow === "callback") {
            try {
                if (!way.port) throw new Error("This sign-in doesn't say which port its page calls.");
                if (this.o.host.forward) this.forwarded = await this.o.host.forward(way.port);
                else if (this.o.windowForwards) this.forwarded = await this.byWindow(way.port);
                else throw new Error("This sign-in needs its page to reach the server, which can't be set up from here.");
            } catch (err) {
                if (run === this.run_) this.set({ busy: undefined, ended: true, error: err instanceof Error ? err.message : String(err) });
                return;
            }
            if (run !== this.run_ || this.over) return this.forwarded?.close();
        }
        this.screen = way.flow === "typed" ? new SmallScreen() : undefined;
        let proc: SignInProcess;
        try {
            // Only a sign-in for a browser on this machine opens it itself (one typed at prompts may too): the card opens the others.
            proc = this.o.host.start(r, words(way.run), { opens: way.flow === "browser" || (way.flow === "typed" && !this.o.host.away), onData: (text) => run === this.run_ && this.heard(e, way, text) });
        } catch (err) {
            this.set({ busy: undefined, ended: true, error: err instanceof Error ? err.message : String(err) });
            return;
        }
        this.proc = proc;
        void proc.exited.then((code) => run === this.run_ && this.exited(e, way, code));
        this.watch();
    }

    private heard(e: Entry, way: SignInWay, text: string) {
        if (this.over) return;
        const r = e.recipe!;
        if (this.screen) {
            this.screen.write(text);
            this.set({ term: this.screen.text() });
            return;
        }
        this.output += text;
        if (this.output.length > 16_000) {
            this.heardTo = Math.max(0, this.heardTo - (this.output.length - 16_000));
            this.output = this.output.slice(-16_000);
        }
        const out = plain(this.output);
        for (const a of r.answers ?? []) {
            if (this.answered.has(a.when) || !first(a.when, out)) continue;
            this.answered.add(a.when);
            this.proc?.write(a.send);
        }
        // After a pasted code, a command that says something and carries on (it wants another) isn't going to exit: what it said goes under the field.
        if (way.flow === "paste" && this.view.step === "paste" && this.view.busy && this.sent.length) {
            if (this.complaint) clearTimeout(this.complaint);
            this.complaint = setTimeout(() => {
                this.complaint = undefined;
                if (this.over || !this.proc || this.view.step !== "paste" || !this.view.busy) return;
                const why = said(this.output.slice(this.heardTo), this.sent, [this.view.url], r.reads?.prompt);
                if (why) this.set({ busy: undefined, error: why });
            }, 1200);
        }
        const url = last(r.reads?.url ?? "(https://\\S+)", out)?.replace(/[)\].,'"]+$/, "");
        const patch: Partial<SignInView> = {};
        if (url && url !== this.view.url) Object.assign(patch, { url, site: siteOf(url) });
        if (way.flow === "device") {
            const code = first(r.reads?.code, out);
            if (code && (code !== this.view.code || this.view.step !== "code")) Object.assign(patch, { step: "code", code, busy: undefined, expired: undefined });
        } else if (way.flow === "paste") {
            if (this.view.step !== "paste" && (url ?? this.view.url) && (!r.reads?.prompt || first(r.reads.prompt, out))) Object.assign(patch, { step: "paste", busy: undefined });
        } else if (url && this.view.busy) {
            // The browser is on another machine: nothing opened the page, so the card offers to.
            Object.assign(patch, { busy: undefined, open: way.flow === "callback" || this.o.host.away ? true : undefined });
        }
        if (Object.keys(patch).length) {
            // Everything up to here is what the card now shows.
            if (patch.step || patch.url || patch.code) this.heardTo = this.output.length;
            this.set(patch);
        }
    }

    private async exited(e: Entry, way: SignInWay, code: number) {
        this.proc = undefined;
        this.forwarded?.close();
        this.forwarded = undefined;
        if (this.over) return;
        const r = e.recipe!;
        // Without a status command, the sign-in's own exit is all there is to go by.
        const ok = r.status.run ? await this.refresh(e) : code === 0;
        if (this.over || this.current !== e) return;
        if (ok) {
            e.state = "in";
            return void this.signedIn(e);
        }
        const out = plain(this.output);
        const expired = way.flow === "device" && this.view.step === "code" && (Boolean(first(r.reads?.expired, out.slice(out.indexOf(this.view.code ?? "") + 1))) || this.now() - this.startedAt > CODE_LIFE_MS);
        if (this.complaint) clearTimeout(this.complaint);
        if (expired) this.set({ expired: true, busy: undefined, error: undefined });
        else {
            // What it said after what the card showed; all of it, if it said nothing more.
            const shown = [this.view.code, this.view.url];
            const why = this.screen ? said(this.screen.text(), this.sent) : said(this.output.slice(this.heardTo), this.sent, shown, r.reads?.prompt) || said(this.output, this.sent, shown, r.reads?.prompt);
            this.set({ busy: undefined, ended: true, error: why || "The sign-in ended without signing in." });
        }
    }

    private async token(e: Entry, value: string) {
        const r = e.recipe;
        if (!r?.token || this.view.busy) return;
        this.set({ busy: true, error: undefined });
        const res = await this.o.host.run(r, words(r.token.run), { stdin: `${value}\n`, timeoutMs: 60_000 }).catch((err) => ({ code: 1, out: err instanceof Error ? err.message : String(err), missing: false }));
        if (this.over || this.current !== e || this.view.step !== "token") return;
        const ok = r.status.run ? await this.refresh(e) : res.code === 0;
        if (this.over || this.current !== e) return;
        if (ok) {
            e.state = "in";
            return void this.signedIn(e);
        }
        // Its first line: what follows is its advice to sign in some other way.
        this.set({ busy: undefined, error: (said(res.out, [value]) || "That token didn't sign in.").split("\n")[0] });
    }

    /** One being wrapped up: a status check that lands meanwhile doesn't wrap it up again. */
    private finishing: Entry | undefined;

    private async signedIn(e: Entry) {
        if (this.finishing === e) return;
        this.finishing = e;
        this.stopCommand();
        try {
            if (e.recipe?.then) await this.o.host.run(e.recipe, words(e.recipe.then), { timeoutMs: 30_000 }).catch(() => undefined);
            if (e.recipe) await this.o.host.signedIn?.(e.recipe).catch(() => undefined);
        } finally {
            this.finishing = undefined;
        }
        this.next();
    }

    /** One is settled: back to the list while others wait, or the end. */
    private next() {
        if (this.over) return;
        this.stopCommand();
        if (this.entries.length > 1 && this.entries.some((e) => e.state === "out")) this.list();
        else this.end(this.entries.some((e) => e.state === "out") ? "later" : "done");
    }

    /**
     * Looks again every so often while the card is up: signing in some other way (a terminal of the user's own)
     * closes the card like signing in through it.
     */
    private watch() {
        if (this.timer) clearTimeout(this.timer);
        if (this.over) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.look();
        }, this.pollMs);
        (this.timer as { unref?: () => void }).unref?.();
    }

    private async look() {
        if (this.over || this.checking) return;
        const run = this.run_;
        const watched = this.current ? [this.current] : this.entries.filter((e) => e.state === "out");
        this.checking = Promise.all(watched.map((e) => this.refresh(e))).then((l) => l.some(Boolean));
        const changed = await this.checking.catch(() => false);
        this.checking = undefined;
        if (this.over) return;
        if (changed && this.current && watched[0] === this.current && run === this.run_ && this.current.state === "in") return void this.signedIn(this.current);
        if (changed && !this.current) {
            if (this.entries.some((e) => e.state === "out")) this.set({ rows: this.rows() });
            else return this.end("done");
        }
        this.watch();
    }

    private ported: ((error?: string) => void) | undefined;

    /** Asks the window to bring the port over, and waits for its word. The window lets go of it when the card stops asking. */
    private byWindow(port: number): Promise<{ close(): void }> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.ported?.("No window answered to bring the sign-in's port over."), 30_000);
            this.ported = (error) => {
                clearTimeout(timer);
                this.ported = undefined;
                if (error) reject(new Error(error));
                else resolve({ close: () => this.set({ forward: undefined }) });
            };
            this.set({ forward: port });
        });
    }

    private stopCommand() {
        this.run_++;
        this.ported?.("Stopped.");
        if (this.complaint) clearTimeout(this.complaint);
        this.complaint = undefined;
        this.proc?.kill();
        this.proc = undefined;
        this.forwarded?.close();
        this.forwarded = undefined;
        this.screen = undefined;
    }

    private end(end: SignInOutcome["end"]) {
        if (this.over) return;
        this.stopCommand();
        this.over = true;
        if (this.timer) clearTimeout(this.timer);
        this.finish({ end, results: this.entries.map((e) => ({ target: e.target, name: e.name, state: e.state, ...(e.who ? { who: e.who } : {}), ...(e.recipe?.status.run ? { watched: true } : {}) })) });
    }
}

/** What the model is told: who is signed in, and what isn't. Nothing else of the sign-in reaches it. */
export function signInReport(o: SignInOutcome, where: string | undefined, tool: string): { text: string; isError?: boolean; summary: string } {
    const on = where ? ` on ${where}` : "";
    const lines = o.results.map((r) => {
        switch (r.state) {
            case "in":
                return `Signed in to ${r.name}${on}${r.who ? ` as ${r.who}` : ""}.`;
            case "unverified":
                return `The user says they signed in to ${r.name}${on}. Cavvy couldn't check: try what needed it.`;
            case "none":
                return `${r.name} isn't installed${on}: its command wasn't found. Install it first, then ask again.`;
            case "unknown":
                return `Cavvy has no sign-in for "${r.target}". Call ${tool} again with \`command\` set to its sign-in command: the user is shown it and runs it themselves.`;
            default:
                return o.end === "stopped" ? `Not signed in to ${r.name}${on}: the request was interrupted.` : `Not signed in to ${r.name}${on}: the user chose Later. Carry on with what doesn't need it and say what's left${r.watched ? "; Cavvy tells you when they sign in" : ""}. Don't ask again unless they bring it up.`;
        }
    });
    const left = o.results.filter((r) => r.state !== "in" && r.state !== "unverified");
    const summary = !left.length ? (o.results.length === 1 && o.results[0]!.who ? `Signed in as ${o.results[0]!.who}` : "Signed in") : o.results.some((r) => r.state === "none" || r.state === "unknown") && left.length === o.results.length ? "Can't sign in" : "Not signed in";
    return { text: lines.join("\n"), isError: left.some((r) => r.state === "unknown" || r.state === "none") && left.length === o.results.length ? true : undefined, summary };
}
