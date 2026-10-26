import { createSignal, For, Show, type JSX } from "solid-js";
import { Check, Copy } from "lucide-solid";
import { copyText } from "../../lib/platform";

export function Kbd(p: { keys: string }) {
    return (
        <span class="kbd-row">
            <For each={p.keys.split("+")}>{(k) => <kbd>{k}</kbd>}</For>
        </span>
    );
}

export function Spinner(p: { size?: number; class?: string }) {
    const s = p.size ?? 14;
    return (
        <svg class={`spinner ${p.class ?? ""}`} width={s} height={s} viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2" />
            <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
    );
}

export function CopyButton(p: { text: () => string; label?: string; class?: string }) {
    const [done, setDone] = createSignal(false);
    return (
        <button
            class={`icon-btn ${p.class ?? ""}`}
            title={p.label ?? "Copy"}
            aria-label={p.label ?? "Copy"}
            onClick={async (e) => {
                e.stopPropagation();
                if (await copyText(p.text())) {
                    setDone(true);
                    setTimeout(() => setDone(false), 1400);
                }
            }}
        >
            <Show when={done()} fallback={<Copy size={14} />}>
                <Check size={14} />
            </Show>
        </button>
    );
}

/** A circle showing how full something is (the context window). Neutral: grey until it's nearly full. */
export function Ring(p: { value: number; size?: number; stroke?: number; title?: string; neutral?: boolean; /** Overrides the tint the value alone would pick. */ tone?: "warning" | "danger" | "normal" }) {
    const size = p.size ?? 18;
    const stroke = p.stroke ?? 2.5;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const v = () => Math.max(0, Math.min(1, p.value));
    const tone = () => p.tone === "danger" ? "var(--danger)" : p.tone === "warning" ? "var(--warn)" : p.tone === "normal" ? (p.neutral ? "var(--fg-2)" : "var(--accent)")
        : (v() >= 0.85 ? "var(--danger)" : v() >= 0.7 ? "var(--warn)" : p.neutral ? "var(--fg-2)" : "var(--accent)");
    return (
        <svg class="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={p.title}>
            <title>{p.title}</title>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.neutral ? "color-mix(in srgb, var(--fg-2) 28%, transparent)" : "var(--line-strong)"} stroke-width={stroke} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone()} stroke-width={stroke} stroke-linecap="round" stroke-dasharray={`${c * v()} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </svg>
    );
}

/** A switch. `tone="danger"`: on is a warning colour (a setting that lowers a safeguard). */
export function Toggle(p: { checked: boolean; onChange: (v: boolean) => void; label?: string; tone?: "danger" }) {
    return (
        <button class={`toggle ${p.checked ? "on" : ""} ${p.tone ?? ""}`} role="switch" aria-checked={p.checked} aria-label={p.label} onClick={() => p.onChange(!p.checked)}>
            <span class="toggle-knob" />
        </button>
    );
}

/** A `disabled` option stays focusable and keeps its tooltip (which should say why), but can't be chosen.
 *  `name`: the option's accessible name, when its label alone doesn't say it (an icon, a bare count). */
export function Segmented<T extends string>(p: { value: T; options: { value: T; label: JSX.Element; name?: string; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; label?: string; size?: "sm" | "md" }) {
    return (
        <div class={`segmented seg-${p.size ?? "md"}`} role="radiogroup" aria-label={p.label}>
            <For each={p.options}>
                {(o) => (
                    <button role="radio" aria-checked={p.value === o.value} aria-disabled={o.disabled || undefined} aria-label={o.name} class={p.value === o.value ? "on" : ""} title={o.title} onClick={() => !o.disabled && p.onChange(o.value)}>
                        {o.label}
                    </button>
                )}
            </For>
        </div>
    );
}

/**
 * The app's mark (design/logo): a c with the accent dot on its top end.
 * `variant="brand"`: the small one in the window's frame (the rail's top row), in
 * the rail's ink. The c is snapped for that 20px tile on a 2x screen (4px stroke,
 * its outer edges on pixel lines), so it stays sharp there; design/logo/build.ts
 * draws the same geometry.
 */
export function Logo(p: { size?: number; variant?: "brand" }) {
    const s = p.size ?? 22;
    const brand = () => p.variant === "brand";
    return (
        <svg class={brand() ? "logo brand" : "logo"} width={s} height={s} viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill={brand() ? "var(--rail-fg)" : "var(--fg)"} />
            <path d="M43.2 21.27a14.4 14.4 0 1 0 0 21.46" stroke="var(--sheet)" stroke-width="6.4" stroke-linecap="round" fill="none" />
            <circle cx="43.2" cy="21.27" r="5.6" fill="var(--accent)" />
        </svg>
    );
}
