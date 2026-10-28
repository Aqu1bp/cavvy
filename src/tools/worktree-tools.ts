// EnterWorktree and ExitWorktree for the models Cavvy runs: the session moves into a git worktree of its own and back,
// as Claude Code's tools of the same names do for it. Only the agent's folder moves (ToolState.cwd): its commands and
// relative paths are the worktree's from then on, and the session follows it (the header's branch, the diff reader:
// AgentEvent cwd). The worktree is made as the New worktree dialog makes one (src/server/worktrees.ts), with the
// project's WorktreeCreate hooks when it has any. Leaving one keeps it: removing a worktree is the user's, in Cavvy's
// own removal (which asks about ignored files it would delete).

import { randomBytes } from "crypto";
import { resolve } from "path";
import type { Tool, ToolContext } from "./types";
import { checkFolder, createWorktreeWithHooks } from "../server/worktrees";
import { sessionWorktree, workingWorktree } from "../server/session-worktrees";
import { redact } from "../util/redact";

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

const fail = (content: string) => ({ content, isError: true });
const message = (e: unknown) => redact((e as Error)?.message ?? String(e));

/** The other worktree of the session's repository the agent is in now, if it's in one. */
function current(ctx: ToolContext) {
    return workingWorktree(ctx.state.projectRoot, ctx.state.cwd);
}

export const EnterWorktreeTool: Tool<{ name?: string; path?: string }> = {
    name: "EnterWorktree",
    category: "execute",
    readOnly: false,
    description: `Move this session into a git worktree: a checkout of the repository of its own, on a new branch, in .claude/worktrees/ of the project. The work there leaves the main checkout alone. From then on your commands run in the worktree and relative paths are its; the user's view of the session (its branch, its changes) follows you there.

Use it only when the user asks for a worktree, or the project's instructions (CLAUDE.md, AGENTS.md) say to work in one. To work on another branch otherwise, use git.

- name: a name for the new worktree (letters, digits, ".", "_" and "-", at most 64). Its branch is worktree-<name>. Leave it out for a generated one.
- path: an existing worktree of this repository to move into instead (one \`git worktree list\` lists). Not with name.

A new worktree's branch starts at the current commit (HEAD); uncommitted changes stay where they are. Go back with ExitWorktree.`,
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "A name for the new worktree; generated when left out. Not with path." },
            path: { type: "string", description: "An existing worktree of this repository to move into instead of making one. Not with name." },
        },
    },
    title: (i) => (i.path ? `EnterWorktree(${i.path})` : i.name ? `EnterWorktree(${i.name})` : "EnterWorktree"),
    validate(i) {
        if (i.name !== undefined && i.path !== undefined) return "Give name or path, not both.";
        if (i.name !== undefined && (typeof i.name !== "string" || !NAME.test(i.name) || i.name.startsWith("-") || i.name === "." || i.name.includes(".."))) return "name: letters, digits, \".\", \"_\" and \"-\" only, at most 64, not starting with \"-\" and without \"..\".";
        if (i.path !== undefined && (typeof i.path !== "string" || !i.path.trim())) return "path must be a folder.";
        return undefined;
    },
    async run(i, ctx) {
        const root = ctx.state.projectRoot;
        const from = current(ctx);
        if (i.path !== undefined) {
            let w;
            try {
                w = await sessionWorktree(root, resolve(ctx.state.cwd, i.path));
            } catch (e) {
                return fail(`${message(e)} Pass a worktree \`git worktree list\` lists, or a name to make a new one.`);
            }
            if (w.current) return fail(`${w.path} is this session's own folder: go back to it with ExitWorktree.`);
            if (from?.path === w.path) return { content: `This session works in ${w.path} already${w.branch ? `, on ${w.branch}` : ""}.` };
            ctx.state.cwd = w.path;
            return { content: `This session works in the worktree ${w.path} now${w.branch ? `, on branch ${w.branch}` : w.head ? `, at ${w.head.slice(0, 12)} (no branch)` : ""}. Commands run there and relative paths are its. ExitWorktree takes it back to ${root}.` };
        }
        if (from) return fail(`This session works in the worktree ${from.path} already. Go back with ExitWorktree first, or pass path to move to another worktree.`);
        const name = i.name ?? `wt-${randomBytes(3).toString("hex")}`;
        const branch = `worktree-${name}`;
        let w;
        try {
            w = await createWorktreeWithHooks({ path: root, branch, folder: checkFolder(name) }, undefined, ctx.settings);
        } catch (e) {
            return fail(`Couldn't make the worktree: ${message(e)}`);
        }
        ctx.state.cwd = w.path;
        return {
            content: `Made the worktree ${w.path} on branch ${w.branch}${w.commit ? `, from ${w.commit.slice(0, 12)}` : ""}. This session works there now: commands run there and relative paths are its. When the work is done, commit it on ${w.branch}; ExitWorktree takes the session back to ${root}.`,
        };
    },
};

export const ExitWorktreeTool: Tool<{ action?: "keep" }> = {
    name: "ExitWorktree",
    category: "execute",
    readOnly: false,
    description: `Move this session back to its own folder from the git worktree it works in (EnterWorktree's, or one you cd'd into). The worktree and its branch stay as they are, to come back to or merge; removing it is the user's, in Cavvy.

- action: "keep", the only one here.

Use it only when the user asks to leave the worktree.`,
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["keep"], description: "\"keep\": the worktree and its branch stay." },
        },
    },
    title: () => "ExitWorktree",
    validate(i) {
        return i.action === undefined || i.action === "keep" ? undefined : "action can only be \"keep\": the worktree stays, and removing it is the user's, in Cavvy.";
    },
    async run(_i, ctx) {
        const root = ctx.state.projectRoot;
        const w = current(ctx);
        if (!w) return { content: `This session isn't in another worktree: it works in ${ctx.state.cwd}. Nothing changed.` };
        ctx.state.cwd = root;
        return { content: `Back in ${root}. The worktree ${w.path}${w.branch ? ` and its branch ${w.branch}` : ""} are kept.` };
    },
};
