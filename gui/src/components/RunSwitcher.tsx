// In the header of a session that's part of a run: the run's other sessions,
// each its model and how it's doing, one click away.

import { For, Match, Show, Switch } from "solid-js";
import { X } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, handleFor } from "../state/app";
import { runStatus } from "../lib/run-status";
import { ProviderIcon } from "./ui/ProviderIcon";

function state(s: SessionSummary) {
    return runStatus(handleFor(s.id)?.view.state.status ?? s.status, s.run?.outcome);
}

export function RunSwitcher(p: { id: string }) {
    const run = () => app.sessions.find((s) => s.id === p.id)?.run;
    // Archived ones are out of the way here too.
    const members = () => (run() ? app.sessions.filter((s) => s.run?.id === run()!.id).sort((a, b) => a.createdAt - b.createdAt) : []);
    return (
        <Show when={members().length > 1}>
            <div class="runs" role="tablist" aria-label={`Models given “${run()!.label}”`}>
                <For each={members()}>
                    {(s) => (
                        <button class="runs-item" role="tab" aria-selected={s.id === p.id} title={`${s.run!.modelName}: ${state(s).word}\n${s.cwd}`} onClick={() => s.id !== p.id && void activate(s.id)}>
                            {/* Working: the rail's breathing dot in place of its mark. Waiting on you or stopped: a glyph after its name. */}
                            <Show when={state(s).tone === "running"} fallback={<ProviderIcon id={s.run!.model.split(":")[0]!} size={13} />}>
                                <span class="status-working" aria-hidden="true" />
                            </Show>
                            <span class="runs-name">{s.run!.modelName}</span>
                            <Switch>
                                <Match when={state(s).tone === "waiting"}>
                                    <span class="status-icon" data-status="needs" role="img" aria-label="Needs you"><span class="status-dot" /></span>
                                </Match>
                                <Match when={state(s).tone === "stopped"}>
                                    <span class="status-icon" data-status="failed" role="img" aria-label="Stopped"><X size={14} stroke-width={2.6} /></span>
                                </Match>
                            </Switch>
                        </button>
                    )}
                </For>
            </div>
        </Show>
    );
}
