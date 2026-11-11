// Settings → Appearance: the theme, the colour scheme, the window's glass and tint, then text and layout.

import "../styles/appearance.css";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Check, Copy, Download, Minus, Plus, Trash2 } from "lucide-solid";
import { ACCENTS, activeTheme, CHAT_WIDTHS, prefs, PREF_DEFAULTS, setPrefs, type AccentId, type Scheme } from "../state/prefs";
import { allThemes, currentTheme, deleteTheme, editTheme, importTheme, isCustom, newTheme, restoreTheme, themeText, useTheme } from "../state/theme";
import { derive, type Theme } from "../lib/theme";
import { toast } from "../state/app";
import { copyText } from "../lib/platform";
import { Group, Row } from "./Settings";
import { Segmented } from "./ui/bits";

/**
 * A theme as a small picture of the window, drawn with the colours it gives in the scheme showing:
 * the rail on the window's glass with the open row, the sheet with what you said, a reply's lines
 * and Send. Its corners and typeface show too.
 */
function ThemeTile(p: { theme: Theme }) {
    const on = () => currentTheme().id === p.theme.id;
    const palette = createMemo(() => derive(p.theme, activeTheme()));
    return (
        <button class="th-tile" classList={{ on: on() }} role="radio" aria-checked={on()} onClick={() => useTheme(p.theme)}>
            <span class="th-pv" style={palette()} data-shape={p.theme.shape ?? "soft"} data-face={p.theme.typeface} aria-hidden="true">
                <span class="th-rail">
                    <i class="cur" />
                    <i />
                    <i />
                </span>
                <span class="th-sheet">
                    <u class="said" />
                    <span class="th-aa">Aa</span>
                    <u />
                    <u class="short" />
                    <b />
                </span>
            </span>
            <span class="th-name truncate">
                <Show when={on()}>
                    <Check size={12} stroke-width={3} />
                </Show>
                {p.theme.name}
            </span>
        </button>
    );
}

/** One of your own themes, changed as you go: the window follows each change. */
function ThemeEditor(p: { theme: Theme }) {
    // One change a frame: a slider says where it is far more often than the window can be redrawn.
    let frame = 0;
    let pending: Partial<Omit<Theme, "id">> = {};
    const change = (c: Partial<Omit<Theme, "id">>) => {
        pending = { ...pending, ...c };
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            editTheme(p.theme.id, pending);
            pending = {};
        });
    };
    const remove = () => {
        const gone = deleteTheme(p.theme.id);
        if (gone) toast(`Deleted ${gone.name}`, "info", { label: "Undo", run: () => restoreTheme(gone) });
    };
    return (
        <div class="set-group ap-group th-edit">
            <Row title="Name">
                <input class="input th-field" value={p.theme.name} maxLength={40} aria-label="Theme name" onChange={(e) => editTheme(p.theme.id, { name: e.currentTarget.value })} />
            </Row>
            <Row title="Colour" desc="The window, its surfaces and text.">
                <div class="th-sliders">
                    <input type="range" class="th-hue" min="0" max="359" value={Math.round(p.theme.hue)} aria-label="Hue" onInput={(e) => change({ hue: Number(e.currentTarget.value) })} />
                    <input type="range" class="th-tint" min="0" max="100" value={Math.round(p.theme.tint * 100)} aria-label="How much colour" style={{ "--th-hue": `${Math.round(p.theme.hue)}` }} onInput={(e) => change({ tint: Number(e.currentTarget.value) / 100 })} />
                </div>
            </Row>
            <Row title="Accent" desc="Send, primary buttons, links and focus.">
                <label class="th-accent">
                    <input type="color" value={p.theme.accent} aria-label="Accent colour" onInput={(e) => change({ accent: e.currentTarget.value })} />
                    <span class="mono">{p.theme.accent}</span>
                </label>
            </Row>
            <Row title="Corners">
                <Segmented
                    size="sm"
                    label="Corners"
                    value={p.theme.shape ?? "soft"}
                    onChange={(v) => editTheme(p.theme.id, { shape: v })}
                    options={[
                        { value: "sharp", label: "Sharp" },
                        { value: "soft", label: "Soft" },
                        { value: "round", label: "Round" },
                    ]}
                />
            </Row>
            <Row title="Typeface">
                <Segmented
                    size="sm"
                    label="Typeface"
                    value={p.theme.typeface ?? "system"}
                    onChange={(v) => editTheme(p.theme.id, { typeface: v })}
                    options={[
                        { value: "system", label: "System" },
                        { value: "serif", label: "Serif" },
                        { value: "mono", label: "Mono" },
                    ]}
                />
            </Row>
            <div class="th-acts">
                <button class="btn secondary sm" onClick={async () => (await copyText(themeText(p.theme))) && toast("Theme copied", "success")}>
                    <Copy size={14} /> Copy theme
                </button>
                <span class="grow" />
                <button class="btn ghost sm th-del" onClick={remove}>
                    <Trash2 size={14} /> Delete
                </button>
            </div>
        </div>
    );
}

/** The themes: the built-in ones, then yours, then making one from the theme in use or from one copied elsewhere. */
function Themes() {
    const [pasting, setPasting] = createSignal(false);
    const [bad, setBad] = createSignal(false);
    const take = (text: string) => {
        if (!text.trim()) return;
        if (importTheme(text)) setPasting(false);
        setBad(!bad() && pasting());
    };
    const mine = () => (isCustom(currentTheme().id) ? currentTheme() : undefined);
    return (
        <>
            <div class="th-grid" role="radiogroup" aria-label="Theme">
                <For each={allThemes()}>{(t) => <ThemeTile theme={t} />}</For>
                <button class="th-tile th-new" title="A theme of your own, starting from this one" onClick={() => newTheme(currentTheme(), isCustom(currentTheme().id) ? undefined : `My ${currentTheme().name}`)}>
                    <span class="th-pv">
                        <Plus size={18} />
                    </span>
                    <span class="th-name">New theme</span>
                </button>
                <button class="th-tile th-new" classList={{ on: pasting() }} aria-expanded={pasting()} onClick={() => (setBad(false), setPasting(!pasting()))}>
                    <span class="th-pv">
                        <Download size={18} />
                    </span>
                    <span class="th-name">Import</span>
                </button>
            </div>
            <Show when={pasting()}>
                <div class="th-paste">
                    <input
                        class="input"
                        placeholder="Paste a copied theme"
                        aria-label="Paste a copied theme"
                        aria-invalid={bad()}
                        ref={(el) => requestAnimationFrame(() => el.focus())}
                        onPaste={(e) => (e.preventDefault(), take(e.clipboardData?.getData("text") ?? ""))}
                        onKeyDown={(e) => e.key === "Enter" && take(e.currentTarget.value)}
                        onInput={() => setBad(false)}
                    />
                    <Show when={bad()}>
                        <span class="tone-err" role="alert">That isn't a theme.</span>
                    </Show>
                </div>
            </Show>
            <Show when={mine()} keyed>
                {(t) => <ThemeEditor theme={t} />}
            </Show>
        </>
    );
}

/**
 * A small picture of the window in that scheme: the rail on the glass, the
 * sheet beside it. Each face carries its own data-theme, so it's drawn with
 * that palette's tokens whichever scheme is showing; System is half of each.
 */
function SchemeTile(p: { id: Scheme; label: string }) {
    const on = () => prefs.scheme === p.id;
    return (
        <button class={`ap-tile ${on() ? "on" : ""}`} aria-pressed={on()} onClick={() => setPrefs("scheme", p.id)}>
            <span class="ap-pv" aria-hidden="true">
                <Show when={p.id !== "dark"}>
                    <span class="ap-face" data-theme="light">
                        <i />
                        <u />
                    </span>
                </Show>
                <Show when={p.id !== "light"}>
                    <span class={`ap-face ${p.id === "system" ? "half" : ""}`} data-theme="dark">
                        <i />
                        <u />
                    </span>
                </Show>
            </span>
            {p.label}
        </button>
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

/** Settings → Appearance: the theme, its scheme, then the window's look, then text and layout. */
export function Appearance() {
    const size = (n: number) => setPrefs("fontSize", Math.max(12, Math.min(18, n)));
    // No choice: the theme's own accent.
    const pickAccent = (id: AccentId | undefined) => setPrefs("accent", id);
    return (
        <div class="ap">
            <Group>Theme</Group>
            <Themes />

            <Group>Colour scheme</Group>
            <div class="set-group ap-group">
                <div class="ap-tiles" role="group" aria-label="Colour scheme">
                    <SchemeTile id="system" label="System" />
                    <SchemeTile id="light" label="Light" />
                    <SchemeTile id="dark" label="Dark" />
                </div>
            </div>

            <Group>Look</Group>
            <div class="set-group ap-group">
                <Row title="Accent" desc="Send, primary buttons, links and focus." changed={prefs.accent !== undefined} reset={() => pickAccent(undefined)}>
                    <div class="ap-swatches" role="group" aria-label="Accent">
                        <button class={`ap-own ${prefs.accent ? "" : "on"}`} aria-pressed={!prefs.accent} style={{ background: derive(currentTheme(), activeTheme())["--accent"] }} title="The theme's own" aria-label="The theme's own" onClick={() => pickAccent(undefined)} />
                        <For each={ACCENTS}>
                            {(a) => <button class={prefs.accent === a.id ? "on" : ""} aria-pressed={prefs.accent === a.id} style={{ background: a.color }} title={a.name} aria-label={a.name} onClick={() => pickAccent(a.id)} />}
                        </For>
                    </div>
                </Row>
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
                <Row title="Window tint" desc="The colour of the glass behind the sidebar." changed={prefs.tint !== PREF_DEFAULTS.tint} reset={() => setPrefs("tint", PREF_DEFAULTS.tint)} class="ap-tint-row">
                    <div class="ap-tiles ap-tint-tiles" role="group" aria-label="Window tint">
                        <TintTile id="clear" label="Clear" />
                        <TintTile id="ocean" label="Ocean" />
                        <TintTile id="accent" label="Accent" />
                    </div>
                </Row>
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
                    The list sorts on <code>updatedAt</code>, so a finished run moves for one frame before its status lands.
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
