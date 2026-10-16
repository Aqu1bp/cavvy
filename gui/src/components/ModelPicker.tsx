import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Brain, Check, ChevronDown, Layers, RefreshCw, Search, Settings2, Star, Zap } from "lucide-solid";
import type { EffortLevel, ModelSummary } from "@shared/protocol";
import { app, refreshModels, toast } from "../state/app";
import { setEffort, setModel, setFastMode } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { comparePicks, setComparePicks, setSettingsTab } from "../state/ui";
import { isMod, mod } from "../lib/platform";
import { Popover } from "./ui/Popover";
import { Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";

const EFFORTS: { id: EffortLevel; label: string; desc: string }[] = [
    { id: "low", label: "Low", desc: "Fastest replies, for simple tasks." },
    { id: "medium", label: "Medium", desc: "Balanced speed and depth." },
    { id: "high", label: "High", desc: "Thorough reasoning for real changes." },
    { id: "xhigh", label: "Extra high", desc: "More time on hard problems." },
    { id: "max", label: "Max", desc: "The deepest reasoning this model offers." },
];

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

/** The model a session (or the next one) uses: what the server says, else the listed model with that ref. */
function resolve(current: ModelSummary | undefined, ref: string | undefined): ModelSummary | undefined {
    return current ?? app.models.flatMap((g) => g.models).find((m) => m.ref === ref);
}

const FAVORITES = "favorites";

type Row = { m: ModelSummary; sub?: string };

/** A menu by the composer: above it in a session, below it on Home, where the composer sits higher. */
export interface ComposerMenu {
    open: boolean;
    setOpen: (v: boolean) => void;
    edge?: () => HTMLElement | undefined;
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
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const [rail, setRail] = createSignal<string>(FAVORITES);
    const currentRef = () => p.current?.ref ?? p.currentRef;
    const currentModel = createMemo(() => resolve(p.current, currentRef()));
    const currentProvider = () => currentModel()?.provider ?? currentRef()?.split(":")[0];

    // Providers with something to pick, or an error worth seeing.
    const groups = createMemo(() =>
        app.models
            .map((g) => ({ ...g, models: g.models.filter((m) => !m.deprecated || m.ref === currentRef()) }))
            .filter((g) => g.models.length || g.status === "error"),
    );
    const providerName = (id: string) => app.models.find((g) => g.provider === id)?.providerName ?? id;
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

    createEffect(
        on(
            () => p.open,
            (open) => {
                if (!open) return;
                setQ("");
                // Start where the current model lives.
                const provider = currentProvider();
                setRail(provider && groups().some((g) => g.provider === provider) ? provider : favorites().length || !groups().length ? FAVORITES : groups()[0]!.provider);
                setSel(Math.max(0, rows().findIndex((r) => r.m.ref === currentRef())));
                if (!app.models.length) void refreshModels();
                requestAnimationFrame(() => {
                    input?.focus();
                    list?.querySelector(".mr.sel")?.scrollIntoView({ block: "nearest" });
                });
            },
        ),
    );
    createEffect(on([q, rail], () => setSel(0), { defer: true }));

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
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = rows().length;
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => list?.querySelector(".mr.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter" && e.target === input) {
            e.preventDefault();
            const r = rows()[sel()];
            if (r) choose(r.m);
        }
    };
    const empty = () => {
        if (app.modelsLoading && !app.models.length) return "Loading models…";
        if (q()) return "No models match.";
        if (!groups().length) return "No providers yet. Add an API key in Providers.";
        if (rail() === FAVORITES) return "Star a model to keep it here.";
        return group()?.status === "error" ? (group()?.error ?? "Couldn't list this provider's models.") : "No models.";
    };

    return (
        <>
            <Show
                when={multi()}
                fallback={
                    <button ref={anchor} class="ctl model" aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title={`${currentModel()?.name ?? currentRef() ?? "Model"} (${mod}+/)`}>
                        <Show when={currentProvider()}>{(id) => <ProviderIcon id={id()} name={providerName(id())} size={16} />}</Show>
                        {/* What an alias resolves to, "(claude-opus-5-5)", is in the list and the tooltip. */}
                        <span class="truncate">{(currentModel() ? shortModel(currentModel()) : currentRef() ? currentRef()!.split(":").slice(1).join(":") : "No model").replace(/^Claude /, "").replace(/\s+\([^()]*\)$/, "")}</span>
                        <ChevronDown size={14} class="chv" />
                    </button>
                }
            >
                <button ref={anchor} class="ctl model on" aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title={picks().map((r) => resolve(undefined, r)?.name ?? r).join(", ") || "Pick 2 to 4 models"}>
                    <Layers size={16} />
                    <span class="truncate">{picks().length >= 2 ? `${picks().length} models` : "Pick 2–4 models"}</span>
                    <ChevronDown size={14} class="chv" />
                </button>
            </Show>
            <Popover open={p.open} anchor={() => anchor} edge={p.edge} onClose={() => p.setOpen(false)} placement={p.placement ?? "top"} width={360} maxHeight={340} minHeight={240} class="mp">
                <div class="mp-wrap" role="dialog" aria-label="Choose a model" onKeyDown={onKey}>
                    <div class="mp-rail" role="tablist" aria-label="Providers">
                        <button class={`rb ${rail() === FAVORITES && !q() ? "on" : ""}`} role="tab" aria-selected={rail() === FAVORITES} title="Favorites" aria-label="Favorites" onClick={() => (setQ(""), setRail(FAVORITES))}>
                            <Star size={18} />
                            <Show when={rail() === FAVORITES && !q()}>
                                <span class="bar" />
                            </Show>
                        </button>
                        <For each={groups()}>
                            {(g) => (
                                <button class={`rb ${rail() === g.provider && !q() ? "on" : ""}`} role="tab" aria-selected={rail() === g.provider} title={g.providerName} aria-label={g.providerName} onClick={() => (setQ(""), setRail(g.provider))}>
                                    <ProviderIcon id={g.provider} name={g.providerName} size={20} />
                                    <Show when={rail() === g.provider && !q()}>
                                        <span class="bar" />
                                    </Show>
                                </button>
                            )}
                        </For>
                    </div>
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
                            <input ref={input} value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search models…" aria-label="Search models" spellcheck={false} />
                            <button class="hb sm" title="Refresh model lists" aria-label="Refresh model lists" onClick={() => void refreshModels(true)} disabled={app.modelsLoading}>
                                <Show when={app.modelsLoading} fallback={<RefreshCw size={13} />}>
                                    <Spinner size={13} />
                                </Show>
                            </button>
                        </div>
                        <div class="mp-label">
                            <span class="truncate">{label()}</span>
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
                        </div>
                        <div class="mp-list" ref={list} role="listbox" aria-label={label()} aria-multiselectable={multi()}>
                            <Show when={rows().length} fallback={<div class="mp-empty">{empty()}</div>}>
                                <For each={rows()}>
                                    {(r, i) => (
                                        <div class={`mr ${i() === sel() ? "sel" : ""} ${(multi() ? picked(r.m.ref) : r.m.ref === currentRef()) ? "on" : ""}`} onMouseMove={() => setSel(i())}>
                                            <button class="mr-pick" role="option" aria-selected={multi() ? picked(r.m.ref) : r.m.ref === currentRef()} onClick={() => choose(r.m)}>
                                                <Show when={multi()}>
                                                    <span class={`mr-check ${picked(r.m.ref) ? "on" : ""}`} aria-hidden="true">
                                                        <Show when={picked(r.m.ref)}>
                                                            <Check size={11} stroke-width={3} />
                                                        </Show>
                                                    </span>
                                                </Show>
                                                <span class="mr-text">
                                                    <span class="mr-name truncate">{r.m.name}</span>
                                                    <Show when={r.sub}>
                                                        <span class="mr-sub truncate">{r.sub}</span>
                                                    </Show>
                                                </span>
                                                <Show when={i() < 9}>
                                                    <kbd>{`${mod === "⌘" ? "⌘" : "Ctrl+"}${i() + 1}`}</kbd>
                                                </Show>
                                            </button>
                                            <button class={`mr-star ${isFav(r.m.ref) ? "f" : ""}`} aria-pressed={isFav(r.m.ref)} title={isFav(r.m.ref) ? "Remove from Favorites" : "Add to Favorites"} aria-label={isFav(r.m.ref) ? `Remove ${r.m.name} from Favorites` : `Add ${r.m.name} to Favorites`} onClick={() => toggleFav(r.m.ref)}>
                                                <Star size={14} />
                                            </button>
                                        </div>
                                    )}
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
            </Popover>
        </>
    );
}

/** Its own menu: each level spelled out, and which one new sessions start with. */
export function EffortMenu(p: ComposerMenu & { current?: ModelSummary; currentRef?: string; effort?: EffortLevel }) {
    let anchor: HTMLButtonElement | undefined;
    const model = createMemo(() => resolve(p.current, p.current?.ref ?? p.currentRef));
    const supported = () => Boolean(model()?.supportsReasoning || model()?.effortLevels?.length);
    const levels = () => EFFORTS.filter((e) => !model()?.effortLevels?.length || model()!.effortLevels!.includes(e.id));
    return (
        <Show when={supported()}>
            <span class="vs" aria-hidden="true" />
            <button ref={anchor} class="ctl" aria-haspopup="menu" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title="Reasoning effort">
                <Brain size={16} />
                <span>{EFFORTS.find((e) => e.id === p.effort)?.label ?? "Default"}</span>
                <ChevronDown size={14} class="chv" />
            </button>
            <Popover open={p.open} anchor={() => anchor} edge={p.edge} onClose={() => p.setOpen(false)} placement={p.placement ?? "top"} width={272}>
                <div class="effort-menu" role="menu" aria-label="Reasoning effort">
                    <div class="menu-head">Reasoning effort</div>
                    <For each={levels()}>
                        {(e) => (
                            <button
                                class={`menu-item ${p.effort === e.id ? "on" : ""}`}
                                role="menuitemradio"
                                aria-checked={p.effort === e.id}
                                onClick={() => {
                                    p.setOpen(false);
                                    void setEffort(e.id);
                                }}
                            >
                                <span class="menu-text">
                                    <span class="menu-label">
                                        {e.label}
                                        <Show when={app.settings.effort === e.id}>
                                            <span class="dbadge" title="New sessions start with this">
                                                Default
                                            </span>
                                        </Show>
                                    </span>
                                    <span class="menu-desc">{e.desc}</span>
                                </span>
                            </button>
                        )}
                    </For>
                </div>
            </Popover>
        </Show>
    );
}

/** Fast service changes speed and pricing, independently of reasoning effort. */
export function FastModeToggle(p: { current?: ModelSummary; currentRef?: string; enabled?: boolean; busy?: boolean }) {
    const model = createMemo(() => resolve(p.current, p.current?.ref ?? p.currentRef));
    return <Show when={model()?.supportsFastMode}>
        <span class="vs" aria-hidden="true" />
        <button class={`ctl ${p.enabled ? "on" : ""}`} aria-label="Fast mode" aria-pressed={Boolean(p.enabled)} disabled={p.busy}
            title={p.busy ? "Change speed after this response finishes" : "Faster service at higher usage/cost. Same model and reasoning effort; account eligibility applies."}
            onClick={() => void setFastMode(!p.enabled)}>
            <Zap size={16} /><span>{p.enabled ? "Fast" : "Standard"}</span>
        </button>
    </Show>;
}
