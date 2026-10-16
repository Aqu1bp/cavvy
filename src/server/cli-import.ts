// Turning a Claude Code or Codex session (read by cli-sessions.ts) into a
// Harness session on the matching backend, and knowing which ones already are
// one. The imported conversation is stored as the session's first messages,
// marked imported (shown, never rewound to), with a lasting {t:"import"}
// record of where it came from. The backend session is set to the CLI's own,
// already synced up to those messages: the next turn resumes it natively
// (--resume, thread/resume) and nothing imported is sent again.

import { lstatSync, readdirSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { projectStateDir } from "../config/paths";
import { cliLinks, Session } from "../agent/session";
import { defaultModelFrom, type ProviderListing } from "../providers/models";
import { getProvider } from "../providers/registry";
import { modelRef, parseModelRef, type AssistantMessage } from "../providers/types";
import type { CliSessionEntry, CliSource, CliTranscript } from "./cli-sessions";
import { UiLog } from "./history";

/** "claude-code:<id>" for a CLI session; ids compared without case. */
export function linkKey(source: string, id: string): string {
    return `${source}:${id.toLowerCase()}`;
}

const linkCache = new Map<string, { mtimeMs: number; size: number; links: { provider: string; id: string }[] }>();

/**
 * CLI sessions already in Harness, from the session files of these folders:
 * imported ones and ones Harness ran itself on a backend. The newest Harness
 * session wins when several hold the same one.
 */
export function harnessLinks(folders: string[]): Map<string, string> {
    const dirs = new Set<string>();
    for (const f of folders) {
        dirs.add(projectStateDir(resolve(f)));
        try {
            dirs.add(projectStateDir(realpathSync(f)));
        } catch {
            // gone: its sessions are under the path as given
        }
    }
    const files: { file: string; id: string; mtimeMs: number; size: number }[] = [];
    for (const dir of dirs) {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            continue;
        }
        for (const n of names) {
            const m = /^([A-Za-z0-9_-]+)\.jsonl$/.exec(n);
            if (!m) continue;
            const file = join(dir, n);
            try {
                const st = lstatSync(file);
                if (st.isFile()) files.push({ file, id: m[1]!, mtimeMs: st.mtimeMs, size: st.size });
            } catch {
                // vanished
            }
        }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out = new Map<string, string>();
    for (const f of files) {
        let cached = linkCache.get(f.file);
        if (!cached || cached.mtimeMs !== f.mtimeMs || cached.size !== f.size) {
            let links: { provider: string; id: string }[] = [];
            try {
                links = cliLinks(f.file);
            } catch {
                // unreadable: nothing linked
            }
            cached = { mtimeMs: f.mtimeMs, size: f.size, links };
            linkCache.set(f.file, cached);
        }
        for (const l of cached.links) {
            const k = linkKey(l.provider, l.id);
            if (!out.has(k)) out.set(k, f.id);
        }
    }
    return out;
}

/**
 * The model to continue on: the CLI session's own when the provider lists it,
 * else the provider's default. Never fails: the runtime falls back again if
 * even the default can't be resolved.
 */
export function importModel(source: CliSource, cliModel: string | undefined, listings: ProviderListing[]): string {
    const listing = listings.find((l) => l.provider.id === source);
    const models = listing?.models ?? [];
    if (cliModel) {
        // Claude Code lists aliases ("opus") named with what they resolve to ("Opus (claude-opus-5-5)").
        const m = models.find((x) => x.id === cliModel) ?? models.find((x) => x.name?.includes(`(${cliModel})`));
        if (m) return modelRef(m);
    }
    const d = models.find((x) => x.id === "default") ?? (listing ? defaultModelFrom([listing]) : undefined);
    return d ? modelRef(d) : `${source}:default`;
}

/** Write the Harness session for an imported conversation; returns its id. Nothing is kept open. */
export function writeImportedSession(o: { cwd: string; entry: CliSessionEntry; transcript: CliTranscript; model: string; title: string }): string {
    const { entry, transcript } = o;
    const name = getProvider(entry.source)?.name ?? entry.source;
    const modelId = parseModelRef(o.model)?.id ?? "default";
    const session = Session.create(o.cwd);
    const messages = transcript.turns.reduce((n, t) => n + 1 + (t.replies.length || t.actions.length ? 1 : 0), 0);
    session.setImported({ source: entry.source, id: entry.id, startedAt: entry.startedAt, importedAt: Date.now(), messages, omitted: transcript.omitted });
    session.setTitle(o.title);
    session.setModel(o.model);
    const ui = new UiLog(session.path, session.meta.id, false);
    for (const t of transcript.turns) {
        const index = session.messages.length;
        session.push({ role: "user", content: [{ type: "text", text: t.prompt }], meta: { kind: t.command ? "command" : "prompt", imported: true } });
        if (t.at) ui.write({ t: "turn", seg: 0, index, at: t.at, ...(t.end ? { end: t.end } : {}), status: "done" });
        // Laid out as Agent.recordBackendTurn stores a backend's turn: the reply, then what it did.
        const content: AssistantMessage["content"] = [];
        const reply = t.replies.join("\n\n");
        if (reply.trim()) content.push({ type: "text", text: reply });
        if (t.actions.length) {
            const more = (t.moreActions ?? 0) + Math.max(0, t.actions.length - 50);
            content.push({ type: "text", text: `[${name} used: ${t.actions.slice(0, 50).join(", ")}${more ? `, and ${more} more` : ""}]` });
        }
        if (content.length) session.push({ role: "assistant", content, provider: entry.source, model: modelId, stopReason: "end_turn" });
    }
    // The CLI has seen all of it: the next turn resumes its session with just the new prompt.
    session.setBackendSession(entry.source, entry.id, session.messages.length);
    session.release();
    return session.meta.id;
}
