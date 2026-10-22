// /rewind (also esc esc on an empty prompt): go back to before one of the
// session's prompts, restoring the files the harness changed since then, the
// conversation, or both.

import type { App } from "../ui/app";
import { SelectDialog } from "../ui/dialogs";
import { theme, truncate } from "../ui/ansi";
import { backendsIn, canonical, FileHistory, resetToolState, rewindTargets, untrackedChangesNote, type RestoreItem, type RewindTarget } from "../agent/checkpoints";
import { beforeFork } from "../agent/fork";
import { APP_TITLE } from "../config/paths";
import { assistantText, type Message } from "../providers/types";
import { displayPath } from "../util/files";

const SHOWN = 10;

function preview(text: string, max: number): string {
    return truncate(text.replace(/\s+/g, " ").trim() || "(empty prompt)", max);
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Said of a prompt from before this session was forked. */
export const FORKED_NOTE = "Files changed before the fork can only be restored from the original session.";

function changedLabel(history: FileHistory | undefined, t: RewindTarget, forked: boolean): string {
    if (forked) return "from before the fork";
    // Claude Code and Codex change files with their own tools, which the file history doesn't see.
    const untracked = t.backends.length ? `${t.backends.join(" and ")} changes not tracked` : undefined;
    if (!history || t.checkpoint === undefined) return untracked ?? "file changes not tracked";
    const n = history.filesIn(t.checkpoint).length;
    if (n) return untracked ? `${plural(n, "file")} changed · ${untracked}` : `${plural(n, "file")} changed`;
    return untracked ?? "no file changes";
}

function fileLine(rel: (p: string) => string, it: RestoreItem): string {
    const what = it.action === "delete" ? "delete " : it.current === null ? "create " : "restore";
    return `  ${theme.muted(what)} ${rel(it.path)}${it.outside ? theme.warning(` (changed outside ${APP_TITLE})`) : ""}`;
}

function listed(lines: string[]): string[] {
    return lines.length > SHOWN ? [...lines.slice(0, SHOWN), theme.muted(`  … and ${lines.length - SHOWN} more`)] : lines;
}

function lastReply(messages: Message[]): string {
    return assistantText(messages).trim();
}

export async function rewindCommand(app: App) {
    const messages = app.session.messages;
    const compacted = messages[0]?.role === "user" && messages[0].meta?.kind === "summary";
    const targets = rewindTargets(messages).reverse();
    if (!targets.length) {
        app.notice(compacted ? "Nothing to rewind to: the earlier prompts were summarized by /compact." : "Nothing to rewind to yet.");
        return;
    }
    const history = FileHistory.for(app.session);
    const header = [theme.muted("Go back to before one of your prompts. Pick one, then choose what to restore.")];
    if (compacted) header.push(theme.muted("Prompts from before the last /compact can't be rewound to."));
    if (history?.unsaved) header.push(theme.warning(`File history couldn't be saved (${history.unsaved}), so it will be lost when this session ends.`));
    const pick = (await app.showDialog(
        new SelectDialog<number>({
            title: "Rewind",
            header,
            items: targets.map((t, i) => ({ label: preview(t.text, 70), value: i, description: changedLabel(history, t, beforeFork(app.session.meta, messages[t.index], t.index)) })),
            numbers: true,
            maxRows: 12,
        }),
    )) as number | undefined;
    if (pick === undefined) return;
    const target = targets[pick]!;
    const chosen = messages[target.index];

    const plan = history && target.checkpoint !== undefined ? history.plan(target.checkpoint) : undefined;
    const backends = backendsIn(messages, target.index);
    const restore = plan?.filter((i) => i.action !== "skip") ?? [];
    const skipped = plan?.filter((i) => i.action === "skip") ?? [];
    // History paths are real paths; show them against the real working folder.
    const root = canonical(app.cwd);
    const rel = (p: string) => displayPath(p, root);
    const lines = [theme.muted("> ") + preview(target.text, 200), ""];
    const forked = beforeFork(app.session.meta, chosen, target.index);
    if (forked) lines.push(theme.warning(FORKED_NOTE));
    if (!plan) lines.push(theme.muted("File changes from then weren't tracked, so only the conversation can be restored."));
    else if (restore.length) {
        lines.push(`${APP_TITLE} changed ${plural(restore.length, "file")} since then:`);
        lines.push(...listed(restore.map((it) => fileLine(rel, it))));
    } else lines.push(theme.muted(skipped.length ? "No other file changes to undo." : forked ? `${APP_TITLE} hasn't changed any files in this session since the fork.` : `${APP_TITLE} hasn't changed any files since then.`));
    if (skipped.length) {
        lines.push(theme.warning(`Can't be restored:`));
        lines.push(...listed(skipped.map((it) => theme.warning(`  ${rel(it.path)} (${it.reason})`))));
    }
    if (backends.length) {
        const except = restore.length ? ", except in the files listed above, which go back to how they were then" : "";
        lines.push(theme.warning(`${backends.join(" and ")} answered since then. ${APP_TITLE} doesn't track what ${backends.length === 1 ? "it changes" : "they change"} in files with ${backends.length === 1 ? "its" : "their"} own tools, so rewinding doesn't undo it${except}. Use git to review or undo the rest.`));
    }
    lines.push(theme.subtle("Changes made by shell commands aren't tracked and won't be undone."));

    type Choice = "both" | "conversation" | "code" | "cancel";
    const noCode = !restore.length;
    const choice = (await app.showDialog(
        new SelectDialog<Choice>({
            title: "Rewind to before this prompt?",
            header: lines,
            items: [
                { label: "Restore code and conversation", value: "both", disabled: noCode },
                { label: "Restore conversation only", value: "conversation", description: noCode ? undefined : "files stay as they are" },
                { label: "Restore code only", value: "code", disabled: noCode, description: noCode ? "no file changes to undo" : "the conversation stays as it is" },
                { label: "Cancel", value: "cancel" },
            ],
            numbers: true,
        }),
    )) as Choice | undefined;
    if (!choice || choice === "cancel") return;
    const code = choice === "both" || choice === "code";
    const conversation = choice === "both" || choice === "conversation";

    const outside = restore.filter((i) => i.outside);
    if (code && outside.length) {
        const ok = await app.showDialog(
            new SelectDialog<boolean>({
                title: `Overwrite changes made outside ${APP_TITLE}?`,
                header: [
                    theme.warning(`These files changed after ${APP_TITLE} last wrote them (by you, another program or a shell command). Restoring them loses those changes:`),
                    ...listed(outside.map((it) => `  ${rel(it.path)}`)),
                ],
                items: [
                    { label: "Restore them anyway", value: true },
                    { label: "Cancel", value: false },
                ],
                numbers: true,
                color: theme.warning,
            }),
        );
        if (ok !== true) return;
    }
    if (app.busy || app.session.messages[target.index] !== chosen) {
        app.notice("The conversation changed in the meantime; nothing was rewound.", "warn");
        return;
    }

    let rewindConversation = conversation;
    let restoredPaths: string[] = [];
    if (code) {
        const { done, failed } = history!.restore(restore);
        restoredPaths = done.map(rel);
        // Their content changed under the model: it must read them again.
        const restored = new Set(done);
        for (const p of [...app.toolState.fileState.keys()]) if (restored.has(canonical(p))) app.toolState.fileState.delete(p);
        if (done.length) app.print(["", `${theme.success("✔")} Restored ${plural(done.length, "file")} to how ${done.length === 1 ? "it was" : "they were"} before that prompt`, ...listed(done.map((p) => theme.muted(`  ${rel(p)}`)))]);
        for (const f of failed) app.notice(`Couldn't restore ${rel(f.path)}: ${f.error}`, "error");
        // Kept, so the prompt stays in /rewind to try again.
        if (conversation && failed.length) {
            rewindConversation = false;
            app.notice("The conversation wasn't rewound, since not every file could be restored. Run /rewind again to retry.", "warn");
        }
        if (!rewindConversation && done.length) {
            app.agent?.addReminder(`The user restored these files to how they were before an earlier prompt (/rewind), undoing the changes made to them since. Read them again before editing them:\n${done.map((p) => `- ${rel(p)}`).join("\n")}`);
        }
    }
    if (rewindConversation) {
        if (app.agent) app.agent.rewind(target.index);
        else {
            app.session.rewind(target.index);
            resetToolState(app.toolState, app.session.messages);
            app.classifier.clearCache();
        }
        app.lastResponse = lastReply(app.session.messages);
        app.editor.set(target.text);
        app.print(["", `${theme.success("✔")} Rewound the conversation to before that prompt. It's back in the input box to edit and send.`]);
        const kept = [...(code ? [] : restore), ...skipped];
        if (kept.length) {
            app.agent?.addReminder(`The user rewound the conversation to an earlier point (/rewind), but these files weren't restored and still have changes made after that point:\n${kept.map((it) => `- ${rel(it.path)}`).join("\n")}`);
        }
        if (backends.length) app.agent?.addReminder(untrackedChangesNote(backends, restoredPaths));
    }
}
