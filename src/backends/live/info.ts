// A live CLI session's background work as the server protocol shows it: no
// imports, so src/server/protocol.ts (and the GUI through it) can take it as is.

export interface BackgroundTaskInfo {
    /** The CLI's id for it (Claude Code's task_id; Codex's processId, or a sub-agent's thread id). */
    id: string;
    /** The agent CLI running it ("claude-code", "codex", …). */
    provider: string;
    kind: "agent" | "shell" | "monitor" | "workflow" | "other";
    label: string;
    /** A shell's whole command, where the label is a description of it or the command cut short (redacted). */
    command?: string;
    /** The call that launched it: its row stays in the launching turn. */
    toolUseId?: string;
    /** Cavvy turn that launched it. */
    turnId?: string;
    startedAt: number;
    status: "running" | "done" | "failed" | "stopped";
    endedAt?: number;
    /** It can be stopped on its own (CliCapabilities.stopTask, and the CLI says so for it). */
    stoppable: boolean;
    /** Running when Cavvy quit (the session's log had it running when the session was opened again). */
    lost?: boolean;
    /** Stopped because its CLI's process went away (a crash, a restart, the run ending), not by the CLI's word. */
    withProcess?: boolean;
    /** Stopped by the user (their Stop, or Esc): its end is no news to them. */
    byUser?: boolean;
}
