// When the title bar reads a branch's ahead/behind counts again (GitBranches.tsx). Each read is a git process on the
// server, so it's asked only when the counts can have moved: a turn ended (it may have committed), the window came
// back, a Git action ran here, or the branch or folder changed. Not as a turn starts, or as its edits land.

export interface SyncReadKey {
    cwd: string;
    id: string;
    branch: string;
    busy: boolean;
    outside: unknown;
    moved: unknown;
}

/** Whether the counts needn't be read again: all that changed since the last read is that a turn started. */
export function syncReadSkipped(now: SyncReadKey, was?: SyncReadKey): boolean {
    return !!was && now.busy && !was.busy && now.cwd === was.cwd && now.id === was.id && now.branch === was.branch && now.outside === was.outside && now.moved === was.moved;
}
