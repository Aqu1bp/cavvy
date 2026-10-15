import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Check, ChevronDown, RefreshCw, Sparkles } from "lucide-solid";
import type { EffortLevel, ModelSummary } from "@shared/protocol";
import { price, tokens } from "../lib/format";
import { app, refreshModels } from "../state/app";
import { setEffort, setModel } from "../state/actions";
import { setSettingsTab } from "../state/ui";
import { Popover } from "./ui/Popover";
import { Segmented, Spinner } from "./ui/bits";

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function fuzzy(q: string, s: string): boolean {
    q = q.toLowerCase();
    s = s.toLowerCase();
    if (s.includes(q)) return true;
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    return i === q.length;
}

export function shortModel(m?: ModelSummary | { name?: string; id: string }): string {
    if (!m) return "No model";
    return (m.name ?? m.id).replace(/^claude-/i, "Claude ");
}

export function ModelPicker(p: { current?: ModelSummary; currentRef?: string; effort?: EffortLevel; open: boolean; setOpen: (v: boolean) => void }) {
    let anchor: HTMLButtonElement | undefined;
    let input: HTMLInputElement | undefined;
    let list: HTMLDivElement | undefined;
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const currentRef = () => p.current?.ref ?? p.currentRef;

    const groups = createMemo(() =>
        app.models
            .map((g) => ({ ...g, models: g.models.filter((m) => !m.deprecated || m.ref === currentRef()).filter((m) => !q() || fuzzy(q(), `${g.providerName} ${m.name} ${m.id}`)) }))
            .filter((g) => g.models.length || (!q() && g.status === "error")),
    );
    const flat = createMemo(() => groups().flatMap((g) => g.models));
    const currentModel = createMemo(() => p.current ?? app.models.flatMap((g) => g.models).find((m) => m.ref === currentRef()));

    createEffect(
        on(
            () => p.open,
            (open) => {
                if (!open) return;
                setQ("");
                const i = flat().findIndex((m) => m.ref === currentRef());
                setSel(Math.max(0, i));
                if (!app.models.length) void refreshModels();
                requestAnimationFrame(() => {
                    input?.focus();
                    list?.querySelector(".mp-item.sel")?.scrollIntoView({ block: "center" });
                });
            },
        ),
    );
    createEffect(on(q, () => setSel(0), { defer: true }));

    const choose = (m: ModelSummary) => {
        p.setOpen(false);
        void setModel(m.ref);
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = flat().length;
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => list?.querySelector(".mp-item.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const m = flat()[sel()];
            if (m) choose(m);
        }
    };
    const supportsEffort = () => Boolean(currentModel()?.supportsReasoning || currentModel()?.effortLevels?.length);

    return (
        <>
            <button ref={anchor} class={`chip-btn ${p.open ? "active" : ""}`} onClick={() => p.setOpen(!p.open)} title="Model">
                <Sparkles size={13} />
                <span class="truncate">{shortModel(currentModel() ?? (currentRef() ? { id: currentRef()!.split(":").slice(1).join(":") } : undefined))}</span>
                <Show when={p.effort && supportsEffort()}>
                    <span class="chip-sub">{p.effort}</span>
                </Show>
                <ChevronDown size={12} class="chev" />
            </button>
            <Popover open={p.open} anchor={() => anchor} onClose={() => p.setOpen(false)} placement="top" width={380} class="model-picker">
                <div class="mp-search">
                    <input ref={input} value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Search models…" spellcheck={false} />
                    <button class="icon-btn" title="Refresh model lists" onClick={() => void refreshModels(true)} disabled={app.modelsLoading}>
                        <Show when={app.modelsLoading} fallback={<RefreshCw size={14} />}>
                            <Spinner size={14} />
                        </Show>
                    </button>
                </div>
                <div class="mp-list" ref={list}>
                    <Show when={groups().length} fallback={<div class="mp-empty">{app.modelsLoading ? "Loading models…" : app.models.length ? "No models match." : "No providers yet. Add an API key in Settings."}</div>}>
                        <For each={groups()}>
                            {(g) => (
                                <div class="mp-group">
                                    <div class="mp-group-head">
                                        <span>{g.providerName}</span>
                                        <Show when={g.status === "cached"}>
                                            <span class="muted">cached</span>
                                        </Show>
                                        <Show when={g.status === "error"}>
                                            <span class="tone-err truncate" title={g.error}>
                                                {g.error ?? "unavailable"}
                                            </span>
                                        </Show>
                                    </div>
                                    <For each={g.models}>
                                        {(m) => (
                                            <button class={`mp-item ${flat()[sel()]?.ref === m.ref ? "sel" : ""} ${m.ref === currentRef() ? "current" : ""}`} onClick={() => choose(m)} onMouseMove={() => setSel(flat().indexOf(m))}>
                                                <span class="mp-check">
                                                    <Show when={m.ref === currentRef()}>
                                                        <Check size={13} />
                                                    </Show>
                                                </span>
                                                <span class="mp-name truncate">{m.name}</span>
                                                <span class="mp-meta">
                                                    <Show when={m.contextWindow}>
                                                        <span>{tokens(m.contextWindow!)}</span>
                                                    </Show>
                                                    <Show when={m.pricing}>
                                                        <span title={m.pricingEstimated ? "Estimated from OpenRouter's catalog" : "USD per million input / output tokens"}>
                                                            {m.pricingEstimated ? "~" : ""}
                                                            {price(m.pricing)}
                                                        </span>
                                                    </Show>
                                                </span>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            )}
                        </For>
                    </Show>
                </div>
                <div class="mp-foot">
                    <Show when={supportsEffort()} fallback={<span class="muted small">Reasoning effort isn't adjustable for this model</span>}>
                        <span class="muted small">Effort</span>
                        <Segmented size="sm" value={(p.effort ?? "medium") as EffortLevel} options={EFFORTS.filter((e) => !currentModel()?.effortLevels?.length || currentModel()!.effortLevels!.includes(e)).map((e) => ({ value: e, label: e === "medium" ? "med" : e }))} onChange={(e) => void setEffort(e)} />
                    </Show>
                    <button
                        class="link-btn"
                        onClick={() => {
                            p.setOpen(false);
                            setSettingsTab("providers");
                        }}
                    >
                        Providers…
                    </button>
                </div>
            </Popover>
        </>
    );
}
