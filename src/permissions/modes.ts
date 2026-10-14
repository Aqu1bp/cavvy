import { theme } from "../ui/ansi";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export const MODE_INFO: Record<PermissionMode, { label: string; short: string; description: string; color: (s: string) => string; symbol: string }> = {
    default: {
        label: "Manual",
        short: "manual",
        description: "Ask before file edits, shell commands and other side effects (read-only tools run freely).",
        color: theme.muted,
        symbol: "",
    },
    acceptEdits: {
        label: "Accept edits",
        short: "accept edits",
        description: "Auto-approve file edits inside the workspace. Still ask for shell commands and network tools.",
        color: theme.acceptEdits,
        symbol: "⏵⏵",
    },
    plan: {
        label: "Plan mode",
        short: "plan mode",
        description: "Read-only research. The model explores and proposes a plan; nothing is modified until you approve it.",
        color: theme.planMode,
        symbol: "⏸",
    },
    auto: {
        label: "Auto",
        short: "auto mode",
        description: "Auto-approve edits and actions a safety classifier judges low-risk and in scope; ask only for risky ones.",
        color: theme.autoMode,
        symbol: "⏵⏵",
    },
    bypassPermissions: {
        label: "Bypass permissions",
        short: "bypass permissions",
        description: "Run everything without asking (deny rules and catastrophic-command guards still apply). Use only in sandboxes.",
        color: theme.bypass,
        symbol: "⏵⏵",
    },
};

export function parseMode(s: string | undefined): PermissionMode | undefined {
    if (!s) return undefined;
    const norm = s.toLowerCase().replace(/[^a-z]/g, "");
    const aliases: Record<string, PermissionMode> = {
        default: "default",
        manual: "default",
        normal: "default",
        ask: "default",
        acceptedits: "acceptEdits",
        accept: "acceptEdits",
        edits: "acceptEdits",
        plan: "plan",
        planmode: "plan",
        auto: "auto",
        automode: "auto",
        bypass: "bypassPermissions",
        bypasspermissions: "bypassPermissions",
        yolo: "bypassPermissions",
        dangerouslyskippermissions: "bypassPermissions",
    };
    return aliases[norm];
}

/** Next mode for shift+tab. Bypass is only part of the cycle when allowed. */
export function nextMode(current: PermissionMode, allowBypass: boolean): PermissionMode {
    const cycle: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];
    if (allowBypass) cycle.push("bypassPermissions");
    const idx = cycle.indexOf(current);
    return cycle[(idx + 1) % cycle.length]!;
}
