import type { PermissionInteraction, PermissionOption } from "@shared/protocol";

/**
 * An approval card's answers. Three at most: Allow once, one broader choice, the one that lasts (always,
 * in this project) before one for the session, and Deny; the server offers no lasting one beside a narrower grant.
 * `keys`: what 1 and 2 answer (Esc denies). `row`: on screen, Allow once first, where the card's question ends and
 * the eye lands, the broader choice after it, and Deny last (the card puts it at the far end); `key` is 0 for Deny.
 */
export function approvalChoices(options: readonly PermissionOption[]): { keys: PermissionOption[]; row: { o: PermissionOption; key: number }[] } {
    const broader = options.find((o) => o.id === "always") ?? options.find((o) => o.id !== "yes" && o.id !== "no");
    const keys = [options.find((o) => o.id === "yes"), broader].filter((o) => o !== undefined);
    return { keys, row: [...keys, ...options.filter((o) => o.id === "no")].map((o) => ({ o, key: keys.indexOf(o) + 1 })) };
}

/** A command short enough to be asked about in the card's question itself: one line, about a line's worth. */
const INLINE_COMMAND = 64;

/**
 * An approval card's question: what's asked, as a question, with what it's about in it where that's short
 * (`code`, in mono). "Run `bun test auth`?", "Create `src/auth/sso.ts`?"; anything else is the server's heading,
 * asked ("Fetch a web page?"). `inline`: the command or path is in the question, so the card doesn't show it again.
 */
export function approvalQuestion(it: Pick<PermissionInteraction, "heading" | "toolName" | "category" | "command" | "path" | "secrets">): { before: string; code?: string; inline: boolean } {
    const command = it.command?.trim();
    if (it.toolName === "Bash" && command && !command.includes("\n") && command.length <= INLINE_COMMAND && !it.secrets?.length) return { before: "Run ", code: command, inline: true };
    if (it.category === "edit" && it.path) {
        // "Create a file", "Overwrite a file", "Edit a file", "Edit a notebook": its verb, then the file.
        const verb = /^(\w+) /.exec(it.heading)?.[1] ?? "Edit";
        return { before: `${verb} `, code: it.path, inline: true };
    }
    return { before: it.heading.replace(/[?.]$/, ""), inline: false };
}
