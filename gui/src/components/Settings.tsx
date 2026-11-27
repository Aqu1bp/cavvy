// Settings as a page: its sections take the sidebar's place, and each
// setting is one row: what it is, what it does, its control, and a reset
// when it's been changed.

import { createEffect, createMemo, createSignal, For, lazy, Match, on, onMount, Show, Suspense, Switch, type JSX } from "solid-js";
import { AlertTriangle, ArrowLeft, ChartColumn, ChevronDown, CircleAlert, Copy, Download, ExternalLink, FolderOpen, Info, Keyboard, Minus, Palette, Plug, Plus, Puzzle, RotateCcw, SlidersHorizontal, X } from "lucide-solid";
import { MODE_LABELS, type FollowUpMode, type GuiSettings, type PermissionModeId, type ProviderInfo } from "@shared/protocol";
import { app, linkFor, refreshModels, refreshProviders, refreshSettings, reportError, rpc, serversUi, setApp, toast } from "../state/app";
import { createStore, reconcile } from "solid-js/store";
import { now } from "../lib/clock";
import { updateView } from "../lib/app-update";
import { connectCli, editors, refreshEditors } from "../state/actions";
import { ACCENTS, CHAT_WIDTHS, forcedScheme, prefs, PREF_DEFAULTS, setPrefs, type AccentId } from "../state/prefs";
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
import { ProvidersAtContext, useProvidersAt, type ProvidersAt } from "../state/providers-at";
import type { Rpc } from "../lib/rpc";
import { createUpdateAction } from "./UpdateAction";
import { MessageText } from "./ErrorCards";
import { commandIn } from "../lib/error-text";
import { ModeIcon, MODES } from "./ModePicker";
import { EffortSlider } from "./ModelPicker";
import { effortLevels, effortOf } from "../lib/effort";
import { SidebarFrame } from "./Sidebar";
import { NeedsYou } from "./Header";
import { needsYou } from "../lib/rail";
import { Logo, Segmented, Spinner, Toggle } from "./ui/bits";
import { UsageView } from "./UsageView";
import { Plugins } from "./Plugins";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "providers", label: "Providers", icon: Plug },
    { id: "plugins", label: "Plugins", icon: Puzzle },
    { id: "usage", label: "Usage", icon: ChartColumn },
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
        <SidebarFrame class="settings-nav">
            <div class="set-back-wrap">
                <button class="set-back" onClick={() => setSettingsTab(undefined)}>
                    <ArrowLeft size={16} /> Back to sessions
                    <kbd>Esc</kbd>
                </button>
            </div>
            <nav class="set-tabs" aria-label="Settings">
                <For each={TABS}>
                    {(t) => (
                        <button class={`navi ${tab() === t.id ? "on" : ""}`} aria-current={tab() === t.id ? "page" : undefined} onClick={() => open(t.id)}>
                            <t.icon size={16} />
                            <span>{t.label}</span>
                        </button>
                    )}
                </For>
            </nav>
        </SidebarFrame>
    );
}

/** One setting: title and description on the left, its control on the right, then Reset when it differs from the default. */
function Row(p: { title: string; desc?: JSX.Element; children?: JSX.Element; reset?: () => void; changed?: boolean; class?: string; hint?: string }) {
    return (
        <div class={`set-row ${p.class ?? ""}`} title={p.hint}>
            <div class="set-lab">
                <div class="set-title">{p.title}</div>
                <Show when={p.desc}>
                    <div class="set-desc">{p.desc}</div>
                </Show>
            </div>
            <div class="set-ctl">{p.children}</div>
            <Show when={p.reset}>
                <span class="set-reset">
                    <Show when={p.changed}>
                        <button class="hb sm" title="Reset" aria-label={`Reset ${p.title.toLowerCase()}`} onClick={() => p.reset!()}>
                            <RotateCcw size={14} />
                        </button>
                    </Show>
                </span>
            </Show>
        </div>
    );
}

/** A heading over a group of settings. */
function Group(p: { children: JSX.Element }) {
    return <div class="set-h">{p.children}</div>;
}

/** A heading (with a line under it, if it needs one), and its settings in one rounded list. */
function Section(p: { title?: JSX.Element; caption?: JSX.Element; children: JSX.Element; class?: string }) {
    return (
        <div class="set-sec">
            <Show when={p.title}>
                <Show when={p.caption} fallback={<Group>{p.title}</Group>}>
                    <div class="set-hd">
                        <Group>{p.title}</Group>
                        <p class="set-cap">{p.caption}</p>
                    </div>
                </Show>
            </Show>
            <div class={`set-group ${p.class ?? ""}`}>{p.children}</div>
        </div>
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

/** A native select drawn as the mockup's .selbtn: a small raised pill with a chevron, and a glyph before its value when there is one. */
function SelectButton(p: { icon?: JSX.Element; children: JSX.Element }) {
    return (
        <span class={`selbtn ${p.icon ? "has-ic" : ""}`}>
            <Show when={p.icon}>
                <span class="selbtn-ic" aria-hidden="true">{p.icon}</span>
            </Show>
            {p.children}
            <ChevronDown size={13} class="selbtn-chev" aria-hidden="true" />
        </span>
    );
}

function ModelSelect(p: { value?: string; onChange: (v: string) => void; empty: string; label: string; apiOnly?: boolean }) {
    // Claude Code and Codex run whole turns: they can't answer a one-off request.
    const groups = () => (p.apiOnly ? app.models.filter((g) => app.providers.find((x) => x.id === g.provider)?.kind !== "agent") : app.models);
    const provider = () => (p.value ? app.models.find((g) => g.models.some((m) => m.ref === p.value)) : undefined);
    return (
        <SelectButton icon={provider() ? <ProviderIcon id={provider()!.provider} name={provider()!.providerName} size={15} /> : undefined}>
            <select class="select" aria-label={p.label} value={p.value ?? ""} onChange={(e) => p.onChange(e.currentTarget.value)}>
                <option value="">{p.empty}</option>
                <For each={groups()}>
                    {(g) => (
                        <optgroup label={g.providerName}>
                            <For each={g.models}>{(m) => <option value={m.ref}>{m.name}</option>}</For>
                        </optgroup>
                    )}
                </For>
            </select>
        </SelectButton>
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
                if (conn === "open") void refreshEditors();
            },
        ),
    );
    // The chosen editor stays listed when it's gone, so the choice isn't silently lost.
    const editorChoices = () => editors().filter((e) => e.installed || e.id === s().editor);
    return (
        <>
            <Section title="Defaults for new sessions">
                <Row title="Model" desc="Also changes when you pick a model in a session.">
                    <ModelSelect label="Model" value={s().model} empty="Automatic" onChange={(v) => void update({ model: v })} />
                </Row>
                <Row title="Small model" desc="For session titles and page summaries.">
                    <ModelSelect label="Small model" value={s().smallModel} empty="Provider's small default" onChange={(v) => void update({ smallModel: v })} />
                </Row>
                <Row title="Auto-mode reviewer" desc="Checks API models' actions in Auto before they run.">
                    <ModelSelect apiOnly label="Auto-mode reviewer" value={s().reviewModel} empty="Sonnet 5.5, or the session's model" onChange={(v) => void update({ reviewModel: v })} />
                </Row>
                <Row title="Permission mode" desc="Shift-Tab cycles it in the composer.">
                    <SelectButton icon={<ModeIcon mode={s().defaultMode ?? "default"} size={14} />}>
                        <select class="select" aria-label="Permission mode" value={s().defaultMode ?? "default"} onChange={(e) => void update({ defaultMode: e.currentTarget.value as PermissionModeId })}>
                            <For each={MODES.filter((m) => m !== "bypassPermissions" || s().allowBypass)}>{(m) => <option value={m}>{MODE_LABELS[m].label}</option>}</For>
                        </select>
                    </SelectButton>
                </Row>
                {/* The composer's effort bars, smaller. Every level: it's where new sessions start, whatever their model. */}
                <Row title="Reasoning effort">
                    <span class="set-effort">
                        <span class="set-effort-l">{effortOf(s().effort)?.label ?? "Provider's default"}</span>
                        <EffortSlider size="sm" levels={effortLevels(undefined)} value={s().effort} onChange={(v) => void update({ effort: v })} />
                    </span>
                </Row>
            </Section>
            <Section title="Conversation">
                <Row title="Show thinking" desc="The model's reasoning, when the provider shares it.">
                    <Toggle
                        label="Show thinking"
                        checked={prefs.showThinking}
                        onChange={(v) => {
                            setPrefs("showThinking", v);
                            void update({ showThinking: v });
                        }}
                    />
                </Row>
                <Row title="Compact automatically" desc="Summarize when the context window is nearly full.">
                    <Toggle label="Compact automatically" checked={s().autoCompact !== false} onChange={(v) => void update({ autoCompact: v })} />
                </Row>
                <Row title="Messages sent while working" desc={`${mod}+Shift+Enter does the other for one message.`}>
                    <SelectButton>
                        <select class="select" aria-label="Messages sent while working" value={s().followUpBehavior ?? "steer"} onChange={(e) => void update({ followUpBehavior: e.currentTarget.value as FollowUpMode })}>
                            <option value="steer">Steer the current turn</option>
                            <option value="queue">Queue for after it</option>
                        </select>
                    </SelectButton>
                </Row>
                <Row
                    title="Compact while idle"
                    desc="Summarize long conversations while you're away, so coming back costs less."
                    // Unset arrives as null over the wire: only a real choice shows Reset.
                    changed={s().idleCompaction === false || s().idleCompaction === "always"}
                    reset={() => void update({ idleCompaction: true })}
                >
                    <SelectButton>
                        <select
                            class="select"
                            aria-label="Compact while idle"
                            disabled={s().autoCompact === false}
                            title={s().autoCompact === false ? "Turn on Compact automatically to use this" : undefined}
                            value={s().autoCompact === false || s().idleCompaction === false ? "off" : s().idleCompaction === "always" ? "always" : "hour"}
                            onChange={(e) => {
                                const v = e.currentTarget.value;
                                void update({ idleCompaction: v === "always" ? "always" : v === "off" ? false : true });
                            }}
                        >
                            <option value="hour">After an hour away</option>
                            <option value="always">After five minutes too</option>
                            <option value="off">Off</option>
                        </select>
                    </SelectButton>
                </Row>
                <Row title="Web search">
                    <SelectButton>
                        <select class="select" aria-label="Web search" value={s().webSearch ?? "auto"} onChange={(e) => void update({ webSearch: e.currentTarget.value })}>
                            <option value="auto">Automatic</option>
                            <option value="anthropic">Anthropic (built in)</option>
                            <option value="brave">Brave</option>
                            <option value="tavily">Tavily</option>
                            <option value="duckduckgo">DuckDuckGo</option>
                            <option value="off">Off</option>
                        </select>
                    </SelectButton>
                </Row>
                <Row title="Browser" desc="Let agents use a browser you can watch in the side panel.">
                    <Toggle label="Browser" checked={s().browser !== false} onChange={(v) => void update({ browser: v })} />
                </Row>
                <Show when={app.hello?.platform === "darwin"}>
                    <Row title="Simulator" desc="Let agents use Xcode's iOS simulators, which you can watch in the side panel.">
                        <Toggle label="Simulator" checked={s().simulator !== false} onChange={(v) => void update({ simulator: v }).then(() => (app.activeId ? loadSimulatorState(app.activeId) : undefined)).catch(() => undefined)} />
                    </Row>
                </Show>
                <Row title="Expand tool activity" desc="Show every tool call instead of a one-line summary.">
                    <Toggle label="Expand tool activity" checked={prefs.expandActivity} onChange={(v) => setPrefs("expandActivity", v)} />
                </Row>
                <Row title="Enter sends" desc={`Off: ${mod}+Enter sends and Enter adds a line.`}>
                    <Toggle label="Enter sends" checked={prefs.enterSends} onChange={(v) => setPrefs("enterSends", v)} />
                </Row>
            </Section>
            <Section title="This computer">
                <Row title="Open files with" desc="For file links in replies, changed files and tool rows.">
                    {/* Each option says whether it's the one chosen: the list arrives after the
                        saved choice, and a select's value set before its options matches nothing. */}
                    <SelectButton>
                        <select class="select" aria-label="Open files with" onChange={(e) => void update({ editor: e.currentTarget.value })}>
                            <option value="" disabled={!s().editor} selected={!s().editor}>
                                {s().editor ? "None" : "Choose an editor"}
                            </option>
                            <For each={editorChoices()}>
                                {(e) => (
                                    <option value={e.id} selected={e.id === s().editor}>
                                        {e.name}
                                        {!e.installed ? " (not found)" : e.lines || e.id === "finder" ? "" : " (without line numbers)"}
                                    </option>
                                )}
                            </For>
                        </select>
                    </SelectButton>
                </Row>
                <Row title="Notifications" desc="When a session needs you or finishes while you're elsewhere.">
                    <Toggle label="Notifications" checked={prefs.notifications} onChange={(v) => setPrefs("notifications", v)} />
                </Row>
                {/* On one of the user's servers Bypass can always be chosen: there's nothing to allow. */}
                <Show when={!s().bypassAlways}>
                    <Row title="Allow bypass mode" desc="Lets sessions run everything without asking. Only for sandboxes and containers.">
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

/**
 * A small picture of the window with that tint: the rail on the tinted glass,
 * the sheet beside it. The face carries only its own data-tint, so it's drawn
 * in the scheme, accent and Window showing (tokens.css matches it under <html>).
 */
function TintTile(p: { id: typeof prefs.tint; label: string }) {
    const on = () => prefs.tint === p.id;
    return (
        <button class={`ap-tile ${on() ? "on" : ""}`} aria-pressed={on()} onClick={() => setPrefs("tint", p.id)}>
            <span class="ap-pv" aria-hidden="true">
                <span class="ap-face ap-tint" data-tint={p.id}>
                    <i />
                    <u />
                </span>
            </span>
            {p.label}
        </button>
    );
}

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
        <div class="ap">
            <Group>Theme</Group>
            <div class="set-group ap-group">
                {/* The scheme picks which of a theme's looks shows, so it sits with them; a theme with one look sets it. */}
                <Row title="Color scheme" desc={forcedScheme() ? `${themeTraits()?.name ?? "This theme"} is ${forcedScheme()} only.` : undefined} changed={prefs.scheme !== PREF_DEFAULTS.scheme} reset={() => setPrefs("scheme", PREF_DEFAULTS.scheme)}>
                    <Segmented
                        size="sm"
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
                    <Row title="Animate" changed={!prefs.themeMotion} reset={() => setPrefs("themeMotion", true)}>
                        <Toggle label="Animate" checked={prefs.themeMotion} onChange={(v) => setPrefs("themeMotion", v)} />
                    </Row>
                </Show>
            </div>

            <Group>Look</Group>
            <div class="set-group ap-group">
                <Show when={!themeAccent()}>
                    <Row title="Accent" desc="Send, primary buttons, links and focus." changed={accent() !== "blue"} reset={() => setPrefs("accent", undefined)}>
                        <div class="ap-swatches" role="group" aria-label="Accent">
                            <For each={ACCENTS}>
                                {(a) => <button class={accent() === a.id ? "on" : ""} aria-pressed={accent() === a.id} style={{ background: a.color }} title={a.name} aria-label={a.name} onClick={() => pickAccent(a.id)} />}
                            </For>
                        </div>
                    </Row>
                </Show>
                <Show when={!scened()}>
                    <Row title="Window" desc="How much of your desktop shows through the window and sidebar." changed={prefs.glass !== PREF_DEFAULTS.glass} reset={() => setPrefs("glass", PREF_DEFAULTS.glass)}>
                        <Segmented
                            size="sm"
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
                    <Row title="Window tint" desc="The color of the glass behind the sidebar." changed={prefs.tint !== PREF_DEFAULTS.tint} reset={() => setPrefs("tint", PREF_DEFAULTS.tint)} class="ap-tint-row">
                        <div class="ap-tiles ap-tint-tiles" role="group" aria-label="Window tint">
                            <TintTile id="clear" label="Clear" />
                            <TintTile id="ocean" label="Ocean" />
                            <TintTile id="accent" label="Accent" />
                        </div>
                    </Row>
                </Show>
                <Row title="Contrast" desc="Stronger text and edges." changed={prefs.contrast !== PREF_DEFAULTS.contrast} reset={() => setPrefs("contrast", PREF_DEFAULTS.contrast)}>
                    <Segmented
                        size="sm"
                        label="Contrast"
                        value={prefs.contrast}
                        onChange={(v) => setPrefs("contrast", v)}
                        options={[
                            { value: "standard", label: "Standard" },
                            { value: "high", label: "Increased" },
                        ]}
                    />
                </Row>
            </div>

            <Group>Text and layout</Group>
            <div class="set-group ap-group">
                <Row title="Text size" desc="Prose and the composer. The interface scales with it." changed={prefs.fontSize !== PREF_DEFAULTS.fontSize} reset={() => setPrefs("fontSize", PREF_DEFAULTS.fontSize)} class="ap-size">
                    <div class="ap-stepper">
                        <button class="hb sm" aria-label="Smaller text" disabled={prefs.fontSize <= 12} onClick={() => size(prefs.fontSize - 1)}>
                            <Minus size={14} />
                        </button>
                        <span class="num" aria-live="polite" aria-label={`${prefs.fontSize} pixels`}>
                            {prefs.fontSize}
                        </span>
                        <button class="hb sm" aria-label="Larger text" disabled={prefs.fontSize >= 18} onClick={() => size(prefs.fontSize + 1)}>
                            <Plus size={14} />
                        </button>
                    </div>
                </Row>
                <div class="ap-preview" aria-label="Preview">
                    Renamed <code>parseConfig</code> and updated the three places that call it.
                </div>
                <Row title="Density" desc="Row and header height across the app." changed={prefs.density !== PREF_DEFAULTS.density} reset={() => setPrefs("density", PREF_DEFAULTS.density)}>
                    <Segmented
                        size="sm"
                        label="Density"
                        value={prefs.density}
                        onChange={(v) => setPrefs("density", v)}
                        options={[
                            { value: "comfortable", label: "Comfortable" },
                            { value: "compact", label: "Compact" },
                        ]}
                    />
                </Row>
                <Row title="Chat width" desc="How wide the conversation can grow on a big window." changed={prefs.chatWidth !== PREF_DEFAULTS.chatWidth} reset={() => setPrefs("chatWidth", PREF_DEFAULTS.chatWidth)}>
                    <Segmented
                        size="sm"
                        label="Chat width"
                        value={prefs.chatWidth}
                        onChange={(v) => setPrefs("chatWidth", v)}
                        options={(Object.keys(CHAT_WIDTHS) as (keyof typeof CHAT_WIDTHS)[]).map((w) => ({ value: w, label: w === "narrow" ? "Narrow" : w === "wide" ? "Wide" : "Standard", title: `${CHAT_WIDTHS[w]}px` }))}
                    />
                </Row>
                <Row title="Panel animations" desc="Panels and menus. Your system's reduced-motion setting always wins." changed={prefs.motion !== PREF_DEFAULTS.motion} reset={() => setPrefs("motion", PREF_DEFAULTS.motion)}>
                    <Segmented
                        size="sm"
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
            </div>
        </div>
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
            await at.link.call("providers.removeKey", { provider: p.pr.id });
            await at.changed();
            toast(agentCli ? `Turned off ${name}; it stays signed in` : `Removed the ${name} key`);
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
        <span class="tag bad">
            <CircleAlert size={11} stroke-width={2.5} />
            {tag}
        </span>
    );
    /** The fix: the command the message names, to copy, and (for a CLI) the check again. */
    const fix = (message: string, retry?: () => void) => (
        <>
            <Show when={commandIn(message)}>
                {(command) => (
                    <button class="btn ghost sm" onClick={() => void copyCommand(command())}>
                        <Copy size={13} />
                        Copy command
                    </button>
                )}
            </Show>
            <Show when={retry}>
                <button class="btn primary sm" disabled={busy()} onClick={() => retry!()}>
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
        : undefined;
    return (
        <div class="prov" classList={{ err: !!failure() }} data-flash={failure() ? flash() : undefined}>
            <ConfirmDialog
                open={confirmRemove()}
                onClose={() => setConfirmRemove(false)}
                title={p.pr.agentCli ? `Turn off ${p.pr.name}?` : `Remove the ${p.pr.name} key?`}
                confirmLabel={p.pr.agentCli ? "Turn off" : "Remove key"}
                busy={removingProviders().has(`${at.server ?? ""}:${p.pr.id}`)}
                onConfirm={remove}
            >
                {p.pr.agentCli ? `${p.pr.name} stays signed in.` : `You'll need to add it again to use ${p.pr.name}.`}
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
                <div class="prov-line">
                    <span class="prov-logo" title={p.pr.configured ? "Set up" : "Not set up"}>
                        <ProviderIcon id={p.pr.id} name={p.pr.name} size={18} />
                    </span>
                    <div class="prov-lab">
                        <div class="prov-name">
                            <span class="truncate">{p.pr.name}</span>
                            <Show when={p.pr.local}>
                                <span class="tag">local</span>
                            </Show>
                            <Show when={failure()}>{(f) => badTag(f().tag)}</Show>
                        </div>
                        <Show
                            when={failure()}
                            fallback={
                                <Show when={p.pr.masked || sub()}>
                                    <div class="prov-sub">
                                        <Show when={p.pr.masked} fallback={sub()}>
                                            <code class="prov-key">{p.pr.masked}</code>
                                        </Show>
                                    </div>
                                </Show>
                            }
                        >
                            {(f) => (
                                <div class="prov-sub selectable" role="alert">
                                    <MessageText text={f().message} />
                                </div>
                            )}
                        </Show>
                    </div>
                    <span class="prov-end">
                        {/* Saving again is the key's own Save, under the row. */}
                        <Show when={failure() && commandIn(failure()!.message)}>
                            <span class="prov-fix">{fix(failure()!.message)}</span>
                        </Show>
                        <Show when={p.pr.source && p.pr.source !== "local"}>
                            <span class="tag">{p.pr.source}</span>
                        </Show>
                        <Show when={p.pr.requiresKey}>
                            <Show
                                when={removable()}
                                fallback={
                                    <Show when={!p.pr.configured}>
                                        <Show when={p.pr.keyUrl}>
                                            <button class="link-btn" onClick={() => void openExternal(p.pr.keyUrl!)}>
                                                Get a key <ExternalLink size={11} />
                                            </button>
                                        </Show>
                                        <button class="btn secondary sm" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
                                            Add key
                                        </button>
                                    </Show>
                                }
                            >
                                <button class="hb sm" title="Remove key" aria-label={`Remove the ${p.pr.name} key`} onClick={() => setConfirmRemove(true)}>
                                    <X size={14} />
                                </button>
                            </Show>
                        </Show>
                    </span>
                </div>
            </Show>
            <Show when={adding()}>
                <div class="prov-add">
                    <input class="input mono" type="password" autofocus aria-label={`${p.pr.name} key`} placeholder={`Paste your ${p.pr.name} key`} value={key()} onInput={(e) => setKey(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
                    <button class="btn primary sm" disabled={!key().trim() || busy()} onClick={() => void save()}>
                        {busy() ? <Spinner size={12} /> : "Save"}
                    </button>
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
    const where = () => at.server ?? "this computer";
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
        <div class="keyin">
            <input class="input mono" type="password" aria-label="API key" placeholder="Paste a key from any provider" value={key()} onInput={(e) => setKey(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void quickAdd()} />
            <button class="btn primary sm" disabled={!key().trim() || busy()} onClick={() => void quickAdd()}>
                {busy() ? <Spinner size={12} /> : "Add"}
            </button>
        </div>
    );
    // API keys always shows, for the box that adds one.
    const sections = () => p.localOnly || groups().some((g) => g.title === "API keys") ? groups() : [...groups().slice(0, 1), { title: "API keys", list: [] }, ...groups().slice(1)];
    return (
        <For each={sections()}>
            {(g) => (
                <Section
                    title={g.title === LOCAL && at.server ? `On ${at.server}` : g.title}
                    class="prov-group"
                    caption={g.title === "API keys" ? <>Kept on {p.synced ? "this computer and the servers you sync" : where()}, sent only to their provider. Custom endpoints: <code>/login custom</code> in the terminal app.</> : undefined}
                >
                    <Show when={g.title === "API keys"}>{keyBox()}</Show>
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
        if (machine || !app.hello?.servers) return;
        void serversUi().then((m) => (setServers(() => m), m.refreshServerList())).catch(() => undefined);
    });
    const withServers = () => !machine && listed().length > 0;
    // Subscriptions are signed in on each machine: one table across them. Keys go with sync; a server's own local
    // models are its own.
    return (
        <>
            <Show when={withServers()}>
                <Section title="Subscriptions" class="prov-group">
                    <Suspense fallback={<div class="set-row"><Spinner size={12} /></div>}>
                        <SubscriptionGrid here={servers()?.HERE ?? ""} servers={listed().map((s) => s.name)} touched={() => servers()?.serverTouched() ?? 0} manage={(pr) => <ProviderRow pr={pr} />} />
                    </Suspense>
                </Section>
            </Show>
            <ProviderSections noSubscriptions={withServers()} synced={listed().some((s) => s.syncOn)} />
            <Show when={withServers()}>
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

/** One keystroke as one key cap, written as everywhere else: "⌘K", "Ctrl+K". */
function Cap(p: { keys: string }) {
    return <kbd>{keyText(p.keys)}</kbd>;
}

/** One key sequence as key caps: a chord's strokes one after another. */
function KeySeq(p: { keys: string }) {
    return (
        <span class="sc-seq">
            <For each={p.keys.split(" ")}>{(stroke, i) => <>{i() > 0 && <span class="sc-then">then</span>}<Cap keys={stroke} /></>}</For>
        </span>
    );
}

function Shortcuts() {
    const [creating, setCreating] = createSignal(false);
    const path = () => keybindingsFile()?.path ?? "~/.cavvy/keybindings.json";
    const exists = () => keybindingsFile()?.text !== undefined;
    const issues = () => keymap().issues;
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
                <div class="sc-issues" role="alert">
                    <div class="sc-issues-title">
                        <AlertTriangle size={14} /> {issues().length === 1 ? "1 problem" : `${issues().length} problems`} in your keybindings file. The rest of it still applies.
                    </div>
                    <ul>
                        <For each={issues()}>{(i) => <li class={i.level}><span class="sc-level">{i.level === "error" ? "Error" : "Warning"}</span> {i.message}</li>}</For>
                    </ul>
                </div>
            </Show>
            <For each={CONTEXTS}>
                {(context) => (
                    <Show when={rows(context).length}>
                        <Section title={CONTEXT_TITLES[context]}>
                            <For each={rows(context)}>
                                {(a) => {
                                    const keys = () => (keymap().keysOf.get(a.id) ?? []).map((k) => formatKeys(k, "gui", os));
                                    const custom = () => keymap().customized.has(a.id);
                                    return (
                                        <Row title={a.description} hint={a.id}>
                                            <span class="sc-keys">
                                                <Show when={custom()}><span class="sc-custom" title="Set in your keybindings file">Custom</span></Show>
                                                <Show when={keys().length} fallback={<span class="sc-none">Not bound</span>}>
                                                    <For each={keys()}>{(k) => <KeySeq keys={k} />}</For>
                                                </Show>
                                            </span>
                                        </Row>
                                    );
                                }}
                            </For>
                        </Section>
                    </Show>
                )}
            </For>
            <Section title="Built in" caption="Can't be changed.">
                <For each={BUILT_IN}>
                    {([k, d]) => (
                        <Row title={d}>
                            <span class="sc-keys">
                                <For each={k.split("  ")}>{(part) => <Cap keys={part} />}</For>
                            </span>
                        </Row>
                    )}
                </For>
            </Section>
            {/* Where the keys above are changed: the file, shared with the terminal app. A row's action name (its
                tooltip) is what the file calls it. */}
            <Section title="Your keys" caption="Shared with the terminal app.">
                <Row
                    title={path()}
                    class="sc-file"
                    desc={<a href={KEYBINDINGS_DOCS} onClick={(e) => { e.preventDefault(); void openExternal(KEYBINDINGS_DOCS); }}>File format</a>}
                >
                    <span class="sc-file-actions">
                        <Show when={exists()} fallback={<button class="btn sm" disabled={creating()} onClick={() => void create()}><Plus size={14} /> Create file</button>}>
                            <button class="btn sm" onClick={() => void copyPath()}><Copy size={14} /> Copy path</button>
                        </Show>
                        <Show when={canReveal && exists()}>
                            <button class="btn sm" onClick={() => void revealPath(path())}><FolderOpen size={14} /> Show</button>
                        </Show>
                    </span>
                </Row>
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
    const u = () => app.update!;
    const SHOWN = 6;
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
    return (
        <Show when={v() && (isDesktop || !app.update?.unavailable) ? v() : undefined}>
            {(v) => (
                <>
                    <Row title={v().title} desc={v().detail} class={`upd-row ${u().updating ? "running" : ""}`}>
                        <Show when={!v().busy && v().action} fallback={<Show when={v().busy}><Spinner size={16} class="upd-spin" /></Show>}>
                            {(a) => (
                                <>
                                    <button class="btn sm" disabled={asking()} onClick={() => void check()}>Check now</button>
                                    <Show when={v().notes}>
                                        {(url) => <button class="btn ghost sm" onClick={() => void openExternal(url())}>Release notes <ExternalLink size={12} /></button>}
                                    </Show>
                                    <Show when={a() === "update"}>
                                        <button class="btn primary sm" disabled={update.pending()} onClick={update.request}>
                                            <Download size={14} /> Update &amp; restart
                                        </button>
                                    </Show>
                                    <Show when={a() === "restart"}>
                                        <button class="btn primary sm" disabled={update.pending()} onClick={update.request}>
                                            <RotateCcw size={14} /> Restart
                                        </button>
                                    </Show>
                                </>
                            )}
                        </Show>
                    </Row>
                    <Show when={v().warn}>
                        <div class="upd-warn"><AlertTriangle size={13} /> {v().warn}</div>
                    </Show>
                    <Show when={v().problem}>
                        <div class="upd-warn"><AlertTriangle size={13} /> {v().problem}</div>
                    </Show>
                    <Show when={!u().updating && u().changes?.length}>
                        <ul class="upd-changes" aria-label="New on main">
                            <For each={u().changes.slice(0, SHOWN)}>{(c) => <li><code>{c.hash}</code><span class="truncate">{c.subject}</span></li>}</For>
                            <Show when={u().behind > SHOWN}><li class="upd-more">and {u().behind - SHOWN} more</li></Show>
                        </ul>
                    </Show>
                    <Show when={!u().updating && u().failed}>
                        <div class="upd-error" role="alert">
                            <CircleAlert size={14} />
                            <span>{u().failed}</span>
                            <Show when={canReveal && u().log}><button class="btn ghost sm" onClick={() => void revealPath(u().log!)}>Show log</button></Show>
                        </div>
                    </Show>
                    <Show when={!u().updating && u().error}>
                        <div class="upd-error" role="alert">
                            <CircleAlert size={14} />
                            <span>{u().error}</span>
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
            {/* The app and its version, with its updates under them. */}
            <Section title="Version">
                <div class="ab-hero">
                    <Logo size={40} />
                    <div class="ab-name">
                        <b>Cavvy</b>
                        <span class="num">{app.hello?.version ?? "—"}</span>
                    </div>
                </div>
                <Updates />
            </Section>
            <Section title="Details">
                <Row title="Data">
                    <span class="set-val">{app.hello?.home ?? "—"}</span>
                </Row>
                <Row title="Platform">
                    <span class="set-val plain">{platform()}</span>
                </Row>
                <Row title="Connection">
                    <span class="set-val plain">{app.conn === "open" ? "Connected" : app.conn}</span>
                </Row>
                <Row title="Protocol">
                    <span class="set-val">{app.hello?.protocol ?? "—"}</span>
                </Row>
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
        <div ref={page} class={`settings-page ${prefs.sidebar ? "" : "rail-off"}`}>
            <div class="set-in">
                {/* The header stays while the page scrolls (on the window's top strip, which moves the window). */}
                <div class="set-top">
                    {/* With the sections as pills under it (no sidebar), the pill names the section: the header says Settings. */}
                    <h2>
                        <span class="set-t-tab">{label()}</span>
                        <span class="set-t-all">Settings</span>
                    </h2>
                    {/* Settings covers the rail and the title bar, where Needs you would be: it's here instead. */}
                    <Show when={waiting().length}>
                        <NeedsYou waiting={waiting()} />
                    </Show>
                    <button class="set-close" title={`${withShortcut("Close settings", "app:settings")}, or Esc`} aria-label="Close settings" onClick={() => setSettingsTab(undefined)}>
                        <X size={16} />
                    </button>
                </div>
                {/* With no sidebar beside it, the sections as a row of pills. */}
                <nav class="set-pills" aria-label="Settings sections">
                    <For each={TABS}>
                        {(t) => (
                            <button class={tab() === t.id ? "on" : ""} aria-current={tab() === t.id ? "page" : undefined} onClick={() => open(t.id)}>
                                {t.label}
                            </button>
                        )}
                    </For>
                </nav>
                <div class="set-body">
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
