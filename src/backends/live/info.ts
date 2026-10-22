// A live CLI session's background work as the server protocol shows it: no
// imports, so src/server/protocol.ts (and the GUI through it) can take it as is.

export interface BackgroundTaskInfo {
    /** The CLI's id for it (Claude Code's task_id; Codex's processId, or a sub-agent's thread id). */
    id: string;
    /** The agent CLI running it ("claude-code", "codex", …). */
    provider: string;
    kind: "agent" | "shell" | "monitor" | "workflow" | "other";
    label: string;
    /** The call that launched it: its row stays in the launching turn. */
    toolUseId?: string;
    /** The harness turn that launched it. */
    turnId?: string;
    startedAt: number;
    status: "running" | "done" | "failed" | "stopped";
    endedAt?: number;
    /** It can be stopped on its own (CliCapabilities.stopTask, and the CLI says so for it). */
    stoppable: boolean;
    /** Stopped because its process went away (a crash, a restart, the harness quitting), not by the CLI's word. */
    lost?: boolean;
}
