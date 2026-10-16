// What the New worktree dialog says about the project's setup script, and
// whether creating the worktree asks for it. The server decides again; this
// only keeps the dialog from promising a run the server would refuse.

import type { ProjectScript, SetupInfo } from "@shared/protocol";

export type SetupNote =
    | { kind: "loading" }
    /** No script is marked: the dialog says nothing. */
    | { kind: "none" }
    | { kind: "runs"; script: ProjectScript }
    | { kind: "untrusted"; script: ProjectScript; main: string }
    /** The scripts couldn't be read (a broken scripts.json, a Git error): nothing runs. */
    | { kind: "error"; message: string };

export function setupNote(info: SetupInfo | undefined, error?: string): SetupNote {
    if (error !== undefined) return { kind: "error", message: error };
    if (!info) return { kind: "loading" };
    if (!info.script) return { kind: "none" };
    return info.trusted ? { kind: "runs", script: info.script } : { kind: "untrusted", script: info.script, main: info.main };
}

/** Only what the dialog showed as about to run, and not skipped this time. */
export const asksForSetup = (note: SetupNote, skip: boolean) => note.kind === "runs" && !skip;

/** The terminal tab's name: "Setup · feat-x". */
export const setupTabLabel = (worktree: string) => `Setup · ${worktree.replace(/\/+$/, "").split("/").pop() || worktree}`;
