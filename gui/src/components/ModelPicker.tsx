import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { Check, ChevronDown, CircleAlert, Layers, Plus, RefreshCw, Search, Settings2, Star, UserRound, Zap } from "lucide-solid";
import { catalogSentence, type AccountInfo, type EffortLevel, type ModelSummary } from "@shared/protocol";
import { app, handleFor, refreshModels, toast } from "../state/app";
import { setEffort, setModel, setFastMode, setAccount } from "../state/actions";
import { prefs, setPrefs, sp } from "../state/prefs";
import { comparePicks, setAddAccountFor, setComparePicks, setSettingsTab } from "../state/ui";
import { isMod, mod } from "../lib/platform";
import { menuIndex, menuTypeahead } from "../lib/menu";
import { Menu } from "./ui/Menu";
import { Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";
import { withShortcut } from "../state/keybindings";
import { effortAt, effortKey, effortLevels, effortOf, takesEffort, type Effort } from "../lib/effort";
import { sendsAccountPick } from "../lib/account-pick";

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

type Row = { m: ModelSummary; sub?: string };

/** The CLIs report plans in lower case ("max", "plus"). */
const planLabel = (plan?: string) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined);
/** Under an account's name in the switcher: who it is, its plan, and what's wrong with it, if anything. */
const accountDetail = (a: Partial<AccountInfo>) => [a.email, planLabel(a.plan), a.invalid ? "Unavailable" : a.signedIn === false ? "Not signed in" : undefined].filter(Boolean).join(" · ");

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

export function ModelPicker(p: ComposerMenu & { current?: ModelSummary; currentRef?: string; compare?: CompareOption }) {
    let anchor: HTMLButtonElement | undefined;
    let input: HTMLInputElement | undefined;
    let list: HTMLDivElement | undefined;
    let railEl: HTMLDivElement | undefined;
    let acctBtn: HTMLButtonElement | undefined;
    let acctMenu: HTMLDivElement | undefined;
    const listId = createUniqueId();
    const typeahead = menuTypeahead();
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const [rail, setRail] = createSignal<string>(FAVORITES);
    /** The account list under the provider's header. */
    const [acctOpen, setAcctOpen] = createSignal(false);
    /** A rail button's name beside it, while it's hovered or focused. */
    const [tip, setTip] = createSignal<{ name: string; top: number }>();
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
    const group = () => groups().find((g) => g.provider === rail());
    const rows = createMemo((): Row[] => {
        if (q()) return groups().flatMap((g) => g.models.filter((m) => fuzzy(q(), `${g.providerName} ${m.name} ${m.id}`)).map((m) => ({ m, sub: g.providerName })));
        if (rail() === FAVORITES) return favorites().map((m) => ({ m, sub: providerName(m.provider) }));
        return (group()?.models ?? []).map((m) => ({ m }));
    });
    const label = () => (q() ? "Results" : rail() === FAVORITES ? "Favorites" : (group()?.providerName ?? ""));
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

    // The provider whose header shows an account switcher: a CLI provider, in its own list.
    const acctProvider = () => (!q() && rail() !== FAVORITES && accountInfo(rail()) ? rail() : undefined);
    const acctItems = () => [...(acctMenu?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    /** Focus an account (or Add account…) and scroll the list to it. */
    const focusAccount = (el?: HTMLElement) => {
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
    };
    /**
     * The list fits inside the picker, which clips what overflows it: below the header if there's room,
     * else moved up over the header as far as it needs. The accounts scroll; Add account… stays at the
     * bottom. Measured from layout (the header, the list's scrollHeight), not the opening transform.
     */
    const placeAccounts = () => {
        const menu = acctMenu;
        const panel = menu?.closest<HTMLElement>(".popover")?.getBoundingClientRect();
        const head = menu?.parentElement?.getBoundingClientRect();
        if (!menu || !panel || !head) return;
        const pad = sp(8);
        const top = head.bottom + sp(2);
        const shift = Math.max(0, Math.min(menu.scrollHeight - (panel.bottom - pad - top), top - panel.top - pad));
        menu.style.marginTop = shift ? `${-shift}px` : "";
        menu.style.maxHeight = `${panel.bottom - pad - (top - shift)}px`;
    };
    const openAccounts = () => {
        setAcctOpen(true);
        placeAccounts();
        const items = acctItems();
        focusAccount(items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0]);
    };
    const closeAccounts = (refocus = true) => {
        setAcctOpen(false);
        if (refocus) acctBtn?.focus();
    };
    const pickAccount = (provider: string, a: { id: string }) => {
        closeAccounts();
        const needed = Boolean(app.activeId && handleFor(app.activeId)?.view.state.accountNeeded === provider);
        if (sendsAccountPick(a.id, selectedAccount(provider), { missing: missingAccount(provider), needed })) void setAccount(provider, a.id);
    };
    const addAccount = (provider: string) => {
        setAcctOpen(false);
        p.setOpen(false);
        setAddAccountFor(provider);
        setSettingsTab("providers");
    };
    const showTip = (el: HTMLElement, name: string) => setTip({ name, top: el.offsetTop - (railEl?.scrollTop ?? 0) + el.offsetHeight / 2 });

    createEffect(
        on(
            () => p.open,
            (open) => {
                setAcctOpen(false);
                setTip(undefined);
                if (!open) return;
                setQ("");
                // Start where the current model lives.
                const provider = currentProvider();
                setRail(provider && groups().some((g) => g.provider === provider) ? provider : favorites().length || !groups().length ? FAVORITES : groups()[0]!.provider);
                setSel(Math.max(0, rows().findIndex((r) => r.m.ref === currentRef())));
                if (!app.models.length) void refreshModels();
                requestAnimationFrame(() => {
                    if (!p.open) return;
                    list?.querySelector(".mr.sel")?.scrollIntoView({ block: "nearest" });
                });
            },
        ),
    );
    // A new list starts at its top. Set here, not in an effect on q and rail: opening the picker moves
    // the rail to the current model's provider, and that must not undo its highlight on the current model.
    const show = (provider: string) => {
        setQ("");
        setRail(provider);
        setSel(0);
        setAcctOpen(false);
    };

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
        // The account list: arrows move through it; Enter and Space are the buttons' own.
        if (acctOpen() && acctMenu?.contains(target) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            const items = acctItems();
            focusAccount(items[menuIndex(items.length, items.indexOf(target as HTMLButtonElement), e.key)]);
            return;
        }
        if (target === acctBtn && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openAccounts();
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
        if (rail() === FAVORITES) return { text: "Star a model to keep it here.", icon: "star" };
        if (group()?.status === "error") return { text: group()?.error ?? "Couldn't list this provider's models.", icon: "error", action: { label: "Try again", run: () => void refreshModels(true) } };
        return { text: "No models." };
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
                    openAccounts();
                    return acctItems()[0] ?? input;
                }}
                onKeyDown={onKey}
                onEscape={() => {
                    if (!acctOpen()) return false;
                    closeAccounts();
                    return true;
                }}
                open={p.open}
                anchor={() => anchor}
                onClose={() => p.setOpen(false)}
                placement={p.placement ?? "top"}
                width={360}
                maxHeight={340}
                minHeight={240}
                class="mp"
                exit
            >
                <div
                    class="mp-wrap"
                    // The account list closes when the pointer or focus goes elsewhere in the picker.
                    onPointerDown={(e) => {
                        const t = e.target as Node;
                        if (acctOpen() && !acctMenu?.contains(t) && !acctBtn?.contains(t)) closeAccounts(false);
                    }}
                    onFocusIn={(e) => {
                        const t = e.target as Node;
                        if (acctOpen() && !acctMenu?.contains(t) && t !== acctBtn) setAcctOpen(false);
                    }}
                >
                    <div class="mp-rail" ref={railEl} role="tablist" aria-label="Providers" aria-orientation="vertical" onScroll={() => setTip(undefined)}>
                        <button
                            class={`rb ${rail() === FAVORITES && !q() ? "on" : ""}`}
                            role="tab"
                            aria-selected={rail() === FAVORITES}
                            aria-label="Favorites"
                            onClick={() => show(FAVORITES)}
                            onPointerEnter={(e) => showTip(e.currentTarget, "Favorites")}
                            onPointerLeave={() => setTip(undefined)}
                            onFocus={(e) => showTip(e.currentTarget, "Favorites")}
                            onBlur={() => setTip(undefined)}
                        >
                            <Star size={18} />
                        </button>
                        <For each={groups()}>
                            {(g) => {
                                const cur = () => g.provider === currentProvider();
                                // No mark on the rail (the composer's button already names the model); screen readers still hear it.
                                const label = () => (cur() ? `${g.providerName}, current model` : g.providerName);
                                return (
                                    <button
                                        class={`rb ${rail() === g.provider && !q() ? "on" : ""}`}
                                        role="tab"
                                        aria-selected={rail() === g.provider}
                                        aria-label={label()}
                                        onClick={() => show(g.provider)}
                                        onPointerEnter={(e) => showTip(e.currentTarget, g.providerName)}
                                        onPointerLeave={() => setTip(undefined)}
                                        onFocus={(e) => showTip(e.currentTarget, g.providerName)}
                                        onBlur={() => setTip(undefined)}
                                    >
                                        <ProviderIcon id={g.provider} name={g.providerName} size={20} />
                                        <Show when={g.status === "error"}>
                                            <span class="rb-err" aria-hidden="true" />
                                        </Show>
                                    </button>
                                );
                            }}
                        </For>
                    </div>
                    <Show when={tip()}>
                        {(t) => (
                            <div class="mp-tip" aria-hidden="true" style={{ top: `${t().top}px` }}>
                                {t().name}
                            </div>
                        )}
                    </Show>
                    <div class="mp-main">
                        <Show when={p.compare}>
                            {(c) => (
                                <div class="mp-compare">
                                    <button class={`mp-compare-btn ${multi() ? "on" : ""}`} role="switch" aria-checked={multi()} disabled={!c().available} onClick={toggleCompare}>
                                        <Layers size={14} />
                                        <span class="grow">Compare models</span>
                                        <Show when={multi()}>
                                            <span class="mp-note">{picks().length} picked</span>
                                        </Show>
                                        <span class={`mp-switch ${multi() ? "on" : ""}`} aria-hidden="true" />
                                    </button>
                                    <div class="mp-compare-note">{!c().available ? c().why : multi() ? "Each model works in a new worktree from HEAD. Uncommitted changes here aren't carried over." : "Send one prompt to 2–4 models, each in a worktree of its own."}</div>
                                </div>
                            )}
                        </Show>
                        <div class="mp-search">
                            <Search size={14} />
                            <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={rows()[sel()] ? `${listId}-${sel()}` : undefined} value={q()} onInput={(e) => (setQ(e.currentTarget.value), setSel(0))} placeholder="Search models…" aria-label="Search models" spellcheck={false} />
                            <button class="hb sm" title="Refresh model lists" aria-label="Refresh model lists" onClick={() => void refreshModels(true)} disabled={app.modelsLoading}>
                                <Show when={app.modelsLoading} fallback={<RefreshCw size={13} />}>
                                    <Spinner size={13} />
                                </Show>
                            </button>
                        </div>
                        <div class="mp-head">
                        <div class="mp-label">
                            <span class="mp-label-name truncate">{label()}</span>
                            <Show when={!q() && group()?.status === "cached"}>
                                <span class="mp-note" title="The provider didn't answer; this is the last list it gave">
                                    cached
                                </span>
                            </Show>
                            <Show when={!q() && group()?.status === "error" && group()!.models.length}>
                                <span class="mp-note tone-err truncate" title={group()!.error}>
                                    {group()!.error ?? "unavailable"}
                                </span>
                            </Show>
                            <Show when={acctProvider()}>
                                {(provider) => (
                                    <button
                                        ref={acctBtn}
                                        class={`mp-acct ${missingAccount(provider()) ? "missing" : ""} ${acctOpen() ? "open" : ""}`}
                                        aria-haspopup="menu"
                                        aria-expanded={acctOpen()}
                                        aria-controls={acctOpen() ? `${listId}-acct` : undefined}
                                        aria-label={`${providerName(provider())} account: ${missingAccount(provider()) ? "removed, choose another" : accountName(provider())}`}
                                        title={missingAccount(provider()) ? "This session's account was removed. Choose another." : `${providerName(provider())} account`}
                                        onClick={() => (acctOpen() ? closeAccounts() : openAccounts())}
                                    >
                                        <Show when={missingAccount(provider())} fallback={<UserRound size={13} />}>
                                            <CircleAlert size={13} />
                                        </Show>
                                        <span class="truncate">{accountName(provider())}</span>
                                        <ChevronDown size={12} class="chev" />
                                    </button>
                                )}
                            </Show>
                        </div>
                        <Show when={acctOpen() && acctProvider()}>
                            {(provider) => (
                                <div ref={acctMenu} id={`${listId}-acct`} class="mp-acct-menu" role="menu" aria-label={`${providerName(provider())} accounts`}>
                                    <Show when={missingAccount(provider())}>
                                        <div class="mp-acct-note">
                                            <CircleAlert size={13} />
                                            <span>This session's account was removed. Choose another.</span>
                                        </div>
                                    </Show>
                                    <div class="mp-acct-list">
                                    <For each={accountChoices(provider())}>
                                        {(a) => (
                                            <button class="menu-item" role="menuitemradio" aria-checked={a.id === selectedAccount(provider())} onClick={() => pickAccount(provider(), a)}>
                                                <span class="menu-text">
                                                    <span class="menu-label truncate">{a.name}</span>
                                                    <Show when={accountDetail(a)}>
                                                        <span class="menu-desc truncate">{accountDetail(a)}</span>
                                                    </Show>
                                                </span>
                                                <Show when={a.id === selectedAccount(provider())}>
                                                    <Check size={14} class="menu-check" />
                                                </Show>
                                            </button>
                                        )}
                                    </For>
                                    </div>
                                    <div class="menu-sep" role="separator" />
                                    <button class="menu-item" role="menuitem" onClick={() => addAccount(provider())}>
                                        <Plus size={14} />
                                        Add account…
                                    </button>
                                </div>
                            )}
                        </Show>
                        </div>
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
                                <For each={rows()}>
                                    {(r, i) => {
                                        const name = modelName(r.m);
                                        const on = () => (multi() ? picked(r.m.ref) : isCurrent(r.m.ref));
                                        return (
                                            <div class={`mr ${i() === sel() ? "sel" : ""} ${on() ? "on" : ""}`} onMouseMove={() => sel() !== i() && setSel(i())}>
                                                <button
                                                    class="mr-pick"
                                                    id={`${listId}-${i()}`}
                                                    onFocus={() => setSel(i())}
                                                    role="option"
                                                    aria-selected={on()}
                                                    aria-keyshortcuts={i() < 9 ? `${mod === "⌘" ? "Meta" : "Control"}+${i() + 1}` : undefined}
                                                    title={[name, r.sub].filter(Boolean).join(" · ")}
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
                                                    {/* The provider, in mixed lists, drops out of sight rather than show a few letters when there's no room. */}
                                                    <span class="mr-text">
                                                        <span class="mr-name truncate">{name}</span>
                                                        <CatalogTag provider={r.m.provider} />
                                                        <Show when={r.sub}>
                                                            <span class="mr-sub truncate">{r.sub}</span>
                                                        </Show>
                                                    </span>
                                                    <Show when={i() < 9}>
                                                        <kbd aria-hidden="true">{`${mod === "⌘" ? "⌘" : "Ctrl+"}${i() + 1}`}</kbd>
                                                    </Show>
                                                </button>
                                                <button onFocus={() => setSel(i())} class={`mr-star ${isFav(r.m.ref) ? "f" : ""}`} aria-pressed={isFav(r.m.ref)} title={isFav(r.m.ref) ? "Remove from Favorites" : "Add to Favorites"} aria-label={isFav(r.m.ref) ? `Remove ${name} from Favorites` : `Add ${name} to Favorites`} onClick={() => toggleFav(r.m.ref)}>
                                                    <Star size={14} />
                                                </button>
                                            </div>
                                        );
                                    }}
                                </For>
                            </Show>
                        </div>
                        <button
                            class="mp-foot"
                            onClick={() => {
                                p.setOpen(false);
                                setSettingsTab("providers");
                            }}
                        >
                            <Settings2 size={14} /> Providers…
                        </button>
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
 * A CLI's models, with their effort and speed options, are listed by its starting account (#426): where the
 * session is on another, they're marked "From <starting account>", the reason in the tooltip (catalogSentence).
 */
function catalogFrom(provider: string | undefined): { source: string; note: string } | undefined {
    const cli = provider ? app.providers.find((x) => x.id === provider) : undefined;
    const info = cli?.agentCli;
    if (!cli || !info || !app.activeId) return undefined;
    const selected = handleFor(app.activeId)?.view.state.accounts?.[cli.id] ?? "default";
    const from = info.defaultAccount ?? "default";
    if (selected === from) return undefined;
    const name = (id: string) => info.accounts?.find((a) => a.id === id)?.name ?? (id === "default" ? "Default" : id);
    return { source: name(from), note: catalogSentence(cli.name, name(from), name(selected)) };
}

function CatalogTag(p: { provider?: string }) {
    const from = () => catalogFrom(p.provider);
    return (
        <Show when={from()}>
            {(f) => (
                <span class="from-tag" title={f().note}>
                    From {f().source}
                    <span class="sr-only">{`. ${f().note}`}</span>
                </span>
            )}
        </Show>
    );
}

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
                    <CatalogTag provider={model()?.provider} />
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
