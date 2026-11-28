// Settings as a page: its sections take the sidebar's place, and each
// setting is one row: what it is, what it does, its control, and a reset
// when it's been changed.

import { createEffect, createMemo, createSignal, For, lazy, Match, on, onMount, Show, Suspense, Switch, type JSX } from "solid-js";
import { AlertTriangle, ArrowLeft, ChartNoAxesColumn, Check, KeyRound, CircleAlert, Copy, ExternalLink, Info, Keyboard, Minus, Palette, Plus, Puzzle, RotateCcw, SlidersHorizontal, X } from "lucide-solid";
import { MODE_LABELS, type EffortLevel, type FollowUpMode, type GuiSettings, type PermissionModeId, type ProviderInfo } from "@shared/protocol";
import { app, linkFor, refreshModels, refreshProviders, refreshSettings, reportError, rpc, serversUi, setApp, toast } from "../state/app";
import { createStore, reconcile } from "solid-js/store";
import { now } from "../lib/clock";
import { updateView } from "../lib/app-update";
import { connectCli, editors, refreshEditors } from "../state/actions";
import { ACCENTS, CHAT_WIDTHS, forcedScheme, prefs, PREF_DEFAULTS, setPrefs, sp, type AccentId } from "../state/prefs";
import { themeTraits } from "../state/theme-traits";

/** Settings → Appearance → Theme: loaded when Appearance first opens. */
const ThemeGallery = lazy(() => import("./ThemeGallery").then((m) => ({ default: m.ThemeGallery })));
const SubscriptionGrid = lazy(() => import("./SubscriptionGrid"));
import { setSettingsTab, settingsTab, type SettingsTab } from "../state/ui";
import { loadSimulatorState } from "../state/simulator";
import { canReveal, copyText, isDesktop, machine, mod, openExternal, os, revealPath } from "../lib/platform";
import { keybindingsFile, keymap, keyText, withShortcut } from "../state/keybindings";
import { ACTIONS, CONTEXTS, KEYBINDINGS_DOCS, formatKeys } from "../../../src/keybindings/core";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ProviderIcon } from "./ui/ProviderIcon";
import { Accounts } from "./Accounts";
import { resetToast } from "../lib/reset-toast";
import { ProvidersAtContext, useProvidersAt, type ProvidersAt } from "../state/providers-at";
import type { Rpc } from "../lib/rpc";
import { createUpdateAction } from "./UpdateAction";
import { MessageText } from "./ErrorCards";
import { commandIn } from "../lib/error-text";
import { ModeIcon, MODES } from "./ModePicker";
import { EffortSlider, modelName, refLabel } from "./ModelPicker";
import { effortLevels, effortOf } from "../lib/effort";
import { SidebarFrame } from "./Sidebar";
import { NeedsYou } from "./Header";
import { needsYou } from "../lib/rail";
import { Logo, Segmented, Spinner, Toggle } from "./ui/bits";
import { Select, type SelectOption } from "./ui/Select";
import { UsageView } from "./UsageView";
import { Plugins } from "./Plugins";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "providers", label: "Providers", icon: KeyRound },
    { id: "plugins", label: "Plugins", icon: Puzzle },
    { id: "usage", label: "Usage", icon: ChartNoAxesColumn },
    { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
    { id: "about", label: "About", icon: Info },
];

const tab = () => settingsTab() ?? "general";

function open(t: SettingsTab) {
    setSettingsTab(t);
    if (t === "providers") void refreshProviders();
    if (t === "general") void refreshSettings();
}

export function SettingsNav() {
    return (
        <SidebarFrame class="settings-side settings-nav">
            <button class="settings-back" onClick={() => setSettingsTab(undefined)}>
                <ArrowLeft size={15} />
                <span>Back to sessions</span>
                <span class="kbd-group" aria-hidden="true">
                    <kbd class="kbd">Esc</kbd>
                </span>
            </button>
            <h1 class="settings-title">Settings</h1>
            <nav class="settings-tabs" aria-label="Settings">
                <For each={TABS}>
                    {(t) => (
                        <button class={`settings-tab navi ${tab() === t.id ? "on" : ""}`} aria-current={tab() === t.id ? "page" : undefined} onClick={() => open(t.id)}>
                            <t.icon size={15} />
                            {t.label}
                        </button>
                    )}
                </For>
            </nav>
        </SidebarFrame>
    );
}

/** One setting (the design's .set-item): what it is, a few words on it, Reset while it differs from the default, then its control. */
function Row(p: { title: JSX.Element; desc?: JSX.Element; children?: JSX.Element; reset?: () => void; changed?: boolean; class?: string; hint?: string; danger?: boolean; tone?: "red"; stack?: boolean }) {
    return (
        <div class={`set-item ${p.stack ? "set-item-stack" : ""} ${p.class ?? ""}`} data-danger={p.danger || undefined} title={p.hint}>
            <div class="set-item-text">
                <span class="set-item-title" data-tone={p.tone}>{p.title}</span>
                <Show when={p.desc}>
                    <span class="set-item-sub">{p.desc}</span>
                </Show>
            </div>
            <Show when={p.reset && p.changed}>
                <button class="icon-btn icon-btn-sm set-reset" data-tip="Reset" aria-label={`Reset ${String(p.title).toLowerCase()}`} onClick={() => p.reset!()}>
                    <RotateCcw size={13} />
                </button>
            </Show>
            <Show when={p.children !== undefined}>
                <div class="set-item-control">{p.children}</div>
            </Show>
        </div>
    );
}

/**
 * A titled block (the design's .set-section): its heading, and a line under it, on the left; its settings beside it,
 * in a card unless `bare` (the page's own pieces: a paste box, a list of keys).
 */
function Section(p: { title?: JSX.Element; caption?: JSX.Element; children: JSX.Element; class?: string; bare?: boolean; before?: JSX.Element }) {
    return (
        <section class="set-section">
            <header class="set-section-head">
                <Show when={p.title}>
                    <h3 class="set-h">{p.title}</h3>
                </Show>
                <Show when={p.caption}>
                    <p class="set-sub">{p.caption}</p>
                </Show>
            </header>
            <div class="set-section-body">
                {p.before}
                <Show when={!p.bare} fallback={p.children}>
                    <div class={`card set-card ${p.class ?? ""}`}>{p.children}</div>
                </Show>
            </div>
        </section>
    );
}

/** "" clears a model (undefined wouldn't reach the server: JSON leaves it out). */
async function update(patch: GuiSettings) {
    try {
        setApp("settings", await rpc.call("settings.update", { patch }));
    } catch (e) {
        reportError(e);
    }
}

/** The design's select width in Settings. */
const SEL_W = 264;

function ModelSelect(p: { value?: string; onChange: (v: string) => void; empty: string; label: string; apiOnly?: boolean }) {
    // Claude Code and Codex run whole turns: they can't answer a one-off request.
    const groups = () => (p.apiOnly ? app.models.filter((g) => app.providers.find((x) => x.id === g.provider.split("@")[0])?.kind !== "agent") : app.models);
    const provider = () => (p.value ? app.models.find((g) => g.models.some((m) => m.ref === p.value)) : undefined);
    // Saved but not listed (its provider removed or turned off, or a model typed by hand): shown as such, never blank or as its id.
    const unlisted = () => (p.value && app.models.length && !provider() ? refLabel(p.value, app.models) : undefined);
    const options = (): SelectOption[] => {
        const u = unlisted();
        return [
            { value: "", label: p.empty },
            ...(u ? [{ value: p.value!, label: u.provider ? `${u.name} · ${u.provider}` : u.name, disabled: true }] : []),
            // Named as the model picker names it: "Opus 5.5", not "Opus 5.5 (claude-opus-5-5)".
            ...groups().flatMap((g) => g.models.map((m, i) => ({ value: m.ref, label: modelName(m), group: i === 0 ? g.providerName : undefined, icon: <ProviderIcon id={g.provider} name={g.providerName} size={14} /> }))),
        ];
    };
    return <Select label={p.label} value={p.value ?? ""} options={options()} width={SEL_W} onChange={p.onChange} />;
}

/** The design's slider with named stops (settings/parts.tsx StopSlider). Arrow keys, Home and End move it. */
function StopSlider(p: { value: string; stops: { id: string; name: string }[]; onChange: (v: string) => void; label: string }) {
    const at = () => Math.max(0, p.stops.findIndex((s) => s.id === p.value));
    const last = () => p.stops.length - 1;
    const pick = (i: number) => {
        const s = p.stops[Math.min(last(), Math.max(0, i))]!;
        if (s.id !== p.value) p.onChange(s.id);
    };
    const pos = (i: number) => `calc(7 * var(--sp) + (100% - 14 * var(--sp)) * ${last() ? i / last() : 0})`;
    return (
        <div class="stopslider">
            <span class="stopslider-label">{p.stops[at()]?.name}</span>
            <div
                class="stopslider-track"
                role="slider"
                tabIndex={0}
                aria-label={p.label}
                aria-valuemin={0}
                aria-valuemax={last()}
                aria-valuenow={at()}
                aria-valuetext={p.stops[at()]?.name}
                onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowDown") pick(at() - 1);
                    else if (e.key === "ArrowRight" || e.key === "ArrowUp") pick(at() + 1);
                    else if (e.key === "Home") pick(0);
                    else if (e.key === "End") pick(last());
                    else return;
                    e.preventDefault();
                }}
                onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const el = e.currentTarget;
                    const move = (x: number) => {
                        const box = el.getBoundingClientRect();
                        pick(Math.round(((x - box.left - sp(7)) / (box.width - sp(14))) * last()));
                    };
                    move(e.clientX);
                    el.setPointerCapture(e.pointerId);
                    const onMove = (ev: PointerEvent) => move(ev.clientX);
                    const onUp = () => {
                        el.removeEventListener("pointermove", onMove);
                        el.removeEventListener("pointerup", onUp);
                    };
                    el.addEventListener("pointermove", onMove);
                    el.addEventListener("pointerup", onUp);
                }}
            >
                <span class="stopslider-fill" style={{ width: pos(at()) }} />
                <For each={p.stops}>{(_, i) => <i class="stopslider-stop" data-on={i() <= at() || undefined} style={{ left: pos(i()) }} />}</For>
                <span class="stopslider-thumb" style={{ left: pos(at()) }} />
            </div>
        </div>
    );
}

// Confirmation can be dismissed and Settings remounted while the request runs.
const [enablingBypass, setEnablingBypass] = createSignal(false);

async function enableBypass() {
    if (enablingBypass()) return;
    setEnablingBypass(true);
    try {
        await update({ allowBypass: true });
    } finally {
        setEnablingBypass(false);
    }
}

function General() {
    const [confirmBypass, setConfirmBypass] = createSignal(false);
    const s = () => app.settings;
    createEffect(
        on(
            () => app.conn,
            (conn) => {
                // Settings too: what this computer allows (keeping it awake) can change as sessions run.
                if (conn === "open") void Promise.all([refreshEditors(), refreshSettings()]);
            },
        ),
    );
    // The chosen editor stays listed when it's gone, so the choice isn't silently lost.
    const editorChoices = () => editors().filter((e) => e.installed || e.id === s().editor);
    const editorOptions = (): SelectOption[] => [
        { value: "", label: s().editor ? "None" : "Choose an editor", disabled: !s().editor },
        ...editorChoices().map((e) => ({ value: e.id, label: e.name, note: !e.installed ? "(not found)" : e.lines || e.id === "finder" ? undefined : "(without line numbers)" })),
    ];
    const effortStops = [{ id: "", name: "Provider's default" }, ...effortLevels(undefined).map((e) => ({ id: e.id as string, name: e.label }))];
    return (
        <>
            <Section title="Defaults for new sessions">
                <Row title="Model">
                    <ModelSelect label="Model" value={s().model} empty="Automatic" onChange={(v) => void update({ model: v })} />
                </Row>
                <Row title="Small model" desc="Titles, summaries and git drafts">
                    <ModelSelect label="Small model" value={s().smallModel} empty="Provider's small default" onChange={(v) => void update({ smallModel: v })} />
                </Row>
                <Row title="Auto-mode reviewer" desc="Checks API models' actions in Auto">
                    <ModelSelect apiOnly label="Auto-mode reviewer" value={s().reviewModel} empty="Sonnet 5.5, or the session's model" onChange={(v) => void update({ reviewModel: v })} />
                </Row>
                <Row title="Permission mode" desc="Shift-Tab cycles it in the composer">
                    <Select
                        label="Permission mode"
                        width={SEL_W}
                        value={s().defaultMode ?? "default"}
                        onChange={(v) => void update({ defaultMode: v as PermissionModeId })}
                        options={MODES.filter((m) => m !== "bypassPermissions" || s().allowBypass).map((m) => ({ value: m, label: MODE_LABELS[m].label, icon: <ModeIcon mode={m} size={14} /> }))}
                    />
                </Row>
                {/* Every level: it's where new sessions start, whatever their model. */}
                <Row title="Reasoning effort">
                    <StopSlider label="Reasoning effort" value={s().effort ?? ""} stops={effortStops} onChange={(v) => void update({ effort: v as EffortLevel })} />
                </Row>
            </Section>
            <Section title="Conversation">
                <Row title="Show thinking" desc="The model's reasoning, when the provider shares it">
                    <Toggle
                        label="Show thinking"
                        checked={prefs.showThinking}
                        onChange={(v) => {
                            setPrefs("showThinking", v);
                            void update({ showThinking: v });
                        }}
                    />
                </Row>
                <Row title="Compact automatically" desc="When the context fills up">
                    <Toggle label="Compact automatically" checked={s().autoCompact !== false} onChange={(v) => void update({ autoCompact: v })} />
                </Row>
                <Row title="Messages sent while working" desc={`${mod}+Shift+Enter does the other for one message`}>
                    <Select
                        label="Messages sent while working"
                        width={SEL_W}
                        value={s().followUpBehavior ?? "steer"}
                        onChange={(v) => void update({ followUpBehavior: v as FollowUpMode })}
                        options={[
                            { value: "steer", label: "Steer the current turn" },
                            { value: "queue", label: "Queue for after it" },
                        ]}
                    />
                </Row>
                <Row
                    title="Compact while idle"
                    // Unset arrives as null over the wire: only a real choice shows Reset.
                    changed={s().idleCompaction === false || s().idleCompaction === "always"}
                    reset={() => void update({ idleCompaction: true })}
                >
                    <Select
                        label="Compact while idle"
                        width={SEL_W}
                        disabled={s().autoCompact === false}
                        title={s().autoCompact === false ? "Turn on Compact automatically to use this" : undefined}
                        value={s().autoCompact === false || s().idleCompaction === false ? "off" : s().idleCompaction === "always" ? "always" : "hour"}
                        onChange={(v) => void update({ idleCompaction: v === "always" ? "always" : v === "off" ? false : true })}
                        options={[
                            { value: "hour", label: "After an hour away" },
                            { value: "always", label: "After five minutes too" },
                            { value: "off", label: "Off" },
                        ]}
                    />
                </Row>
                <Row title="Web search">
                    <Select
                        label="Web search"
                        width={SEL_W}
                        value={s().webSearch ?? "auto"}
                        onChange={(v) => void update({ webSearch: v })}
                        options={[
                            { value: "auto", label: "Automatic" },
                            { value: "anthropic", label: "Anthropic (built in)" },
                            { value: "brave", label: "Brave" },
                            { value: "tavily", label: "Tavily" },
                            { value: "duckduckgo", label: "DuckDuckGo" },
                            { value: "off", label: "Off" },
                        ]}
                    />
                </Row>
                <Row title="Browser" desc="Agents can open and use web pages">
                    <Toggle label="Browser" checked={s().browser !== false} onChange={(v) => void update({ browser: v })} />
                </Row>
                <Show when={app.hello?.platform === "darwin"}>
                    <Row title="Simulator" desc="Agents can use iOS simulators">
                        <Toggle label="Simulator" checked={s().simulator !== false} onChange={(v) => void update({ simulator: v }).then(() => (app.activeId ? loadSimulatorState(app.activeId) : undefined)).catch(() => undefined)} />
                    </Row>
                </Show>
                <Row title="Expand tool activity" desc="Show every step of a finished turn">
                    <Toggle label="Expand tool activity" checked={prefs.expandActivity} onChange={(v) => setPrefs("expandActivity", v)} />
                </Row>
                <Row title="Enter sends" desc={`Off: ${mod}Enter sends, Enter adds a line`}>
                    <Toggle label="Enter sends" checked={prefs.enterSends} onChange={(v) => setPrefs("enterSends", v)} />
                </Row>
            </Section>
            <Section title="Sidebar">
                <Row title="Settle idle sessions after" changed={(s().autoSettleDays ?? 7) !== 7} reset={() => void update({ autoSettleDays: 7 })}>
                    <Select
                        label="Settle idle sessions after"
                        width={SEL_W}
                        value={String(s().autoSettleDays ?? 7)}
                        onChange={(v) => void update({ autoSettleDays: Number(v) })}
                        options={[
                            { value: "0", label: "Off" },
                            { value: "1", label: "1 day" },
                            { value: "3", label: "3 days" },
                            { value: "7", label: "7 days" },
                            { value: "14", label: "14 days" },
                        ]}
                    />
                </Row>
            </Section>
            <Section title="This computer">
                <Row title="Open files with">
                    <Select label="Open files with" width={SEL_W} value={s().editor ?? ""} options={editorOptions()} onChange={(v) => void update({ editor: v })} />
                </Row>
                <Row title="Notifications" desc="When a session finishes or needs you">
                    <Toggle label="Notifications" checked={prefs.notifications} onChange={(v) => setPrefs("notifications", v)} />
                </Row>
                <Row title="Keep computer awake while agents work" desc={s().keepAwakeUnavailable ? "Not available on this computer." : undefined}>
                    {/* Unavailable: off, as it acts; the choice is kept for when it works (another computer, a fixed install). */}
                    <Toggle label="Keep computer awake while agents work" checked={s().keepAwake !== false && !s().keepAwakeUnavailable} disabled={s().keepAwakeUnavailable} onChange={(v) => void update({ keepAwake: v })} />
                </Row>
                {/* On one of the user's servers Bypass can always be chosen: there's nothing to allow. */}
                <Show when={!s().bypassAlways}>
                    <Row title="Allow bypass mode" desc="Bypass runs everything without asking" danger changed={Boolean(s().allowBypass)} reset={() => void update({ allowBypass: false })}>
                        <Toggle tone="danger" label="Allow bypass mode" checked={Boolean(s().allowBypass)} onChange={(v) => (v ? setConfirmBypass(true) : void update({ allowBypass: false }))} />
                    </Row>
                </Show>
            </Section>
            <ConfirmDialog
                open={confirmBypass()}
                onClose={() => setConfirmBypass(false)}
                title="Allow bypass mode?"
                confirmLabel="Allow bypass mode"
                busy={enablingBypass()}
                onConfirm={enableBypass}
            >
                Sessions will run everything without asking: use it only in a sandbox or container.
            </ConfirmDialog>
        </>
    );
}

const TINTS: { id: typeof prefs.tint; label: string }[] = [
    { id: "clear", label: "Clear" },
    { id: "ocean", label: "Ocean" },
    { id: "accent", label: "Accent" },
];

/** Settings → Appearance: the theme (its scheme, the gallery), then the look, then text and layout. */
function Appearance() {
    const size = (n: number) => setPrefs("fontSize", Math.max(12, Math.min(18, n)));
    // Blue is the default: picking it clears the choice.
    const accent = () => prefs.accent ?? "blue";
    const pickAccent = (id: AccentId) => setPrefs("accent", id === "blue" ? undefined : id);
    // What a theme sets, the settings for it step aside for: the window's glass and tint under a scene, the accent it chooses.
    const scened = () => Boolean(themeTraits()?.scened);
    const themeAccent = () => Boolean(themeTraits()?.accent);
    return (
        <>
            <Section title="Theme">
                {/* The scheme picks which of a theme's looks shows, so it sits with them; a theme with one look sets it. */}
                <Row title="Color scheme" desc={forcedScheme() ? `${themeTraits()?.name ?? "This theme"} is ${forcedScheme()} only` : undefined} changed={prefs.scheme !== PREF_DEFAULTS.scheme} reset={() => setPrefs("scheme", PREF_DEFAULTS.scheme)}>
                    <Segmented
                        label="Color scheme"
                        value={prefs.scheme}
                        onChange={(v) => setPrefs("scheme", v)}
                        options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1), disabled: Boolean(forcedScheme()) }))}
                    />
                </Row>
                <Suspense>
                    <ThemeGallery />
                </Suspense>
                <Show when={scened()}>
                    <Row title="Animate" desc="Off: the scene holds still" changed={!prefs.themeMotion} reset={() => setPrefs("themeMotion", true)}>
                        <Toggle label="Animate" checked={prefs.themeMotion} onChange={(v) => setPrefs("themeMotion", v)} />
                    </Row>
                </Show>
            </Section>

            <Section title="Look">
                <Show when={!themeAccent()}>
                    <Row title="Accent" changed={accent() !== "blue"} reset={() => setPrefs("accent", undefined)}>
                        <div class="swatches" role="radiogroup" aria-label="Accent">
                            <For each={ACCENTS}>
                                {(a) => (
                                    <button class="swatch" role="radio" aria-checked={accent() === a.id} style={{ "--swatch": a.color }} data-tip={a.name} aria-label={a.name} onClick={() => pickAccent(a.id)}>
                                        <Show when={accent() === a.id}>
                                            <Check size={11} stroke-width={3.2} />
                                        </Show>
                                    </button>
                                )}
                            </For>
                        </div>
                    </Row>
                </Show>
                <Show when={!scened()}>
                    <Row title="Window" changed={prefs.glass !== PREF_DEFAULTS.glass} reset={() => setPrefs("glass", PREF_DEFAULTS.glass)}>
                        <Segmented
                            label="Window"
                            value={prefs.glass}
                            onChange={(v) => setPrefs("glass", v)}
                            options={[
                                { value: "glass", label: "Glass" },
                                { value: "tinted", label: "Tinted" },
                                { value: "solid", label: "Solid" },
                            ]}
                        />
                    </Row>
                </Show>
                <Show when={!prefs.themeId}>
                    <Row title="Window tint" changed={prefs.tint !== PREF_DEFAULTS.tint} reset={() => setPrefs("tint", PREF_DEFAULTS.tint)}>
                        <div class="tints" role="radiogroup" aria-label="Window tint">
                            <For each={TINTS}>
                                {(t) => (
                                    <button class="tint" role="radio" aria-checked={prefs.tint === t.id} data-tint={t.id} onClick={() => setPrefs("tint", t.id)}>
                                        <span class="tint-art" />
                                        <span class="tint-name">{t.label}</span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </Row>
                </Show>
                <Row title="Contrast" changed={prefs.contrast !== PREF_DEFAULTS.contrast} reset={() => setPrefs("contrast", PREF_DEFAULTS.contrast)}>
                    <Segmented
                        label="Contrast"
                        value={prefs.contrast}
                        onChange={(v) => setPrefs("contrast", v)}
                        options={[
                            { value: "standard", label: "Standard" },
                            { value: "high", label: "Increased" },
                        ]}
                    />
                </Row>
            </Section>

            <Section title="Text and layout">
                <Row title="Text size" changed={prefs.fontSize !== PREF_DEFAULTS.fontSize} reset={() => setPrefs("fontSize", PREF_DEFAULTS.fontSize)}>
                    <div class="stepper" role="group" aria-label="Text size">
                        <button class="stepper-btn" aria-label="Smaller text" disabled={prefs.fontSize <= 12} onClick={() => size(prefs.fontSize - 1)}>
                            <Minus size={13} />
                        </button>
                        <span class="stepper-value num" aria-live="polite" aria-label={`${prefs.fontSize} pixels`}>
                            {prefs.fontSize}
                        </span>
                        <button class="stepper-btn" aria-label="Larger text" disabled={prefs.fontSize >= 18} onClick={() => size(prefs.fontSize + 1)}>
                            <Plus size={13} />
                        </button>
                    </div>
                </Row>
                <div class="set-item set-preview" aria-label="Preview">
                    <p class="text-sample">
                        Renamed <code>parseConfig</code> and updated the three places that call it.
                    </p>
                </div>
                <Row title="Density" changed={prefs.density !== PREF_DEFAULTS.density} reset={() => setPrefs("density", PREF_DEFAULTS.density)}>
                    <Segmented
                        label="Density"
                        value={prefs.density}
                        onChange={(v) => setPrefs("density", v)}
                        options={[
                            { value: "comfortable", label: "Comfortable" },
                            { value: "compact", label: "Compact" },
                        ]}
                    />
                </Row>
                <Row title="Chat width" changed={prefs.chatWidth !== PREF_DEFAULTS.chatWidth} reset={() => setPrefs("chatWidth", PREF_DEFAULTS.chatWidth)}>
                    <Segmented
                        label="Chat width"
                        value={prefs.chatWidth}
                        onChange={(v) => setPrefs("chatWidth", v)}
                        options={(Object.keys(CHAT_WIDTHS) as (keyof typeof CHAT_WIDTHS)[]).map((w) => ({ value: w, label: w === "narrow" ? "Narrow" : w === "wide" ? "Wide" : "Standard", title: `${CHAT_WIDTHS[w]}px` }))}
                    />
                </Row>
                <Row title="Panel animations" changed={prefs.motion !== PREF_DEFAULTS.motion} reset={() => setPrefs("motion", PREF_DEFAULTS.motion)}>
                    <Segmented
                        label="Panel animations"
                        value={prefs.motion}
                        onChange={(v) => setPrefs("motion", v)}
                        options={[
                            { value: "instant", label: "Instant" },
                            { value: "quick", label: "Quick" },
                            { value: "smooth", label: "Smooth" },
                        ]}
                    />
                </Row>
            </Section>
        </>
    );
}

/**
 * The servers' state and what's done to them (state/servers.ts), which comes with their own code: asked for when
 * Providers opens on a computer that has servers, so a window doesn't start with it. Until then there are none to show.
 */
const [servers, setServers] = createSignal<typeof import("./Servers")>();
const serverList = () => servers()?.serverList() ?? [];

/** connectCli (state/actions.ts) for a server shown from here: asked of the Cavvy there, whose providers are read again. */
async function connectThere(pr: ProviderInfo, at: ProvidersAt, failed: (e: unknown) => void): Promise<boolean> {
    try {
        const r = await at.link.call("providers.connectCli", { provider: pr.id });
        toast(`Using your ${pr.agentCli?.plan ?? pr.name} on ${at.server} (${r.description})`, "success");
        if (r.warning) toast(r.warning, "warn");
    } catch (e) {
        failed(e);
        return false;
    }
    await at.changed().catch(reportError);
    return true;
}

const [removingProviders, setRemovingProviders] = createSignal<ReadonlySet<string>>(new Set());

function ProviderRow(p: { pr: ProviderInfo }) {
    const at = useProvidersAt();
    const [confirmRemove, setConfirmRemove] = createSignal(false);
    const [adding, setAdding] = createSignal(false);
    const [key, setKey] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    // A failure of the row's own action (connecting, saving its key) shows on the row, with its fix,
    // for as long as it's true, and not also as an error card.
    const [failure, setFailure] = createSignal<{ message: string; tag: string }>();
    // Arriving, the row flashes; the name alternates so a second failure flashes again.
    const [flash, setFlash] = createSignal<"a" | "b">();
    const failed = (e: unknown, tag: string) => {
        setFailure({ message: e instanceof Error ? e.message : String(e), tag });
        setFlash((f) => (f === "a" ? "b" : "a"));
    };
    createEffect(on(() => p.pr.configured, (configured) => configured && setFailure(undefined)));
    // A key that wasn't saved is wrong only while it's still there to save.
    createEffect(on(adding, (open) => !open && !p.pr.agentCli && setFailure(undefined), { defer: true }));
    const copyCommand = async (command: string) => {
        const copied = await copyText(command);
        toast(copied ? `Copied ${command}` : "Couldn't copy the command", copied ? "success" : "info");
    };
    const save = async () => {
        setBusy(true);
        try {
            const r = await at.link.call("providers.setKey", { provider: p.pr.id, key: key() }).catch((e: unknown) => void failed(e, "Key not saved"));
            if (!r) return;
            setFailure(undefined);
            toast(`Saved the ${p.pr.name} key ${r.masked}`, "success");
            if (r.warning) toast(r.warning, "warn");
            setAdding(false);
            setKey("");
            await at.changed();
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        const { name, agentCli } = p.pr;
        // One machine's removal doesn't hold the same provider's row on another.
        const id = `${at.server ?? ""}:${p.pr.id}`;
        if (removingProviders().has(id)) return;
        setRemovingProviders((ids) => new Set(ids).add(id));
        try {
            const r = await at.link.call("providers.removeKey", { provider: p.pr.id });
            await at.changed();
            toast(agentCli ? `Turned off ${name}; it stays signed in` : `Removed the ${name} key`);
            resetToast(r?.reset);
        } catch (e) {
            reportError(e);
        } finally {
            setRemovingProviders((ids) => {
                const remaining = new Set(ids);
                remaining.delete(id);
                return remaining;
            });
        }
    };
    // connectCli's request (state/actions.ts), with its failure kept for the row: "Use my plan", and Check again.
    const connect = async () => {
        if (busy()) return;
        setBusy(true);
        try {
            // A failure shows on this row, not as an error card.
            const refused = (e: unknown) => {
                const code = (e as { code?: string }).code;
                failed(e, code === "not_signed_in" ? "Not signed in" : code === "not_installed" ? "Not installed" : "Couldn't connect");
            };
            const ok = at.server ? await connectThere(p.pr, at, refused) : await connectCli(p.pr, refused);
            if (ok) setFailure(undefined);
        } finally {
            setBusy(false);
        }
    };
    const badTag = (tag: string) => (
        <span class="tag bad" data-tone="red">
            <CircleAlert size={10} stroke-width={2.5} />
            {tag}
        </span>
    );
    /** The fix: the command the message names, to copy, and (for a CLI) the check again. */
    const fix = (message: string, retry?: () => void) => (
        <>
            <Show when={commandIn(message)}>
                {(command) => (
                    <button class="btn btn-sm btn-ghost" onClick={() => void copyCommand(command())}>
                        Copy command
                    </button>
                )}
            </Show>
            <Show when={retry}>
                <button class="btn btn-sm" disabled={busy()} onClick={() => retry!()}>
                    <Show when={busy()} fallback="Check again">
                        <Spinner size={12} />
                        Checking
                    </Show>
                </button>
            </Show>
        </>
    );
    const removable = () => p.pr.requiresKey && p.pr.configured && !p.pr.source?.startsWith("$");
    // The line under the name: the key as stored (masked), or what's missing.
    const sub = () =>
        p.pr.masked ? undefined
        : !p.pr.configured ? (p.pr.requiresKey ? "Not set up" : p.pr.id === "vertex" ? "Run cavvy auth add vertex in a terminal" : "Set up in the terminal")
        : p.pr.local ? "Running" : "Connected";
    const closeAdd = () => {
        setAdding(false);
        setKey("");
    };
    return (
        <div class="prov" classList={{ err: !!failure() }} data-flash={failure() ? flash() : undefined}>
            <ConfirmDialog
                open={confirmRemove()}
                onClose={() => setConfirmRemove(false)}
                title={p.pr.agentCli ? `Turn off ${p.pr.name}?` : `Remove the ${p.pr.name} key?`}
                confirmLabel={p.pr.agentCli ? "Turn off" : "Remove"}
                busy={removingProviders().has(`${at.server ?? ""}:${p.pr.id}`)}
                onConfirm={remove}
            >
                {p.pr.agentCli ? "Its models leave the picker. Your sign-in stays." : "Sessions on its models stop until you add one again."}
            </ConfirmDialog>
            {/* Claude Code and Codex: their row, accounts and menus are in Accounts. */}
            <Show
                when={!p.pr.agentCli}
                fallback={
                    <>
                        <Accounts provider={p.pr} connecting={busy()} onConnect={() => void connect()} onTurnOff={() => setConfirmRemove(true)} />
                        {/* Accounts draws the CLI's line, so what's wrong goes on a line of its own under it. */}
                        <Show when={failure()}>
                            {(f) => (
                                <div class="prov-err-line">
                                    <div class="prov-err-msg selectable" role="alert">
                                        {badTag(f().tag)}
                                        <MessageText text={f().message} />
                                    </div>
                                    <span class="prov-fix">{fix(f().message, () => void connect())}</span>
                                </div>
                            )}
                        </Show>
                    </>
                }
            >
                <div class="row prow">
                    <ProviderIcon id={p.pr.id} name={p.pr.name} size={18} class="prow-icon" />
                    <div class="row-text">
                        <span class="prow-name">
                            <span class="row-title">{p.pr.name}</span>
                            <Show when={p.pr.local}>
                                <span class="tag" data-tone="neutral">local</span>
                            </Show>
                            <Show when={!failure() && p.pr.source && p.pr.source !== "local"}>
                                <span class="tag" data-tone="neutral" title="Where the key comes from">{p.pr.source}</span>
                            </Show>
                            <Show when={failure()}>{(f) => badTag(f().tag)}</Show>
                        </span>
                        <Show
                            when={failure()}
                            fallback={
                                <span class={`row-sub ${p.pr.masked ? "mono" : ""}`}>{p.pr.masked ?? sub()}</span>
                            }
                        >
                            {(f) => (
                                <span class="row-sub prow-problem selectable" role="alert">
                                    <MessageText text={f().message} />
                                </span>
                            )}
                        </Show>
                    </div>
                    <Show
                        when={adding()}
                        fallback={
                            <div class="prow-actions">
                                {/* Saving again is the key's own Save. */}
                                <Show when={failure() && commandIn(failure()!.message)}>{fix(failure()!.message)}</Show>
                                <Show when={p.pr.requiresKey && !p.pr.configured && p.pr.keyUrl}>
                                    <button class="btn btn-sm btn-ghost" onClick={() => void openExternal(p.pr.keyUrl!)}>
                                        Get a key
                                    </button>
                                </Show>
                                <Show when={p.pr.requiresKey && !p.pr.configured}>
                                    <button class="btn btn-sm" aria-expanded={adding()} onClick={() => setAdding(true)}>
                                        Add key
                                    </button>
                                </Show>
                                <Show when={removable()} fallback={<span class="prow-slot" />}>
                                    <button class="icon-btn icon-btn-sm" data-tip="Remove key" aria-label={`Remove the ${p.pr.name} key`} onClick={() => setConfirmRemove(true)}>
                                        <X size={13} />
                                    </button>
                                </Show>
                            </div>
                        }
                    >
                        <form
                            class="prow-add"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void save();
                            }}
                        >
                            <input
                                class="input input-sm mono"
                                type="password"
                                autofocus
                                aria-label={`${p.pr.name} key`}
                                placeholder="Paste the key"
                                value={key()}
                                onInput={(e) => setKey(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key !== "Escape") return;
                                    // Its own: not also leaving Settings (App.tsx's Esc skips a handled key).
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closeAdd();
                                }}
                            />
                            <button type="button" class="btn btn-sm btn-primary" disabled={!key().trim() || busy()} onClick={() => void save()}>
                                {busy() ? <Spinner size={12} /> : "Save"}
                            </button>
                            <button type="button" class="btn btn-sm btn-ghost" onClick={closeAdd}>
                                Cancel
                            </button>
                        </form>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/** One machine's providers: the rows are the same for the window's own machine and for a server shown from it. */
function ProviderSections(p: { noSubscriptions?: boolean; localOnly?: boolean; synced?: boolean }) {
    const at = useProvidersAt();
    const [key, setKey] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const quickAdd = async () => {
        setBusy(true);
        try {
            const r = await at.link.call("providers.setKey", { key: key() });
            toast(`Saved a ${r.provider} key ${r.masked}`, "success");
            if (r.warning) toast(r.warning, "warn");
            setKey("");
            await at.changed();
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(false);
        }
    };
    // The server they're on: one shown from here, or the one this window is on. Undefined: this computer.
    const server = () => at.server ?? machine;
    const where = () => server() ?? "this computer";
    const LOCAL = "On this computer";
    // Grouped as the mockup has them: subscriptions (the CLIs), API keys, models on that machine, then web search.
    const models = () => at.list().filter((p) => !p.search);
    const groups = () => [
        // With servers, subscriptions are one table across machines above these (SubscriptionGrid.tsx).
        { title: "Subscriptions", list: p.noSubscriptions ? [] : models().filter((p) => p.agentCli) },
        { title: "API keys", list: models().filter((p) => !p.agentCli && !p.local) },
        { title: LOCAL, list: models().filter((p) => !p.agentCli && p.local) },
        { title: "Web search", list: at.list().filter((p) => p.search) },
    ].filter((g) => g.list.length && (!p.localOnly || g.title === LOCAL));
    const keyBox = () => (
        <form
            class="paste"
            onSubmit={(e) => {
                e.preventDefault();
                void quickAdd();
            }}
        >
            <div class="paste-line">
                <input class="input mono" type="password" aria-label="API key" placeholder="Paste a key from any provider" value={key()} onInput={(e) => setKey(e.currentTarget.value)} />
                <button type="submit" class="btn" disabled={!key().trim() || busy()}>
                    <Show when={busy()}>
                        <Spinner size={13} />
                    </Show>
                    Add
                </button>
            </div>
            <p class="paste-note">
                Kept on {p.synced ? "this computer and the servers you sync" : where()}, sent only to their provider. Custom endpoints: <code>/login custom</code> in the terminal app
            </p>
        </form>
    );
    // API keys always shows, for the box that adds one.
    const sections = () => p.localOnly || groups().some((g) => g.title === "API keys") ? groups() : [...groups().slice(0, 1), { title: "API keys", list: [] }, ...groups().slice(1)];
    return (
        <For each={sections()}>
            {(g) => (
                <Section
                    title={g.title === LOCAL && server() ? `On ${server()}` : g.title}
                    caption={g.title === "Subscriptions" ? "Plans you use through their own CLI" : undefined}
                    class="prov-group"
                    before={g.title === "API keys" ? keyBox() : undefined}
                >
                    <For each={g.list}>{(pr) => <ProviderRow pr={pr} />}</For>
                </Section>
            )}
        </For>
    );
}

/** A server's own local models (a model server there), read over a connection of this window's own to the Cavvy there. Nothing while it isn't reached. */
function ServerLocalModels(p: { name: string }) {
    const [state, setState] = createStore<{ list: ProviderInfo[] }>({ list: [] });
    const [link, setLink] = createSignal<Rpc>();
    const refresh = async () => {
        const l = link();
        if (l) setState("list", reconcile(await l.call("providers.list", {}), { key: "id" }));
    };
    onMount(() => {
        void linkFor(p.name).then((l) => (setLink(l), refresh())).catch(() => undefined);
    });
    return (
        <Show when={link()}>
            {(l) => (
                <ProvidersAtContext.Provider value={{ server: p.name, link: l(), list: () => state.list, refresh, changed: refresh }}>
                    <ProviderSections localOnly />
                </ProvidersAtContext.Provider>
            )}
        </Show>
    );
}

function Providers() {
    // The user's servers (state/servers.ts), offered from their own computer, by name: the order they're kept in
    // changes as they're changed.
    const listed = createMemo(() => [...serverList()].sort((a, b) => a.name.localeCompare(b.name)));
    onMount(() => {
        if (!machine && !app.hello?.servers) return;
        void serversUi().then((m) => (setServers(() => m), m.refreshServerList())).catch(() => undefined);
    });
    const withServers = () => listed().length > 0;
    // Subscriptions are signed in on each machine: one table across them, the same in a window on any of them. Keys
    // go with sync; a server's own local models are its own.
    return (
        <>
            <Show when={withServers()}>
                <Section title="Subscriptions" caption="Plans you use through their own CLI, on each computer" class="prov-group sg-card">
                    <Suspense fallback={<div class="set-item"><Spinner size={12} /></div>}>
                        <SubscriptionGrid here={servers()?.HERE ?? ""} servers={listed().map((s) => s.name)} touched={() => servers()?.serverTouched() ?? 0} manage={(pr) => <ProviderRow pr={pr} />} />
                    </Suspense>
                </Section>
            </Show>
            <ProviderSections noSubscriptions={withServers()} synced={!machine && listed().some((s) => s.syncOn)} />
            <Show when={!machine && withServers()}>
                <For each={listed()}>{(s) => <ServerLocalModels name={s.name} />}</For>
            </Show>
        </>
    );
}

// Shift as the keymap's own rows write it: a symbol on macOS, where a key's parts run together (keyText).
const shift = os === "macos" ? "⇧" : "Shift";

/** Keys that aren't in the keybindings file: they belong to what's on screen. */
const BUILT_IN: [string, string][] = [
    [`${mod}+1…9`, "Pick a model, in the model picker"],
    ["Esc", "Deny a request, or close what's open"],
    ["1  2  3", "Answer a request"],
    [`${mod}+${shift}+Enter`, "Steer instead of queue, or the reverse"],
    ["@", "Mention a file"],
    ["/", "Commands"],
    ["!", "Run a shell command"],
    // Mouse gestures and arrows in the session list: not bindings.
    [`${shift}+Click`, "Select a range of sessions"],
    [`${mod}+Click`, "Add a session to the selection, or remove it"],
    [`${shift}+↑  ${shift}+↓`, "Extend the session selection"],
];

const CONTEXT_TITLES: Record<string, string> = { Global: "Anywhere", Chat: "In the input box", Autocomplete: "In the / and @ menu", Sidebar: "In the session list" };

/** One keystroke as the design's key caps (Kbd): "⌘K" as ⌘ and K, "Ctrl+K" as Ctrl and K. */
function Cap(p: { keys: string }) {
    const caps = () => {
        const t = keyText(p.keys);
        if (t.includes("+") && t.length > 1) return t.split("+").filter(Boolean);
        const mods = /^[⌘⇧⌥⌃]+/.exec(t)?.[0] ?? "";
        return [...mods, ...(t.slice(mods.length) ? [t.slice(mods.length)] : [])];
    };
    return (
        <span class="kbd-group" aria-hidden="true">
            <For each={caps()}>{(k) => <kbd class="kbd">{k}</kbd>}</For>
        </span>
    );
}

/** One key sequence as key caps: a chord's strokes one after another. */
function KeySeq(p: { keys: string }) {
    return <For each={p.keys.split(" ")}>{(stroke, i) => <>{i() > 0 && <span class="keys-or">then</span>}<Cap keys={stroke} /></>}</For>;
}

function Shortcuts() {
    const [creating, setCreating] = createSignal(false);
    const path = () => keybindingsFile()?.path ?? "~/.cavvy/keybindings.json";
    const exists = () => keybindingsFile()?.text !== undefined;
    const issues = () => keymap().issues;
    const custom = () => keymap().customized.size;
    const create = async () => {
        setCreating(true);
        try {
            const r = await rpc.call("keybindings.create", {});
            if (r.created) toast(`Created ${r.path}`, "success");
        } catch (e) {
            reportError(e);
        } finally {
            setCreating(false);
        }
    };
    const copyPath = async () => {
        if (await copyText(path())) toast("Path copied", "success");
    };
    const rows = (context: string) => ACTIONS.filter((a) => a.context === context && keymap().keysOf.has(a.id));
    return (
        <>
            <Show when={issues().length}>
                <div class="note keys-problems" data-tone="amber" role="alert">
                    <AlertTriangle size={14} />
                    <div class="note-body">
                        <p class="keys-problems-title">
                            {issues().length === 1 ? "1 problem" : `${issues().length} problems`} in your keybindings file. The rest of it still applies.
                        </p>
                        <ul>
                            <For each={issues()}>{(i) => <li class={i.level}><span class="keys-level">{i.level === "error" ? "Error" : "Warning"}</span> {i.message}</li>}</For>
                        </ul>
                    </div>
                </div>
            </Show>
            <For each={CONTEXTS}>
                {(context) => (
                    <Show when={rows(context).length}>
                        <Section title={CONTEXT_TITLES[context]} bare>
                            <dl class="keys">
                                <For each={rows(context)}>
                                    {(a) => {
                                        const keys = () => (keymap().keysOf.get(a.id) ?? []).map((k) => formatKeys(k, "gui", os));
                                        return (
                                            <div class="keys-row" title={a.id}>
                                                <dt>
                                                    {a.description}
                                                    <Show when={keymap().customized.has(a.id)}>
                                                        <span class="tag" data-tone="accent" title="Set in your keybindings file">Custom</span>
                                                    </Show>
                                                </dt>
                                                <dd>
                                                    <Show when={keys().length} fallback={<span class="keys-none">Not bound</span>}>
                                                        <For each={keys()}>{(k, i) => <>{i() > 0 && <span class="keys-or">or</span>}<KeySeq keys={k} /></>}</For>
                                                    </Show>
                                                    <span class="sr-only">{keys().join(", or ")}</span>
                                                </dd>
                                            </div>
                                        );
                                    }}
                                </For>
                            </dl>
                        </Section>
                    </Show>
                )}
            </For>
            <Section title="Built in" caption="Can't be changed." bare>
                <dl class="keys">
                    <For each={BUILT_IN}>
                        {([k, d]) => (
                            <div class="keys-row">
                                <dt>{d}</dt>
                                <dd>
                                    <For each={k.split("  ")}>{(part) => <Cap keys={part} />}</For>
                                    <span class="sr-only">{k}</span>
                                </dd>
                            </div>
                        )}
                    </For>
                </dl>
            </Section>
            {/* Where the keys above are changed: the file, shared with the terminal app. A row's action name (its
                tooltip) is what the file calls it. */}
            <Section title="Your keys" caption="Shared with the terminal app.">
                <div class="row keys-file">
                    <div class="row-text">
                        <span class="row-title mono">{path()}</span>
                        <span class="row-sub">{!exists() ? "Not created yet" : custom() ? `${custom()} custom ${custom() === 1 ? "key" : "keys"}` : "No custom keys"}</span>
                    </div>
                    <a class="link-btn" href={KEYBINDINGS_DOCS} onClick={(e) => { e.preventDefault(); void openExternal(KEYBINDINGS_DOCS); }}>File format</a>
                    <Show when={exists()} fallback={<button class="btn btn-sm" disabled={creating()} onClick={() => void create()}>Create file</button>}>
                        <Show when={canReveal}>
                            <button class="btn btn-sm" onClick={() => void revealPath(path())}>Show</button>
                        </Show>
                        <button class="btn btn-sm" onClick={() => void copyPath()}>Copy path</button>
                    </Show>
                </div>
            </Section>
        </>
    );
}

/**
 * The desktop app updating itself (src/server/app-update.ts): from main, what's
 * new since this build, and Update & restart; a downloaded app, the latest
 * release, its notes, and Update & restart. The build runs while you work;
 * Cavvy restarts once it's installed. Only the desktop app shows why it can't
 * (a browser's server never updates an app).
 */
function Updates() {
    // Those on this computer: the app's restart doesn't stop a server's.
    const working = () => app.sessions.filter((s) => !s.machine && s.status === "running").length;
    const v = createMemo(() => updateView(app.update, working(), now()));
    const [asking, setAsking] = createSignal(false);
    const [all, setAll] = createSignal(false);
    const u = () => app.update!;
    const SHOWN = 4;
    // The same as the rail's icon: asks first while sessions are working.
    const update = createUpdateAction();
    async function check() {
        setAsking(true);
        try {
            setApp("update", reconcile(await rpc.call("app.update.check", {})));
        } catch (e) {
            reportError(e);
        } finally {
            setAsking(false);
        }
    }
    const shown = () => (all() ? u().changes.length : Math.min(SHOWN, u().changes.length));
    return (
        <Show when={v() && (isDesktop || !app.update?.unavailable) ? v() : undefined}>
            {(v) => (
                <>
                    <Row title={v().title} desc={v().detail} tone={!u().updating && u().failed ? "red" : undefined} class={u().updating ? "about-updating" : undefined}>
                        <Show when={v().busy}>
                            <Spinner size={14} class="about-spinner" />
                        </Show>
                        <Show when={!v().busy && v().action}>
                            {(a) => (
                                <>
                                    <Show when={canReveal && !u().updating && u().failed && u().log}>
                                        <button class="btn btn-sm btn-ghost" onClick={() => void revealPath(u().log!)}>Show log</button>
                                    </Show>
                                    <Show when={v().notes}>
                                        {(url) => <button class="btn btn-sm btn-ghost" onClick={() => void openExternal(url())}>Release notes <ExternalLink size={12} /></button>}
                                    </Show>
                                    <button class="btn btn-sm" disabled={asking()} onClick={() => void check()}>Check now</button>
                                    <Show when={a() === "update"}>
                                        <button class="btn btn-sm btn-primary" disabled={update.pending()} onClick={update.request}>
                                            Update &amp; restart
                                        </button>
                                    </Show>
                                    <Show when={a() === "restart"}>
                                        <button class="btn btn-sm btn-primary" disabled={update.pending()} onClick={update.request}>
                                            Restart
                                        </button>
                                    </Show>
                                </>
                            )}
                        </Show>
                    </Row>
                    <For each={[v().warn, v().problem].filter(Boolean)}>
                        {(w) => (
                            <div class="set-item about-warning">
                                <AlertTriangle size={14} />
                                <span>{w}</span>
                            </div>
                        )}
                    </For>
                    <For each={!u().updating ? [u().failed, u().error].filter(Boolean) : []}>
                        {(e) => (
                            <div class="set-item about-warning" data-tone="red" role="alert">
                                <CircleAlert size={14} />
                                <span>{e}</span>
                            </div>
                        )}
                    </For>
                    <Show when={!u().updating && u().changes?.length}>
                        <div class="set-item set-item-stack about-commits">
                            <span class="about-commits-title">New on main</span>
                            <ul aria-label="New on main">
                                <For each={u().changes.slice(0, shown())}>{(c) => <li><code>{c.hash}</code><span>{c.subject}</span></li>}</For>
                            </ul>
                            <Show when={u().behind > shown()}>
                                <Show when={u().changes.length > shown()} fallback={<span class="about-commits-title">and {u().behind - shown()} more</span>}>
                                    <button class="link-btn" onClick={() => setAll(true)}>and {u().behind - shown()} more</button>
                                </Show>
                            </Show>
                        </div>
                    </Show>
                    <update.Confirm />
                </>
            )}
        </Show>
    );
}

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

function About() {
    const platform = () => PLATFORMS[app.hello?.platform ?? ""] ?? app.hello?.platform ?? "—";
    return (
        <>
            <div class="about-head">
                <Logo size={56} />
                <div>
                    <p class="about-name">Cavvy</p>
                    <p class="about-version num">Version {app.hello?.version ?? "—"}</p>
                </div>
            </div>
            <Show when={app.update && (isDesktop || !app.update.unavailable)}>
                <Section title="Updates">
                    <Updates />
                </Section>
            </Show>
            <Section title="Details" bare>
                <dl class="keys about-details">
                    <div class="keys-row">
                        <dt>Data</dt>
                        <dd class="mono selectable">{app.hello?.home ?? "—"}</dd>
                    </div>
                    <div class="keys-row">
                        <dt>Platform</dt>
                        <dd>{platform()}</dd>
                    </div>
                    <div class="keys-row">
                        <dt>Connection</dt>
                        <dd>{app.conn === "open" ? "Connected" : app.conn}</dd>
                    </div>
                    <div class="keys-row">
                        <dt>Protocol</dt>
                        <dd class="num">{app.hello?.protocol ?? "—"}</dd>
                    </div>
                </dl>
            </Section>
        </>
    );
}

export function SettingsPage() {
    const label = () => TABS.find((t) => t.id === tab())?.label ?? "Settings";
    // Every session waiting on you, the open one too: Settings covers its request.
    const waiting = createMemo(() => needsYou([...app.sessions, ...app.archived]));
    let page: HTMLDivElement | undefined;
    // Each section starts at its top.
    createEffect(on(tab, () => page?.scrollTo({ top: 0 }), { defer: true }));
    return (
        <div class={`settings-sheet ${prefs.sidebar ? "" : "rail-off"} ${isDesktop && os === "macos" ? "traffic" : ""}`}>
            {/* The bar stays put; the page scrolls under it (on the window's top strip, which moves the window). */}
            <header class="main-head settings-top">
                {/* No sidebar: the way back moves up here, past the window buttons. */}
                <div class="settings-top-lead">
                    <button class="icon-btn" data-tip="Back to sessions" aria-label="Back to sessions" onClick={() => setSettingsTab(undefined)}>
                        <ArrowLeft size={16} />
                    </button>
                </div>
                {/* With the sections as pills under it (no sidebar), the pill names the section: the bar says Settings. */}
                <h2 class="settings-top-title">
                    <span class="set-t-tab">{label()}</span>
                    <span class="set-t-all">Settings</span>
                </h2>
                <span class="grow" />
                {/* Settings covers the rail and the title bar, where Needs you would be: it's here instead. */}
                <Show when={waiting().length}>
                    <NeedsYou waiting={waiting()} />
                </Show>
                <button class="icon-btn" data-tip={`${withShortcut("Close settings", "app:settings")}, or Esc`} aria-label="Close settings" onClick={() => setSettingsTab(undefined)}>
                    <X size={16} />
                </button>
            </header>
            {/* With no sidebar beside it, the sections as a row of pills. */}
            <nav class="settings-pills" aria-label="Settings sections">
                <For each={TABS}>
                    {(t) => (
                        <button class="chip" aria-current={tab() === t.id ? "page" : undefined} onClick={() => open(t.id)}>
                            {t.label}
                        </button>
                    )}
                </For>
            </nav>
            <div ref={page} class="settings-main" tabIndex={-1}>
                <div class="settings-page" data-tab={tab()}>
                    <Switch>
                        <Match when={tab() === "general"}>
                            <General />
                        </Match>
                        <Match when={tab() === "appearance"}>
                            <Appearance />
                        </Match>
                        <Match when={tab() === "providers"}>
                            <Providers />
                        </Match>
                        <Match when={tab() === "plugins"}>
                            <Plugins />
                        </Match>
                        <Match when={tab() === "usage"}>
                            <UsageView />
                        </Match>
                        <Match when={tab() === "shortcuts"}>
                            <Shortcuts />
                        </Match>
                        <Match when={tab() === "about"}>
                            <About />
                        </Match>
                    </Switch>
                </div>
            </div>
        </div>
    );
}
