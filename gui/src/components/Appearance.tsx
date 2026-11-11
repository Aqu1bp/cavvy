// Settings → Appearance: the theme, the colour scheme, the window's glass and tint, then text and layout.

import "../styles/appearance.css";
import { For, Show } from "solid-js";
import { Minus, Plus } from "lucide-solid";
import { ACCENTS, CHAT_WIDTHS, prefs, PREF_DEFAULTS, setPrefs, type AccentId, type Scheme } from "../state/prefs";
import { Group, Row } from "./Settings";
import { Segmented } from "./ui/bits";

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

/** Settings → Appearance, as the mockup draws it: scheme tiles, then the look, then text and layout. */
export function Appearance() {
    const size = (n: number) => setPrefs("fontSize", Math.max(12, Math.min(18, n)));
    // Blue is the default: picking it clears the choice.
    const accent = () => prefs.accent ?? "blue";
    const pickAccent = (id: AccentId) => setPrefs("accent", id === "blue" ? undefined : id);
    return (
        <div class="ap">
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
                <Row title="Accent" desc="Send, primary buttons, links and focus." changed={accent() !== "blue"} reset={() => setPrefs("accent", undefined)}>
                    <div class="ap-swatches" role="group" aria-label="Accent">
                        <For each={ACCENTS}>
                            {(a) => <button class={accent() === a.id ? "on" : ""} aria-pressed={accent() === a.id} style={{ background: a.color }} title={a.name} aria-label={a.name} onClick={() => pickAccent(a.id)} />}
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
