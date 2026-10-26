// What an agent CLI says of its own (Claude Code's informational messages, Codex's warnings), as a notice draws it
// (#426): its logo as the icon, a warning's first line as its title, and a docs link it ends with as a link.

import type { NoticeData } from "../server/protocol";

const LINK = /\s*(?:(?:see|read)(?: the)? docs(?: for more)?|learn more|more info(?:rmation)?|docs|details)\s*(?:at|here)?\s*:?\s*(https?:\/\/[^\s<>()]+?)[.)]?\s*$/i;
const BARE_LINK = /\s*(https?:\/\/[^\s<>()]+?)[.)]?\s*$/;

/**
 * A CLI's message as NoticeData. A warning or error of several lines is titled by its first (a short one): the rest
 * folds under it, and a link it ends with ("See docs for more: https://…") is its link. One line, or info: the text.
 */
export function cliNotice(source: string, level: "info" | "warn" | "error", message: string): NoticeData {
    const text = message.trim();
    const lines = text.split("\n");
    if (level === "info" || lines.length < 2 || lines[0]!.trim().length > 120) return { source, text };
    let body = lines.slice(1).join("\n").trim();
    let link: string | undefined;
    const m = body.match(LINK) ?? body.match(BARE_LINK);
    if (m) {
        link = m[1];
        body = body.slice(0, m.index).trim();
    }
    return { source, title: lines[0]!.trim(), text: body, ...(link ? { link } : {}) };
}
