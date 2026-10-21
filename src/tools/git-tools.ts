// Git and GitHub as tools the agent calls: commit, push, open a pull request,
// and watch one. Commit and publish go through the same code as the GUI's
// Commit and Publish dialogs (private index, bounded hooks, no force push,
// audited remotes); pull requests are read and watched through `gh`.

import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { canonical } from "../agent/checkpoints";
import type { Tool, ToolContext, ToolDisplay } from "./types";
import type { ServerTool, ServerToolResult } from "../mcp/server";
import { gitCommit } from "../server/git-commit";
import { gitChanges } from "../server/git-changes";
import { currentGithubRepo, gitPrState, gitPublish, gitPublishInfo, gitPushTarget, runGh } from "../server/git-publish";
import type { GitPrInfo } from "../server/protocol";
import { isTrusted } from "../config/trust";
import { gitBranch, gitRoot } from "../util/git";
import { redact } from "../util/redact";
import { describeSnapshot, parsePrRef, PrReadError, PrWatch, prWatchId, readPullRequest, type GhRunner, type PrSnapshot } from "../agent/pr-watch";

/** What the tools reach the outside world with; tests swap in fakes. */
export const gitToolDeps = {
    gh: (cwd: string): GhRunner => (args, signal) => runGh(cwd, args, signal),
    trusted: (cwd: string) => isTrusted(cwd),
};

/** What each tool's permission prompt is headed with. */
export const GIT_TOOL_HEADINGS: Record<string, string> = {
    GitCommit: "Commit changes",
    GitPush: "Push the branch",
    CreatePullRequest: "Open a pull request",
};

const message = (e: unknown) => redact(e instanceof Error ? e.message : String(e));
const fail = (content: string) => ({ content, isError: true });
const prLine = (pr: GitPrInfo) => `#${pr.number} (${pr.state}): ${pr.title}\n${pr.url}`;

/** The most files one commit takes (as the GUI's commit dialog). */
const MAX_COMMIT_FILES = 300;

/**
 * Changed files git would list, as paths from the working directory (../ for the rest of the
 * repository), as the commit code takes them; new folders of many files are left out (named in
 * `skipped`). `total` counts past what's listed.
 */
async function changedFiles(cwd: string): Promise<{ files: string[]; skipped: string[]; total: number; reason?: string }> {
    const listed = await gitChanges(cwd, { scope: "uncommitted" });
    if (!listed.repo) return { files: [], skipped: [], total: 0, reason: listed.reason ?? "This folder isn't a Git repository." };
    const files: string[] = [];
    const skipped: string[] = [];
    for (const f of listed.files) (f.kind === "folder" || f.kind === "repo" ? skipped : files).push(f.path);
    return { files, skipped, total: files.length + (listed.more ?? 0) };
}

const tooMany = (n: number) => `${n} changed files: one commit takes at most ${MAX_COMMIT_FILES}. Name the files for this commit in paths, and commit the rest after.`;

/** Paths as the model gave them (absolute, or from the working directory), as the commit code names them: from the working directory. */
function fromCwd(cwd: string, paths: string[]): string[] | string {
    const root = gitRoot(cwd);
    if (!root) return "This folder isn't a Git repository.";
    const top = canonical(root);
    const here = canonical(cwd);
    const out: string[] = [];
    for (const p of paths) {
        const given = isAbsolute(p) ? p : resolve(here, p);
        // The folder is resolved, not the file: a changed link is itself the change.
        const abs = join(canonical(dirname(given)), basename(given));
        const inRepo = relative(top, abs);
        if (!inRepo || inRepo.startsWith("..") || isAbsolute(inRepo)) return `Not inside the repository: ${p}`;
        out.push((relative(here, abs) || ".").split("\\").join("/"));
    }
    return out;
}

/**
 * What a permission prompt showed for one call (its branch; for "commit
 * everything", its files), so the approved call does that and not what the
 * repository turned into while the prompt was open. Keyed by the call's input,
 * which the agent hands to both.
 */
const shown = new WeakMap<object, { branch?: string; files?: string[]; push?: { fingerprint: string; what: string } }>();

/** Refuses when the branch moved since the prompt showed it. */
function branchMoved(input: object, cwd: string, current?: string): string | undefined {
    const was = shown.get(input)?.branch;
    if (was === undefined) return undefined;
    const now = current ?? gitBranch(cwd) ?? "a detached HEAD";
    return now === was ? undefined : `Branch changed since the user was asked: they approved this for ${was}, and the repository is now on ${now}. Nothing was done; check with the user before trying again.`;
}

function needsTrust(ctx: ToolContext, what: string): string | undefined {
    return gitToolDeps.trusted(ctx.state.cwd) ? undefined : `Trust this folder before ${what}: Git runs the repository's hooks and configured programs. The user can trust it from the folder prompt or settings.`;
}

// ---------------------------------------------------------------------------

export const GitCommitTool: Tool<{ message: string; paths?: string[] }> = {
    name: "GitCommit",
    category: "execute",
    readOnly: false,
    description: `Commit changes in the current Git repository.

- message: the commit message (subject line, then an optional body). Follow the style of the repository's recent commits.
- paths: the files to commit (absolute, or relative to the working directory). Omit to commit every changed file, new ones included.

Only the named files are committed; anything already staged for other files stays staged and out of this commit. Repository hooks run. The user is asked first unless they've allowed it. Don't commit unless the user asked you to, and never commit secrets (.env, keys).`,
    parameters: {
        type: "object",
        properties: {
            message: { type: "string", description: "The commit message" },
            paths: { type: "array", items: { type: "string" }, description: "Files to commit; omit for every changed file" },
        },
        required: ["message"],
    },
    title: (i) => `GitCommit(${(i.message ?? "").split("\n")[0]!.slice(0, 60)})`,
    validate(i) {
        if (!String(i.message ?? "").trim()) return "Give a commit message.";
        if (i.paths !== undefined && (!Array.isArray(i.paths) || i.paths.some((p) => typeof p !== "string" || !p))) return "paths must be a list of file paths.";
        return undefined;
    },
    async preview(i, ctx): Promise<ToolDisplay> {
        const all = i.paths?.length ? undefined : await changedFiles(ctx.state.cwd);
        const listed = all ? all.files : fromCwd(ctx.state.cwd, i.paths!);
        const files = typeof listed === "string" ? [] : listed;
        const count = all ? all.total : files.length;
        const branch = gitBranch(ctx.state.cwd);
        shown.set(i, { branch: branch ?? "a detached HEAD", ...(i.paths?.length ? {} : { files }) });
        return {
            summary: `${count} file${count === 1 ? "" : "s"}${branch ? ` on ${branch}` : ""}${count > MAX_COMMIT_FILES ? ` (more than one commit takes: it will be refused)` : ""}`,
            body: `${i.message.trim()}\n\n${files.slice(0, 30).map((f) => `  ${f}`).join("\n")}${files.length > 30 ? `\n  … and ${files.length - 30} more` : ""}`,
        };
    },
    async run(i, ctx) {
        const cwd = ctx.state.cwd;
        const untrusted = needsTrust(ctx, "committing");
        if (untrusted) return fail(untrusted);
        const moved = branchMoved(i, cwd);
        if (moved) return fail(moved);
        let paths: string[];
        let skipped: string[] = [];
        let late: string[] = [];
        const approved = shown.get(i)?.files;
        if (i.paths?.length) {
            const r = fromCwd(cwd, i.paths);
            if (typeof r === "string") return fail(r);
            paths = r;
        } else {
            const c = await changedFiles(cwd);
            if (c.reason) return fail(c.reason);
            if (c.total > MAX_COMMIT_FILES) return fail(tooMany(c.total));
            paths = c.files;
            skipped = c.skipped;
            if (approved) {
                // Only what the user saw: files that changed while they were asked wait for another commit.
                late = paths.filter((p) => !approved.includes(p));
                paths = paths.filter((p) => approved.includes(p));
                if (!paths.length && late.length) return fail(`Nothing to commit that the user was shown: the changed files now (${late.join(", ")}) appeared after they were asked. Ask again.`);
            }
            if (!paths.length) return fail(skipped.length ? `Nothing to commit but new folders of many files (${skipped.join(", ")}). Name the files to commit in paths, or add them with git in Bash.` : "Nothing to commit: the working tree is clean.");
        }
        try {
            const done = await gitCommit(cwd, paths, i.message, { signal: ctx.signal });
            const left = `${skipped.length ? `\nLeft out (new folders of many files; name their files to commit them): ${skipped.join(", ")}` : ""}${late.length ? `\nLeft out (changed after the user was asked, so they didn't see it): ${late.join(", ")}` : ""}`;
            return {
                content: `Committed ${done.hash.slice(0, 7)} on ${done.branch ?? "a detached HEAD"}: ${done.subject} (${paths.length} file${paths.length === 1 ? "" : "s"})${left}`,
                display: { summary: `${done.hash.slice(0, 7)} ${done.subject}` },
            };
        } catch (e) {
            return fail(`Commit failed: ${message(e)}`);
        }
    },
};

// ---------------------------------------------------------------------------

/** Why the agent may not push this branch, if it may not. */
function pushRefusal(info: { branch: string; target: string; protected: boolean; defaultUnknown: boolean }): string | undefined {
    if (info.protected) return `Won't push ${info.target === info.branch ? info.branch : `${info.branch} to ${info.target}`}: it's the repository's main branch. Work on a branch of your own (git switch -c <name>), or ask the user to push it themselves.`;
    if (info.defaultUnknown) return "Won't push: the remote doesn't say which branch is its main one, so this could be it. Ask the user to push it themselves.";
    return undefined;
}

async function uncommittedNote(cwd: string): Promise<string> {
    const c = await changedFiles(cwd).catch(() => undefined);
    const n = (c?.files.length ?? 0) + (c?.skipped.length ?? 0);
    return n ? `\nNot included: ${n} uncommitted change${n === 1 ? "" : "s"} in the working tree (commit them first with GitCommit if they belong).` : "";
}

/** The prompt names the branch, commit and destination, and the push is held to exactly those. */
async function publishPreview(input: object, ctx: ToolContext, extra?: string): Promise<ToolDisplay> {
    const branch = gitBranch(ctx.state.cwd);
    const t = await gitPushTarget(ctx.state.cwd, ctx.signal).catch(() => undefined);
    const what = t && `${t.branch} at ${t.sha.slice(0, 7)} to ${redact(t.url)} (${t.target})`;
    shown.set(input, { branch: branch ?? "a detached HEAD", ...(t ? { push: { fingerprint: t.fingerprint, what: what! } } : {}) });
    return {
        summary: t ? `${t.branch} → ${t.remote}/${t.target}` : branch ? `Branch ${branch}` : undefined,
        body: [t ? `Commit ${t.sha.slice(0, 7)} to ${redact(t.url)}` : "", extra ?? ""].filter(Boolean).join("\n\n") || undefined,
    };
}

/** Refuses when the branch, commit or destination isn't what the prompt showed; else the fingerprint to push with. */
function pushApproved(input: object, info: { branch: string; fingerprint: string }, cwd: string): { refused: string } | { fingerprint: string } {
    const moved = branchMoved(input, cwd, info.branch);
    if (moved) return { refused: moved };
    const push = shown.get(input)?.push;
    if (push && push.fingerprint !== info.fingerprint) return { refused: `The commit or destination changed since the user was asked: they approved pushing ${push.what}. Nothing was pushed; check with the user before trying again.` };
    return { fingerprint: push?.fingerprint ?? info.fingerprint };
}

export const GitPushTool: Tool<Record<string, never>> = {
    name: "GitPush",
    category: "execute",
    readOnly: false,
    description: `Push the current branch to its remote (its upstream; on the first push, origin when it's the only remote, which then becomes its upstream).

Never forces and never pushes tags. Refuses the repository's main branch: work on your own branch. A rejected push means the remote has commits you don't: fetch, reconcile (rebase or merge), then push again. Only what's committed is pushed. The user is asked first unless they've allowed it.`,
    parameters: { type: "object", properties: {} },
    title: () => "GitPush",
    async preview(i, ctx) {
        return publishPreview(i, ctx);
    },
    async run(i, ctx) {
        const cwd = ctx.state.cwd;
        const untrusted = needsTrust(ctx, "pushing");
        if (untrusted) return fail(untrusted);
        try {
            const info = await gitPublishInfo(cwd, ctx.signal);
            const approved = pushApproved(i, info, cwd);
            if ("refused" in approved) return fail(approved.refused);
            const refused = pushRefusal(info);
            if (refused) return fail(refused);
            // gitPublish checks the repository still matches this fingerprint right before pushing.
            const { pr } = await gitPublish(cwd, { fingerprint: approved.fingerprint, action: "push" }, ctx.signal);
            const commits = info.hasUpstream ? (info.ahead ?? 0) : undefined;
            const what = commits === undefined ? "" : commits === 0 ? " (already up to date)" : ` (${commits} commit${commits === 1 ? "" : "s"})`;
            return {
                content: `Pushed ${info.branch} to ${info.remote}/${info.target}${what}.${pr ? `\nPull request ${prLine(pr)}` : ""}${await uncommittedNote(cwd)}`,
                display: { summary: `${info.branch} → ${info.remote}/${info.target}${what}` },
            };
        } catch (e) {
            return fail(`Push failed: ${message(e)}`);
        }
    },
};

// ---------------------------------------------------------------------------

export const CreatePullRequestTool: Tool<{ title: string; body?: string; base?: string; draft?: boolean; watch?: boolean }> = {
    name: "CreatePullRequest",
    category: "execute",
    readOnly: false,
    description: `Push the current branch and open a GitHub pull request for it (with the gh CLI, as the user's GitHub account).

- title: a short summary of the change.
- body: what changed and why, and how it was tested (Markdown).
- base: the branch to merge into; defaults to the remote's main branch.
- draft: open it as a draft.
- watch: also watch it (see WatchPullRequest) to be woken when checks fail or someone comments.

If the branch already has an open pull request, nothing new is opened: you get that one. Refuses to open one from the main branch. The user is asked first unless they've allowed it.`,
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "Pull request title" },
            body: { type: "string", description: "Pull request description (Markdown)" },
            base: { type: "string", description: "Branch to merge into; default: the remote's main branch" },
            draft: { type: "boolean", description: "Open as a draft" },
            watch: { type: "boolean", description: "Also watch it for failing checks and comments" },
        },
        required: ["title"],
    },
    title: (i) => `CreatePullRequest(${String(i.title ?? "").slice(0, 60)})`,
    validate(i) {
        if (!String(i.title ?? "").trim()) return "Give the pull request a title.";
        if (i.title.length > 250) return "Keep the title under 250 characters.";
        if ((i.body?.length ?? 0) > 16000) return "Keep the body under 16,000 characters.";
        return undefined;
    },
    async preview(i, ctx) {
        return publishPreview(i, ctx, `${i.draft ? "[draft] " : ""}${i.title}${i.base ? `  (into ${i.base})` : ""}\n\n${(i.body ?? "").slice(0, 1500)}${(i.body?.length ?? 0) > 1500 ? "\n…" : ""}`);
    },
    async run(i, ctx) {
        const cwd = ctx.state.cwd;
        const untrusted = needsTrust(ctx, "opening a pull request");
        if (untrusted) return fail(untrusted);
        let pr: GitPrInfo | undefined;
        let existed = false;
        try {
            const info = await gitPublishInfo(cwd, ctx.signal);
            const approved = pushApproved(i, info, cwd);
            if ("refused" in approved) return fail(approved.refused);
            const refused = pushRefusal(info);
            if (refused) return fail(refused);
            if (!info.gh) return fail("The GitHub CLI isn't installed or isn't logged in (or the remote isn't on github.com). Ask the user to run gh auth login, or push with GitPush and give them the compare link.");
            const base = i.base?.trim() || info.base;
            if (!base) return fail("The remote doesn't say which branch is its main one: pass base.");
            existed = info.pr?.state === "open" || info.pr?.state === "draft";
            ({ pr } = await gitPublish(cwd, { fingerprint: approved.fingerprint, action: "pr", base, title: i.title.trim(), body: i.body ?? "", draft: i.draft === true }, ctx.signal));
        } catch (e) {
            return fail(`Couldn't open the pull request: ${message(e)}`);
        }
        if (!pr) return fail("The branch was pushed, but GitHub didn't return the pull request. Check it with gh pr view.");
        let out = `${existed ? "This branch already has an open pull request (pushed the latest commits to it)" : "Opened pull request"} ${prLine(pr)}${await uncommittedNote(cwd)}`;
        if (i.watch) {
            const w = await startWatch(ctx, String(pr.number), pr.url);
            out += `\n\n${w.content}`;
        }
        return { content: out, display: { summary: `#${pr.number} ${pr.title}` } };
    },
};

// ---------------------------------------------------------------------------

async function resolvePr(ctx: ToolContext, ref: string | number | undefined, url?: string): Promise<{ repo: string; number: number } | string> {
    const cwd = ctx.state.cwd;
    const parsed = parsePrRef(url ?? ref);
    if (ref !== undefined && ref !== "" && !parsed) return `Not a pull request: ${String(ref).slice(0, 100)}. Pass its number or its github.com URL.`;
    if (parsed?.repo) return { repo: parsed.repo, number: parsed.number };
    let repo: string | undefined;
    try {
        repo = await currentGithubRepo(cwd, ctx.signal);
    } catch (e) {
        return parsed ? `Pass the pull request's full URL: the repository couldn't be worked out here (${message(e)}).` : `Couldn't find this branch's pull request: ${message(e)}`;
    }
    if (!repo) return "This branch doesn't push to github.com. Pass the pull request's full URL.";
    if (parsed) return { repo, number: parsed.number };
    try {
        const pr = await gitPrState(cwd, ctx.signal);
        if (!pr) return "This branch has no pull request (or the GitHub CLI isn't logged in). Open one with CreatePullRequest, or pass a number or URL.";
        return { repo, number: pr.number };
    } catch (e) {
        return `Couldn't find this branch's pull request: ${message(e)}`;
    }
}

async function startWatch(ctx: ToolContext, ref: string | number | undefined, url?: string): Promise<{ content: string; isError?: boolean }> {
    const wakes = ctx.wakes;
    const watchers = ctx.state.watchers;
    if (!wakes || !watchers) return fail("Only the session's own agent can watch a pull request (not a sub-agent or a one-shot run): its watch would end with this task.");
    const target = await resolvePr(ctx, ref, url);
    if (typeof target === "string") return fail(target);
    const id = prWatchId(target.repo, target.number);
    const gh = gitToolDeps.gh(ctx.state.cwd);
    let snap: PrSnapshot;
    try {
        snap = await readPullRequest(gh, target.repo, target.number, ctx.signal);
    } catch (e) {
        return fail(e instanceof PrReadError ? e.message : `Couldn't read the pull request: ${message(e)}`);
    }
    const state = describeSnapshot(snap);
    if (snap.state !== "open") return { content: `${state}\n\nIt's ${snap.state}, so there's nothing to watch.` };
    if (watchers.has(id)) return { content: `${state}\n\nAlready watching it: you'll be woken on the next change.` };
    const watch = new PrWatch({ repo: target.repo, number: target.number, gh, wakes, snapshot: snap, onEnd: () => watchers.get(id) === watch && watchers.delete(id) });
    watchers.set(id, watch);
    watch.start();
    return {
        content: `${state}\n\nWatching it now. You'll be woken when a check fails, the checks pass, someone else comments or reviews, the branch starts to conflict with ${snap.base}, or it merges or closes. Only changes from now on wake you, so handle what's above first, then end your turn: don't poll or sleep. Call UnwatchPullRequest when you hand the work back to the user.`,
    };
}

export const WatchPullRequestTool: Tool<{ pr?: string | number }> = {
    name: "WatchPullRequest",
    category: "meta",
    readOnly: true,
    description: `Watch a GitHub pull request and be woken with a message when a check fails, the checks pass, someone else comments or reviews, the branch starts to conflict with its base, or it merges or closes.

- pr: its number or github.com URL; omit for the current branch's pull request.

Use this to monitor or babysit a pull request instead of polling, sleeping, or running a watcher in Bash. The result shows its state now (checks, recent comments): handle that first, then end your turn. You're woken only for changes after this call, while the session stays open. Your own comments (the gh account's) don't wake you. A wake is news, not a decision to merge. Uses the gh CLI as the user's GitHub account and checks once a minute or two.`,
    parameters: {
        type: "object",
        properties: { pr: { type: ["string", "integer"], description: "Pull request number or URL; omit for this branch's" } },
    },
    title: (i) => (i.pr !== undefined && i.pr !== "" ? `WatchPullRequest(${String(i.pr).slice(0, 80)})` : "WatchPullRequest"),
    async run(i, ctx) {
        const r = await startWatch(ctx, i.pr);
        return r.isError ? r : { ...r, display: { summary: r.content.includes("Watching it now") ? "Watching" : r.content.includes("Already watching") ? "Already watching" : "Not watching" } };
    },
};

export const UnwatchPullRequestTool: Tool<{ pr?: string | number }> = {
    name: "UnwatchPullRequest",
    category: "meta",
    readOnly: true,
    description: `Stop watching a pull request (see WatchPullRequest). pr: its number or URL; omit to stop every watch in this session.`,
    parameters: {
        type: "object",
        properties: { pr: { type: ["string", "integer"], description: "Pull request number or URL; omit for all" } },
    },
    title: (i) => (i.pr !== undefined && i.pr !== "" ? `UnwatchPullRequest(${String(i.pr).slice(0, 80)})` : "UnwatchPullRequest"),
    async run(i, ctx) {
        const watchers = ctx.state.watchers;
        const prs = [...(watchers?.values() ?? [])].filter((w): w is PrWatch => w instanceof PrWatch);
        if (!prs.length) return { content: "No pull request is being watched." };
        let stop = prs;
        if (i.pr !== undefined && i.pr !== "") {
            const ref = parsePrRef(i.pr);
            if (!ref) return fail(`Not a pull request: ${String(i.pr).slice(0, 100)}. Pass its number or its github.com URL.`);
            stop = prs.filter((w) => w.id === (ref.repo ? prWatchId(ref.repo, ref.number) : w.id) && w.id.endsWith(`#${ref.number}`));
            if (!stop.length) return fail(`Not watching #${ref.number}. Watching: ${prs.map((w) => w.label).join(", ")}`);
        }
        for (const w of stop) {
            w.stop();
            watchers!.delete(w.id);
        }
        return { content: `Stopped watching ${stop.map((w) => w.label).join(", ")}.`, display: { summary: `Stopped ${stop.length}` } };
    },
};

// ---------------------------------------------------------------------------

/**
 * WatchPullRequest and UnwatchPullRequest for Claude Code and Codex, through
 * the harness MCP server: neither CLI can watch a pull request itself, and
 * their process ends with each turn. Committing, pushing and opening one they
 * do with their own shells, under the harness's permission prompts.
 */
export function watchServerTools(context: (signal: AbortSignal) => ToolContext): ServerTool[] {
    const wrap = (r: { content: string; isError?: boolean }): ServerToolResult => ({ text: r.content, isError: r.isError });
    const pr = (args: Record<string, unknown>) => ({ pr: typeof args.pr === "string" || typeof args.pr === "number" ? args.pr : undefined });
    const rename = (text: string) => text.replaceAll("WatchPullRequest", "watch_pull_request");
    return [
        {
            name: "watch_pull_request",
            title: "Watch a pull request",
            description: rename(WatchPullRequestTool.description).replace("running a watcher in Bash", "running a watcher in your shell, a Monitor or a ScheduleWakeup"),
            inputSchema: WatchPullRequestTool.parameters,
            annotations: { readOnlyHint: true, openWorldHint: true },
            call: async (args, { signal }) => wrap(await WatchPullRequestTool.run(pr(args), context(signal))),
        },
        {
            name: "unwatch_pull_request",
            title: "Stop watching a pull request",
            description: rename(UnwatchPullRequestTool.description),
            inputSchema: UnwatchPullRequestTool.parameters,
            annotations: { readOnlyHint: false, openWorldHint: false },
            call: async (args, { signal }) => wrap(await UnwatchPullRequestTool.run(pr(args), context(signal))),
        },
    ];
}

export const WATCH_INSTRUCTIONS = `# Watching pull requests (harness)

To follow a pull request's checks and reviews ("watch the PR", "tell me when CI finishes", "babysit it"), call watch_pull_request and end your turn: Harness wakes you with a message when a check fails or passes, someone comments or reviews, the branch conflicts, or it merges or closes. Don't poll, sleep, or set a Monitor or ScheduleWakeup for it: this CLI process ends after each turn. A wake is news from the harness, not the user's request.`;
