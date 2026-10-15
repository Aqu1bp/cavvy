import { createSignal, For, Match, Show, Switch } from "solid-js";
import { Check, ExternalLink, Info, KeyRound, Keyboard, Palette, Plug, SlidersHorizontal, Trash2 } from "lucide-solid";
import { MODE_LABELS, type EffortLevel, type GuiSettings, type PermissionModeId, type ProviderInfo } from "@shared/protocol";
import { app, refreshModels, refreshProviders, refreshSettings, reportError, rpc, setApp, toast } from "../state/app";
import { connectCli } from "../state/actions";
import { ACCENTS, prefs, setPrefs, THEMES, type ThemeId } from "../state/prefs";
import { setSettingsTab, settingsTab, type SettingsTab } from "../state/ui";
import { mod, openExternal } from "../lib/platform";
import { MODES } from "./ModePicker";
import { Dialog } from "./ui/Dialog";
import { Kbd, Segmented, Spinner, Toggle } from "./ui/bits";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "providers", label: "Providers", icon: Plug },
    { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
    { id: "about", label: "About", icon: Info },
];

function Row(p: { label: string; hint?: string; children: any }) {
    return (
        <div class="set-row">
            <div class="set-label">
                <div>{p.label}</div>
                <Show when={p.hint}>
                    <div class="set-hint">{p.hint}</div>
                </Show>
            </div>
            <div class="set-control">{p.children}</div>
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

function ModelSelect(p: { value?: string; onChange: (v: string) => void; empty: string }) {
    return (
        <select class="select" value={p.value ?? ""} onChange={(e) => p.onChange(e.currentTarget.value)}>
            <option value="">{p.empty}</option>
            <For each={app.models}>
                {(g) => (
                    <optgroup label={g.providerName}>
                        <For each={g.models}>{(m) => <option value={m.ref}>{m.name}</option>}</For>
                    </optgroup>
                )}
            </For>
        </select>
    );
}

function General() {
    const s = () => app.settings;
    return (
        <>
            <div class="set-group">Defaults for new sessions</div>
            <Row label="Model" hint="Also changes when you pick a model in a session.">
                <ModelSelect value={s().model} empty="Automatic" onChange={(v) => void update({ model: v })} />
            </Row>
            <Row label="Small model" hint="For the auto-mode reviewer, session titles and page summaries.">
                <ModelSelect value={s().smallModel} empty="Provider's small default" onChange={(v) => void update({ smallModel: v })} />
            </Row>
            <Row label="Permission mode">
                <select class="select" value={s().defaultMode ?? "default"} onChange={(e) => void update({ defaultMode: e.currentTarget.value as PermissionModeId })}>
                    <For each={MODES.filter((m) => m !== "bypassPermissions" || s().allowBypass)}>{(m) => <option value={m}>{MODE_LABELS[m].label}</option>}</For>
                </select>
            </Row>
            <Row label="Reasoning effort">
                <Segmented size="sm" value={(s().effort ?? "medium") as EffortLevel} onChange={(e) => void update({ effort: e })} options={(["low", "medium", "high", "xhigh", "max"] as EffortLevel[]).map((e) => ({ value: e, label: e }))} />
            </Row>
            <div class="set-group">Behavior</div>
            <Row label="Show thinking" hint="The model's reasoning, when the provider shares it.">
                <Toggle
                    checked={prefs.showThinking}
                    onChange={(v) => {
                        setPrefs("showThinking", v);
                        void update({ showThinking: v });
                    }}
                />
            </Row>
            <Row label="Compact automatically" hint="Summarize the conversation when the context window is nearly full.">
                <Toggle checked={s().autoCompact !== false} onChange={(v) => void update({ autoCompact: v })} />
            </Row>
            <Row label="Web search">
                <select class="select" value={s().webSearch ?? "auto"} onChange={(e) => void update({ webSearch: e.currentTarget.value })}>
                    <option value="auto">Automatic</option>
                    <option value="anthropic">Anthropic (built in)</option>
                    <option value="brave">Brave</option>
                    <option value="tavily">Tavily</option>
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="off">Off</option>
                </select>
            </Row>
            <Row label="Allow bypass mode" hint="Lets sessions run everything without asking. Only for sandboxes and containers.">
                <Toggle checked={Boolean(s().allowBypass)} onChange={(v) => void update({ allowBypass: v })} />
            </Row>
            <div class="set-group">This device</div>
            <Row label="Notifications" hint="When a session needs you or finishes while you're elsewhere.">
                <Toggle checked={prefs.notifications} onChange={(v) => setPrefs("notifications", v)} />
            </Row>
            <Row label="Enter sends" hint={`Off: ${mod}+Enter sends and Enter adds a line.`}>
                <Toggle checked={prefs.enterSends} onChange={(v) => setPrefs("enterSends", v)} />
            </Row>
            <Row label="Expand tool activity" hint="Show every tool call instead of a one-line summary.">
                <Toggle checked={prefs.expandActivity} onChange={(v) => setPrefs("expandActivity", v)} />
            </Row>
        </>
    );
}

function ThemeCard(p: { id: ThemeId }) {
    const t = () => THEMES.find((x) => x.id === p.id)!;
    const active = () => prefs.theme === p.id;
    return (
        <button class={`theme-card ${active() ? "on" : ""}`} onClick={() => setPrefs("theme", p.id)} title={t().name}>
            <div class="theme-preview" style={{ background: t().swatch[0] }}>
                <div class="tp-side" style={{ background: t().swatch[1] }}>
                    <span style={{ background: t().swatch[2], opacity: 0.25 }} />
                    <span style={{ background: t().swatch[2], opacity: 0.18 }} />
                    <span style={{ background: t().swatch[2], opacity: 0.18 }} />
                </div>
                <div class="tp-main">
                    <span class="tp-bubble" style={{ background: t().swatch[2], opacity: 0.12 }} />
                    <span class="tp-line" style={{ background: t().swatch[2], opacity: 0.3 }} />
                    <span class="tp-line short" style={{ background: t().swatch[2], opacity: 0.2 }} />
                    <span class="tp-accent" style={{ background: t().swatch[3] }} />
                </div>
            </div>
            <div class="theme-name">
                <span>{t().name}</span>
                <Show when={active()}>
                    <Check size={13} />
                </Show>
            </div>
        </button>
    );
}

function Appearance() {
    return (
        <>
            <div class="set-group">Theme</div>
            <div class="theme-grid">
                <button class={`theme-card system ${prefs.theme === "system" ? "on" : ""}`} onClick={() => setPrefs("theme", "system")}>
                    <div class="theme-preview split">
                        <div style={{ background: "#ffffff" }} />
                        <div style={{ background: "#161618" }} />
                    </div>
                    <div class="theme-name">
                        <span>Match system</span>
                        <Show when={prefs.theme === "system"}>
                            <Check size={13} />
                        </Show>
                    </div>
                </button>
                <For each={THEMES}>{(t) => <ThemeCard id={t.id} />}</For>
            </div>
            <Show when={prefs.theme === "system"}>
                <Row label="Light and dark themes" hint="Used when your system switches.">
                    <div class="row-gap">
                        <select class="select" value={prefs.lightTheme} onChange={(e) => setPrefs("lightTheme", e.currentTarget.value as ThemeId)}>
                            <For each={THEMES}>{(t) => <option value={t.id}>{t.name}</option>}</For>
                        </select>
                        <select class="select" value={prefs.darkTheme} onChange={(e) => setPrefs("darkTheme", e.currentTarget.value as ThemeId)}>
                            <For each={THEMES}>{(t) => <option value={t.id}>{t.name}</option>}</For>
                        </select>
                    </div>
                </Row>
            </Show>
            <Row label="Accent" hint="Links, focus, progress and highlights.">
                <div class="swatches">
                    <button class={`swatch theme-default ${!prefs.accent ? "on" : ""}`} title="The theme's own" onClick={() => setPrefs("accent", undefined)} />
                    <For each={ACCENTS}>{(a) => <button class={`swatch ${prefs.accent === a.id ? "on" : ""}`} style={{ background: a.color }} title={a.name} onClick={() => setPrefs("accent", a.id)} />}</For>
                </div>
            </Row>
            <Row label="Text size">
                <div class="row-gap">
                    <input type="range" min="12" max="18" step="1" value={prefs.fontSize} onInput={(e) => setPrefs("fontSize", Number(e.currentTarget.value))} />
                    <span class="muted small" style={{ width: "36px" }}>
                        {prefs.fontSize}px
                    </span>
                </div>
            </Row>
            <Row label="Density">
                <Segmented size="sm" value={prefs.density} onChange={(v) => setPrefs("density", v)} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
            </Row>
        </>
    );
}

function ProviderRow(p: { pr: ProviderInfo }) {
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
        try {
            await rpc.call("providers.removeKey", { provider: p.pr.id });
            await Promise.all([refreshProviders(), refreshModels()]);
            toast(p.pr.agentCli ? `Turned off ${p.pr.name}; it stays signed in` : `Removed the ${p.pr.name} key`);
        } catch (e) {
            reportError(e);
        }
    };
    const connect = async () => {
        setBusy(true);
        await connectCli(p.pr);
        setBusy(false);
    };
    return (
        <div class="prov">
            <div class="prov-line">
                <span class={`dot ${p.pr.configured ? "ok" : ""}`} />
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
                                <button class="icon-btn" title={`Turn off (${p.pr.name} stays signed in)`} onClick={() => void remove()}>
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
                        <button class="icon-btn" title="Remove key" onClick={() => void remove()}>
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
                <input class="input mono" type="password" placeholder="Paste any API key; the provider is detected from its format" value={key()} onInput={(e) => setKey(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void quickAdd()} />
                <button class="btn primary sm" disabled={!key().trim() || busy()} onClick={() => void quickAdd()}>
                    {busy() ? <Spinner size={12} /> : "Add"}
                </button>
            </div>
            <div class="set-hint" style={{ margin: "0 2px 14px" }}>
                Keys are checked with one cheap request, then stored in your OS keychain (or a private file when there's none). They're only ever sent to their own provider and are masked everywhere else.
            </div>
            <div class="set-group">Models</div>
            <For each={models()}>{(pr) => <ProviderRow pr={pr} />}</For>
            <div class="set-group">Web search</div>
            <For each={search()}>{(pr) => <ProviderRow pr={pr} />}</For>
            <div class="set-hint" style={{ "margin-top": "12px" }}>
                Claude Code and Codex use your own Claude subscription or ChatGPT plan through the CLI installed on this computer; it stays signed in on its own and nothing secret is stored here. Gemini on Google Cloud (Vertex AI) is set up from the terminal with <code>harness auth add vertex</code>. Custom OpenAI-compatible endpoints: <code>/login custom</code> in the terminal app.
            </div>
        </>
    );
}

const SHORTCUTS: [string, string][] = [
    [`${mod}+N`, "New session"],
    [`${mod}+K`, "Search sessions and actions"],
    [`${mod}+,`, "Settings"],
    [`${mod}+B`, "Toggle the sidebar"],
    [`${mod}+.`, "Toggle the side panel"],
    [`${mod}+/`, "Switch model"],
    [`${mod}+[  ${mod}+]`, "Previous / next session"],
    [`${mod}+L`, "Focus the input box"],
    ["Shift+Tab", "Cycle permission mode"],
    ["Esc", "Interrupt (while working) · deny a permission"],
    ["1  2  3", "Answer the request above the input"],
    ["Enter  Shift+Enter", "Send · new line"],
    ["↑", "Previous prompt (empty input)"],
    ["@", "Mention a file"],
    ["/", "Commands"],
    ["!", "Run a shell command yourself"],
];

function Shortcuts() {
    return (
        <div class="shortcuts">
            <For each={SHORTCUTS}>
                {([k, d]) => (
                    <div class="sc-row">
                        <span>{d}</span>
                        <span class="sc-keys">
                            <For each={k.split("  ")}>{(part) => <Kbd keys={part} />}</For>
                        </span>
                    </div>
                )}
            </For>
        </div>
    );
}

function About() {
    return (
        <dl class="kv">
            <dt>Version</dt>
            <dd>{app.hello?.version ?? "—"}</dd>
            <dt>Protocol</dt>
            <dd>{app.hello?.protocol ?? "—"}</dd>
            <dt>Data</dt>
            <dd class="mono">{app.hello?.home ?? "—"}</dd>
            <dt>Platform</dt>
            <dd>{app.hello?.platform ?? "—"}</dd>
            <dt>Connection</dt>
            <dd>{app.conn}</dd>
        </dl>
    );
}

export function SettingsDialog() {
    const tab = () => settingsTab() ?? "general";
    return (
        <Dialog open={Boolean(settingsTab())} onClose={() => setSettingsTab(undefined)} bare width={820} class="settings">
            <div class="set-wrap">
                <nav class="set-nav">
                    <div class="set-title">Settings</div>
                    <For each={TABS}>
                        {(t) => (
                            <button
                                class={`nav-item ${tab() === t.id ? "active" : ""}`}
                                onClick={() => {
                                    setSettingsTab(t.id);
                                    if (t.id === "providers") void refreshProviders();
                                    if (t.id === "general") void refreshSettings();
                                }}
                            >
                                <t.icon size={15} />
                                <span>{t.label}</span>
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
                        <Match when={tab() === "shortcuts"}>
                            <Shortcuts />
                        </Match>
                        <Match when={tab() === "about"}>
                            <About />
                        </Match>
                    </Switch>
                </div>
            </div>
        </Dialog>
    );
}
