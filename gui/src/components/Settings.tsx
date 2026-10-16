// Settings as a page: its sections take the sidebar's place, and each
// setting is one row: what it is, what it does, its control, and a reset
// when it's been changed.

import { createEffect, createSignal, For, Match, on, onMount, Show, Switch, type JSX } from "solid-js";
import { ArrowLeft, ArrowUp, ChartColumn, Check, ExternalLink, Info, Keyboard, KeyRound, Minus, Palette, Plug, Plus, RotateCcw, Settings as Gear, SlidersHorizontal, Trash2 } from "lucide-solid";
import { MODE_LABELS, type EffortLevel, type GuiSettings, type PermissionModeId, type ProviderInfo } from "@shared/protocol";
import { app, refreshModels, refreshProviders, refreshSettings, reportError, rpc, setApp, toast } from "../state/app";
import { connectCli, editors, refreshEditors } from "../state/actions";
import { ACCENTS, CHAT_WIDTHS, prefs, PREF_DEFAULTS, setPrefs, THEMES, type ThemeId } from "../state/prefs";
import { setSettingsTab, settingsTab, type SettingsTab } from "../state/ui";
import { mod, openExternal, terminalShortcut } from "../lib/platform";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ProviderIcon } from "./ui/ProviderIcon";
import { MODES } from "./ModePicker";
import { CrumbSep, TitleBar } from "./Header";
import { SidebarFrame } from "./Sidebar";
import { Kbd, Segmented, Spinner, Toggle } from "./ui/bits";
import { UsageView } from "./UsageView";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "providers", label: "Providers", icon: Plug },
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
            <span class="grow" />
            <div class="side-foot">
                <span class={`conn conn-${app.conn}`} />
                <span class="side-foot-text truncate">{app.conn === "open" ? "This computer" : "Reconnecting…"}</span>
                <span class="grow" />
                <button class="hb lg" aria-pressed="true" title={`Close settings (${mod}+,)`} aria-label="Close settings" onClick={() => setSettingsTab(undefined)}>
                    <Gear size={16} />
                </button>
            </div>
        </SidebarFrame>
    );
}

/** One setting: title and description on the left, the control, then Reset when it differs from the default. */
function Row(p: { title: string; desc?: JSX.Element; children?: JSX.Element; reset?: () => void; changed?: boolean; class?: string }) {
    return (
        <div class={`srow ${p.class ?? ""}`}>
            <div class="srow-text">
                <div class="srow-title">{p.title}</div>
                <Show when={p.desc}>
                    <div class="srow-desc">{p.desc}</div>
                </Show>
            </div>
            <div class="srow-control">{p.children}</div>
            <span class="srow-reset">
                <Show when={p.changed && p.reset}>
                    <button class="hb sm" title="Reset" aria-label={`Reset ${p.title.toLowerCase()}`} onClick={() => p.reset!()}>
                        <RotateCcw size={14} />
                    </button>
                </Show>
            </span>
        </div>
    );
}

function Group(p: { children: JSX.Element }) {
    return <div class="sgroup">{p.children}</div>;
}

/** "" clears a model (undefined wouldn't reach the server: JSON leaves it out). */
async function update(patch: GuiSettings) {
    try {
        setApp("settings", await rpc.call("settings.update", { patch }));
    } catch (e) {
        reportError(e);
    }
}

function ModelSelect(p: { value?: string; onChange: (v: string) => void; empty: string; label: string; apiOnly?: boolean }) {
    // Claude Code and Codex run whole turns: they can't answer a one-off request.
    const groups = () => (p.apiOnly ? app.models.filter((g) => app.providers.find((x) => x.id === g.provider)?.kind !== "agent") : app.models);
    return (
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
    );
}

const EFFORT_LABELS: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

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
            <Group>Defaults for new sessions</Group>
            <Row title="Model" desc="Also changes when you pick a model in a session.">
                <ModelSelect label="Model" value={s().model} empty="Automatic" onChange={(v) => void update({ model: v })} />
            </Row>
            <Row title="Small model" desc="For session titles and page summaries.">
                <ModelSelect label="Small model" value={s().smallModel} empty="Provider's small default" onChange={(v) => void update({ smallModel: v })} />
            </Row>
            <Row title="Auto-mode reviewer" desc="Checks actions in Auto before they run, on API models. Claude Code and Codex use their own.">
                <ModelSelect apiOnly label="Auto-mode reviewer" value={s().reviewModel} empty="Sonnet 5.5, or the session's model" onChange={(v) => void update({ reviewModel: v })} />
            </Row>
            <Row title="Permission mode" desc="Shift-Tab cycles it in the composer.">
                <select class="select" aria-label="Permission mode" value={s().defaultMode ?? "default"} onChange={(e) => void update({ defaultMode: e.currentTarget.value as PermissionModeId })}>
                    <For each={MODES.filter((m) => m !== "bypassPermissions" || s().allowBypass)}>{(m) => <option value={m}>{MODE_LABELS[m].label}</option>}</For>
                </select>
            </Row>
            <Row title="Reasoning effort">
                <select class="select" aria-label="Reasoning effort" value={s().effort ?? ""} onChange={(e) => void update({ effort: e.currentTarget.value as EffortLevel })}>
                    <Show when={!s().effort}>
                        <option value="" disabled>
                            Provider's default
                        </option>
                    </Show>
                    <For each={Object.keys(EFFORT_LABELS) as EffortLevel[]}>{(e) => <option value={e}>{EFFORT_LABELS[e]}</option>}</For>
                </select>
            </Row>
            <Group>Behaviour</Group>
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
            <Row title="Compact automatically" desc="Summarize the conversation when the context window is nearly full.">
                <Toggle label="Compact automatically" checked={s().autoCompact !== false} onChange={(v) => void update({ autoCompact: v })} />
            </Row>
            <Row title="Web search">
                <select class="select" aria-label="Web search" value={s().webSearch ?? "auto"} onChange={(e) => void update({ webSearch: e.currentTarget.value })}>
                    <option value="auto">Automatic</option>
                    <option value="anthropic">Anthropic (built in)</option>
                    <option value="brave">Brave</option>
                    <option value="tavily">Tavily</option>
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="off">Off</option>
                </select>
            </Row>
            <Row title="Open files with" desc="For file links in replies, changed files and tool rows. It opens on the computer running Harness.">
                {/* Each option says whether it's the one chosen: the list arrives after the
                    saved choice, and a select's value set before its options matches nothing. */}
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
            </Row>
            <Row title="Allow bypass mode" desc="Lets sessions run everything without asking. Only for sandboxes and containers.">
                <Toggle label="Allow bypass mode" checked={Boolean(s().allowBypass)} onChange={(v) => (v ? setConfirmBypass(true) : void update({ allowBypass: false }))} />
            </Row>
            <ConfirmDialog
                open={confirmBypass()}
                onClose={() => setConfirmBypass(false)}
                title="Allow bypass mode?"
                confirmLabel="Allow bypass mode"
                busy={enablingBypass()}
                onConfirm={enableBypass}
            >
                Lets sessions run tools without asking for permission. Enable only in a sandbox or container.
            </ConfirmDialog>
            <Group>This computer</Group>
            <Row title="Notifications" desc="When a session needs you or finishes while you're elsewhere.">
                <Toggle label="Notifications" checked={prefs.notifications} onChange={(v) => setPrefs("notifications", v)} />
            </Row>
            <Row title="Enter sends" desc={`Off: ${mod}+Enter sends and Enter adds a line.`}>
                <Toggle label="Enter sends" checked={prefs.enterSends} onChange={(v) => setPrefs("enterSends", v)} />
            </Row>
            <Row title="Expand tool activity" desc="Show every tool call instead of a one-line summary.">
                <Toggle label="Expand tool activity" checked={prefs.expandActivity} onChange={(v) => setPrefs("expandActivity", v)} />
            </Row>
        </>
    );
}

type Scheme = "system" | "light" | "dark";

/** A small drawing of the app in that scheme; System is split corner to corner. */
function SchemeTile(p: { id: Scheme; label: string }) {
    const current = (): Scheme => (prefs.theme === "system" ? "system" : (THEMES.find((t) => t.id === prefs.theme)?.scheme ?? "light"));
    const on = () => current() === p.id;
    const pick = () => setPrefs("theme", p.id === "system" ? "system" : p.id === "light" ? prefs.lightTheme : prefs.darkTheme);
    return (
        <button class={`scheme ${on() ? "on" : ""}`} aria-pressed={on()} onClick={pick}>
            <span class={`wire wire-${p.id}`} aria-hidden="true">
                <Show when={p.id === "system"}>
                    <span class="wire-half" />
                </Show>
                <span class="w-side" />
                <span class="w-title" />
                <span class="w-bub" />
                <span class="w-line" />
                <span class="w-line short" />
                <span class="w-box" />
                <span class="w-send" />
            </span>
            <span class="scheme-label">
                {p.label}
                <Show when={on()}>
                    <Check size={14} />
                </Show>
            </span>
        </button>
    );
}

function ThemeOrbs(p: { scheme: "light" | "dark" }) {
    const key = p.scheme === "light" ? "lightTheme" : "darkTheme";
    const pick = (id: ThemeId) => {
        setPrefs(key, id);
        // Showing that scheme now: show the pick too.
        if (prefs.theme !== "system" && THEMES.find((t) => t.id === prefs.theme)?.scheme === p.scheme) setPrefs("theme", id);
    };
    return (
        <div class="orb-row">
            <For each={THEMES.filter((t) => t.scheme === p.scheme)}>
                {(t) => (
                    <button class={`orbc ${prefs[key] === t.id ? "on" : ""}`} aria-pressed={prefs[key] === t.id} title={t.name} onClick={() => pick(t.id)}>
                        <span class="orbs" aria-hidden="true">
                            <span style={{ background: t.swatch[0] }} />
                            <span style={{ background: t.swatch[1] }} />
                            <span style={{ background: t.swatch[3] }} />
                        </span>
                        {t.name}
                    </button>
                )}
            </For>
        </div>
    );
}

function Appearance() {
    const size = (n: number) => setPrefs("fontSize", Math.max(12, Math.min(18, n)));
    return (
        <>
            <Group>Theme</Group>
            <Row title="Colour scheme" desc="Follow the system, or always use one." class="no-line" />
            <div class="scheme-row">
                <SchemeTile id="system" label="System" />
                <SchemeTile id="light" label="Light" />
                <SchemeTile id="dark" label="Dark" />
            </div>
            <Row title="Light theme" desc="Used when the scheme is light." changed={prefs.lightTheme !== PREF_DEFAULTS.lightTheme} reset={() => setPrefs("lightTheme", PREF_DEFAULTS.lightTheme)}>
                <ThemeOrbs scheme="light" />
            </Row>
            <Row title="Dark theme" desc="Used when the scheme is dark." changed={prefs.darkTheme !== PREF_DEFAULTS.darkTheme} reset={() => setPrefs("darkTheme", PREF_DEFAULTS.darkTheme)}>
                <ThemeOrbs scheme="dark" />
            </Row>
            <Row title="Accent" desc="Send, primary buttons, links and focus." changed={Boolean(prefs.accent)} reset={() => setPrefs("accent", undefined)}>
                <div class="swatches">
                    <button class={`sw sw-theme ${!prefs.accent ? "on" : ""}`} aria-pressed={!prefs.accent} title="The theme's own" aria-label="The theme's own" onClick={() => setPrefs("accent", undefined)} />
                    <For each={ACCENTS}>{(a) => <button class={`sw ${prefs.accent === a.id ? "on" : ""}`} aria-pressed={prefs.accent === a.id} style={{ background: a.color }} title={a.name} aria-label={a.name} onClick={() => setPrefs("accent", a.id)} />}</For>
                </div>
            </Row>

            <Group>Text and layout</Group>
            <Row title="Text size" desc="Prose and the composer. The interface scales with it." changed={prefs.fontSize !== PREF_DEFAULTS.fontSize} reset={() => setPrefs("fontSize", PREF_DEFAULTS.fontSize)} class="no-line">
                <div class="stepper">
                    <button class="hb sm" aria-label="Smaller text" disabled={prefs.fontSize <= 12} onClick={() => size(prefs.fontSize - 1)}>
                        <Minus size={14} />
                    </button>
                    <span class="num">{prefs.fontSize}px</span>
                    <button class="hb sm" aria-label="Larger text" disabled={prefs.fontSize >= 18} onClick={() => size(prefs.fontSize + 1)}>
                        <Plus size={14} />
                    </button>
                </div>
            </Row>
            <div class="type-preview" aria-label="Preview">
                <div class="tp-user">
                    <span>Can you shorten the error message?</span>
                </div>
                <div class="tp-reply">
                    Done. It's one sentence now and still names the file: <code>config.json is not valid JSON</code>.
                </div>
                <div class="tp-box">
                    <span>Ask, plan, or describe a change…</span>
                    <span class="grow" />
                    <span class="tp-send">
                        <ArrowUp size={15} stroke-width={2.4} />
                    </span>
                </div>
            </div>
            <Row title="Density" desc="Row and header height across the app." changed={prefs.density !== PREF_DEFAULTS.density} reset={() => setPrefs("density", PREF_DEFAULTS.density)}>
                <Segmented
                    size="sm"
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
                    value={prefs.chatWidth}
                    onChange={(v) => setPrefs("chatWidth", v)}
                    options={(Object.keys(CHAT_WIDTHS) as (keyof typeof CHAT_WIDTHS)[]).map((w) => ({ value: w, label: w === "narrow" ? "Narrow" : w === "wide" ? "Wide" : "Default", title: `${CHAT_WIDTHS[w]}px` }))}
                />
            </Row>

            <Group>Motion</Group>
            <Row title="Panel animations" desc="Panels and menus open instantly unless you choose otherwise. Your system's reduced-motion setting always wins." changed={prefs.motion !== PREF_DEFAULTS.motion} reset={() => setPrefs("motion", PREF_DEFAULTS.motion)} class="no-line">
                <Segmented
                    size="sm"
                    value={prefs.motion}
                    onChange={(v) => setPrefs("motion", v)}
                    options={[
                        { value: "instant", label: "Instant" },
                        { value: "quick", label: "Quick" },
                        { value: "smooth", label: "Smooth" },
                    ]}
                />
            </Row>
        </>
    );
}

const [removingProviders, setRemovingProviders] = createSignal<ReadonlySet<string>>(new Set());

function ProviderRow(p: { pr: ProviderInfo }) {
    const [confirmRemove, setConfirmRemove] = createSignal(false);
    const [adding, setAdding] = createSignal(false);
    const [key, setKey] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const save = async () => {
        setBusy(true);
        try {
            const r = await rpc.call("providers.setKey", { provider: p.pr.id, key: key() });
            toast(`Saved the ${p.pr.name} key ${r.masked}`, "success");
            if (r.warning) toast(r.warning, "warn");
            setAdding(false);
            setKey("");
            await Promise.all([refreshProviders(), refreshModels(), refreshSettings()]);
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        const { id, name, agentCli } = p.pr;
        if (removingProviders().has(id)) return;
        setRemovingProviders((ids) => new Set(ids).add(id));
        try {
            await rpc.call("providers.removeKey", { provider: id });
            await Promise.all([refreshProviders(), refreshModels()]);
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
    const connect = async () => {
        setBusy(true);
        await connectCli(p.pr);
        setBusy(false);
    };
    return (
        <div class="prov">
            <ConfirmDialog
                open={confirmRemove()}
                onClose={() => setConfirmRemove(false)}
                title={p.pr.agentCli ? `Turn off ${p.pr.name}?` : `Remove the ${p.pr.name} key?`}
                confirmLabel={p.pr.agentCli ? "Turn off" : "Remove key"}
                busy={removingProviders().has(p.pr.id)}
                onConfirm={remove}
            >
                {p.pr.agentCli ? `Stops using ${p.pr.name} in Harness. It stays signed in.` : `Removes the stored ${p.pr.name} key from Harness. You'll need to add it again to use this provider.`}
            </ConfirmDialog>
            <div class="prov-line">
                <span class="prov-ico" title={p.pr.configured ? "Set up" : "Not set up"}>
                    <ProviderIcon id={p.pr.id} name={p.pr.name} size={18} />
                    <span class={`dot ${p.pr.configured ? "ok" : ""}`} />
                </span>
                <span class="prov-name">{p.pr.name}</span>
                <Show when={p.pr.masked}>
                    <code class="prov-key">{p.pr.masked}</code>
                </Show>
                <Show when={p.pr.source && p.pr.source !== "local"}>
                    <span class="chip tiny">{p.pr.source}</span>
                </Show>
                <Show when={p.pr.local}>
                    <span class="chip tiny">local</span>
                </Show>
                <span class="grow" />
                <Show when={p.pr.agentCli}>
                    {(cli) => (
                        <Show
                            when={!p.pr.configured}
                            fallback={
                                <button class="hb sm" title={`Turn off (${p.pr.name} stays signed in)`} aria-label={`Turn off ${p.pr.name}`} onClick={() => setConfirmRemove(true)}>
                                    <Trash2 size={14} />
                                </button>
                            }
                        >
                            <Show
                                when={cli().installed}
                                fallback={
                                    <>
                                        <span class="muted small">Not installed</span>
                                        <Show when={p.pr.keyUrl}>
                                            <button class="link-btn" onClick={() => void openExternal(p.pr.keyUrl!)}>
                                                Install <ExternalLink size={11} />
                                            </button>
                                        </Show>
                                    </>
                                }
                            >
                                <button class="btn secondary sm" disabled={busy()} onClick={() => void connect()}>
                                    {busy() ? <Spinner size={12} /> : `Use my ${cli().plan}`}
                                </button>
                            </Show>
                        </Show>
                    )}
                </Show>
                <Show when={!p.pr.requiresKey && !p.pr.configured && !p.pr.agentCli}>
                    <span class="muted small">Set up in the terminal</span>
                </Show>
                <Show when={p.pr.requiresKey}>
                    <Show
                        when={p.pr.configured && !p.pr.source?.startsWith("$")}
                        fallback={
                            <Show when={!p.pr.configured}>
                                <Show when={p.pr.keyUrl}>
                                    <button class="link-btn" onClick={() => void openExternal(p.pr.keyUrl!)}>
                                        Get a key <ExternalLink size={11} />
                                    </button>
                                </Show>
                                <button class="btn secondary sm" onClick={() => setAdding(!adding())}>
                                    Add key
                                </button>
                            </Show>
                        }
                    >
                        <button class="hb sm" title="Remove key" aria-label={`Remove the ${p.pr.name} key`} onClick={() => setConfirmRemove(true)}>
                            <Trash2 size={14} />
                        </button>
                    </Show>
                </Show>
            </div>
            <Show when={adding()}>
                <div class="prov-add">
                    <input class="input mono" type="password" autofocus placeholder={`Paste your ${p.pr.name} key`} value={key()} onInput={(e) => setKey(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
                    <button class="btn primary sm" disabled={!key().trim() || busy()} onClick={() => void save()}>
                        {busy() ? <Spinner size={12} /> : "Save"}
                    </button>
                </div>
            </Show>
        </div>
    );
}

function Providers() {
    const [key, setKey] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const quickAdd = async () => {
        setBusy(true);
        try {
            const r = await rpc.call("providers.setKey", { key: key() });
            toast(`Saved a ${r.provider} key ${r.masked}`, "success");
            if (r.warning) toast(r.warning, "warn");
            setKey("");
            await Promise.all([refreshProviders(), refreshModels(), refreshSettings()]);
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(false);
        }
    };
    const models = () => app.providers.filter((p) => !p.search);
    const search = () => app.providers.filter((p) => p.search);
    return (
        <>
            <div class="prov-quick">
                <KeyRound size={16} />
                <input class="input mono" type="password" aria-label="API key" placeholder="Paste any API key; the provider is detected from its format" value={key()} onInput={(e) => setKey(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void quickAdd()} />
                <button class="btn primary sm" disabled={!key().trim() || busy()} onClick={() => void quickAdd()}>
                    {busy() ? <Spinner size={12} /> : "Add"}
                </button>
            </div>
            <div class="set-note">Keys are checked with one cheap request, then stored in your OS keychain (or a private file when there's none). They're only ever sent to their own provider and are masked everywhere else.</div>
            <Group>Models</Group>
            <For each={models()}>{(pr) => <ProviderRow pr={pr} />}</For>
            <Group>Web search</Group>
            <For each={search()}>{(pr) => <ProviderRow pr={pr} />}</For>
            <div class="set-note">
                Claude Code and Codex use your own Claude subscription or ChatGPT plan through the CLI installed on this computer; it stays signed in on its own and nothing secret is stored here. Gemini on Google Cloud (Vertex AI) is set up from the terminal with <code>harness auth add vertex</code>. Custom OpenAI-compatible endpoints: <code>/login custom</code> in the terminal app.
            </div>
        </>
    );
}

const SHORTCUTS: [string, string][] = [
    [`${mod}+N`, "New session"],
    [`${mod}+K`, "Search sessions, messages and actions"],
    [`${mod}+F`, "Find in the conversation"],
    [`${mod}+,`, "Settings"],
    [`${mod}+B`, "Toggle the sidebar"],
    [`${mod}+.`, "Toggle the side panel"],
    [`${mod}+/`, "Switch model"],
    [`${mod}+1…9`, "Pick a model (model picker open)"],
    [`${mod}+[  ${mod}+]`, "Previous / next session"],
    [`${mod}+L`, "Focus the input box"],
    [terminalShortcut, "Toggle the terminal"],
    ["Shift+Tab", "Cycle permission mode"],
    ["Esc", "Interrupt (while working) · deny a permission · close"],
    ["1  2  3", "Answer the request on the composer"],
    ["Enter  Shift+Enter", "Send · new line"],
    ["↑", "Previous prompt (empty input)"],
    ["@", "Mention a file"],
    ["/", "Commands"],
    ["!", "Run a shell command yourself"],
];

function Shortcuts() {
    return (
        <For each={SHORTCUTS}>
            {([k, d]) => (
                <Row title={d}>
                    <span class="sc-keys">
                        <For each={k.split("  ")}>{(part) => <Kbd keys={part} />}</For>
                    </span>
                </Row>
            )}
        </For>
    );
}

function About() {
    return (
        <>
            <Row title="Version">
                <span class="srow-value">{app.hello?.version ?? "—"}</span>
            </Row>
            <Row title="Protocol">
                <span class="srow-value">{app.hello?.protocol ?? "—"}</span>
            </Row>
            <Row title="Data">
                <span class="srow-value mono">{app.hello?.home ?? "—"}</span>
            </Row>
            <Row title="Platform">
                <span class="srow-value">{app.hello?.platform ?? "—"}</span>
            </Row>
            <Row title="Connection">
                <span class="srow-value">{app.conn}</span>
            </Row>
        </>
    );
}

const INTRO: Record<SettingsTab, string> = {
    general: "Defaults for new sessions, and how Harness behaves.",
    appearance: "How Harness looks on this computer. Changes apply as you pick.",
    providers: "Where the models come from: API keys, and the CLIs signed in on this computer.",
    usage: "Your plans' limits, and the tokens and cost of your sessions by model.",
    shortcuts: "Keys that work across the app.",
    about: "This build, and where it keeps its data.",
};

export function SettingsPage() {
    const label = () => TABS.find((t) => t.id === tab())?.label ?? "Settings";
    let page: HTMLDivElement | undefined;
    // Each section starts at its top.
    createEffect(on(tab, () => page?.scrollTo({ top: 0 }), { defer: true }));
    return (
        <>
            <TitleBar>
                <span class="bc static">Settings</span>
                <CrumbSep />
                <span class="bc static current">{label()}</span>
            </TitleBar>
            <div ref={page} class="settings-page">
                <div class="settings-col">
                    <h1 class="set-h1">{label()}</h1>
                    <p class="set-intro">{INTRO[tab()]}</p>
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
        </>
    );
}
