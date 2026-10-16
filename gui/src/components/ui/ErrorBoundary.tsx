import { createEffect, createSignal, ErrorBoundary as SolidErrorBoundary, on, Show, type JSX } from "solid-js";
import { copyText } from "../../lib/platform";
import { rawRenderText, renderDetails } from "../../lib/render-error";

type Props = {
    children: JSX.Element;
    raw?: () => unknown;
    resetKey?: () => unknown;
    app?: boolean;
};

function RenderFallback(p: Omit<Props, "children"> & { error: unknown; reset: () => void }) {
    const details = renderDetails(p.error);
    // Never pass the Error object to the console: browsers expand its unredacted stack.
    console.error(details);
    const [copied, setCopied] = createSignal("");
    const raw = () => rawRenderText(p.raw);
    // Only a changed input or an explicit Retry remounts a failed renderer.
    createEffect(on(() => p.resetKey?.() ?? raw(), () => p.reset(), { defer: true }));
    const copy = async (value: string) => {
        try { setCopied(await copyText(value) ? "Copied" : "Couldn't copy"); }
        catch { setCopied("Couldn't copy"); }
    };
    return (
        <div class={`render-error ${p.app ? "render-error-app" : ""}`} role="alert">
            <p>{p.app ? "Couldn't render Harness. Reload to try again." : "Couldn't render this part."}</p>
            <Show when={p.raw}><pre>{raw()}</pre></Show>
            <div class="render-error-actions">
                <button class="ghost-btn" onClick={() => p.app ? location.reload() : p.reset()}>{p.app ? "Reload" : "Retry"}</button>
                <button class="ghost-btn" onClick={() => void copy(details)}>Copy details</button>
                <Show when={p.raw}><button class="ghost-btn" onClick={() => void copy(raw())}>Copy text</button></Show>
                <span role="status">{copied()}</span>
            </div>
        </div>
    );
}

export function RenderBoundary(p: Props) {
    return <SolidErrorBoundary fallback={(error, reset) => <RenderFallback raw={p.raw} resetKey={p.resetKey} app={p.app} error={error} reset={reset} />}>{p.children}</SolidErrorBoundary>;
}
