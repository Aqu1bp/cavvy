import { createSignal, For, Show, type JSX } from "solid-js";
import { Check, ChevronDown } from "lucide-solid";
import { Menu } from "./Menu";

export interface SelectOption {
    value: string;
    label: string;
    /** A heading over this option and the ones after it (a provider's name over its models). */
    group?: string;
    icon?: JSX.Element;
    /** Said after the name, dimmer: "(not found)". */
    note?: string;
    disabled?: boolean;
}

/**
 * The design's select: a small raised button with the value and a caret, opening a menu of the choices with a check
 * on the chosen one (the mock's ui.tsx Select). A value with no option shows `placeholder`.
 */
export function Select(p: { label: string; value: string; options: SelectOption[]; onChange: (v: string) => void; width?: number; placeholder?: string; disabled?: boolean; title?: string; mono?: boolean }) {
    const [open, setOpen] = createSignal(false);
    let btn: HTMLButtonElement | undefined;
    const current = () => p.options.find((o) => o.value === p.value);
    const pick = (o: SelectOption) => {
        setOpen(false);
        if (o.value !== p.value) p.onChange(o.value);
    };
    return (
        <>
            <button
                ref={btn}
                type="button"
                class="select"
                aria-label={p.label}
                aria-haspopup="menu"
                aria-expanded={open()}
                data-state={open() ? "open" : undefined}
                data-tip={p.title}
                disabled={p.disabled}
                style={p.width ? { width: `calc(${p.width} * var(--sp))` } : undefined}
                onClick={() => setOpen(!open())}
            >
                {current()?.icon}
                <span class={`select-value ${p.mono ? "mono" : ""}`}>{current()?.label ?? p.placeholder ?? ""}</span>
                <ChevronDown size={13} class="select-caret" />
            </button>
            <Menu open={open()} anchor={() => btn} onClose={() => setOpen(false)} label={p.label} align="end" offset={4} width={p.width ?? 220} class="menu-scroll">
                <For each={p.options}>
                    {(o) => (
                        <>
                            <Show when={o.group}>
                                <div class="menu-label">{o.group}</div>
                            </Show>
                            <button type="button" class="menu-item" role="menuitemradio" aria-checked={o.value === p.value} disabled={o.disabled} data-disabled={o.disabled || undefined} onClick={() => pick(o)}>
                                <span class="menu-check">
                                    <Show when={o.value === p.value}>
                                        <Check size={14} />
                                    </Show>
                                </span>
                                {o.icon}
                                <span class={`menu-item-name ${p.mono ? "mono" : ""}`}>{o.label}</span>
                                <Show when={o.note}>
                                    <span class="menu-item-note">{o.note}</span>
                                </Show>
                            </button>
                        </>
                    )}
                </For>
            </Menu>
        </>
    );
}
