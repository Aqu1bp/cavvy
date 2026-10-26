// Spawns `claude` the way Cavvy does (src/backends/claude-code.ts STREAM_ARGS + initialize), for the probes.
import { JsonProc, Log, SCRATCH } from "./lib";

export const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];

export function startClaude(log: Log, extra: string[] = []) {
    const model = process.env.PROBE_CLAUDE_MODEL ?? "haiku";
    // Cavvy adds --include-partial-messages and --permission-prompt-tool=stdio; the probes skip the
    // prompts by pre-allowing the tools they use, and skip partial deltas to keep the logs small.
    const args = [...STREAM_ARGS, "--model", model, "--effort", "low", "--permission-mode", "bypassPermissions", "--no-session-persistence", ...extra];
    log.note(`spawn claude ${args.join(" ")}`);
    const p = new JsonProc(log, ["claude", ...args], { cwd: SCRATCH });
    let n = 0;
    const control = async (request: Record<string, unknown>, timeoutMs = 15000) => {
        const request_id = `probe-${++n}`;
        const from = p.frames.length;
        p.send({ type: "control_request", request_id, request });
        return p.waitFor((f) => f.type === "control_response" && f.response?.request_id === request_id, timeoutMs, from);
    };
    const user = (text: string, extraFields: Record<string, unknown> = {}) => {
        const uuid = crypto.randomUUID();
        p.send({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "", ...extraFields });
        return uuid;
    };
    const result = (from: number, timeoutMs: number) => p.waitFor((f) => f.type === "result", timeoutMs, from);
    return { p, control, user, result };
}
