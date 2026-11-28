import { createResource, For, Show } from "solid-js";
import { ShieldQuestion } from "lucide-solid";
import { machine } from "../lib/platform";
import { tildify } from "../lib/format";
import { app, reportError, rpc, setTrustRequest, trustRequest } from "../state/app";
import { trustAndContinue } from "../state/actions";
import { Dialog } from "./ui/Dialog";

/** Opening a folder, or explicitly trusting an already open folder for MCP approval. */
export function TrustDialog() {
    // Asked of the folder's machine (the request's link), else the window's.
    const [info] = createResource(
        () => app.conn === "open" && trustRequest(),
        (req) =>
            (req.link ?? rpc).call("projects.inspect", { path: req.path }).catch((e) => {
                if (app.conn === "open") reportError(e);
                return undefined;
            }),
    );
    const forMcp = () => trustRequest()?.purpose === "mcp-approval";
    // Trusting it is the only way on: declining changes nothing.
    const upgrade = () => forMcp() || trustRequest()?.purpose === "agent";
    const cancel = () => setTrustRequest(undefined);
    const decide = async (trust: boolean) => {
        const req = trustRequest();
        if (!req) return;
        try {
            await trustAndContinue(req.path, trust, req.link);
            setTrustRequest(undefined);
            req.then();
        } catch (e) {
            reportError(e);
        }
    };
    /** The configuration that can run commands there, when it has some (none while it's only asked to approve). */
    const files = () => (upgrade() ? [] : info()?.needsTrust ?? []);
    const where = () => (trustRequest()?.on ?? machine) || "this computer";
    return (
        <Dialog
            open={Boolean(trustRequest())}
            onClose={cancel}
            title="Do you trust the files in this folder?"
            subtitle={<span class="mono trust-path">{tildify(trustRequest()?.path ?? "", app.hello?.homeDir)}</span>}
            icon={<ShieldQuestion size={18} />}
            width={460}
            class="trust"
            footer={[
                <button class="btn" onClick={() => (upgrade() ? cancel() : void decide(false))}>
                    {upgrade() ? "Cancel" : "Ignore its configuration"}
                </button>,
                <button class="btn btn-primary" autofocus onClick={() => void decide(true)}>
                    Trust this folder
                </button>,
            ]}
        >
            <p class="dlg-text">
                <Show
                    when={files().length}
                    fallback={forMcp() ? "Trust it to approve its MCP servers." : trustRequest()?.purpose === "agent" && trustRequest()?.reason ? trustRequest()!.reason : `Configuration added to it later can run commands on ${where()} without asking.`}
                >
                    Its configuration (
                    <For each={files()}>
                        {(f, i) => (
                            <span>
                                {i() > 0 && ", "}
                                <code>{f}</code>
                            </span>
                        )}
                    </For>
                    ) can run commands on {where()} without asking.
                </Show>
            </p>
        </Dialog>
    );
}
