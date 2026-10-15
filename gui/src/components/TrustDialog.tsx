import { createResource, Show } from "solid-js";
import { ShieldAlert } from "lucide-solid";
import { reportError, rpc, setTrustRequest, trustRequest } from "../state/app";
import { trustAndContinue } from "../state/actions";
import { Dialog } from "./ui/Dialog";

/** Asked when opening a session in a folder whose configuration hasn't been trusted or declined. */
export function TrustDialog() {
    const [info] = createResource(
        () => trustRequest()?.path,
        (path) => rpc.call("projects.inspect", { path }),
    );
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
        <Dialog open={Boolean(trustRequest())} onClose={() => setTrustRequest(undefined)} bare width={500}>
            <div class="trust-dialog">
                <ShieldAlert size={28} class="tone-warn" />
                <h2>Do you trust the files in this folder?</h2>
                <div class="mono small trust-path">{trustRequest()?.path}</div>
                <Show when={info()}>
                    <p class="muted">
                        It has configuration ({info()!.needsTrust.join(", ")}). Project settings can define hooks and MCP servers that run commands on your machine, and permission rules that let the agent act without asking.
                    </p>
                    <p class="muted">If you don't trust it, those files are ignored (except deny and ask rules, which only add restrictions), and so are its memory files.</p>
                </Show>
                <div class="trust-actions">
                    <button class="btn secondary" onClick={() => void decide(false)}>
                        Ignore its configuration
                    </button>
                    <button class="btn primary" onClick={() => void decide(true)}>
                        Trust this folder
                    </button>
                </div>
            </div>
        </Dialog>
    );
}
