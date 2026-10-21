// Messages sent while a session was working, kept beside its transcript
// (queue/<id>.json) so a restart doesn't lose them. The file is rewritten on
// every change and removed when the queue empties. Like the transcript it's
// redacted before it touches disk; images and PDFs are kept as they are.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { AttachedPart } from "../providers/types";
import type { FollowUpMode } from "../server/protocol";
import { ensureDir } from "../config/paths";
import { redactedJson } from "../util/redact";

/** What a message sent mid-turn does: join the running turn at its next step, or wait for it to end. */
export type FollowUp = FollowUpMode;

export const FOLLOW_UPS: readonly FollowUp[] = ["steer", "queue"];

export const isFollowUp = (v: unknown): v is FollowUp => FOLLOW_UPS.includes(v as FollowUp);

export interface StoredQueued {
    text: string;
    mode: FollowUp;
    attachments?: AttachedPart[];
    /** Sent as a message even though it starts with a /word (the GUI's "Send as message"). */
    literal?: boolean;
}

/** The setting, or the default: steer (what mid-turn messages always did). */
export function followUpDefault(setting: unknown): FollowUp {
    return setting === "queue" ? "queue" : "steer";
}

export function queueFile(sessionFile: string, id: string): string {
    return join(dirname(sessionFile), "queue", `${id}.json`);
}

/** The saved queue, oldest first; nothing for a missing, torn or foreign file. */
export function loadQueue(sessionFile: string, id: string): StoredQueued[] {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(queueFile(sessionFile, id), "utf-8"));
    } catch {
        return [];
    }
    const items = (raw as { items?: unknown })?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((x): StoredQueued[] => {
        if (!x || typeof x !== "object" || typeof (x as StoredQueued).text !== "string") return [];
        const q = x as StoredQueued;
        const attachments = Array.isArray(q.attachments) ? q.attachments.filter((a) => a && typeof a === "object" && (a.type === "image" || a.type === "file")) : undefined;
        return [{ text: q.text, mode: q.mode === "queue" ? "queue" : "steer", ...(attachments?.length ? { attachments } : {}), ...(q.literal ? { literal: true } : {}) }];
    });
}

/** Write it whole (through a temporary file, so a crash mid-write leaves the old one), or remove it when empty. */
export function saveQueue(sessionFile: string, id: string, items: readonly StoredQueued[]) {
    const file = queueFile(sessionFile, id);
    try {
        if (!items.length) {
            if (existsSync(file)) unlinkSync(file);
            return;
        }
        ensureDir(dirname(file));
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, redactedJson({ v: 1, items }), { mode: 0o600 });
        renameSync(tmp, file);
    } catch {
        // A full or read-only disk: the queue still works, it just won't outlive this process.
    }
}
