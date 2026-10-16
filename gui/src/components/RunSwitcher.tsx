// In the header of a session that's part of a run: the run's other sessions,
// each its model and how it's doing, one click away.

import { For, Show } from "solid-js";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, handleFor } from "../state/app";
import { ProviderIcon } from "./ui/ProviderIcon";

function state(s: SessionSummary): { word: string; tone: string } {
    const status = handleFor(s.id)?.view.state.status ?? s.status;
    if (status === "running") return { word: "working", tone: "running" };
    if (status === "waiting") return { word: "needs you", tone: "waiting" };
    if (status === "error") return { word: "stopped", tone: "stopped" };
    return { word: "done", tone: "done" };
}

export function RunSwitcher(p: { id: string }) {
    const run = () => app.sessions.find((s) => s.id === p.id)?.run;
    // Archived ones are out of the way here too.
    const members = () => (run() ? app.sessions.filter((s) => s.run?.id === run()!.id).sort((a, b) => a.createdAt - b.createdAt) : []);
    return (
        <Show when={members().length > 1}>
            <div class="run-switch" role="group" aria-label={`Models given “${run()!.label}”`}>
                <For each={members()}>
                    {(s) => (
                        <button class={`rs ${s.id === p.id ? "on" : ""}`} aria-current={s.id === p.id ? "page" : undefined} title={`${s.run!.modelName}: ${state(s).word}\n${s.cwd}`} onClick={() => s.id !== p.id && void activate(s.id)}>
                            <ProviderIcon id={s.run!.model.split(":")[0]!} size={12} />
                            <span class="truncate">{s.run!.modelName}</span>
                            <span class={`rs-st st-${state(s).tone}`}>{state(s).word}</span>
                        </button>
                    )}
                </For>
            </div>
        </Show>
    );
}
