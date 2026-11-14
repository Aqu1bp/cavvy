// A session's sign-ins: the ones a card is up for, and the ones the user put
// off. A request waits for the user as a question does; "Later" leaves it
// reachable (it's listed with what the session watches) and, when the user
// does sign in, the session is woken, as a watched pull request wakes it.
// A request that came through a tool call with a time limit answers "still
// waiting" before the limit and leaves its card up.

import type { SignInAction } from "../server/protocol";
import type { Watcher } from "../tools/types";
import { SignInFlow, signInReport, signInStatus, type SignInHost, type SignInOutcome, type SignInView, type SignInWant } from "./sign-in";
import { findRecipe, type SignInRecipe } from "./sign-in-recipes";
import type { WakeQueue } from "./wakes";

export interface SignInRequest {
    /** What to sign in to. `command`: for one Cavvy has no recipe for, what the user is shown to run themselves. */
    targets: { target: string; command?: string }[];
    /** A server, by its name. Left out: the machine the session runs on. */
    machine?: string;
    /** Which of an agent CLI's accounts (Cavvy's own features only). */
    account?: string;
    /** The call may only take this long: then it answers "still waiting", and the card stays. */
    waitMs?: number;
    /** The tool the model called, for what it's told to call again. */
    tool?: string;
}

export interface SignInAnswer {
    text: string;
    isError?: boolean;
    /** A few words for the transcript. */
    summary: string;
    /** Nothing was left signed out. */
    signedIn: boolean;
}

/** Where a sign-in happens. `name`: said in the card (a server reached from here). `where`: said to the model. */
export interface SignInMachine {
    host: SignInHost;
    name?: string;
    where?: string;
}

export interface SignInCards {
    /** Puts the card up, or changes the one that's up. `kept`: it stays when the turn ends. */
    show(id: string, view: SignInView & { machine?: string }, kept: boolean): void;
    hide(id: string): void;
}

export interface SessionSignInsOptions {
    recipes(): SignInRecipe[];
    /** The machine an agent named, or this one. Throws what the agent is told when it can't be that one. */
    machine(name: string | undefined, account?: string): SignInMachine | Promise<SignInMachine>;
    cards: SignInCards;
    wakes?(): WakeQueue | undefined;
    watchers?(): Map<string, Watcher> | undefined;
    /** Keeps a sign-in Cavvy didn't know, as the user's own. */
    save?(recipe: SignInRecipe): void;
    newId(): string;
    /** Windows on this session can bring a port over for a sign-in's card (it runs on a server the user reaches from another machine). */
    windowForwards?(): boolean;
    /** How often one that was put off is looked at again, and for how long. */
    laterPollMs?: number;
    laterForMs?: number;
    /** How often after that, for as long as it's listed. */
    laterSlowPollMs?: number;
    pollMs?: number;
}

interface Active {
    flow: SignInFlow;
    stop: AbortController;
    /** It stays when the turn ends: nothing in a turn is all that waits on it. */
    kept: boolean;
    /** The one put off that this card is for. */
    later?: string;
    /** The machine, account and services it's for: a second request for the same joins this card. */
    key: string;
    /** The machine and account, and the services, apart. */
    on: string;
    targets: string[];
    run: Promise<SignInOutcome>;
    /** Calls in a turn still waiting on it. */
    holders: number;
    shown: boolean;
}

interface Later {
    id: string;
    key: string;
    on: string;
    wants: SignInWant[];
    machine: SignInMachine;
    timer?: ReturnType<typeof setTimeout>;
    /** Until then it's looked at often; after, now and then, for as long as it's listed. */
    until: number;
    /** Cavvy's own features that wait on it: each hears whether it was signed in (true) or the user dismissed it (false). */
    thens: ((signedIn: boolean) => void)[];
    /** The agent asked for it too: it's woken when it's signed in. */
    wake: boolean;
}

const SHELL = /[;&|<>`$(){}\\\n\r"']/;

/** Why a command an agent offers for an unknown sign-in can't be shown, or undefined. It must be `target`'s own command, with nothing a shell would act on. */
export function offeredCommandError(target: string, command: unknown): string | undefined {
    if (typeof command !== "string" || !command.trim()) return "command must be the sign-in command, as text.";
    const c = command.trim();
    if (c.length > 200 || SHELL.test(c) || /[\x00-\x1f\x7f]/.test(c)) return "command must be one plain command: no quotes, pipes, variables or several lines.";
    const first = c.split(/\s+/)[0]!;
    if (first.toLowerCase() !== target.trim().toLowerCase()) return `command must start with the target itself ("${target.trim()} …"): name the CLI as the target.`;
    return undefined;
}

/** What a sign-in's card asks, in a few words: for the notification, which names the machine. */
export function signInAsks(i: { name?: string; machine?: string; rows?: unknown[]; step: string }): string {
    const on = i.machine ? ` on ${i.machine}` : "";
    return i.step === "list" || !i.name ? `Sign in${on}` : `Sign in to ${i.name}${on}`;
}

const ACTIONS = ["start", "token", "back", "later", "retry", "ran", "pick", "submit", "keys", "done", "port"];

/** A step from a window, checked: only what a card can send. */
export function signInAction(r: unknown): SignInAction {
    const x = (r ?? {}) as Record<string, unknown>;
    if (typeof x.action !== "string" || !ACTIONS.includes(x.action)) throw new Error("That isn't something this card does.");
    if (x.action === "pick") {
        if (typeof x.target !== "string") throw new Error("Which one?");
        return { action: "pick", target: x.target };
    }
    if (x.action === "submit" || x.action === "keys") {
        if (typeof x.value !== "string") throw new Error("Nothing was sent.");
        return { action: x.action, value: x.value };
    }
    if (x.action === "done") return { action: "done", save: x.save === true };
    if (x.action === "port") return { action: "port", ...(typeof x.error === "string" && x.error ? { error: x.error.slice(0, 300) } : {}) };
    return { action: x.action as "start" | "token" | "back" | "later" | "retry" | "ran" };
}

const names = (l: { name: string }[]) => (l.length <= 2 ? l.map((x) => x.name).join(" and ") : `${l.slice(0, -1).map((x) => x.name).join(", ")} and ${l[l.length - 1]!.name}`);

export class SessionSignIns {
    private active = new Map<string, Active>();
    private later = new Map<string, Later>();
    private disposed = false;

    constructor(private o: SessionSignInsOptions) {}

    /** A sign-in a tool asked for: waits for the user, and answers with what the model is told. */
    async request(req: SignInRequest, signal: AbortSignal): Promise<SignInAnswer> {
        const tool = req.tool ?? "RequestSignIn";
        let machine: SignInMachine;
        try {
            machine = await this.o.machine(req.machine, req.account);
        } catch (e) {
            return { text: e instanceof Error ? e.message : String(e), isError: true, summary: "Can't sign in", signedIn: false };
        }
        if (signal.aborted) return { ...signInReport({ end: "stopped", results: [] }, machine.where, tool), text: "The request to sign in was interrupted.", signedIn: false };
        const wants = this.wants(req.targets);
        const a = this.open(req, wants, machine);
        const run = this.held(a, wants, signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = req.waitMs ? new Promise<"waiting">((r) => { timer = setTimeout(() => r("waiting"), req.waitMs); }) : undefined;
        const o = await (limit ? Promise.race([run, limit]) : run);
        if (timer) clearTimeout(timer);
        if (o === "waiting") {
            // The card stays for the user, whatever becomes of the turn; the agent hears when it's over.
            a.kept = true;
            void a.run.then((end) => this.settled(end, wants, machine, req));
            const what = names(wants.map((w) => ({ name: w.recipe?.name ?? w.target })));
            return { text: `The user hasn't signed in to ${what}${machine.where ? ` on ${machine.where}` : ""} yet; the request is still in front of them. End your turn now, saying what's waiting on it. Cavvy tells you when they've signed in: don't ask again or check in the meantime.`, summary: "Still waiting", signedIn: false };
        }
        // The agent has its answer here: whoever else waited on what's now signed in hears too, and it isn't woken for it.
        if (o.end !== "stopped") this.heard(req, o, false);
        if (o.end === "later") this.putOff(o, wants, machine, req);
        const r = signInReport(o, machine.where, tool);
        return { ...r, signedIn: o.end === "done" && o.results.every((x) => x.state === "in" || x.state === "unverified") };
    }

    /**
     * A sign-in one of Cavvy's own features needs (a push that found GitHub signed out, a turn that stopped on a
     * signed-out CLI): the card, with no tool call behind it. "signed-in": the user did, in the card. "later": they
     * put it off, and `then` hears how that ends: true once they've signed in after all, false if they dismiss it.
     * "cannot": there was nothing to show (it already says it's signed in, its CLI isn't installed, or Cavvy has
     * no sign-in for it).
     */
    async ask(req: SignInRequest, then?: (signedIn: boolean) => void): Promise<"signed-in" | "later" | "cannot"> {
        let machine: SignInMachine;
        try {
            machine = await this.o.machine(req.machine, req.account);
        } catch {
            return "cannot";
        }
        const wants = this.wants(req.targets);
        const a = this.open(req, wants, machine);
        a.kept = true;
        const o = await a.run;
        if (o.end === "later") {
            // Some of it may have been signed in before the rest was put off.
            this.heard(req, o, a.holders <= 0);
            this.putOff(o, wants, machine, req, then ?? (() => undefined));
            return "later";
        }
        if (!a.shown || o.end !== "done" || !o.results.every((r) => r.state === "in" || r.state === "unverified")) return "cannot";
        this.heard(req, o, a.holders <= 0);
        return "signed-in";
    }

    /** The user's step in a card. Throws what the card should say when it can't be taken. */
    act(id: string, a: SignInAction) {
        this.active.get(id)?.flow.act(a);
    }

    /** What "Open in terminal" types for a card that shows a command, or undefined. */
    typed(id: string): string | undefined {
        return this.active.get(id)?.flow.typed();
    }

    has(id: string): boolean {
        return this.active.has(id);
    }

    /** Whether the card stays when the turn ends (nothing in the turn is waiting on it). */
    kept(id: string): boolean {
        return this.active.get(id)?.kept ?? false;
    }

    /** The user came back to one they'd put off: its card again. */
    reopen(laterId: string): boolean {
        const l = this.later.get(laterId);
        if (!l || this.disposed) return false;
        // One card for it at a time.
        if (this.cardFor(l)) return true;
        const a = this.start(l.on, l.wants, l.machine, true);
        a.later = laterId;
        a.kept = true;
        void a.run.then((o) => {
            // A call that joined this card has its answer already: the agent isn't woken as well.
            if (o.end === "done") this.signedInLater(l, o, a.holders <= 0);
            else if (this.later.has(laterId)) this.poll(l);
        });
        return true;
    }

    /** The user dismissed one that was put off: it's no longer looked at, and what waited on it hears that. */
    drop(laterId: string) {
        const l = this.later.get(laterId);
        if (!l) return;
        this.forget(l);
        if (!this.disposed) for (const then of l.thens) then(false);
    }

    /** The session is closing: every card and everything put off goes. */
    dispose() {
        this.disposed = true;
        for (const a of [...this.active.values()]) a.stop.abort();
        for (const l of this.later.values()) if (l.timer) clearTimeout(l.timer);
        this.later.clear();
    }

    private forget(l: Later) {
        if (l.timer) clearTimeout(l.timer);
        this.later.delete(l.id);
        for (const a of this.active.values()) if (a.later === l.id) a.stop.abort();
        const watchers = this.o.watchers?.();
        if (watchers?.has(l.id)) watchers.delete(l.id);
    }

    private wants(targets: SignInRequest["targets"]): SignInWant[] {
        const recipes = this.o.recipes();
        const seen = new Set<string>();
        return targets.flatMap((t) => {
            const recipe = findRecipe(t.target, recipes);
            const target = recipe?.id ?? t.target.trim();
            if (seen.has(target)) return [];
            seen.add(target);
            return [{ target, recipe, command: recipe ? undefined : t.command?.trim() }];
        });
    }

    /** The machine and account a request is for, as its key says them. */
    private on(req: SignInRequest): string {
        return `${req.machine?.toLowerCase() ?? ""}${req.account ? `/${req.account}` : ""}`;
    }

    private key(on: string, wants: SignInWant[]): string {
        return `${on}:${wants.map((w) => w.target).sort().join(",")}`;
    }

    /** Whether a card is up that answers for a put-off sign-in: its own, or one on the same machine and account that asks for all of it (and maybe more). */
    private cardFor(l: Later): boolean {
        return [...this.active.values()].some((a) => a.later === l.id || (a.on === l.on && l.wants.every((w) => a.targets.includes(w.target))));
    }

    /** The card for a request: the one already up for the same sign-in, or a new one. */
    private open(req: SignInRequest, wants: SignInWant[], machine: SignInMachine): Active {
        const on = this.on(req);
        const key = this.key(on, wants);
        return [...this.active.values()].find((a) => a.key === key) ?? this.start(on, wants, machine);
    }

    private start(on: string, wants: SignInWant[], machine: SignInMachine, asked = false): Active {
        const id = this.o.newId();
        const stop = new AbortController();
        const entry: Active = { stop, kept: false, key: this.key(on, wants), on, targets: wants.map((w) => w.target), holders: 0, shown: false, flow: undefined as unknown as SignInFlow, run: undefined as unknown as Promise<SignInOutcome> };
        if (this.disposed) stop.abort();
        entry.flow = new SignInFlow({
            wants,
            host: machine.host,
            pollMs: this.o.pollMs,
            windowForwards: this.o.windowForwards?.(),
            asked,
            show: (view) => {
                entry.shown = true;
                this.o.cards.show(id, machine.name ? { ...view, machine: machine.name } : view, entry.kept);
            },
            save: this.o.save ? (w) => this.keep(w) : undefined,
        });
        this.active.set(id, entry);
        entry.run = entry.flow.run(stop.signal).finally(() => {
            this.active.delete(id);
            this.o.cards.hide(id);
        });
        return entry;
    }

    /**
     * A call in a turn waiting on a card. Interrupted, it stops waiting; the card goes with it unless another call
     * waits on it too, or it has been left for the user.
     */
    private held(a: Active, wants: SignInWant[], signal: AbortSignal): Promise<SignInOutcome> {
        a.holders++;
        return new Promise((resolve) => {
            const interrupted = () => {
                a.holders--;
                if (!a.kept && a.holders <= 0) return a.stop.abort();
                resolve({ end: "stopped", results: wants.map((w) => ({ target: w.target, name: w.recipe?.name ?? w.target, state: w.recipe || w.command ? "out" : "unknown" })) });
            };
            signal.addEventListener("abort", interrupted, { once: true });
            void a.run.then((o) => {
                signal.removeEventListener("abort", interrupted);
                resolve(o);
            });
        });
    }

    /** A command the user ran themselves, kept as a recipe: Cavvy runs it next time, in the card. It has no status command, so it's never reported as signed in, only as done. */
    private keep(w: SignInWant) {
        if (!w.command || offeredCommandError(w.target, w.command)) return;
        const id = w.target.toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(id)) return;
        this.o.save?.({ id, name: w.target, status: { run: "" }, here: { flow: "typed", run: w.command.trim().split(/\s+/).join(" ") } });
    }

    /** A card that outlived its tool call is over: the agent is told, or it's put off like any other. */
    private settled(o: SignInOutcome, wants: SignInWant[], machine: SignInMachine, req: SignInRequest) {
        if (this.disposed || o.end === "stopped") return;
        this.heard(req, o, false);
        if (o.end === "later") return this.putOff(o, wants, machine, req);
        this.wake(o, machine);
    }

    /** Put off: listed with what the session watches. `then`: a feature of Cavvy's own waits on it; without one, the agent does. */
    private putOff(o: SignInOutcome, wants: SignInWant[], machine: SignInMachine, req: SignInRequest, then?: (signedIn: boolean) => void) {
        if (this.disposed) return;
        // Only what can be checked later: one Cavvy has no status command for would never be seen to change.
        const left = wants.filter((w) => w.recipe?.status.run && o.results.some((r) => r.target === w.target && r.state === "out"));
        if (!left.length) return;
        const on = this.on(req);
        const key = this.key(on, left);
        const id = `sign-in:${key}`;
        let l = this.later.get(id);
        if (!l) {
            l = { id, key, on, wants: left, machine, until: Date.now() + (this.o.laterForMs ?? 2 * 3_600_000), thens: [], wake: false };
            this.later.set(id, l);
            const label = `Sign in to ${names(left.map((w) => ({ name: w.recipe!.name })))}${machine.name ? ` on ${machine.name}` : ""}`;
            this.o.watchers?.()?.set(id, { id, kind: "sign-in", label, stop: () => this.drop(id) });
            this.poll(l);
        }
        // One row, however many wait on it: each of them hears.
        if (then) l.thens.push(then);
        else l.wake = true;
    }

    /**
     * Looks, now and then, whether one that was put off has been signed in some other way: for as long as it's
     * listed, less often once it has been a while.
     */
    private poll(l: Later) {
        if (l.timer) clearTimeout(l.timer);
        if (this.disposed || !this.later.has(l.id)) return;
        const every = Date.now() > l.until ? (this.o.laterSlowPollMs ?? 10 * 60_000) : (this.o.laterPollMs ?? (l.machine.name || l.machine.host.away ? 120_000 : 60_000));
        // Not while a card for it is up (its own, or one asked for again): that looks for itself, and says how it ended.
        const up = () => this.cardFor(l);
        l.timer = setTimeout(async () => {
            l.timer = undefined;
            if (up()) return this.poll(l);
            const now = await Promise.all(l.wants.map(async (w) => ({ target: w.target, name: w.recipe!.name, ...(await signInStatus(l.machine.host, w.recipe!)) })));
            if (this.disposed || !this.later.has(l.id)) return;
            // A card that came up while this looked: what it finds is that card's to tell.
            if (up()) return this.poll(l);
            if (now.every((r) => r.state === "in")) this.signedInLater(l, { end: "done", results: now }, true);
            else this.poll(l);
        }, every);
        (l.timer as { unref?: () => void }).unref?.();
    }

    /** A card ended signed in: whatever was put off for the same sign-in is over too. `wake`: the agent hasn't heard yet. */
    private heard(req: SignInRequest, o: SignInOutcome, wake: boolean) {
        const on = this.on(req);
        for (const l of [...this.later.values()]) {
            if (l.on === on && l.wants.every((w) => o.results.some((r) => r.target === w.target && r.state === "in"))) this.signedInLater(l, { end: "done", results: o.results.filter((r) => l.wants.some((w) => w.target === r.target)) }, wake);
        }
    }

    private signedInLater(l: Later, o: SignInOutcome, wake: boolean) {
        if (!this.later.has(l.id)) return;
        this.forget(l);
        for (const then of l.thens) then(true);
        if (l.wake && wake) this.wake(o, l.machine);
    }

    private wake(o: SignInOutcome, machine: SignInMachine) {
        const r = signInReport(o, machine.where, "RequestSignIn");
        const done = o.results.filter((x) => x.state === "in");
        if (!done.length) return;
        this.o.wakes?.()?.push({ source: "sign-in", label: `Signed in to ${names(done)}${machine.where ? ` on ${machine.where}` : ""}`, text: `${r.text}\nThe user did this after you asked. Carry on with what was waiting on it.` });
    }
}
