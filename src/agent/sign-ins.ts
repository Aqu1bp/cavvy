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
    pollMs?: number;
}

interface Active {
    flow: SignInFlow;
    stop: AbortController;
    kept: boolean;
    /** The one put off that this card is for. */
    later?: string;
}

interface Later {
    id: string;
    wants: SignInWant[];
    machine: SignInMachine;
    request: SignInRequest;
    timer?: ReturnType<typeof setTimeout>;
    until: number;
    /** Called when it's signed in, in place of waking the agent (a feature of Cavvy's own asked). */
    then?: () => void;
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
        const id = this.o.newId();
        const run = this.start(id, wants, machine, signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = req.waitMs ? new Promise<"waiting">((r) => { timer = setTimeout(() => r("waiting"), req.waitMs); }) : undefined;
        const o = await (limit ? Promise.race([run, limit]) : run);
        if (timer) clearTimeout(timer);
        if (o === "waiting") {
            // The card stays for the user, whatever becomes of the turn; the agent hears when it's over.
            const a = this.active.get(id);
            if (a) a.kept = true;
            void run.then((end) => this.settled(end, wants, machine, req));
            const what = names(wants.map((w) => ({ name: w.recipe?.name ?? w.target })));
            return { text: `The user hasn't signed in to ${what}${machine.where ? ` on ${machine.where}` : ""} yet; the request is still in front of them. End your turn now, saying what's waiting on it. Cavvy tells you when they've signed in: don't ask again or check in the meantime.`, summary: "Still waiting", signedIn: false };
        }
        if (o.end === "later") this.putOff(o, wants, machine, req);
        const r = signInReport(o, machine.where, tool);
        return { ...r, signedIn: o.end === "done" };
    }

    /**
     * A sign-in one of Cavvy's own features needs (a push that found GitHub signed out, a turn that stopped on a
     * signed-out CLI): the card, with no tool call behind it. "signed-in": the user did, in the card. "later": they
     * put it off, and `then` runs if they sign in after all. "cannot": there was nothing to show (it already says
     * it's signed in, its CLI isn't installed, or Cavvy has no sign-in for it).
     */
    async ask(req: SignInRequest, then?: () => void): Promise<"signed-in" | "later" | "cannot"> {
        let machine: SignInMachine;
        try {
            machine = await this.o.machine(req.machine, req.account);
        } catch {
            return "cannot";
        }
        const wants = this.wants(req.targets);
        const id = this.o.newId();
        let shown = false;
        const o = await this.start(id, wants, machine, undefined, false, () => { shown = true; });
        if (o.end === "later") {
            this.putOff(o, wants, machine, req, then ?? (() => undefined));
            return "later";
        }
        return shown && o.end === "done" && o.results.every((r) => r.state === "in" || r.state === "unverified") ? "signed-in" : "cannot";
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
        if ([...this.active.values()].some((a) => a.later === laterId)) return true;
        const id = this.o.newId();
        const run = this.start(id, l.wants, l.machine, undefined, true);
        const a = this.active.get(id);
        if (a) a.later = laterId;
        void run.then((o) => {
            if (o.end === "done") this.signedInLater(l, o);
            else if (this.later.has(laterId)) this.poll(l);
        });
        return true;
    }

    /** Stops looking at one that was put off (the user dismissed it). */
    drop(laterId: string) {
        const l = this.later.get(laterId);
        if (!l) return;
        if (l.timer) clearTimeout(l.timer);
        this.later.delete(laterId);
        for (const [id, a] of this.active) if (a.later === laterId) this.stop(id);
        const watchers = this.o.watchers?.();
        if (watchers?.has(laterId)) watchers.delete(laterId);
    }

    /** The session is closing: every card and everything put off goes. */
    dispose() {
        this.disposed = true;
        for (const id of [...this.active.keys()]) this.stop(id);
        for (const l of this.later.values()) if (l.timer) clearTimeout(l.timer);
        this.later.clear();
    }

    private stop(id: string) {
        this.active.get(id)?.stop.abort();
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

    private start(id: string, wants: SignInWant[], machine: SignInMachine, signal: AbortSignal | undefined, asked = false, onShow?: () => void): Promise<SignInOutcome> {
        const stop = new AbortController();
        const entry: Active = { stop, kept: !signal, flow: undefined as unknown as SignInFlow };
        // A turn that's interrupted takes its card with it, unless the card has since been left for the user.
        const interrupted = () => { if (!entry.kept) stop.abort(); };
        signal?.addEventListener("abort", interrupted, { once: true });
        if (signal?.aborted || this.disposed) stop.abort();
        entry.flow = new SignInFlow({
            wants,
            host: machine.host,
            pollMs: this.o.pollMs,
            windowForwards: this.o.windowForwards?.(),
            asked,
            show: (view) => {
                onShow?.();
                this.o.cards.show(id, machine.name ? { ...view, machine: machine.name } : view, entry.kept);
            },
            save: this.o.save ? (w) => this.keep(w) : undefined,
        });
        this.active.set(id, entry);
        return entry.flow.run(stop.signal).finally(() => {
            signal?.removeEventListener("abort", interrupted);
            this.active.delete(id);
            this.o.cards.hide(id);
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
        if (o.end === "later") return this.putOff(o, wants, machine, req);
        this.wake(o, machine);
    }

    private putOff(o: SignInOutcome, wants: SignInWant[], machine: SignInMachine, req: SignInRequest, then?: () => void) {
        if (this.disposed) return;
        // Only what can be checked later: one Cavvy has no status command for would never be seen to change.
        const left = wants.filter((w) => w.recipe?.status.run && o.results.some((r) => r.target === w.target && r.state === "out"));
        if (!left.length) return;
        const id = `sign-in:${req.machine?.toLowerCase() ?? ""}:${left.map((w) => w.target).sort().join(",")}`;
        if (this.later.has(id)) return;
        const l: Later = { id, wants: left, machine, request: req, until: Date.now() + (this.o.laterForMs ?? 2 * 3_600_000), then };
        this.later.set(id, l);
        const label = `Sign in to ${names(left.map((w) => ({ name: w.recipe!.name })))}${machine.name ? ` on ${machine.name}` : ""}`;
        this.o.watchers?.()?.set(id, { id, kind: "sign-in", label, stop: () => this.drop(id) });
        this.poll(l);
    }

    /** Looks, now and then, whether one that was put off has been signed in some other way. */
    private poll(l: Later) {
        if (l.timer) clearTimeout(l.timer);
        if (this.disposed || !this.later.has(l.id) || Date.now() > l.until) return;
        l.timer = setTimeout(async () => {
            l.timer = undefined;
            // Not while its card is up: that looks for itself.
            if ([...this.active.values()].some((a) => a.later === l.id)) return;
            const now = await Promise.all(l.wants.map(async (w) => ({ target: w.target, name: w.recipe!.name, ...(await signInStatus(l.machine.host, w.recipe!)) })));
            if (this.disposed || !this.later.has(l.id)) return;
            if (now.every((r) => r.state === "in")) this.signedInLater(l, { end: "done", results: now });
            else this.poll(l);
        }, this.o.laterPollMs ?? (l.machine.name || l.machine.host.away ? 120_000 : 60_000));
        (l.timer as { unref?: () => void }).unref?.();
    }

    private signedInLater(l: Later, o: SignInOutcome) {
        if (!this.later.has(l.id)) return;
        const then = l.then;
        this.drop(l.id);
        if (then) then();
        else this.wake(o, l.machine);
    }

    private wake(o: SignInOutcome, machine: SignInMachine) {
        const r = signInReport(o, machine.where, "RequestSignIn");
        const done = o.results.filter((x) => x.state === "in");
        if (!done.length) return;
        this.o.wakes?.()?.push({ source: "sign-in", label: `Signed in to ${names(done)}${machine.where ? ` on ${machine.where}` : ""}`, text: `${r.text}\nThe user did this after you asked. Carry on with what was waiting on it.` });
    }
}
