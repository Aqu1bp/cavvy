// In the header of a session that's part of a run: the run's other sessions,
// each its model and how it's doing, one click away.

import { For, Show } from "solid-js";
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
            <div class="runs" role="group" aria-label={`Models given “${run()!.label}”`}>
                <For each={members()}>
                    {(s) => (
                        <button class="runs-item" aria-current={s.id === p.id ? "page" : undefined} title={`${s.run!.modelName}: ${state(s).word}\n${s.cwd}`} onClick={() => s.id !== p.id && void activate(s.id)}>
                            <ProviderIcon id={s.run!.model.split(":")[0]!} size={13} />
                            <span class="runs-name">{s.run!.modelName}</span>
                            <span class="runs-state" data-tone={state(s).tone}>{state(s).word}</span>
                        </button>
                    )}
                </For>
            </div>
        </Show>
    );
}
