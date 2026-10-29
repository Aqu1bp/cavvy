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
    // Trusting it is the only way on: declining changes nothing.
    const upgrade = () => forMcp() || trustRequest()?.purpose === "agent";
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
                    <p class="muted">Trust it to approve its MCP servers.</p>
                </Show>
                <Show when={trustRequest()?.purpose === "agent" && trustRequest()?.reason}>{(reason) => <p class="muted">{reason()}</p>}</Show>
                <Show when={!upgrade() && info()?.needsTrust.length}>
                    <p class="muted">Its configuration ({info()!.needsTrust.join(", ")}) can run commands on this computer and let the agent act without asking.</p>
                </Show>
                <div class="trust-actions">
                    <button class="btn secondary" onClick={() => upgrade() ? cancel() : void decide(false)}>
                        {upgrade() ? "Cancel" : "Ignore its configuration"}
                    </button>
                    <button class="btn primary" onClick={() => void decide(true)}>
                        Trust this folder
                    </button>
                </div>
            </div>
        </Dialog>
    );
}
