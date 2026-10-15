import { For, Show } from "solid-js";
import { Check, ChevronDown, Eye, FastForward, Hand, ShieldAlert, Zap } from "lucide-solid";
import { MODE_LABELS, type PermissionModeId } from "@shared/protocol";
import { setMode } from "../state/actions";
import { Popover } from "./ui/Popover";
import { Kbd } from "./ui/bits";

export const MODES: PermissionModeId[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export function ModeIcon(p: { mode: PermissionModeId; size?: number }) {
    const s = p.size ?? 13;
    return (
        <Show when={p.mode !== "default"} fallback={<Hand size={s} />}>
            <Show when={p.mode !== "acceptEdits"} fallback={<FastForward size={s} />}>
                <Show when={p.mode !== "plan"} fallback={<Eye size={s} />}>
                    <Show when={p.mode !== "auto"} fallback={<Zap size={s} />}>
                        <ShieldAlert size={s} />
                    </Show>
                </Show>
            </Show>
        </Show>
    );
}

export function nextMode(m: PermissionModeId, bypass: boolean): PermissionModeId {
    const cycle: PermissionModeId[] = ["default", "acceptEdits", "plan", "auto"];
    if (bypass) cycle.push("bypassPermissions");
    return cycle[(cycle.indexOf(m) + 1) % cycle.length]!;
}

export function ModePicker(p: { mode: PermissionModeId; bypassAllowed: boolean; open: boolean; setOpen: (v: boolean) => void }) {
    let anchor: HTMLButtonElement | undefined;
    return (
        <>
            <button ref={anchor} class={`chip-btn mode-${p.mode} ${p.open ? "active" : ""}`} onClick={() => p.setOpen(!p.open)} title="Permission mode (shift+tab cycles)">
                <ModeIcon mode={p.mode} />
                <span>{MODE_LABELS[p.mode].label}</span>
                <ChevronDown size={12} class="chev" />
            </button>
            <Popover open={p.open} anchor={() => anchor} onClose={() => p.setOpen(false)} placement="top" width={330} class="mode-picker">
                <div class="menu-head">
                    <span>Permission mode</span>
                    <Kbd keys="⇧+Tab" />
                </div>
                <For each={MODES}>
                    {(m) => {
                        const disabled = () => m === "bypassPermissions" && !p.bypassAllowed;
                        return (
                            <button
                                class={`menu-item mode-item mode-${m} ${p.mode === m ? "current" : ""}`}
                                disabled={disabled()}
                                title={disabled() ? "Start with --dangerously-skip-permissions, or set permissions.allowBypass in your user settings" : undefined}
                                onClick={() => {
                                    p.setOpen(false);
                                    void setMode(m);
                                }}
                            >
                                <span class="mode-dot">
                                    <ModeIcon mode={m} size={14} />
                                </span>
                                <span class="menu-text">
                                    <span class="menu-label">{MODE_LABELS[m].label}</span>
                                    <span class="menu-desc">{MODE_LABELS[m].description}</span>
                                </span>
                                <Show when={p.mode === m}>
                                    <Check size={14} class="menu-check" />
                                </Show>
                            </button>
                        );
                    }}
                </For>
            </Popover>
        </>
    );
}
