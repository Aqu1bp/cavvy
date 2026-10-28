import { For, Show } from "solid-js";
import { Check, ChevronDown, FilePen, Hand, Map as MapIcon, ShieldAlert, Zap } from "lucide-solid";
import { MODE_LABELS, type PermissionModeId } from "@shared/protocol";
import { setMode } from "../state/actions";
import { Menu } from "./ui/Menu";
import type { ComposerMenu } from "./ModelPicker";

export const MODES: PermissionModeId[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export function ModeIcon(p: { mode: PermissionModeId; size?: number }) {
    const s = p.size ?? 13;
    return (
        <Show when={p.mode !== "default"} fallback={<Hand size={s} />}>
            <Show when={p.mode !== "acceptEdits"} fallback={<FilePen size={s} />}>
                <Show when={p.mode !== "plan"} fallback={<MapIcon size={s} />}>
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

const BYPASS_OFF = "Turn on “Allow bypass mode” in Settings first.";

/** Grey but Plan, in the accent, and Bypass, in red: the two worth noticing. */
export function ModePicker(p: ComposerMenu & { mode: PermissionModeId; bypassAllowed: boolean }) {
    let anchor: HTMLButtonElement | undefined;
    return (
        <>
            <button
                ref={anchor}
                class={`pick mode ${p.mode === "plan" ? "mode-plan" : p.mode === "bypassPermissions" ? "mode-bypass" : ""} ${p.open ? "open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={p.open}
                onClick={() => p.setOpen(!p.open)}
                title={`Permission mode: ${MODE_LABELS[p.mode].label} (⇧Tab cycles)`}
            >
                <ModeIcon mode={p.mode} size={14} />
                <span class="lbl">{MODE_LABELS[p.mode].label}</span>
                <ChevronDown size={13} class="chev" />
            </button>
            <Menu label="Permission mode" open={p.open} anchor={() => anchor} onClose={() => p.setOpen(false)} placement={p.placement ?? "top"} width={340}>
                <div class="mode-menu">
                    <div class="menu-head">
                        <span>Permission mode</span>
                        <kbd>⇧Tab</kbd>
                    </div>
                    <For each={MODES}>
                        {(m) => {
                            const disabled = () => m === "bypassPermissions" && !p.bypassAllowed;
                            return (
                                <button
                                    class={`menu-item ${p.mode === m ? "on" : ""} ${m === "bypassPermissions" ? "danger" : ""}`}
                                    role="menuitemradio"
                                    aria-checked={p.mode === m}
                                    disabled={disabled()}
                                    title={disabled() ? BYPASS_OFF : MODE_LABELS[m].description}
                                    onClick={() => {
                                        p.setOpen(false);
                                        void setMode(m);
                                    }}
                                >
                                    <span class="menu-ico">
                                        <ModeIcon mode={m} size={15} />
                                    </span>
                                    <span class="menu-text">
                                        <span class="menu-label">{MODE_LABELS[m].label}</span>
                                        {/* Off, what turns it on matters more than what it does. */}
                                        <Show when={disabled()} fallback={<span class="menu-desc">{MODE_LABELS[m].description}</span>}>
                                            <span class="menu-desc menu-hint">{BYPASS_OFF}</span>
                                        </Show>
                                    </span>
                                    <Show when={p.mode === m}>
                                        <Check size={15} stroke-width={2} class="menu-check" />
                                    </Show>
                                </button>
                            );
                        }}
                    </For>
                </div>
            </Menu>
        </>
    );
}
