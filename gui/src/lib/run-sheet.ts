// The result sheet owns a run until it is dismissed, even if Home remounts.
import { createSignal } from "solid-js";
import type { PermissionModeId, RunResult } from "@shared/protocol";
import type { Attachment } from "./attachments";
import { RpcError } from "./rpc";

export interface RunRequest {
    path: string;
    models: string[];
    text: string;
    attachments: Attachment[];
    mode: PermissionModeId;
}

type Phase =
    | { kind: "starting" }
    | { kind: "confirm"; message: string }
    | { kind: "trust"; folder: string; message: string; project: boolean }
    | { kind: "error"; message: string }
    | { kind: "done"; results: RunResult[] };

export function createRunSheet(io: {
    start: (req: RunRequest, confirmPaid: boolean) => Promise<{ results: RunResult[] }>;
    trust: (folder: string, trust: boolean) => Promise<unknown>;
    refresh: () => void;
}) {
    const [sheet, setSheet] = createSignal<{ req: RunRequest; phase: Phase; confirmPaid: boolean; resolve: (started: boolean) => void }>();
    const setPhase = (phase: Phase) => setSheet((s) => s && { ...s, phase });

    async function attempt() {
        const s = sheet();
        if (!s) return;
        setPhase({ kind: "starting" });
        try {
            const r = await io.start(s.req, s.confirmPaid);
            if (sheet()?.req !== s.req) return;
            setPhase({ kind: "done", results: r.results });
            io.refresh();
        } catch (e) {
            const message = (e as Error).message;
            if (e instanceof RpcError && e.code === "confirm_paid") return setPhase({ kind: "confirm", message });
            if (e instanceof RpcError && (e.code === "needs_trust" || e.code === "needs_project_trust")) return setPhase({ kind: "trust", folder: e.folder ?? s.req.path, message, project: e.code === "needs_project_trust" });
            setPhase({ kind: "error", message });
        }
    }

    /** True only when at least one model started; cancellation preserves the draft. */
    function startRun(req: RunRequest): Promise<boolean> {
        if (sheet()) return Promise.resolve(false);
        return new Promise((resolve) => {
            setSheet({ req, phase: { kind: "starting" }, confirmPaid: false, resolve });
            void attempt();
        });
    }

    function close() {
        const s = sheet();
        if (!s || s.phase.kind === "starting") return;
        setSheet(undefined);
        s.resolve(s.phase.kind === "done" && s.phase.results.some((r) => r.ok));
    }

    function confirm() {
        if (sheet()?.phase.kind !== "confirm") return;
        setSheet((s) => s && { ...s, confirmPaid: true });
        void attempt();
    }

    async function decide(folder: string, trust: boolean) {
        if (sheet()?.phase.kind !== "trust") return;
        setPhase({ kind: "starting" });
        try {
            await io.trust(folder, trust);
        } catch (e) {
            return setPhase({ kind: "error", message: (e as Error).message });
        }
        await attempt();
    }

    return { sheet, startRun, close, confirm, decide };
}

export type { Phase as RunPhase };
