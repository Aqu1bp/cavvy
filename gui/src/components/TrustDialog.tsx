import { createResource, createUniqueId, Show } from "solid-js";
import { ShieldAlert } from "lucide-solid";
import { app, reportError, rpc, setTrustRequest, trustRequest } from "../state/app";
import { trustAndContinue } from "../state/actions";
import { Dialog } from "./ui/Dialog";

/** Opening a folder, or explicitly trusting an already open folder for MCP approval. */
export function TrustDialog() {
    const [info] = createResource(
        () => app.conn === "open" && trustRequest()?.path,
        (path) =>
            rpc.call("projects.inspect", { path }).catch((e) => {
                if (app.conn === "open") reportError(e);
                return undefined;
            }),
    );
    const titleId = createUniqueId();
    const forMcp = () => trustRequest()?.purpose === "mcp-approval";
    const cancel = () => setTrustRequest(undefined);
    const decide = async (trust: boolean) => {
        const req = trustRequest();
        if (!req) return;
        try {
            await trustAndContinue(req.path, trust);
            setTrustRequest(undefined);
            req.then();
        } catch (e) {
            reportError(e);
        }
    };
    return (
        <Dialog open={Boolean(trustRequest())} onClose={cancel} bare labelledBy={titleId} width={500}>
            <div class="trust-dialog">
                <ShieldAlert size={28} class="tone-warn" />
                <h2 id={titleId}>Do you trust the files in this folder?</h2>
                <div class="mono small trust-path">{trustRequest()?.path}</div>
                <Show when={forMcp()}>
                    <p class="muted">Cavvy trusted this folder for this session only, because it had nothing to protect when it was opened. Its .mcp.json servers can be approved once you trust it yourself.</p>
                    <p class="muted">Cancel keeps the current session trust, project settings and hooks as they are. It does not approve any MCP server.</p>
                </Show>
                <Show when={info()?.needsTrust.length}>
                    <p class="muted">
                        It has configuration ({info()!.needsTrust.join(", ")}). Project settings can define hooks and MCP servers that run commands on your machine, and permission rules that let the agent act without asking.
                    </p>
                    <Show when={!forMcp()}>
                        <p class="muted">If you don't trust it, those files are ignored (except deny and ask rules, which only add restrictions), and so are its memory files.</p>
                    </Show>
                </Show>
                <div class="trust-actions">
                    <button class="btn secondary" onClick={() => forMcp() ? cancel() : void decide(false)}>
                        {forMcp() ? "Cancel" : "Ignore its configuration"}
                    </button>
                    <button class="btn primary" onClick={() => void decide(true)}>
                        Trust this folder
                    </button>
                </div>
            </div>
        </Dialog>
    );
}
