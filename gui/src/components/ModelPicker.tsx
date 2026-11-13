import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Layers, Plus, RefreshCw, Search, Settings2, Star, Zap } from "lucide-solid";
import { planLimitKey, type AccountInfo, type EffortLevel, type ModelSummary } from "@shared/protocol";
import { app, handleFor, refreshModels, toast } from "../state/app";
import { setEffort, setModel, setFastMode, setAccount } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { comparePicks, setAddAccountFor, setComparePicks, setSettingsTab } from "../state/ui";
import { isMod, mod } from "../lib/platform";
import { menuIndex, menuTypeahead } from "../lib/menu";
import { Menu } from "./ui/Menu";
import { Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";
import { withShortcut } from "../state/keybindings";
import { effortAt, effortKey, effortLevels, effortOf, takesEffort, type Effort } from "../lib/effort";
import { sendsAccountPick } from "../lib/account-pick";
import { meterOf } from "../lib/limits";
import { now } from "../lib/clock";
import { nearLimit } from "./ComposerMeter";

function fuzzy(q: string, s: string): boolean {
    q = q.toLowerCase();
    s = s.toLowerCase();
    if (s.includes(q)) return true;
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    return i === q.length;
}

export function shortModel(m?: ModelSummary | { name?: string; id: string }): string {
    if (!m) return "No model";
    return (m.name ?? m.id).replace(/^claude-/i, "Claude ");
}

/** What a parenthesis holds when it's an id ("claude-opus-5-5", "openai/gpt-6"), not words ("recommended"). */
const ID_LIKE = /^[\w.:/@-]*[\d/-][\w.:/@-]*$/;

/**
 * A model's name as the picker shows it, without ids. Claude Code names an alias with what it resolves
 * to, "Opus 5.5 (claude-opus-5-5)": that's "Opus 5.5". A model with no name goes by its id. Search
 * still matches the full name and the id.
 */
export function modelName(m: { name?: string; id: string }): string {
    const full = m.name || m.id;
    const paren = full.match(/^(.*\S)\s+\(([^()\s]+)\)$/);
    return paren && ID_LIKE.test(paren[2]!) ? paren[1]! : full;
}

/** The model a session (or the next one) uses: what the server says, else the listed model with that ref. */
function resolve(current: ModelSummary | undefined, ref: string | undefined): ModelSummary | undefined {
    return current ?? app.models.flatMap((g) => g.models).find((m) => m.ref === ref);
}

const FAVORITES = "favorites";

/** Design options to compare, from ?picker= (main.tsx): list, columns, inline, steps; none is the picker as it is. Temporary. */
type Variant = "" | "list" | "columns" | "inline" | "steps";
const variant = (): Variant => (typeof document === "undefined" ? "" : ((document.documentElement.dataset.picker ?? "") as Variant));
/** Every provider's models under its name, not one provider's behind a filter. */
const grouped = () => ["list", "inline", "steps"].includes(variant());
/** Opens on the effort, with the models a step away. */
const twoStep = () => variant() === "" || variant() === "steps";
/** A level's word on a segment: as on the button, short enough for five in a row. */
const segWord = (l: Effort) => (l.id === "xhigh" ? "XHigh" : l.label);

type Row = { m: ModelSummary; i: number; line: string };
/** A run of rows under one heading: the provider's (or Favorites) in a list, each provider's in search results. */
type Section = { key: string; name: string; provider?: string; rows: Row[] };

/** The CLIs report plans in lower case ("max", "plus"). */
const planLabel = (plan?: string) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined);
/** An account's tooltip: who it is, its plan, and what's wrong with it, if anything. */
const accountDetail = (a: Partial<AccountInfo>) => [a.email, planLabel(a.plan), a.invalid ? "Unavailable" : a.signedIn === false ? "Not signed in" : undefined].filter(Boolean).join(" · ");

/** The line under a model's name: whose it is, in Favorites, where models of every provider are listed together. */
function modelLine(m: ModelSummary, opts: { provider?: string }): string {
    return opts.provider ?? "";
}

/** A menu from a button in the composer: just above it in a session, below it on Home, where the composer sits higher. */
export interface ComposerMenu {
    open: boolean;
    setOpen: (v: boolean) => void;
    placement?: "top" | "bottom";
}

/** Home only: picking several models for one prompt, or why that isn't possible here. */
export interface CompareOption {
    available: boolean;
    why?: string;
}

const MAX_COMPARE = 4;
const COMPARE_ON = "Each model gets a new worktree. Uncommitted changes aren't carried over.";
const COMPARE_OFF = "Send one prompt to 2–4 models, each in a worktree of its own";

const FAST_TIP = "Faster replies from the same model, at higher usage or cost.";
const FAST_BUSY = "Change speed after this response finishes";

/**
 * The model, and how hard it thinks, in one control: "Opus 5.5 xhigh". Its popover opens on what's changed most:
 * the effort, as a slider, under the model's name (with fast mode's bolt beside it, where the model has it). The
 * name opens the models in the popover's place: search, one provider's list or the favourites, a subscription's
 * account. A model with neither effort nor fast mode opens straight on the models. `effort`, `fast`: the session's,
 * or the next one's. `busy`: a reply is under way, when speed can't change.
 */
export function ModelPicker(p: ComposerMenu & { current?: ModelSummary; currentRef?: string; compare?: CompareOption; effort?: EffortLevel; fast?: boolean; busy?: boolean }) {
    let anchor: HTMLButtonElement | undefined;
    let sliderEl: HTMLDivElement | undefined;
    let modelRow: HTMLButtonElement | undefined;
    /** What the popover shows: the effort of the model in use, or the models. */
    const [view, setView] = createSignal<"effort" | "models">("models");
    let input: HTMLInputElement | undefined;
    let list: HTMLDivElement | undefined;
    let filtersEl: HTMLDivElement | undefined;
    let acctEl: HTMLElement | undefined;
    const listId = createUniqueId();
    const typeahead = menuTypeahead();
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const [filter, setFilter] = createSignal<string>(FAVORITES);
    /** The provider filters' fades: "more-l", "more-r", where more pills are scrolled out of sight. */
    const [edges, setEdges] = createSignal("");
    /** The heading's list of accounts is open. */
    const [acctOpen, setAcctOpen] = createSignal(false);
    const currentRef = () => p.current?.ref ?? p.currentRef;
    const isCurrent = (ref: string) => ref === currentRef();
    const currentModel = createMemo(() => resolve(p.current, currentRef()));
    const currentProvider = () => currentModel()?.provider ?? currentRef()?.split(":")[0];

    const accountInfo = (provider = currentProvider()) => app.providers.find((p) => p.id === provider)?.agentCli;
    const selectedAccount = (provider = currentProvider()) => app.activeId ? handleFor(app.activeId)?.view.state.accounts?.[provider ?? ""] ?? "default" : accountInfo(provider)?.defaultAccount ?? "default";
    const accountChoices = (provider = currentProvider()) => accountInfo(provider)?.accounts ?? [{ id: "default", name: "Default" }];
    const missingAccount = (provider = currentProvider()) => !accountChoices(provider).some((a) => a.id === selectedAccount(provider));
    const showAccounts = (provider = currentProvider()) => !!accountInfo(provider) && (accountChoices(provider).length > 1 || missingAccount(provider));
    const accountName = (provider = currentProvider()) => accountChoices(provider).find((a) => a.id === selectedAccount(provider))?.name ?? "Removed account";

    // ---- Effort and speed, of the model in use ----
    const reasoning = () => takesEffort(currentModel());
    const fastOk = () => Boolean(currentModel()?.supportsFastMode);
    const fastOn = () => fastOk() && Boolean(p.fast);
    const levels = () => effortLevels(currentModel());
    // Shown at once while the server takes it, so stepping through the levels doesn't lag behind the keys.
    const [effort, setShownEffort] = createSignal(p.effort);
    createEffect(on(() => p.effort, (e) => setShownEffort(() => e)));
    let effortPicks = 0;
    const pickEffort = (id: EffortLevel) => {
        if (id === effort()) return;
        setShownEffort(() => id);
        const n = ++effortPicks;
        // Refused (disconnected, say): back to the level in force, so picking it again sends again.
        void setEffort(id).then((ok) => {
            if (!ok && n === effortPicks) setShownEffort(() => p.effort);
        });
    };
    /** There's something to set besides the model itself: the popover opens on that. */
    const hasEffortView = () => (reasoning() || fastOk()) && !multi() && twoStep();
    /** To the models, in the popover's place; `seed`: what was typed to get there, into the search. */
    const toModels = (seed = "") => {
        setView("models");
        setQ(seed);
        setSel(seed ? 0 : Math.max(0, rows().findIndex((r) => r.m.ref === currentRef())));
        requestAnimationFrame(() => {
            input?.focus();
            list?.querySelector(".mr.sel")?.scrollIntoView({ block: "nearest" });
            measureFilters();
        });
    };
    const toEffort = () => {
        setView("effort");
        requestAnimationFrame(() => (sliderEl?.isConnected ? sliderEl : modelRow)?.focus());
    };
    /** The level on the chip, as it's named everywhere it's set: "xhigh". None chosen: the provider's own, unsaid. */
    const effortWord = () => (reasoning() ? effortOf(effort())?.id : undefined);

    // Providers with something to pick, or an error worth seeing.
    const groups = createMemo(() =>
        app.models
            .map((g) => ({ ...g, models: g.models.filter((m) => !m.deprecated || m.ref === currentRef()) }))
            .filter((g) => g.models.length || g.status === "error"),
    );
    const providerName = (id: string) => app.models.find((g) => g.provider === id)?.providerName ?? id;
    /** The model and whose it is: Claude Code's Opus and the Anthropic API's both read "Opus 5.5" on the chip. */
    const chipName = () => {
        const name = currentModel()?.name ?? currentRef() ?? "Model";
        const provider = currentProvider();
        return provider ? `${name} · ${providerName(provider)}` : name;
    };
    /** On the chip, the name alone: what an alias resolves to, "(claude-opus-5-5)", is in the list and the tooltip. */
    const chipModel = () => {
        const m = currentModel();
        if (m) return modelName(m).replace(/^claude[- ]/i, "");
        return currentRef() ? currentRef()!.split(":").slice(1).join(":") : "No model";
    };
    const favorites = createMemo(() => {
        const all = new Map(groups().flatMap((g) => g.models.map((m) => [m.ref, m] as const)));
        return prefs.favoriteModels.map((ref) => all.get(ref)).filter((m): m is ModelSummary => Boolean(m));
    });
    // The panel's height (px at text size 14): the search box, filters and foot, and the longest of the lists a tab
    // shows (Favorites or one provider's), so it keeps one height from tab to tab and a short list isn't left in a
    // tall panel. At most seven and a half rows, so a cut-off row says there's more: a longer list scrolls, and the
    // search finds the rest.
    const fit = createMemo(() => Math.max(200, Math.min(104 + (p.compare ? 40 : 0) + 7.5 * 35, 104 + (p.compare ? 40 : 0) + Math.max(1, favorites().length, ...groups().map((g) => g.models.length)) * 35)));
    const group = () => groups().find((g) => g.provider === filter());
    /** One provider's models, or the favorites; searching looks through every provider's, under its name. */
    const sections = createMemo((): Section[] => {
        let i = 0;
        const row = (m: ModelSummary, mixed = false): Row => ({ m, i: i++, line: modelLine(m, { provider: mixed ? providerName(m.provider) : undefined }) });
        if (q()) {
            return groups()
                .map((g) => ({ g, models: g.models.filter((m) => fuzzy(q(), `${g.providerName} ${m.name} ${m.id}`)) }))
                .filter((x) => x.models.length)
                .map(({ g, models }) => ({ key: g.provider, name: g.providerName, provider: g.provider, rows: models.map((m) => row(m)) }));
        }
        if (grouped()) {
            const out: Section[] = [];
            if (favorites().length) out.push({ key: FAVORITES, name: "Favorites", rows: favorites().map((m) => row(m, true)) });
            for (const g of groups()) out.push({ key: g.provider, name: g.providerName, provider: g.provider, rows: g.models.map((m) => row(m)) });
            return out;
        }
        if (filter() === FAVORITES) return [{ key: FAVORITES, name: "Favorites", rows: favorites().map((m) => row(m, true)) }];
        return [{ key: filter(), name: group()?.providerName ?? providerName(filter()), provider: filter(), rows: (group()?.models ?? []).map((m) => row(m)) }];
    });
    const rows = createMemo(() => sections().flatMap((s) => s.rows));
    const label = () => (q() ? "Results" : (sections()[0]?.name ?? ""));
    const isFav = (ref: string) => prefs.favoriteModels.includes(ref);
    const toggleFav = (ref: string) => setPrefs("favoriteModels", (list) => (list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref]));
    // Several models: rows toggle, and the default model stays as it is.
    const multi = () => Boolean(p.compare?.available && comparePicks());
    const picks = () => comparePicks() ?? [];
    const picked = (ref: string) => multi() && picks().includes(ref);
    const togglePick = (ref: string) => {
        if (picks().includes(ref)) return setComparePicks(picks().filter((r) => r !== ref));
        if (picks().length >= MAX_COMPARE) return toast(`Up to ${MAX_COMPARE} models at once`, "warn");
        setComparePicks([...picks(), ref]);
    };
    const toggleCompare = () => setComparePicks(multi() ? undefined : currentRef() ? [currentRef()!] : []);

    // The provider whose heading has its accounts: a CLI provider, in its own list.
    const acctProvider = () => (!q() && filter() !== FAVORITES && accountInfo(filter()) && accountInfo(filter())!.multiAccount !== false ? filter() : undefined);
    /** A plan nearing or at its limit: its fullest window's percentage, from 80%; 100 once reached. */
    const accountLimit = (provider: string, id: string) => {
        const l = app.limits[planLimitKey(provider, id)];
        return nearLimit(meterOf(l, now()), l, now());
    };
    const accountTip = (provider: string, a: Partial<AccountInfo> & { id: string }) => {
        const m = meterOf(app.limits[planLimitKey(provider, a.id)], now());
        const limits = m?.reached ? `Limit reached${m.resets ? `, resets ${m.resets}` : ""}` : m?.windows.filter((w) => w.pct !== undefined).map((w) => `${w.label} ${w.pct}%`).join(", ");
        return [accountDetail(a), limits].filter(Boolean).join(". ") || undefined;
    };
    const pickAccount = (provider: string, a: { id: string }) => {
        const needed = Boolean(app.activeId && handleFor(app.activeId)?.view.state.accountNeeded === provider);
        if (sendsAccountPick(a.id, selectedAccount(provider), { missing: missingAccount(provider), needed })) void setAccount(provider, a.id);
    };
    const addAccount = (provider: string) => {
        p.setOpen(false);
        setAddAccountFor(provider);
        setSettingsTab("providers");
    };

    const measureFilters = () => {
        const f = filtersEl;
        if (!f) return;
        setEdges(`${f.scrollLeft > 2 ? "more-l" : ""} ${f.scrollLeft + f.clientWidth < f.scrollWidth - 2 ? "more-r" : ""}`);
    };
    /** Opens or closes the heading's list of accounts; from the keyboard, focus goes into it (to the session's one) or back to its button. */
    const openAccounts = (open: boolean, focus: boolean) => {
        setAcctOpen(open);
        if (!focus) return;
        const to = open ? (acctEl?.querySelector(".mp-acct-it.on") ?? acctEl?.querySelector(".mp-acct-it")) : acctEl?.querySelector(".mp-acct-btn");
        (to as HTMLElement | null | undefined)?.focus();
    };
    /** The chosen filter, scrolled into the row's view. */
    const revealFilter = () =>
        requestAnimationFrame(() => {
            filtersEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
            measureFilters();
        });

    createEffect(
        on(
            () => p.open,
            (open) => {
                setAcctOpen(false);
                if (!open) return;
                setView(hasEffortView() ? "effort" : "models");
                setQ("");
                // Start where the current model lives.
                const provider = currentProvider();
                setFilter(provider && groups().some((g) => g.provider === provider) ? provider : favorites().length || !groups().length ? FAVORITES : groups()[0]!.provider);
                setSel(Math.max(0, rows().findIndex((r) => r.m.ref === currentRef())));
                if (!app.models.length) void refreshModels();
                requestAnimationFrame(() => {
                    if (!p.open) return;
                    list?.querySelector(".mr.sel")?.scrollIntoView({ block: "nearest" });
                    filtersEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
                    measureFilters();
                });
            },
        ),
    );
    // A new list starts at its top. Set here, not in an effect on q and the filter: opening the picker moves
    // the filter to the current model's provider, and that must not undo its highlight on the current model.
    const show = (provider: string) => {
        setQ("");
        setFilter(provider);
        setSel(0);
        revealFilter();
    };
    const filterIds = () => [FAVORITES, ...groups().map((g) => g.provider)];
    // Another list's heading starts with its accounts closed.
    createEffect(on(acctProvider, () => setAcctOpen(false), { defer: true }));

    const choose = (m: ModelSummary) => {
        if (multi()) return togglePick(m.ref);
        p.setOpen(false);
        void setModel(m.ref);
    };
    const onKey = (e: KeyboardEvent) => {
        if (isMod(e) && /^[1-9]$/.test(e.key)) {
            const r = rows()[Number(e.key) - 1];
            e.preventDefault();
            if (r) choose(r.m);
            return;
        }
        const target = e.target as HTMLElement;
        if (view() === "effort") {
            // The slider: ← → step and pick, Home and End jump, 1–n pick one; Enter is done. (The panel takes the keys
            // before the slider sees them, as it keeps focus inside: it moves it here.)
            if (target === sliderEl) {
                if (e.key === "Enter") return void (e.preventDefault(), p.setOpen(false));
                const i = effortKey(e, levels().findIndex((l) => l.id === effort()), levels().length);
                if (i !== undefined) return void (e.preventDefault(), pickEffort(levels()[i]!.id));
            }
            // ↑ ↓ between the model's row and the slider; → on the row, or typing anywhere, goes to the models.
            if (e.key === "ArrowUp" || e.key === "ArrowDown") return void (e.preventDefault(), (target === sliderEl ? modelRow : sliderEl ?? modelRow)?.focus());
            if (e.key === "ArrowRight" && target === modelRow) return void (e.preventDefault(), toModels());
            if (e.key.length === 1 && e.key !== " " && !/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) return void (e.preventDefault(), toModels(e.key));
            return;
        }
        const tab = target.closest<HTMLElement>('[role="tab"]');
        if (tab && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            const tabs = [...tab.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const key = e.key === "ArrowLeft" ? "ArrowUp" : e.key === "ArrowRight" ? "ArrowDown" : e.key;
            const next = tabs[menuIndex(tabs.length, tabs.indexOf(tab as HTMLButtonElement), key)];
            next?.focus();
            next?.click();
            return;
        }
        // The accounts list: ↑ and ↓ move through it, and open it from its button.
        const moves = ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key);
        if (moves && target.closest(".mp-acct-menu")) {
            e.preventDefault();
            const items = [...(acctEl?.querySelectorAll<HTMLElement>(".mp-acct-it") ?? [])];
            items[menuIndex(items.length, items.indexOf(target), e.key)]?.focus();
            return;
        }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && target.closest(".mp-acct-btn")) {
            e.preventDefault();
            openAccounts(true, true);
            return;
        }
        // ← and → in an empty search box move through the provider filters.
        if (target === input && !q() && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            const ids = filterIds();
            show(ids[menuIndex(ids.length, ids.indexOf(filter()), e.key === "ArrowLeft" ? "ArrowUp" : "ArrowDown")] ?? FAVORITES);
            return;
        }
        if (target !== input && !target.closest(".mp-list")) return;
        const picks = () => [...(list?.querySelectorAll<HTMLButtonElement>(".mr-pick") ?? [])];
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            const next = menuIndex(rows().length, sel(), e.key);
            if (next < 0) return;
            setSel(next);
            if (target !== input) picks()[next]?.focus();
            list?.querySelector(".mr.sel")?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && target === input) {
            e.preventDefault();
            const r = rows()[sel()];
            if (r) choose(r.m);
        } else if (target !== input && e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            const next = typeahead(rows().map((r) => r.m.name), sel(), e.key);
            if (next >= 0) {
                setSel(next);
                picks()[next]?.focus();
            }
        }
    };
    /** What the list says when it has nothing to show, and the one thing to do about it. */
    const empty = (): { text: string; icon?: "loading" | "error" | "star" | "search"; action?: { label: string; run: () => void } } => {
        const providers = { label: "Set up providers", run: () => (p.setOpen(false), setSettingsTab("providers")) };
        if (app.modelsLoading && !app.models.length) return { text: "Loading models…", icon: "loading" };
        if (q()) return { text: `No models match “${q()}”.`, icon: "search" };
        if (!groups().length) return { text: "No providers yet.", action: providers };
        if (filter() === FAVORITES) return { text: "Star a model to keep it here.", icon: "star" };
        if (group()?.status === "error") return { text: group()?.error ?? "Couldn't list this provider's models.", icon: "error", action: { label: "Try again", run: () => void refreshModels(true) } };
        return { text: "No models." };
    };

    /** Options: effort as labelled segments, one per level the model takes. */
    const segments = () => (
        <div class="mpx-seg" role="radiogroup" aria-label="Effort">
            <For each={levels()}>
                {(l) => (
                    <button class={`mpx-sg ${effort() === l.id ? "on" : ""}`} role="radio" aria-checked={effort() === l.id} title={`${l.label} effort`} onClick={() => pickEffort(l.id)}>
                        {segWord(l)}
                    </button>
                )}
            </For>
        </div>
    );
    const fastPill = () => (
        <Show when={fastOk()}>
            <button class={`mpx-fast ${fastOn() ? "on" : ""}`} aria-pressed={fastOn()} disabled={p.busy} title={p.busy ? FAST_BUSY : FAST_TIP} onClick={() => void setFastMode(!p.fast)}>
                <Zap size={13} stroke-width={2} />
                Fast
            </button>
        </Show>
    );
    /** Options A and B: effort and speed along the panel's foot. */
    const effortBar = () => (
        <Show when={(reasoning() || fastOk()) && !multi()}>
            <div class="mpx-eff">
                <Show when={reasoning()}>
                    <span class="mpx-eff-l">Effort</span>
                    {segments()}
                </Show>
                {fastPill()}
            </div>
        </Show>
    );

    const rowView = (r: Row) => {
        const name = modelName(r.m);
        const i = r.i;
        const on = () => (multi() ? picked(r.m.ref) : isCurrent(r.m.ref));
        const inlineEffort = () => variant() === "inline" && !multi() && isCurrent(r.m.ref) && (reasoning() || fastOk());
        return (
            <div class={`mr ${i === sel() ? "sel" : ""} ${on() ? "on" : ""} ${inlineEffort() ? "has-eff" : ""}`} onMouseMove={() => sel() !== i && setSel(i)}>
                <button
                    class="mr-pick"
                    id={`${listId}-${i}`}
                    onFocus={() => setSel(i)}
                    role="option"
                    aria-selected={on()}
                    aria-keyshortcuts={i < 9 ? `${mod === "⌘" ? "Meta" : "Control"}+${i + 1}` : undefined}
                    title={[name, r.line].filter(Boolean).join(" · ")}
                    onClick={() => choose(r.m)}
                >
                    <span class="mr-mark" aria-hidden="true">
                        <Show
                            when={multi()}
                            fallback={
                                <Show when={isCurrent(r.m.ref)}>
                                    <Check size={14} stroke-width={2.5} />
                                </Show>
                            }
                        >
                            <span class={`mr-check ${picked(r.m.ref) ? "on" : ""}`}>
                                <Show when={picked(r.m.ref)}>
                                    <Check size={11} stroke-width={3} />
                                </Show>
                            </span>
                        </Show>
                    </span>
                    {/* One line: the name, then what it stands for (or whose it is, its window and price) dimmed, cut first. */}
                    <span class="mr-text">
                        <Show when={r.line}>
                            <span class="mr-ic" aria-hidden="true"><ProviderIcon id={r.m.provider} name={r.line} size={14} /></span>
                        </Show>
                        <span class="mr-name truncate">{name}</span>
                        <Show when={r.line}>
                            <span class="mr-sub truncate">{r.line}</span>
                        </Show>
                    </span>
                    <Show when={i < 9}>
                        <kbd aria-hidden="true">{`${mod === "⌘" ? "⌘" : "Ctrl+"}${i + 1}`}</kbd>
                    </Show>
                </button>
                <button onFocus={() => setSel(i)} class={`mr-star ${isFav(r.m.ref) ? "f" : ""}`} aria-pressed={isFav(r.m.ref)} title={isFav(r.m.ref) ? "Remove from Favorites" : "Add to Favorites"} aria-label={isFav(r.m.ref) ? `Remove ${name} from Favorites` : `Add ${name} to Favorites`} onClick={() => toggleFav(r.m.ref)}>
                    <Star size={14} />
                </button>
                {/* Option C: the model in use carries its effort under its name. */}
                <Show when={inlineEffort()}>
                    <div class="mr-eff">
                        <Show when={reasoning()}>{segments()}</Show>
                        {fastPill()}
                    </div>
                </Show>
            </div>
        );
    };

    /**
     * A subscription's account, in its heading: the session's one, opening a short list of them to switch to or add
     * one. Items, not radios: picking one switches the session's account (and restarts its CLI), so it waits for a
     * click or Enter.
     */
    const accounts = (provider: string) => {
        const label = `${providerName(provider)} account`;
        const current = () => accountChoices(provider).find((a) => a.id === selectedAccount(provider));
        const level = (pct: number, long: boolean) => <span class={`mp-acct-lv ${pct >= 100 ? "full" : ""}`}>{pct >= 100 ? (long ? "Limit reached" : "limit") : `${pct}%${long ? " used" : ""}`}</span>;
        return (
            <span class="mp-acct" ref={(el) => (acctEl = el)} onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setAcctOpen(false)}>
                <button
                    class={`mp-acct-btn ${current() ? "" : "missing"} ${acctOpen() ? "open" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={acctOpen()}
                    aria-label={`${label}: ${current()?.name ?? "removed"}`}
                    title={current() && accountTip(provider, current()!)}
                    onClick={(e) => openAccounts(!acctOpen(), e.detail === 0)}
                >
                    <span class="truncate">{current()?.name ?? "Choose account"}</span>
                    <Show when={current() && accountLimit(provider, current()!.id)}>{(l) => level(l().pct, false)}</Show>
                    <ChevronDown size={12} class="chev" />
                </button>
                <Show when={acctOpen()}>
                    <div class="mp-acct-menu" role="menu" aria-label={label}>
                        <For each={accountChoices(provider)}>
                            {(a) => {
                                const on = () => a.id === selectedAccount(provider);
                                return (
                                    <button
                                        class={`mp-acct-it ${on() ? "on" : ""}`}
                                        role="menuitemradio"
                                        aria-checked={on()}
                                        title={accountTip(provider, a)}
                                        onClick={() => {
                                            pickAccount(provider, a);
                                            openAccounts(false, true);
                                        }}
                                    >
                                        <span class="mp-acct-ck">
                                            <Show when={on()}>
                                                <Check size={13} />
                                            </Show>
                                        </span>
                                        <span class="truncate">{a.name}</span>
                                        <Show when={accountLimit(provider, a.id)}>{(l) => level(l().pct, true)}</Show>
                                    </button>
                                );
                            }}
                        </For>
                        <div class="mp-acct-sep" role="separator" />
                        <button class="mp-acct-it" role="menuitem" onClick={() => addAccount(provider)}>
                            <span class="mp-acct-ck">
                                <Plus size={13} />
                            </span>
                            <span class="truncate">Add account</span>
                        </button>
                    </div>
                </Show>
            </span>
        );
    };

    /** Searching, each provider's matches under its name: a quiet label. */
    const heading = (s: Section) => (
        <div class="mp-h">
            <span class="mp-h-ic" aria-hidden="true">
                <Show when={s.provider} fallback={<Star size={13} />}>{(id) => <ProviderIcon id={id()} name={s.name} size={14} />}</Show>
            </span>
            <span class="truncate" aria-hidden="true">{s.name}</span>
            <Show when={grouped() && !q() && s.provider && s.provider === currentProvider() && showAccounts(s.provider)}>{accounts(s.provider!)}</Show>
        </div>
    );

    return (
        <>
            {/* Keep the trigger mounted when Compare changes so Menu can restore focus. */}
            <button ref={anchor} class={`pick model ${multi() ? "on" : ""} ${p.open ? "open" : ""}`} aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title={multi() ? picks().map((r) => resolve(undefined, r)?.name ?? r).join(", ") || "Pick 2 to 4 models" : withShortcut([chipName(), showAccounts() ? accountName() : undefined, reasoning() && effortOf(effort()) ? `${effortOf(effort())!.label} effort` : undefined, fastOn() ? "fast mode" : undefined].filter(Boolean).join(" · "), "chat:modelPicker")}>
                <Show when={multi()} fallback={
                    <>
                        {/* Fast mode: its bolt first, ahead of the provider's mark and the name. */}
                        <Show when={fastOn()}>
                            <span class="fz" aria-hidden="true">
                                <Zap size={13} stroke-width={2} />
                            </span>
                        </Show>
                        <Show when={currentProvider()}>{(id) => <ProviderIcon id={id()} name={providerName(id())} size={15} />}</Show>
                        <span class="truncate">{chipModel()}</span>
                        {/* How hard it thinks, after its name, a step quieter: "Opus 5.5 xhigh". */}
                        <Show when={effortWord()}>{(w) => <span class="lbl pick-eff">{w()}<span class="sr-only"> effort</span></span>}</Show>
                        <Show when={fastOn()}>
                            <span class="sr-only">, fast mode on</span>
                        </Show>
                        {/* The icon is hidden from assistive tech, so the provider is named for it here. */}
                        <Show when={currentProvider()}>{(id) => <span class="sr-only">, {providerName(id())}</span>}</Show>
                        <Show when={showAccounts()}><span class="pick-acct truncate"> · {accountName()}</span></Show>
                    </>
                }>
                    <Layers size={15} />
                    <span class="truncate">{picks().length >= 2 ? `${picks().length} models` : "Pick 2–4 models"}</span>
                </Show>
                <ChevronDown size={13} class="chev" />
            </button>
            <Menu
                label="Choose a model"
                kind="dialog"
                initialFocus={() => {
                    if (view() === "effort") return sliderEl?.isConnected ? sliderEl : modelRow;
                    // The session's account was removed (#410): it opens on that CLI's accounts, to pick another.
                    const provider = currentProvider();
                    if (!provider || acctProvider() !== provider || !missingAccount(provider) || !acctEl) return input;
                    openAccounts(true, false);
                    return acctEl.querySelector<HTMLElement>(".mp-acct-it") ?? input;
                }}
                onKeyDown={onKey}
                // Escape closes the accounts list first, back to its button; then the models, back to the effort they were opened from.
                onEscape={() => (acctOpen() ? (openAccounts(false, true), true) : view() === "models" && hasEffortView() ? (toEffort(), true) : false)}
                open={p.open}
                anchor={() => anchor}
                onClose={() => p.setOpen(false)}
                placement={p.placement ?? "top"}
                width={view() === "effort" ? (variant() === "steps" ? 320 : 288) : variant() === "columns" ? 540 : variant() ? 360 : 340}
                maxHeight={variant() === "columns" ? 420 : 460}
                minHeight={view() === "effort" || (variant() && variant() !== "columns") ? 0 : 200}
                class={`mp ${view() === "effort" ? "mp-effort" : ""} ${variant() ? `mpx mpx-${variant()}` : ""}`}
                exit
            >
                <Show when={view() === "effort" && variant() === "steps"}>
                    {/* Option D: the model and whose it is, Change to the models; effort as labelled steps; fast mode as a switch. */}
                    <div class="mpe mpx-mpe">
                        <button ref={modelRow} class="mpx-model" aria-label={`${chipName()}. Change model`} onClick={() => toModels()}>
                            <Show when={currentProvider()}>{(id) => <ProviderIcon id={id()} name={providerName(id())} size={20} />}</Show>
                            <span class="mpx-model-t">
                                <span class="mpx-model-n truncate">{chipModel()}</span>
                                <Show when={currentProvider()}>{(id) => <span class="mpx-model-p truncate">{providerName(id())}</span>}</Show>
                            </span>
                            <span class="mpx-change">Change</span>
                            <ChevronRight size={14} class="chev" />
                        </button>
                        <Show when={reasoning()}>
                            <div class="mpx-field">
                                <span class="mpx-field-l">Effort</span>
                                {segments()}
                            </div>
                        </Show>
                        <Show when={fastOk()}>
                            <button class="mpx-fastrow" role="switch" aria-checked={fastOn()} disabled={p.busy} title={p.busy ? FAST_BUSY : FAST_TIP} onClick={() => void setFastMode(!p.fast)}>
                                <Zap size={14} stroke-width={2} />
                                <span>Fast mode</span>
                                <span class={`mp-switch ${fastOn() ? "on" : ""}`} aria-hidden="true" />
                            </button>
                        </Show>
                    </div>
                </Show>
                <Show when={view() === "effort" && variant() !== "steps"}>
                    {/* The model in use and how hard it thinks; its name opens the models. Fast mode's bolt beside it. */}
                    <div class="mpe">
                        <div class="mpe-h">
                            <Show when={fastOk()}>
                                <button class={`mpe-fast ${fastOn() ? "on" : ""}`} aria-pressed={fastOn()} aria-label="Fast mode" disabled={p.busy} title={p.busy ? FAST_BUSY : FAST_TIP} onClick={() => void setFastMode(!p.fast)}>
                                    <Zap size={15} stroke-width={2} />
                                </button>
                            </Show>
                            <button ref={modelRow} class="mpe-model" title="Change model" aria-label={`${chipName()}. Change model`} onClick={() => toModels()}>
                                <Show when={currentProvider()}>{(id) => <ProviderIcon id={id()} name={providerName(id())} size={16} />}</Show>
                                <span class="mpe-name truncate">{chipModel()}</span>
                                <Show when={reasoning()}>
                                    <span class="mpe-eff">{effortOf(effort())?.id ?? "default"}</span>
                                </Show>
                                <ChevronRight size={14} class="chev" />
                            </button>
                        </div>
                        <Show when={reasoning()}>
                            <EffortSlider ref={(el) => (sliderEl = el)} levels={levels()} value={effort()} onChange={pickEffort} />
                        </Show>
                    </div>
                </Show>
                <Show when={view() === "models"}>
                {/* A click anywhere else in the picker closes the accounts list. */}
                <div class={`mp-wrap ${variant() ? `mpx-wrap-${variant()}` : ""}`} style={{ "--mp-fit": fit() }} onPointerDown={(e) => acctOpen() && !acctEl?.contains(e.target as Node) && setAcctOpen(false)}>
                    <div class="mp-search">
                        {/* Back to the effort, where the picker opened on it. */}
                        <Show when={hasEffortView()} fallback={<Search size={14} />}>
                            <button class="hb sm mp-back" title="Back" aria-label="Back to effort" onClick={toEffort}>
                                <ChevronLeft size={15} />
                            </button>
                        </Show>
                        <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={rows()[sel()] ? `${listId}-${sel()}` : undefined} value={q()} onInput={(e) => (setQ(e.currentTarget.value), setSel(0))} placeholder="Search models…" aria-label="Search models" spellcheck={false} />
                        <button class="hb sm" title="Refresh model lists" aria-label="Refresh model lists" onClick={() => void refreshModels(true)} disabled={app.modelsLoading}>
                            <Show when={app.modelsLoading} fallback={<RefreshCw size={13} />}>
                                <Spinner size={13} />
                            </Show>
                        </button>
                        <button class="hb sm" title="Providers…" aria-label="Set up providers" onClick={() => (p.setOpen(false), setSettingsTab("providers"))}>
                            <Settings2 size={13} />
                        </button>
                    </div>
                    {/* Whose models are listed: the favourites or one provider's, as plain words (a wheel scrolls them sideways).
                        At the row's end, the listed provider's account, where it's a subscription with accounts. */}
                    <div class="mp-bar" hidden={grouped()}>
                        <div
                            class={`mp-filters ${edges()}`}
                            ref={filtersEl}
                            role="tablist"
                            aria-label="Providers"
                            onScroll={measureFilters}
                            onWheel={(e) => {
                                if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
                                e.currentTarget.scrollLeft += e.deltaY;
                                e.preventDefault();
                            }}
                        >
                            <button class={`mp-f ${filter() === FAVORITES && !q() ? "on" : ""}`} role="tab" aria-selected={filter() === FAVORITES} onClick={(e) => (show(FAVORITES), e.detail && input?.focus())}>
                                <Star size={13} />
                                Favorites
                            </button>
                            <For each={groups()}>
                                {(g) => (
                                    <button
                                        class={`mp-f ${filter() === g.provider && !q() ? "on" : ""} ${g.status === "error" ? "err" : ""}`}
                                        role="tab"
                                        aria-selected={filter() === g.provider}
                                        aria-label={g.provider === currentProvider() ? `${g.providerName}, current model` : undefined}
                                        title={g.status === "error" ? (g.error ?? "Couldn't list this provider's models") : g.status === "cached" ? "The provider didn't answer; this is the last list it gave" : undefined}
                                        onClick={(e) => (show(g.provider), e.detail && input?.focus())}
                                    >
                                        <ProviderIcon id={g.provider} name={g.providerName} size={variant() === "columns" ? 15 : 14} />
                                        <span class="truncate">{g.providerName}</span>
                                    </button>
                                )}
                            </For>
                        </div>
                        {/* Rebuilt only when the list changes, so the accounts list (and focus in it) survives an update. */}
                        <Show when={acctProvider()} keyed>
                            {(id) => accounts(id)}
                        </Show>
                    </div>
                    <Show when={acctProvider() && missingAccount(acctProvider())}>
                        <div class="mp-acct-note">
                            <CircleAlert size={13} />
                            <span>This session's account was removed. Choose another.</span>
                        </div>
                    </Show>
                    <div class="mp-list" ref={list} id={listId} role="listbox" aria-label={label()} aria-multiselectable={multi()}>
                        <Show
                            when={rows().length}
                            fallback={
                                <div class={`mp-empty ${empty().icon === "error" ? "err" : ""}`} role="status">
                                    <Show when={empty().icon}>
                                        {(icon) => (icon() === "loading" ? <Spinner size={16} /> : icon() === "error" ? <CircleAlert size={16} /> : icon() === "star" ? <Star size={16} /> : <Search size={16} />)}
                                    </Show>
                                    <span>{empty().text}</span>
                                    <Show when={empty().action}>
                                        {(a) => (
                                            <button class="btn secondary sm" onClick={() => a().run()}>
                                                {a().label}
                                            </button>
                                        )}
                                    </Show>
                                </div>
                            }
                        >
                            <Show when={q() || grouped()} fallback={<For each={rows()}>{rowView}</For>}>
                                <For each={sections()}>
                                    {(s) => (
                                        <div class="mp-group" role="group" aria-label={s.name}>
                                            {heading(s)}
                                            <For each={s.rows}>{rowView}</For>
                                        </div>
                                    )}
                                </For>
                            </Show>
                        </Show>
                    </div>
                    <Show when={variant() === "list" || variant() === "columns"}>{effortBar()}</Show>
                    <Show when={multi()}>
                        <div class="mp-cmp-note">{COMPARE_ON}</div>
                    </Show>
                    <Show when={p.compare}>
                        {(c) => (
                            <div class="mp-foot">
                                {/* The wrapper carries the reason: a disabled button shows no tooltip of its own. */}
                                <span class="mp-cmp-wrap" title={!c().available ? c().why : multi() ? COMPARE_ON : COMPARE_OFF}>
                                    <button class={`mp-cmp ${multi() ? "on" : ""}`} role="switch" aria-checked={multi()} disabled={!c().available} onClick={toggleCompare}>
                                        Compare models
                                        <Show when={multi()}>
                                            <span class="mp-cmp-n">{picks().length} picked</span>
                                        </Show>
                                        <span class={`mp-switch ${multi() ? "on" : ""}`} aria-hidden="true" />
                                        <Show when={!c().available}>
                                            <span class="sr-only">. {c().why}</span>
                                        </Show>
                                    </button>
                                </span>
                            </div>
                        )}
                    </Show>
                </div>
                </Show>
            </Menu>
        </>
    );
}

/**
 * Effort as a slider, from Quick to Thorough: a knob that stops at a dot per
 * level the model takes, with the track behind it filled with the accent.
 * Click or drag along it, or use the arrows, Home/End and 1–n; hovering a
 * level's dot grows it, to show where a click would put the knob. It applies
 * as it moves. Settings → General uses it too (`size="sm"`).
 */
export function EffortSlider(p: { levels: Effort[]; value?: EffortLevel; onChange: (id: EffortLevel) => void; size?: "sm"; label?: string; ref?: (el: HTMLDivElement) => void }) {
    let el: HTMLDivElement | undefined;
    let thumb: HTMLSpanElement | undefined;
    const [down, setDown] = createSignal(false);
    const [hover, setHover] = createSignal(-1);
    const at = () => p.levels.findIndex((e) => e.id === p.value);
    // Where a stop is along the track, 0 to 1.
    const place = (i: number) => (p.levels.length > 1 ? Math.max(i, 0) / (p.levels.length - 1) : 0);
    const go = (i: number) => {
        const l = p.levels[i];
        if (l && l.id !== p.value) p.onChange(l.id);
    };
    const under = (e: PointerEvent) => {
        const r = el!.getBoundingClientRect();
        // The knob's middle travels from half its width (and the track's padding) in from either end.
        const t = thumb?.getBoundingClientRect?.();
        const inset = t ? t.width / 2 + (t.top - r.top) : 0;
        return effortAt(e.clientX, r.left, r.width, p.levels.length, inset);
    };
    const up = () => setDown(false);
    return (
        <div
            ref={(e) => {
                el = e;
                p.ref?.(e);
            }}
            class={`es ${p.size ?? ""} ${at() < 0 ? "unset" : ""} ${down() ? "drag" : ""}`}
            style={{ "--p": String(place(at())) }}
            role="slider"
            tabIndex={0}
            aria-label={p.label ?? "Reasoning effort"}
            aria-valuemin={1}
            aria-valuemax={p.levels.length}
            aria-valuenow={at() >= 0 ? at() + 1 : undefined}
            aria-valuetext={p.levels[at()]?.label ?? "Default"}
            onPointerDown={(e) => {
                // Only the primary button picks; a right- or middle-click leaves the level alone.
                if (e.button !== 0) return;
                e.preventDefault();
                // Focused by the pointer: no focus ring, as a click would leave.
                el!.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
                try {
                    el!.setPointerCapture(e.pointerId);
                } catch {
                    // Synthetic events have no pointer to capture.
                }
                setDown(true);
                go(under(e));
            }}
            onPointerMove={(e) => (down() ? go(under(e)) : setHover(under(e)))}
            onPointerLeave={() => setHover(-1)}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={(e) => {
                const i = effortKey(e, at(), p.levels.length);
                if (i === undefined) return;
                e.preventDefault();
                e.stopPropagation();
                go(i);
            }}
        >
            <span class="es-fill" aria-hidden="true" />
            {/* The dots span the knob's travel, so each sits where the knob's middle stops. */}
            <span class="es-stops" aria-hidden="true">
                <For each={p.levels}>{(l, i) => <i class={`${i() <= at() ? "on" : ""} ${i() === hover() && i() !== at() && !down() ? "hov" : ""}`} title={l.label} />}</For>
            </span>
            <span ref={thumb} class="es-thumb" aria-hidden="true" />
        </div>
    );
}
