// Synthetic Claude Code and Codex stores for tests, shaped like what the CLIs
// write (see src/server/cli-sessions.ts). Never a copy of a real store.
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export interface FixtureTurn {
    prompt: string;
    reply: string;
    /** Tool calls, as [name, input]. */
    tools?: [string, Record<string, unknown>][];
    /** More replies after the first, each its own message. */
    more?: string[];
}

const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Claude Code's folder for a working directory: every non-alphanumeric character becomes "-". */
export function claudeFolder(root: string, cwd: string): string {
    return join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** A Claude Code session file; `folderOf` is the cwd whose folder it's put in (a collision), `cwd` the one it records. */
export function claudeSession(root: string, o: { cwd: string; folderOf?: string; id?: string; turns: FixtureTurn[]; title?: string; model?: string; at?: number; mtime?: number }): { id: string; file: string } {
    const id = o.id ?? randomUUID();
    const dir = claudeFolder(root, o.folderOf ?? o.cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    let t = o.at ?? Date.parse("2026-10-14T09:00:00Z");
    const ts = () => new Date((t += 1000)).toISOString();
    const base = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: o.cwd, sessionId: id, version: "2.1.301", gitBranch: "main" };
    const rows: unknown[] = [];
    if (o.title) rows.push({ type: "custom-title", customTitle: o.title, sessionId: id });
    let parent: string | null = null;
    const entry = (e: Record<string, unknown>) => {
        const uuid = randomUUID();
        rows.push({ parentUuid: parent, ...e, uuid, timestamp: ts(), ...base });
        parent = uuid;
    };
    o.turns.forEach((turn, n) => {
        entry({ type: "user", message: { role: "user", content: turn.prompt }, promptId: randomUUID() });
        const msg = `msg_${n}_a`;
        const assistant = (id: string, content: unknown[]) => entry({ type: "assistant", message: { id, type: "message", role: "assistant", model: o.model ?? "claude-test-1", content, stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 5 } } });
        assistant(msg, [{ type: "thinking", thinking: "THINKING_TEXT", signature: "c2ln" }]);
        assistant(msg, [{ type: "text", text: turn.reply }]);
        for (const [i, [name, input]] of (turn.tools ?? []).entries()) {
            const toolId = `toolu_${n}_${i}`;
            assistant(msg, [{ type: "tool_use", id: toolId, name, input }]);
            entry({ type: "user", message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: "TOOL_OUTPUT" }] }, toolUseResult: { stdout: "TOOL_OUTPUT" } });
        }
        if (turn.tools?.length) assistant(`msg_${n}_b`, [{ type: "text", text: "Finished." }]);
        for (const [i, text] of (turn.more ?? []).entries()) assistant(`msg_${n}_m${i}`, [{ type: "text", text }]);
        rows.push({ type: "last-prompt", lastPrompt: turn.prompt, leafUuid: parent, sessionId: id });
    });
    writeFileSync(file, lines(rows));
    if (o.mtime) utimesSync(file, o.mtime / 1000, o.mtime / 1000);
    return { id, file };
}

/** A Codex rollout file (and its title in session_index.jsonl, when given). */
export function codexSession(root: string, o: { cwd: string; id?: string; turns: FixtureTurn[]; title?: string; model?: string; day?: string; mtime?: number; subAgent?: boolean }): { id: string; file: string } {
    const id = o.id ?? randomUUID();
    const day = o.day ?? "2026/10/14";
    const dir = join(root, "sessions", ...day.split("/"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${day.replaceAll("/", "-")}T09-00-00-${id}.jsonl`);
    let t = Date.parse(`${day.replaceAll("/", "-")}T09:00:00Z`);
    const ts = () => new Date((t += 1000)).toISOString();
    const rows: unknown[] = [
        // Its first line holds the whole system prompt: longer than the probe reads.
        { timestamp: ts(), type: "session_meta", payload: { session_id: id, id, timestamp: ts(), cwd: o.cwd, originator: "codex_cli_rs", cli_version: "0.163.0", source: o.subAgent ? { subagent: { thread_spawn: {} } } : "cli", model_provider: "openai", base_instructions: { text: "You are Codex. ".repeat(3000) } } },
        { timestamp: ts(), type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>sandboxed</permissions instructions>" }] } },
        { timestamp: ts(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${o.cwd}</cwd>\n</environment_context>` }] } },
        { timestamp: ts(), type: "turn_context", payload: { turn_id: "t0", cwd: o.cwd, model: o.model ?? "gpt-test" } },
    ];
    o.turns.forEach((turn, n) => {
        rows.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_started", turn_id: `t${n}` } });
        rows.push({ timestamp: ts(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.prompt }] } });
        rows.push({ timestamp: ts(), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "THINKING_TEXT" }], encrypted_content: "xyz" } });
        for (const [i, [name, input]] of (turn.tools ?? []).entries()) {
            rows.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name, arguments: JSON.stringify(input), call_id: `c${n}_${i}` } });
            rows.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call_output", call_id: `c${n}_${i}`, output: "TOOL_OUTPUT" } });
        }
        for (const text of [turn.reply, ...(turn.more ?? [])]) rows.push({ timestamp: ts(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
        rows.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_complete", turn_id: `t${n}` } });
    });
    writeFileSync(file, lines(rows));
    if (o.mtime) utimesSync(file, o.mtime / 1000, o.mtime / 1000);
    if (o.title) appendFileSync(join(root, "session_index.jsonl"), JSON.stringify({ id, thread_name: o.title, updated_at: new Date(t).toISOString() }) + "\n");
    return { id, file };
}

/** Every path under a folder with its type, size, mtime and bytes: to check nothing was changed. */
export function snapshotTree(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const n of readdirSync(dir)) {
            const p = join(dir, n);
            const st = lstatSync(p);
            if (st.isDirectory()) {
                out[p] = `dir ${st.mtimeMs}`;
                walk(p);
            } else if (st.isSymbolicLink()) out[p] = `link ${st.mtimeMs}`;
            else out[p] = `file ${st.size} ${st.mtimeMs} ${Bun.hash(readFileSync(p)).toString()}`;
        }
    };
    walk(root);
    return out;
}
