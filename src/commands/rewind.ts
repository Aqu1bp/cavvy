// /rewind (also esc esc on an empty prompt): go back to before one of the
// session's prompts, restoring the files changed since then (rewind-files.ts),
// the conversation, or both. `/rewind undo` puts back the files the last
// restore changed.

import type { App } from "../ui/app";
import { SelectDialog } from "../ui/dialogs";
import { theme, truncate } from "../ui/ansi";
import { backendsIn, canonical, FileHistory, resetToolState, rewindTargets, untrackedChangesNote, type RewindTarget } from "../agent/checkpoints";
import { canUndoRestore, changedBy, planFileRestore, restoreFiles, undoRestore, type FileRestoreItem } from "../agent/rewind-files";
import { TurnSnapshots } from "../agent/turn-snapshots";
import { beforeFork } from "../agent/fork";
import { APP_TITLE } from "../config/paths";
import { assistantText, textOf, type Message } from "../providers/types";
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

function changedLabel(changed: { tracked: boolean; whole: boolean; files: number }, t: RewindTarget, forked: boolean): string {
    if (forked) return "from before the fork";
    // Without a turn snapshot, Claude Code and Codex change files with their own tools, which the file history doesn't see.
    const untracked = t.backends.length && !changed.whole ? `${t.backends.join(" and ")} changes not tracked` : undefined;
    if (!changed.tracked) return untracked ?? "file changes not tracked";
    const n = changed.files;
    if (n) return untracked ? `${plural(n, "file")} changed · ${untracked}` : `${plural(n, "file")} changed`;
    return untracked ?? "no file changes";
}

function fileLine(rel: (p: string) => string, it: FileRestoreItem): string {
    const what = it.action === "delete" ? "delete " : it.action === "create" ? "create " : "restore";
    return `  ${theme.muted(what)} ${rel(it.path)}${it.outside ? theme.warning(` (changed outside ${APP_TITLE})`) : ""}`;
}

function listed(lines: string[]): string[] {
    return lines.length > SHOWN ? [...lines.slice(0, SHOWN), theme.muted(`  … and ${lines.length - SHOWN} more`)] : lines;
}

function lastReply(messages: Message[]): string {
    const answer = assistantText(messages).trim();
    if (answer) return answer;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "assistant" && textOf(m).trim()) return assistantText(messages.slice(0, i + 1)).trim();
    }
    return "";
}

/** The last file restore of each session, while Undo can put it back. */
const lastRestore = new WeakMap<object, string>();

/** The turn snapshots files are restored from: only in a trusted folder, where they're recorded. */
function snapshotsOf(app: App): TurnSnapshots | undefined {
    return app.init?.trusted ? (app.agent?.turnSnapshots ?? TurnSnapshots.for(app.session, app.toolState.projectRoot)) : undefined;
}

async function undoLastRestore(app: App) {
    const snapshots = snapshotsOf(app);
    const id = lastRestore.get(app.session);
    if (!id || !canUndoRestore(snapshots, id)) {
        app.notice("There's no file restore to undo.");
        return;
    }
    if (app.busy) {
        app.notice("Wait for the response to finish, or stop it.", "warn");
        return;
    }
    lastRestore.delete(app.session);
    const root = canonical(app.cwd);
    const rel = (p: string) => displayPath(p, root);
    try {
        const { done, failed } = await undoRestore(snapshots, id, FileHistory.for(app.session));
        const changed = new Set(done);
        for (const p of [...app.toolState.fileState.keys()]) if (changed.has(canonical(p))) app.toolState.fileState.delete(p);
        if (done.length) {
            app.print(["", `${theme.success("✔")} Put back ${plural(done.length, "file")} as ${done.length === 1 ? "it was" : "they were"} before the restore`, ...listed(done.map((p) => theme.muted(`  ${rel(p)}`)))]);
            app.agent?.addReminder(`The user undid a file restore (/rewind): these files are back as they were before it. Read them again before editing them:\n${done.map((p) => `- ${rel(p)}`).join("\n")}`);
        }
        for (const f of failed) app.notice(`Couldn't put back ${rel(f.path)}: ${f.error}`, "error");
    } catch (e) {
        app.notice((e as Error).message, "error");
    }
}

export async function rewindCommand(app: App, args = "") {
    if (args.trim() === "undo") return undoLastRestore(app);
    const messages = app.session.messages;
    const compacted = messages[0]?.role === "user" && messages[0].meta?.kind === "summary";
    const targets = rewindTargets(messages).reverse();
    if (!targets.length) {
        app.notice(compacted ? "Nothing to rewind to: the earlier prompts were summarized by /compact." : "Nothing to rewind to yet.");
        return;
    }
    const history = FileHistory.for(app.session);
    const snapshots = snapshotsOf(app);
    const undo = lastRestore.get(app.session);
    const undoable = !!undo && canUndoRestore(snapshots, undo);
    const header: string[] = [];
    if (compacted) header.push(theme.muted("Prompts from before the last /compact can't be rewound to."));
    if (history?.unsaved) header.push(theme.warning(`File history couldn't be saved (${history.unsaved}), so it will be lost when this session ends.`));
    const pick = (await app.showDialog(
        new SelectDialog<number>({
            title: "Rewind to before which prompt?",
            header,
            items: [
                ...(undoable ? [{ label: "Undo the last file restore", value: -1, description: "put the files back as they were" }] : []),
                ...targets.map((t, i) => ({ label: preview(t.text, 70), value: i, description: changedLabel(changedBy(snapshots, history, t.checkpoint), t, beforeFork(app.session.meta, messages[t.index], t.index)) })),
            ],
            numbers: true,
            maxRows: 12,
        }),
    )) as number | undefined;
    if (pick === undefined) return;
    if (pick === -1) return undoLastRestore(app);
    const target = targets[pick]!;
    const chosen = messages[target.index];
    const count = app.session.messageCount;

    const plan = await planFileRestore({ snapshots, history, checkpoint: target.checkpoint });
    const backends = backendsIn(messages, target.index);
    const restore = plan.items;
    const skipped = plan.skipped;
    // History paths are real paths; show them against the real working folder.
    const root = canonical(app.cwd);
    const rel = (p: string) => displayPath(p, root);
    const lines = [theme.muted("> ") + preview(target.text, 200), ""];
    const forked = beforeFork(app.session.meta, chosen, target.index);
    const tracked = plan.whole || (!!history && target.checkpoint !== undefined);
    if (forked) lines.push(theme.warning(FORKED_NOTE));
    // One line, as the GUI's Rewind says it (RewindDialog.tsx), with where the rest is when Claude Code or Codex answered.
    const gitFor = backends.length && !plan.whole ? ` Use git for ${backends.map((b) => `${b}'s`).join(" and ")}.` : "";
    if (plan.refused) lines.push(theme.warning(`${plan.refused.replace(/\.$/, "")}: only ${APP_TITLE}'s edits can be restored.${gitFor}`));
    if (!tracked) lines.push(theme.muted("File changes from then weren't tracked, so only the conversation can be restored."));
    else if (restore.length) {
        lines.push(plan.whole ? `${plural(restore.length, "file")} changed since then:` : `${APP_TITLE} changed ${plural(restore.length, "file")} since then:`);
        lines.push(...listed(restore.map((it) => fileLine(rel, it))));
    } else lines.push(theme.muted(skipped.length ? "No other file changes to undo." : plan.whole ? "No files changed since then." : forked ? `${APP_TITLE} hasn't changed any files in this session since the fork.` : `${APP_TITLE} hasn't changed any files since then.`));
    if (skipped.length) {
        lines.push(theme.warning(`Can't be restored:`));
        lines.push(...listed(skipped.map((it) => theme.warning(`  ${rel(it.path)} (${it.reason})`))));
    }
    // As the GUI says it; with a refusal, its line says this.
    if (backends.length && !plan.whole && !plan.refused) lines.push(theme.warning(`What ${backends.join(" and ")} changed in files isn't undone${restore.length ? ", except in the files above" : ""}. Use git for that.`));
    if (!plan.whole && !plan.refused) lines.push(theme.subtle("Changes made by shell commands aren't undone."));

    type Choice = "both" | "conversation" | "code" | "cancel";
    const noCode = !restore.length;
    const choice = (await app.showDialog(
        new SelectDialog<Choice>({
            title: "Rewind to before this prompt?",
            header: lines,
            items: [
                // The GUI's buttons.
                { label: "Restore both", value: "both", disabled: noCode },
                { label: "Conversation only", value: "conversation" },
                { label: "Code only", value: "code", disabled: noCode },
                { label: "Cancel", value: "cancel" },
            ],
            numbers: true,
        }),
    )) as Choice | undefined;
    if (!choice || choice === "cancel") return;
    const code = choice === "both" || choice === "code";
    const conversation = choice === "both" || choice === "conversation";

    // What Undo can't put back is asked about first.
    const outside = restore.filter((i) => i.outside && !i.undoable);
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
    if (app.busy || app.session.messages[target.index] !== chosen || app.session.messageCount !== count) {
        app.notice("The conversation changed in the meantime; nothing was rewound.", "warn");
        return;
    }

    let rewindConversation = conversation;
    let restoredPaths: string[] = [];
    if (code) {
        let r: Awaited<ReturnType<typeof restoreFiles>>;
        try {
            r = await restoreFiles(plan);
        } catch (e) {
            app.notice((e as Error).message, "error");
            return;
        }
        const { done, failed } = r;
        restoredPaths = done.map(rel);
        // Their content changed under the model: it must read them again.
        const restored = new Set(done);
        for (const p of [...app.toolState.fileState.keys()]) if (restored.has(canonical(p))) app.toolState.fileState.delete(p);
        if (done.length) app.print(["", `${theme.success("✔")} Restored ${plural(done.length, "file")} to how ${done.length === 1 ? "it was" : "they were"} before that prompt`, ...listed(done.map((p) => theme.muted(`  ${rel(p)}`)))]);
        for (const f of failed) app.notice(`Couldn't restore ${rel(f.path)}: ${f.error}`, "error");
        if (r.undo) {
            lastRestore.set(app.session, r.undo);
            app.notice("Undo it with /rewind undo");
        }
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
        if (backends.length && !(code && plan.whole)) app.agent?.addReminder(untrackedChangesNote(backends, restoredPaths));
    }
}
