import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { Check, ChevronDown, CircleAlert, Layers, Plus, RefreshCw, Search, Settings2, Star, Zap } from "lucide-solid";
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
import { tokens } from "../lib/format";
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

type Row = { m: ModelSummary; i: number; line: string };
/** A run of rows under one heading: the provider's (or Favorites) in a list, each provider's in search results. */
type Section = { key: string; name: string; provider?: string; rows: Row[] };

/** The CLIs report plans in lower case ("max", "plus"). */
const planLabel = (plan?: string) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined);
/** An account's tooltip: who it is, its plan, and what's wrong with it, if anything. */
const accountDetail = (a: Partial<AccountInfo>) => [a.email, planLabel(a.plan), a.invalid ? "Unavailable" : a.signedIn === false ? "Not signed in" : undefined].filter(Boolean).join(" · ");

/** "$3", "$0.3", "$1.25": a price per million tokens; a paid one under a cent never reads "$0". */
const perMillion = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : `$${Number(n.toFixed(2))}`);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The line under a model's name: whose it is (in Favorites), the id it stands for when its name doesn't say
 * ("default" → "claude-opus-5-5"), its context window and, billed by the token, its price per million.
 */
function modelLine(m: ModelSummary, opts: { provider?: string; priced: boolean }): string {
    const resolved = m.name?.match(/\(([^()\s]+)\)\s*$/)?.[1];
    const name = squash(modelName(m));
    const id = resolved && ID_LIKE.test(resolved) ? resolved : name.includes(squash(m.id)) ? undefined : m.id;
    // Borrowed from another provider's list (pricingEstimated): marked "~", as the CLI marks it.
    const price = opts.priced && m.pricing ? `${m.pricingEstimated ? "~" : ""}${perMillion(m.pricing.input)} / ${perMillion(m.pricing.output)} per M` : undefined;
    return [opts.provider, id, m.contextWindow ? `${tokens(m.contextWindow)} context` : undefined, price].filter(Boolean).join(" · ");
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
const COMPARE_ON = "Each model works in a new worktree from HEAD. Uncommitted changes here aren't carried over.";
const COMPARE_OFF = "Send one prompt to 2–4 models, each in a worktree of its own";

export function ModelPicker(p: ComposerMenu & { current?: ModelSummary; currentRef?: string; compare?: CompareOption }) {
    let anchor: HTMLButtonElement | undefined;
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
    const group = () => groups().find((g) => g.provider === filter());
    /** One provider's models, or the favorites; searching looks through every provider's, under its name. */
    const sections = createMemo((): Section[] => {
        let i = 0;
        const row = (m: ModelSummary, mixed = false): Row => ({ m, i: i++, line: modelLine(m, { provider: mixed ? providerName(m.provider) : undefined, priced: !accountInfo(m.provider) }) });
        if (q()) {
            return groups()
                .map((g) => ({ g, models: g.models.filter((m) => fuzzy(q(), `${g.providerName} ${m.name} ${m.id}`)) }))
                .filter((x) => x.models.length)
                .map(({ g, models }) => ({ key: g.provider, name: g.providerName, provider: g.provider, rows: models.map((m) => row(m)) }));
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
    const acctProvider = () => (!q() && filter() !== FAVORITES && accountInfo(filter()) ? filter() : undefined);
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
    /**
     * The heading's row of accounts, its session's account scrolled into view: with more than fit, it may be past
     * the end. The row is new each time it shows (the picker opens, its provider is picked, a search is cleared).
     */
    const accountsRow = (el: HTMLElement) => {
        acctEl = el;
        requestAnimationFrame(() => el.querySelector(".mp-ac.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
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
                if (!open) return;
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
        if (!groups().length) return { text: "No providers yet. Add an API key or sign in to a CLI.", action: providers };
        if (filter() === FAVORITES) return { text: "Star a model to keep it here.", icon: "star" };
        if (group()?.status === "error") return { text: group()?.error ?? "Couldn't list this provider's models.", icon: "error", action: { label: "Try again", run: () => void refreshModels(true) } };
        return { text: "No models." };
    };

    const rowView = (r: Row) => {
        const name = modelName(r.m);
        const i = r.i;
        const on = () => (multi() ? picked(r.m.ref) : isCurrent(r.m.ref));
        return (
            <div class={`mr ${i === sel() ? "sel" : ""} ${on() ? "on" : ""}`} onMouseMove={() => sel() !== i && setSel(i)}>
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
            </div>
        );
    };

    /** A subscription's accounts, in its heading: the session's one filled; one alone goes by its name. */
    const accounts = (provider: string) => (
        <span class="mp-accts" ref={accountsRow}>
            <Show
                when={accountChoices(provider).length > 1 || missingAccount(provider)}
                fallback={
                    <span class="mp-acct1 truncate" title={accountTip(provider, accountChoices(provider)[0]!)}>
                        {accountName(provider)}
                    </span>
                }
            >
                {/* Buttons, not radios: picking one switches the session's account (and restarts its CLI), so it waits for a click or Enter. */}
                <span class="mp-acs" role="group" aria-label={`${providerName(provider)} account`}>
                    <For each={accountChoices(provider)}>
                        {(a) => {
                            const lim = () => accountLimit(provider, a.id);
                            return (
                                <button class={`mp-ac ${a.id === selectedAccount(provider) ? "on" : ""} ${lim() ? (lim()!.pct >= 100 ? "full" : "hot") : ""}`} aria-pressed={a.id === selectedAccount(provider)} title={accountTip(provider, a)} onClick={() => pickAccount(provider, a)}>
                                    <span class="truncate">{a.name}</span>
                                    <Show when={lim()}>{(l) => <span class="mp-ac-lv">{l().pct >= 100 ? "limit" : `${l().pct}%`}</span>}</Show>
                                </button>
                            );
                        }}
                    </For>
                </span>
            </Show>
            <button class="mp-ac add" title={`Add a ${providerName(provider)} account`} aria-label={`Add a ${providerName(provider)} account`} onClick={() => addAccount(provider)}>
                <Plus size={12} stroke-width={2.25} />
            </button>
        </span>
    );

    /** A list's heading: the provider's mark and name, a note on its list, and its accounts. */
    const heading = (s: Section, searching: boolean) => {
        const g = () => groups().find((x) => x.provider === s.provider);
        return (
            <div class="mp-h" aria-hidden={searching ? "true" : undefined}>
                <Show when={s.provider} fallback={<Star size={13} class="mp-h-star" />}>
                    {(id) => <ProviderIcon id={id()} name={s.name} size={14} />}
                </Show>
                <b class="truncate">{s.name}</b>
                <Show when={!searching && g()?.status === "cached"}>
                    <span class="mp-note" title="The provider didn't answer; this is the last list it gave">
                        cached
                    </span>
                </Show>
                <Show when={!searching && g()?.status === "error" && g()!.models.length}>
                    <span class="mp-note tone-err truncate" title={g()!.error}>
                        {g()!.error ?? "unavailable"}
                    </span>
                </Show>
                <span class="grow" />
                <Show when={!searching && s.provider === acctProvider() && s.provider}>{(id) => accounts(id())}</Show>
            </div>
        );
    };

    return (
        <>
            {/* Keep the trigger mounted when Compare changes so Menu can restore focus. */}
            <button ref={anchor} class={`pick model ${multi() ? "on" : ""} ${p.open ? "open" : ""}`} aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title={multi() ? picks().map((r) => resolve(undefined, r)?.name ?? r).join(", ") || "Pick 2 to 4 models" : withShortcut(chipName(), "chat:modelPicker")}>
                <Show when={multi()} fallback={
                    <>
                        <Show when={currentProvider()}>{(id) => <ProviderIcon id={id()} name={providerName(id())} size={15} />}</Show>
                        <span class="truncate">{chipModel()}</span>
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
                    // The session's account was removed (#410): it opens on that CLI's accounts, to pick another.
                    const provider = currentProvider();
                    if (!provider || acctProvider() !== provider || !missingAccount(provider)) return input;
                    return acctEl?.querySelector<HTMLElement>(".mp-ac:not(.add)") ?? input;
                }}
                onKeyDown={onKey}
                open={p.open}
                anchor={() => anchor}
                onClose={() => p.setOpen(false)}
                placement={p.placement ?? "top"}
                width={340}
                maxHeight={380}
                minHeight={240}
                class="mp"
                exit
            >
                <div class="mp-wrap">
                    <div class="mp-search">
                        <Search size={14} />
                        <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={rows()[sel()] ? `${listId}-${sel()}` : undefined} value={q()} onInput={(e) => (setQ(e.currentTarget.value), setSel(0))} placeholder="Search models…" aria-label="Search models" spellcheck={false} />
                        <button class="hb sm" title="Refresh model lists" aria-label="Refresh model lists" onClick={() => void refreshModels(true)} disabled={app.modelsLoading}>
                            <Show when={app.modelsLoading} fallback={<RefreshCw size={13} />}>
                                <Spinner size={13} />
                            </Show>
                        </button>
                    </div>
                    {/* Each provider by mark and name, so nothing hides behind a tooltip. A wheel scrolls them sideways. */}
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
                            <Star size={13} class="mp-f-star" />
                            <span>Favorites</span>
                        </button>
                        <For each={groups()}>
                            {(g) => (
                                <button
                                    class={`mp-f ${filter() === g.provider && !q() ? "on" : ""} ${g.status === "error" ? "err" : ""}`}
                                    role="tab"
                                    aria-selected={filter() === g.provider}
                                    // No mark on the filter (the composer's button already names the model); screen readers still hear it.
                                    aria-label={g.provider === currentProvider() ? `${g.providerName}, current model` : undefined}
                                    title={g.status === "error" ? (g.error ?? "Couldn't list this provider's models") : undefined}
                                    onClick={(e) => (show(g.provider), e.detail && input?.focus())}
                                >
                                    <ProviderIcon id={g.provider} name={g.providerName} size={14} />
                                    <span>{g.providerName}</span>
                                </button>
                            )}
                        </For>
                    </div>
                    {/* Rebuilt only when the list changes, so focus on an account pill survives an update. */}
                    <Show when={!q() && sections()[0]?.key} keyed>
                        {(key) => heading({ key, name: key === FAVORITES ? "Favorites" : providerName(key), provider: key === FAVORITES ? undefined : key, rows: [] }, false)}
                    </Show>
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
                            <Show when={q()} fallback={<For each={rows()}>{rowView}</For>}>
                                <For each={sections()}>
                                    {(s) => (
                                        <div class="mp-group" role="group" aria-label={s.name}>
                                            {heading(s, true)}
                                            <For each={s.rows}>{rowView}</For>
                                        </div>
                                    )}
                                </For>
                            </Show>
                        </Show>
                    </div>
                    <Show when={multi()}>
                        <div class="mp-cmp-note">{COMPARE_ON}</div>
                    </Show>
                    <div class="mp-foot">
                        <button
                            class="mp-link"
                            onClick={() => {
                                p.setOpen(false);
                                setSettingsTab("providers");
                            }}
                        >
                            <Settings2 size={13} /> Providers…
                        </button>
                        <Show when={p.compare}>
                            {(c) => (
                                // The wrapper carries the reason: a disabled button shows no tooltip of its own.
                                <span class="mp-cmp-wrap" title={!c().available ? c().why : multi() ? COMPARE_ON : COMPARE_OFF}>
                                    <button class={`mp-cmp ${multi() ? "on" : ""}`} role="switch" aria-checked={multi()} disabled={!c().available} onClick={toggleCompare}>
                                        <Layers size={13} />
                                        Compare
                                        <Show when={multi()}>
                                            <span class="mp-cmp-n">{picks().length} picked</span>
                                        </Show>
                                        <span class={`mp-switch ${multi() ? "on" : ""}`} aria-hidden="true" />
                                        <Show when={!c().available}>
                                            <span class="sr-only">. {c().why}</span>
                                        </Show>
                                    </button>
                                </span>
                            )}
                        </Show>
                    </div>
                </div>
            </Menu>
        </>
    );
}

/** Effort as a glyph: five bars, filled up to the level (1 low … 5 max; 0 none chosen). */
export function EffortGlyph(p: { level: number }) {
    return (
        <span class="eg" aria-hidden="true">
            <For each={[1, 2, 3, 4, 5]}>{(i) => <i class={i <= p.level ? "on" : ""} style={{ height: `calc(${2 + i * 2} * var(--sp))` }} />}</For>
        </span>
    );
}

/**
 * The glyph grown into a control: one bar per level the model takes, rising
 * left to right; the chosen level and those below fill with the accent.
 * Click or drag across them, or use the arrows, Home/End and 1–n; hovering
 * previews a level before it's picked. It applies as it moves. Settings →
 * General uses it too (`size="sm"`).
 */
export function EffortBars(p: { levels: Effort[]; value?: EffortLevel; onChange: (id: EffortLevel) => void; size?: "sm"; label?: string; ref?: (el: HTMLDivElement) => void }) {
    let el: HTMLDivElement | undefined;
    let down = false;
    const [hover, setHover] = createSignal(-1);
    const at = () => p.levels.findIndex((e) => e.id === p.value);
    const go = (i: number) => {
        const l = p.levels[i];
        if (l && l.id !== p.value) p.onChange(l.id);
    };
    const under = (e: PointerEvent) => {
        const r = el!.getBoundingClientRect();
        return effortAt(e.clientX, r.left, r.width, p.levels.length);
    };
    const up = () => (down = false);
    return (
        <div
            ref={(e) => {
                el = e;
                p.ref?.(e);
            }}
            class={`es ${p.size ?? ""} ${hover() >= 0 ? "hov" : ""}`}
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
                el!.focus({ preventScroll: true });
                try {
                    el!.setPointerCapture(e.pointerId);
                } catch {
                    // Synthetic events have no pointer to capture.
                }
                down = true;
                go(under(e));
            }}
            onPointerMove={(e) => (down ? go(under(e)) : setHover(under(e)))}
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
            <For each={p.levels}>
                {(l, i) => (
                    <span class={`eb ${i() <= at() ? "on" : ""} ${i() <= hover() ? "pre" : ""}`} style={{ "--h": String((i() + 1) / p.levels.length) }} title={l.label}>
                        <i />
                    </span>
                )}
            </For>
        </div>
    );
}

const FAST_TIP = "Faster service at higher usage/cost. Same model and reasoning effort; account eligibility applies.";
const FAST_BUSY = "Change speed after this response finishes";

/**
 * Reasoning effort (and fast mode, where the model has it) in one picker: the
 * level glyph, with a filled ⚡ before it while fast mode is on. Its popover
 * names the level, has the "⚡ Fast" pill, and the bars.
 */
export function EffortPicker(p: ComposerMenu & { current?: ModelSummary; currentRef?: string; effort?: EffortLevel; fast?: boolean; busy?: boolean }) {
    let anchor: HTMLButtonElement | undefined;
    let bars: HTMLDivElement | undefined;
    let fastBtn: HTMLButtonElement | undefined;
    const model = createMemo(() => resolve(p.current, p.current?.ref ?? p.currentRef));
    const reasoning = () => takesEffort(model());
    const fastOk = () => Boolean(model()?.supportsFastMode);
    const fastOn = () => fastOk() && Boolean(p.fast);
    const levels = () => effortLevels(model());
    // Shown at once while the server takes it, so a drag across the bars doesn't lag behind the pointer.
    const [shown, setShown] = createSignal(p.effort);
    createEffect(on(() => p.effort, (e) => setShown(() => e)));
    let picks = 0;
    const pick = (id: EffortLevel) => {
        setShown(() => id);
        const n = ++picks;
        // Refused (disconnected, say): back to the level the session has, so picking it again sends again.
        void setEffort(id).then((ok) => {
            if (!ok && n === picks) setShown(() => p.effort);
        });
    };
    const label = () => (reasoning() ? (effortOf(shown())?.label ?? "Default") : fastOn() ? "Fast" : "Standard");
    return (
        <Show when={reasoning() || fastOk()}>
            <button ref={anchor} class={`pick effort ${p.open ? "open" : ""}`} aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title={reasoning() ? `Reasoning effort${fastOn() ? ", fast mode on" : ""}` : "Speed"}>
                <Show when={fastOn()}>
                    <span class="fz" aria-hidden="true">
                        <Zap size={13} stroke-width={2} />
                    </span>
                </Show>
                <Show when={reasoning()} fallback={<Show when={!fastOn()}><Zap size={14} /></Show>}>
                    <EffortGlyph level={effortOf(shown())?.lv ?? 0} />
                </Show>
                <span class="lbl">{label()}</span>
                <Show when={fastOn()}>
                    <span class="sr-only">, fast mode on</span>
                </Show>
                <ChevronDown size={13} class="chev" />
            </button>
            <Menu
                label={reasoning() ? "Reasoning effort" : "Speed"}
                kind="dialog"
                open={p.open}
                anchor={() => anchor}
                onClose={() => p.setOpen(false)}
                placement={p.placement ?? "top"}
                width={220}
                class="effort-pop"
                initialFocus={() => (bars?.isConnected ? bars : fastBtn)}
                onKeyDown={(e) => {
                    // The panel takes the keys before the bars see them (it keeps focus inside), so it moves them here.
                    if (!bars?.isConnected || e.target !== bars) return;
                    if (e.key === "Enter") {
                        e.preventDefault();
                        p.setOpen(false);
                        return;
                    }
                    const i = effortKey(e, levels().findIndex((l) => l.id === shown()), levels().length);
                    if (i === undefined) return;
                    e.preventDefault();
                    const l = levels()[i];
                    if (l && l.id !== shown()) pick(l.id);
                }}
            >
                <div class="ep-h">
                    <b class="ep-lv">{label()}</b>
                    <Show when={fastOk()}>
                        <button ref={fastBtn} class={`ep-fast ${fastOn() ? "on" : ""}`} aria-pressed={fastOn()} disabled={p.busy} title={p.busy ? FAST_BUSY : FAST_TIP} onClick={() => void setFastMode(!p.fast)}>
                            <Zap size={12} stroke-width={2.25} />
                            Fast
                        </button>
                    </Show>
                </div>
                <Show when={reasoning()}>
                    <EffortBars ref={(e) => (bars = e)} levels={levels()} value={shown()} onChange={pick} />
                </Show>
            </Menu>
        </Show>
    );
}
