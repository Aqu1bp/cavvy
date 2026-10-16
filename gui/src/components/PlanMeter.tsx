// The plan meter beside the context ring: where the user's Claude or ChatGPT
// plan stands, as the session's agent CLI last reported it. Limits are the
// account's, so every session on that CLI shows the same numbers.

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { app } from "../state/app";
import { setSettingsTab } from "../state/ui";
import { now } from "../lib/clock";
import { meterOf, windowLine } from "../lib/limits";
import { Popover } from "./ui/Popover";

export function PlanMeter(p: { provider?: string }) {
    let btn: HTMLButtonElement | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const [open, setOpen] = createSignal(false);
    const meter = createMemo(() => meterOf(p.provider ? app.limits[p.provider] : undefined, now()));
    const name = () => app.providers.find((x) => x.id === p.provider)?.agentCli?.plan ?? "Plan";
    const show = () => (clearTimeout(closeTimer), setOpen(true));
    const hide = () => (closeTimer = setTimeout(() => setOpen(false), 160));
    onCleanup(() => clearTimeout(closeTimer));
    const tone = () => (meter()?.reached ? "danger" : (meter()?.top ?? 0) >= 80 ? "warn" : "");
    const chip = () => {
        const m = meter()!;
        if (m.reached) return m.resets ? `Limit · ${m.resets.replace(/, in .*$/, "")}` : "Limit reached";
        return m.top !== undefined ? `${m.top}%` : "Plan";
    };
    return (
        <Show when={meter()}>
            <button
                ref={btn}
                class={`hb plan-meter ${tone()}`}
                aria-haspopup="dialog"
                aria-expanded={open()}
                aria-label={`${name()} usage: ${meter()!.windows.map(windowLine).join("; ") || "limit reached"}`}
                onMouseEnter={show}
                onMouseLeave={hide}
                onClick={() => setOpen(!open())}
            >
                <span class="plan-gauge" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, meter()!.reached ? 100 : (meter()!.top ?? 0))}%` }} />
                </span>
                <span class="num">{chip()}</span>
            </button>
            <Popover open={open()} anchor={() => btn} onClose={() => setOpen(false)} placement="top" align="end" width={280} class="ctx-card">
                <div onMouseEnter={show} onMouseLeave={hide}>
                    <div class="ctx-label">
                        {name()} limits
                        <Show when={meter()!.asOf}>
                            <span class="plan-asof"> · {meter()!.asOf}</span>
                        </Show>
                    </div>
                    <Show when={meter()!.reached}>
                        <div class="plan-reached">Limit reached{meter()!.resets ? `. Resets ${meter()!.resets}.` : "."}</div>
                    </Show>
                    <For each={meter()!.windows}>
                        {(w) => (
                            <div class="plan-window">
                                <div class="ctx-line">
                                    <span>{w.label}</span>
                                    <span class="ctx-pct num">{w.pct !== undefined ? `${w.pct}%` : w.reached ? "reached" : "—"}</span>
                                </div>
                                <Show when={w.pct !== undefined}>
                                    <div class="ctx-bar">
                                        <div class={`ctx-fill ${w.reached || (w.pct ?? 0) >= 90 ? "danger" : (w.pct ?? 0) >= 80 ? "warn" : ""}`} style={{ width: `${Math.min(100, w.pct ?? 0)}%` }} />
                                    </div>
                                </Show>
                                <Show when={w.resets}>
                                    <div class="plan-resets">Resets {w.resets}</div>
                                </Show>
                            </div>
                        )}
                    </For>
                    <div class="ctx-foot">
                        <span>From the CLI's own reports.</span>
                        <button
                            class="ghost-btn outlined"
                            onClick={() => {
                                setOpen(false);
                                setSettingsTab("usage");
                            }}
                        >
                            Usage
                        </button>
                    </div>
                </div>
            </Popover>
        </Show>
    );
}
