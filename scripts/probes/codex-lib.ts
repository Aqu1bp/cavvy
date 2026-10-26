// Spawns `codex app-server` and speaks JSON-RPC to it the way Cavvy does (src/backends/codex.ts spawnRpc + handshake).
import { JsonProc, Log, SCRATCH } from "./lib";

export function startCodex(log: Log, opts: { experimentalApi?: boolean } = {}) {
    log.note(`spawn codex app-server (experimentalApi=${Boolean(opts.experimentalApi)})`);
    const p = new JsonProc(log, ["codex", "app-server"], { cwd: SCRATCH });
    let seq = 0;
    const request = (method: string, params: unknown, timeoutMs = 30_000): Promise<{ result?: any; error?: any; timeout?: boolean }> => {
        const id = ++seq;
        const from = p.frames.length;
        p.send({ id, method, params });
        return p
            .waitFor((f) => f.id === id && (("result" in f) || ("error" in f)) && !f.method, timeoutMs, from)
            .then((f) => (f ? (f.error ? { error: f.error } : { result: f.result }) : { timeout: true }));
    };
    const handshake = async () => {
        const r = await request("initialize", { clientInfo: { name: "cavvy_probe", title: "Cavvy probe", version: "0.0.0" }, capabilities: opts.experimentalApi ? { experimentalApi: true } : null });
        p.send({ method: "initialized" });
        return r;
    };
    const turnStart = (threadId: string, text: string, extra: Record<string, unknown> = {}) => request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...extra });
    /** Notifications (method frames without id) after index `from`. */
    const notes = (from = 0) => p.frames.slice(from).filter((f) => f.method && f.id === undefined);
    // Auto-answer server requests (approvals) so a probe never stalls; the approval policy is "never", so this should not happen.
    const answered = new Set<any>();
    const timer = setInterval(() => {
        for (const f of p.frames) if (f.method && f.id !== undefined && !answered.has(f)) (answered.add(f), log.note(`server request ${f.method} auto-declined`), p.send({ id: f.id, result: { decision: "decline" } }));
    }, 200);
    const stop = async () => (clearInterval(timer), p.kill());
    return { p, request, handshake, turnStart, notes, stop };
}
