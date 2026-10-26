// A sub-agent's mark, the same wherever it's listed (the transcript's sub-agent card, the side panel's Agents
// tab, the permission dock): its provider's (ProviderIcon), or a robot when which provider runs it isn't known.
// And a group's: its distinct providers' marks, overlapping, a few and "+N" (lib/agent-marks.ts).

import { createMemo, For, Show } from "solid-js";
import { Bot } from "lucide-solid";
import { app } from "../../state/app";
import { runnerName } from "../../lib/background";
import { providerStack } from "../../lib/agent-marks";
import { plural } from "../../lib/format";
import { ProviderIcon } from "./ProviderIcon";

/** A provider's name, as the app lists it ("Claude Code", "OpenAI"). */
export function providerName(id: string): string {
    return runnerName({ provider: id }, app.providers);
}

/** `provider`: who runs it (lib/agent-marks.ts agentProvider); none when that isn't known. */
export function AgentMark(p: { provider?: string; size?: number; class?: string }) {
    return (
        <Show when={p.provider} fallback={<Bot size={p.size ?? 14} class={p.class} />}>
            {(id) => <ProviderIcon id={id()} name={providerName(id())} label={providerName(id())} size={p.size ?? 14} class={p.class} />}
        </Show>
    );
}

/** A group of agents' providers: up to three marks, overlapping, then "+N"; named for a screen reader ("3 sub-agents: Claude Code, Codex"). */
export function ProviderStack(p: { providers: readonly (string | undefined)[]; noun?: string }) {
    const stack = createMemo(() => providerStack(p.providers));
    const label = () => {
        const names = [...new Set(p.providers)].filter((x): x is string => x !== undefined).map(providerName);
        const what = plural(p.providers.length, p.noun ?? "sub-agent");
        return names.length ? `${what}: ${names.join(", ")}` : what;
    };
    return (
        <span class="stack" role="img" aria-label={label()} title={label()}>
            <For each={stack().shown}>
                {(id) => (
                    <span class="av">
                        <AgentMark provider={id} />
                    </span>
                )}
            </For>
            <Show when={stack().more}>
                <span class="av more num">+{stack().more}</span>
            </Show>
        </span>
    );
}
