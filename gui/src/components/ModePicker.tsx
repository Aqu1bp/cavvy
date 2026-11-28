import { For, Show } from "solid-js";
import { ChevronDown, FilePen, Hand, Map as MapIcon, ShieldAlert, ShieldCheck } from "lucide-solid";
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
                    <Show when={p.mode !== "auto"} fallback={<ShieldCheck size={s} />}>
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

/** Words alone, on the button and in its menu. Plan, in the accent, and Bypass, in red, on the button: the two worth noticing. */
export function ModePicker(p: ComposerMenu & { /** The session it's for (default: the one shown). */ sessionId?: string; mode: PermissionModeId; bypassAllowed: boolean }) {
    let anchor: HTMLButtonElement | undefined;
    const describe = (m: PermissionModeId) => MODE_LABELS[m].description;
    return (
        <>
            <button
                ref={anchor}
                class="bar-btn mode"
                data-mode={p.mode === "plan" ? "plan" : p.mode === "bypassPermissions" ? "bypass" : undefined}
                aria-haspopup="menu"
                aria-expanded={p.open}
                onClick={() => p.setOpen(!p.open)}
                title="Permission mode (⇧Tab)"
            >
                <span class="bar-main">{MODE_LABELS[p.mode].label}</span>
                <ChevronDown size={13} class="bar-chev" />
            </button>
            <Menu label="Permission mode" open={p.open} anchor={() => anchor} onClose={() => p.setOpen(false)} placement={p.placement ?? "top"} align="start" offset={8} width={336} class="menu menu-wide menu-choice">
                <div class="menu-label">Permission mode</div>
                <For each={MODES}>
                    {(m) => {
                        const disabled = () => m === "bypassPermissions" && !p.bypassAllowed;
                        return (
                            <button
                                class="menu-item menu-item-two"
                                role="menuitemradio"
                                aria-checked={p.mode === m}
                                disabled={disabled()}
                                onClick={() => {
                                    p.setOpen(false);
                                    void setMode(m, p.sessionId);
                                }}
                            >
                                <span class="menu-item-text">
                                    <span class="menu-item-name">{MODE_LABELS[m].label}</span>
                                    {/* Off, what turns it on matters more than what it does. */}
                                    <span class="menu-item-sub">{disabled() ? BYPASS_OFF : describe(m)}</span>
                                </span>
                            </button>
                        );
                    }}
                </For>
            </Menu>
        </>
    );
}
