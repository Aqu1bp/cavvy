// Watching a GitHub pull request for the agent (WatchPullRequest): one GraphQL
// read per poll through `gh`, compared with what the last poll saw, and a wake
// when there's news: a check failed, the checks passed, someone commented or
// reviewed, the branch conflicts with its base, or it merged or closed.
//
// After T3 Code's watch_pull_request: news only from after the watch started,
// never the gh account's own comments (the agent's echoes), and a stop after
// a run of comment-only wakes so a chatty bot can't loop the agent.

import { redact } from "../util/redact";
import type { WakeQueue } from "./wakes";

export interface PrCheck {
    name: string;
    status: "pending" | "success" | "failure" | "cancelled" | "timed-out" | "action-required" | "skipped" | "neutral";
    required: boolean;
    url?: string;
}

export interface PrRemark {
    id: string;
    kind: "comment" | "review" | "inline";
    author: string;
    body: string;
    /** A review's verdict: APPROVED, CHANGES_REQUESTED, COMMENTED. */
    state?: string;
    path?: string;
    url?: string;
    at: string;
}

export interface PrSnapshot {
    repo: string;
    number: number;
    url: string;
    title: string;
    state: "open" | "merged" | "closed";
    draft: boolean;
    headSha?: string;
    base: string;
    head: string;
    mergeable: "mergeable" | "conflicting" | "unknown";
    checks: PrCheck[];
    remarks: PrRemark[];
    viewer?: string;
    rateLimit?: { remaining: number; resetAt?: string };
}

export interface WatchState {
    headSha?: string;
    /** Names of the checks known to have failed on this head. */
    failed: string[];
    /** The checks passed on this head (and the agent was told, or it was so when the watch started). */
    passed: boolean;
    /**
     * Without required checks, a pass is told only once a second poll sees the same checks:
     * right after a push the fast ones can be green before the rest have registered.
     */
    passing?: string;
    seen: Set<string>;
    conflicting: boolean;
    /** Comment-only wakes in a row. */
    chatter: number;
}

export type PrChange =
    | { kind: "checks-failed"; failed: PrCheck[] }
    | { kind: "checks-passed"; count: number; required: boolean }
    | { kind: "remarks"; remarks: PrRemark[] }
    | { kind: "conflicting" }
    | { kind: "ended"; state: "merged" | "closed" };

/** Comment-only wakes in a row before the watch stops (T3 Code uses the same number). */
export const CHATTER_LIMIT = 10;
/** Comment ids remembered past what the latest poll returned. */
const SEEN_CAP = 2000;
/** Read failures in a row before the watch stops (a rate limit only delays it). */
export const FAILURE_LIMIT = 8;
const LISTED = 10;
const SNIPPET = 300;

const FAILED = new Set<PrCheck["status"]>(["failure", "cancelled", "timed-out", "action-required"]);
export const isFailed = (c: PrCheck) => FAILED.has(c.status);

/** The gate for "checks passed": the required checks when there are any, else all. */
function gate(checks: PrCheck[]): { gate: PrCheck[]; required: boolean } {
    const required = checks.filter((c) => c.required);
    return required.length ? { gate: required, required: true } : { gate: checks, required: false };
}

const allPassed = (checks: PrCheck[]) => {
    const g = gate(checks).gate;
    return g.length > 0 && g.every((c) => c.status !== "pending" && !isFailed(c));
};

/** What the watch starts from: everything already there is old news. */
export function initialState(snap: PrSnapshot): WatchState {
    return {
        headSha: snap.headSha,
        failed: snap.checks.filter(isFailed).map((c) => c.name),
        passed: allPassed(snap.checks),
        seen: new Set(snap.remarks.map((r) => r.id)),
        conflicting: snap.mergeable === "conflicting",
        chatter: 0,
    };
}

/** What changed since the last poll, and the state to compare the next one with. */
export function evaluate(prev: WatchState, snap: PrSnapshot): { changes: PrChange[]; next: WatchState; exhausted: boolean } {
    const changes: PrChange[] = [];
    const moved = snap.headSha !== prev.headSha;
    // A new push starts the checks over.
    let failed = moved ? [] : prev.failed;
    let passed = moved ? false : prev.passed;
    let passing: string | undefined;
    if (snap.checks.length) {
        const nowFailed = snap.checks.filter(isFailed);
        const fresh = nowFailed.filter((c) => !failed.includes(c.name));
        if (fresh.length) changes.push({ kind: "checks-failed", failed: fresh });
        // A check that ran again and passed can fail again later: only failing ones stay remembered.
        failed = nowFailed.map((c) => c.name);
        const g = gate(snap.checks);
        const key = g.gate.map((c) => c.name).sort().join("\0");
        if (allPassed(snap.checks)) {
            // The confirmation must come from this commit: the last one's green poll says nothing about it.
            if (!passed && (g.required || (!moved && prev.passing === key))) {
                changes.push({ kind: "checks-passed", count: g.gate.length, required: g.required });
                passed = true;
            } else if (!passed) passing = key;
        } else passed = false;
    }

    const own = snap.viewer?.toLowerCase();
    const seen = new Set(prev.seen);
    const remarks: PrRemark[] = [];
    for (const r of snap.remarks) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        if (own && r.author.toLowerCase() === own) continue;
        remarks.push(r);
    }
    if (remarks.length) changes.push({ kind: "remarks", remarks });
    // Ids this poll returned stay (a busy PR's pages hold more than the cap); older ones can't come back.
    const current = new Set(snap.remarks.map((r) => r.id));
    const cap = Math.max(SEEN_CAP, current.size);
    if (seen.size > cap) for (const id of [...seen]) {
        if (seen.size <= cap) break;
        if (!current.has(id)) seen.delete(id);
    }

    // "unknown" is GitHub still working it out after a push: only a clear answer changes it.
    const conflicting = snap.mergeable === "unknown" ? prev.conflicting : snap.mergeable === "conflicting";
    if (conflicting && !prev.conflicting) changes.push({ kind: "conflicting" });

    if (snap.state !== "open") changes.push({ kind: "ended", state: snap.state });

    const commentsOnly = changes.length > 0 && changes.every((c) => c.kind === "remarks");
    const progress = moved || (changes.length > 0 && !commentsOnly);
    const chatter = (progress ? 0 : prev.chatter) + (commentsOnly ? 1 : 0);
    return {
        changes,
        next: { headSha: snap.headSha, failed, passed, ...(passing ? { passing } : {}), seen, conflicting, chatter },
        exhausted: commentsOnly && chatter >= CHATTER_LIMIT,
    };
}

const snippet = (body: string) => {
    const text = redact(body.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim());
    return text.length <= SNIPPET ? text : `${text.slice(0, SNIPPET - 1)}…`;
};

function listed<T>(items: T[], line: (item: T) => string): string[] {
    const out = items.slice(0, LISTED).map(line);
    if (items.length > LISTED) out.push(`  - and ${items.length - LISTED} more`);
    return out;
}

const STATUS_WORD: Partial<Record<PrCheck["status"], string>> = { cancelled: "cancelled", "timed-out": "timed out", "action-required": "needs action" };

function remarkLine(r: PrRemark): string {
    const where = r.path ? ` on ${r.path}` : "";
    const body = snippet(r.body);
    const verdict = r.kind === "review" && r.state && r.state !== "COMMENTED" ? ` ${r.state.toLowerCase().replace(/_/g, " ")}` : "";
    const said = body ? `${verdict ? `${verdict}:` : ":"} "${body}"` : verdict || " reviewed";
    return `  - ${r.author}${where}${said}${r.url ? ` ${r.url}` : ""}`;
}

function changeLines(c: PrChange, snap: PrSnapshot): string[] {
    const commit = snap.headSha ? ` on ${snap.headSha.slice(0, 7)}` : "";
    switch (c.kind) {
        case "checks-failed":
            return [`- Checks failed${commit}:`, ...listed(c.failed, (x) => `  - ${x.name}${STATUS_WORD[x.status] ? ` (${STATUS_WORD[x.status]})` : ""}${x.url ? ` ${x.url}` : ""}`)];
        case "checks-passed":
            return [`- All ${c.count} ${c.required ? "required " : ""}${c.count === 1 ? "check" : "checks"} passed${commit}.`];
        case "remarks":
            return [`- ${c.remarks.length} new ${c.remarks.length === 1 ? "comment" : "comments"}:`, ...listed(c.remarks, remarkLine)];
        case "conflicting":
            return [`- The branch now conflicts with ${snap.base}.`];
        case "ended":
            return [`- The pull request was ${c.state}.`];
    }
}

const SUMMARY: Record<PrChange["kind"], string> = {
    "checks-failed": "checks failed",
    "checks-passed": "checks passed",
    remarks: "new comments",
    conflicting: "merge conflict",
    ended: "",
};

/** The wake for some changes: a line for the transcript and what the model is told. */
export function describeChanges(snap: PrSnapshot, changes: PrChange[], opts: { exhausted?: boolean } = {}): { label: string; text: string } {
    const ended = changes.find((c): c is Extract<PrChange, { kind: "ended" }> => c.kind === "ended");
    const parts = changes.map((c) => (c.kind === "ended" ? c.state : c.kind === "remarks" && c.remarks.length === 1 ? "new comment" : SUMMARY[c.kind]));
    if (opts.exhausted) parts.push("stopped watching");
    const label = `PR #${snap.number}: ${parts.join(", ")}`;
    const closing = ended
        ? "The watch has ended."
        : opts.exhausted
          ? `Stopped watching after ${CHATTER_LIMIT} comment-only updates in a row. Call WatchPullRequest to watch it again.`
          : "Look into each item and act on it as your task requires. The watch goes on and wakes you on the next change, so end your turn when you're done. Call UnwatchPullRequest when you hand the work back to the user.";
    const text = [`Update on pull request #${snap.number} (${snap.url}) in ${snap.repo}, which you're watching:`, ...changes.flatMap((c) => changeLines(c, snap)), "", closing].join("\n");
    return { label, text };
}

/** The state as the tool reports it when a watch starts. */
export function describeSnapshot(snap: PrSnapshot): string {
    const out = [`Pull request #${snap.number}: ${snippet(snap.title)}`, `${snap.url}`, `${snap.head} → ${snap.base}, ${snap.draft ? "draft" : snap.state}${snap.headSha ? `, head ${snap.headSha.slice(0, 7)}` : ""}`];
    if (snap.checks.length) {
        const failed = snap.checks.filter(isFailed);
        const pending = snap.checks.filter((c) => c.status === "pending");
        const ok = snap.checks.length - failed.length - pending.length;
        out.push(`Checks: ${ok} passed or skipped, ${pending.length} pending, ${failed.length} failed`);
        out.push(...listed(failed, (c) => `  - failed: ${c.name}${c.url ? ` ${c.url}` : ""}`));
    } else out.push("Checks: none reported yet");
    if (snap.mergeable === "conflicting") out.push(`The branch conflicts with ${snap.base}.`);
    const own = snap.viewer?.toLowerCase();
    const others = snap.remarks.filter((r) => r.author.toLowerCase() !== own);
    if (others.length) {
        const recent = [...others].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-5);
        out.push(`${others.length} existing ${others.length === 1 ? "comment" : "comments"} from others${others.length > recent.length ? `, the latest ${recent.length}` : ""}:`, ...recent.map(remarkLine));
    }
    return out.join("\n");
}

// ---------------------------------------------------------------------------
// Reading a pull request

const CHECK_FIELDS = `__typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }`;
const THREAD_FIELDS = "comments(last: 10) { nodes { id author { login } body createdAt path url } }";

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title state isDraft headRefOid headRefName baseRefName mergeable
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes {
        ${CHECK_FIELDS}
      } } } } } }
      comments(last: 50) { nodes { id author { login } body createdAt url } }
      reviews(last: 30) { nodes { id author { login } body state submittedAt url } }
      reviewThreads(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } }
    }
  }
}`;

/** The rest of the checks, past the first page (a big matrix). */
const CHECKS_PAGE = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
      ${CHECK_FIELDS}
    } } } } } }
  } }
}`;

/** The rest of the review threads: oldest first, so a reply on an old one is on a later page. */
const THREADS_PAGE = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } }
  } }
}`;

/** Pages read past the first, for each of checks and threads: 500 of either is plenty. */
const MORE_PAGES = 4;

export type GhRunner = (args: string[], signal?: AbortSignal) => Promise<{ out: string; err: string; code: number }>;

/** Why a read failed, and what the watch does about it. */
export class PrReadError extends Error {
    constructor(
        message: string,
        /** auth: gh isn't logged in; missing: no such PR (or no access); rate: wait; other: retry with backoff. */
        readonly kind: "auth" | "missing" | "rate" | "other",
        readonly retryAt?: number,
    ) {
        super(message);
    }
}

function classify(text: string): PrReadError {
    const t = redact(text).trim().slice(0, 500) || "gh failed without saying why";
    if (/rate limit|secondary rate|abuse detection|HTTP 429/i.test(t)) return new PrReadError(t, "rate");
    if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials|requires authentication/i.test(t)) return new PrReadError(`GitHub CLI isn't logged in: ${t}. Run gh auth login in a terminal.`, "auth");
    if (/Could not resolve to a (PullRequest|Repository)|NOT_FOUND|HTTP 404/i.test(t)) return new PrReadError(`Pull request not found, or this gh account can't see it: ${t}`, "missing");
    return new PrReadError(t, "other");
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function checkOf(n: any): PrCheck | undefined {
    if (n?.__typename === "CheckRun") {
        const conclusion = str(n.conclusion).toUpperCase();
        const status: PrCheck["status"] =
            str(n.status).toUpperCase() !== "COMPLETED"
                ? "pending"
                : conclusion === "SUCCESS"
                  ? "success"
                  : conclusion === "FAILURE" || conclusion === "STARTUP_FAILURE"
                    ? "failure"
                    : conclusion === "CANCELLED"
                      ? "cancelled"
                      : conclusion === "TIMED_OUT"
                        ? "timed-out"
                        : conclusion === "ACTION_REQUIRED"
                          ? "action-required"
                          : conclusion === "SKIPPED"
                            ? "skipped"
                            : "neutral";
        return { name: str(n.name) || "check", status, required: n.isRequired === true, url: str(n.detailsUrl) || undefined };
    }
    if (n?.__typename === "StatusContext") {
        const state = str(n.state).toUpperCase();
        const status: PrCheck["status"] = state === "SUCCESS" ? "success" : state === "FAILURE" || state === "ERROR" ? "failure" : "pending";
        return { name: str(n.context) || "status", status, required: n.isRequired === true, url: str(n.targetUrl) || undefined };
    }
    return undefined;
}

/** A check that ran more than once under one name (a re-run, a matrix leg) counts as failed if any run failed, pending if any is pending. */
function mergeChecks(checks: PrCheck[]): PrCheck[] {
    const byName = new Map<string, PrCheck>();
    const rank = (c: PrCheck) => (isFailed(c) ? 2 : c.status === "pending" ? 1 : 0);
    for (const c of checks) {
        const had = byName.get(c.name);
        if (!had || rank(c) > rank(had)) byName.set(c.name, { ...c, required: c.required || Boolean(had?.required) });
        else if (c.required) had.required = true;
    }
    return [...byName.values()];
}

export function parseSnapshot(repo: string, json: string): PrSnapshot {
    let data: any;
    try {
        data = JSON.parse(json);
    } catch {
        throw new PrReadError("GitHub returned something that isn't JSON.", "other");
    }
    if (Array.isArray(data?.errors) && data.errors.length) {
        const msg = data.errors.map((e: any) => `${str(e?.type)} ${str(e?.message)}`.trim()).join("; ");
        throw classify(msg);
    }
    const pr = data?.data?.repository?.pullRequest;
    if (!pr || !Number.isSafeInteger(pr.number)) throw new PrReadError("Pull request not found, or this gh account can't see it.", "missing");
    const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const remarks: PrRemark[] = [];
    for (const c of pr.comments?.nodes ?? []) if (c?.id) remarks.push({ id: c.id, kind: "comment", author: str(c.author?.login) || "ghost", body: str(c.body), url: str(c.url) || undefined, at: str(c.createdAt) });
    for (const r of pr.reviews?.nodes ?? []) {
        // A pending review is a draft nobody else can see; an empty "commented" one only wraps inline comments, listed on their own.
        if (!r?.id || r.state === "PENDING" || (r.state === "COMMENTED" && !str(r.body).trim())) continue;
        remarks.push({ id: r.id, kind: "review", author: str(r.author?.login) || "ghost", body: str(r.body), state: str(r.state), url: str(r.url) || undefined, at: str(r.submittedAt) });
    }
    for (const t of pr.reviewThreads?.nodes ?? []) {
        for (const c of t?.comments?.nodes ?? []) if (c?.id) remarks.push({ id: c.id, kind: "inline", author: str(c.author?.login) || "ghost", body: str(c.body), path: str(c.path) || undefined, url: str(c.url) || undefined, at: str(c.createdAt) });
    }
    remarks.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    const state = str(pr.state).toUpperCase();
    const mergeable = str(pr.mergeable).toUpperCase();
    const rl = data?.data?.rateLimit;
    return {
        repo,
        number: pr.number,
        url: str(pr.url) || `https://github.com/${repo}/pull/${pr.number}`,
        title: str(pr.title),
        state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
        draft: pr.isDraft === true,
        headSha: str(pr.headRefOid) || undefined,
        head: str(pr.headRefName),
        base: str(pr.baseRefName),
        mergeable: mergeable === "CONFLICTING" ? "conflicting" : mergeable === "MERGEABLE" ? "mergeable" : "unknown",
        checks: mergeChecks(contexts.map(checkOf).filter((c: PrCheck | undefined): c is PrCheck => Boolean(c))),
        remarks,
        viewer: str(data?.data?.viewer?.login) || undefined,
        rateLimit: typeof rl?.remaining === "number" ? { remaining: rl.remaining, resetAt: str(rl.resetAt) || undefined } : undefined,
    };
}

/** One read of a pull request: a single GraphQL request (1 point of the hourly 5,000), and one more per extra page of checks or review threads. */
export async function readPullRequest(gh: GhRunner, repo: string, number: number, signal?: AbortSignal): Promise<PrSnapshot> {
    const [owner, name] = repo.split("/");
    const ask = async (query: string, after?: string): Promise<string> => {
        const res = await gh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, ...(after ? ["-f", `after=${after}`] : [])], signal);
        // gh exits non-zero on GraphQL errors too, with the JSON on stdout: parse that first for the real reason.
        if (res.code) {
            if (res.out.trim().startsWith("{")) {
                try {
                    parseSnapshot(repo, res.out);
                } catch (e) {
                    if (e instanceof PrReadError && e.kind !== "other") throw e;
                }
            }
            throw classify(`${res.err}\n${res.out}`);
        }
        return res.out;
    };
    const out = await ask(QUERY);
    let data: any;
    try {
        data = JSON.parse(out);
    } catch {
        return parseSnapshot(repo, out);
    }
    const pr = data?.data?.repository?.pullRequest;
    const rollup = () => pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    // Each page's nodes go onto the first's; parseSnapshot reads them all as one.
    const more = async (query: string, list: () => { pageInfo?: any; nodes?: any[] } | undefined, from: (d: any) => { pageInfo?: any; nodes?: any[] } | undefined) => {
        for (let page = 0; page < MORE_PAGES; page++) {
            const into = list();
            const cursor = into?.pageInfo?.hasNextPage ? str(into.pageInfo.endCursor) : "";
            if (!into || !cursor) return;
            let next: any;
            try {
                next = from(JSON.parse(await ask(query, cursor))?.data?.repository?.pullRequest);
            } catch (e) {
                if (e instanceof PrReadError) throw e;
                throw new PrReadError("GitHub returned something that isn't JSON.", "other");
            }
            into.nodes = [...(into.nodes ?? []), ...(next?.nodes ?? [])];
            into.pageInfo = next?.pageInfo;
        }
    };
    await more(CHECKS_PAGE, () => rollup()?.contexts, (p) => p?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts);
    await more(THREADS_PAGE, () => pr?.reviewThreads, (p) => p?.reviewThreads);
    return parseSnapshot(repo, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// The watch

export const prWatchTiming = {
    /** Between polls while checks are pending or GitHub is still working out mergeability. */
    fastMs: 60_000,
    /** Between polls otherwise. */
    slowMs: 120_000,
    maxBackoffMs: 15 * 60_000,
    /** How long to wait on a rate limit that gives no reset time. */
    rateLimitMs: 10 * 60_000,
    /** Below this many points left, wait for the reset rather than spend the user's last ones. */
    lowBudget: 100,
};

export interface PrWatchOptions {
    repo: string;
    number: number;
    gh: GhRunner;
    wakes: WakeQueue;
    /** What the watch started from (the tool's own read). */
    snapshot: PrSnapshot;
    /** It ended by itself (merged, closed, gave up): the host forgets it. */
    onEnd?: (reason: string) => void;
    now?: () => number;
}

export class PrWatch {
    readonly id: string;
    readonly kind = "pull-request";
    readonly label: string;
    private state: WatchState;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private abort = new AbortController();
    private failures = 0;
    private stopped = false;
    /** Polls made, for tests and /status-like listings. */
    polls = 0;
    last: PrSnapshot;
    private readonly now: () => number;

    constructor(private readonly o: PrWatchOptions) {
        this.id = prWatchId(o.repo, o.number);
        this.label = `PR #${o.number} in ${o.repo}`;
        this.state = initialState(o.snapshot);
        this.last = o.snapshot;
        this.now = o.now ?? Date.now;
    }

    start() {
        this.schedule(this.delayAfter(this.o.snapshot));
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.abort.abort();
        this.o.wakes.drop(this.id);
    }

    get active() {
        return !this.stopped;
    }

    onChange?: () => void;

    get url(): string {
        return this.last.url;
    }

    /** How it stands, from the last read. */
    get detail(): string {
        const s = this.last;
        const failed = s.checks.filter(isFailed).length;
        const pending = s.checks.some((c) => c.status === "pending");
        const parts = [failed ? `${failed} check${failed === 1 ? "" : "s"} failing` : pending ? "checks running" : s.checks.length ? "checks passed" : "no checks yet"];
        if (s.mergeable === "conflicting") parts.push("conflicts");
        if (this.failures) parts.push("can't reach GitHub, retrying");
        return parts.join(" · ");
    }

    /** Poll now (tests; the timer calls it otherwise). */
    async poll(): Promise<void> {
        if (this.stopped) return;
        this.timer = undefined;
        this.polls++;
        let snap: PrSnapshot;
        try {
            snap = await readPullRequest(this.o.gh, this.o.repo, this.o.number, this.abort.signal);
        } catch (e) {
            if (this.stopped) return;
            return this.failed(e);
        }
        if (this.stopped) return;
        const was = this.detail;
        this.failures = 0;
        this.last = snap;
        if (this.detail !== was) this.onChange?.();
        const { changes, next, exhausted } = evaluate(this.state, snap);
        this.state = next;
        if (changes.length) {
            const { label, text } = describeChanges(snap, changes, { exhausted });
            this.o.wakes.push({ source: "pull-request", key: this.id, label, text });
        }
        if (snap.state !== "open") return this.end(`it was ${snap.state}`);
        if (exhausted) return this.end("of too many comment-only updates");
        this.schedule(this.delayAfter(snap));
    }

    /** Until the next poll after this read. */
    private delayAfter(snap: PrSnapshot): number {
        // Spend the last of the hourly budget on the user's own work, not on polling.
        const reset = Date.parse(snap.rateLimit?.resetAt ?? "");
        if (snap.rateLimit && snap.rateLimit.remaining < prWatchTiming.lowBudget && reset > this.now()) return reset - this.now() + 1000;
        return this.interval(snap);
    }

    private interval(snap: PrSnapshot): number {
        const busy = snap.checks.some((c) => c.status === "pending") || snap.mergeable === "unknown" || this.state.passing !== undefined;
        return busy ? prWatchTiming.fastMs : prWatchTiming.slowMs;
    }

    private failed(e: unknown) {
        const err = e instanceof PrReadError ? e : new PrReadError(redact(e instanceof Error ? e.message : String(e)), "other");
        if (err.kind === "rate") return this.schedule(prWatchTiming.rateLimitMs);
        if (!this.failures) queueMicrotask(() => this.onChange?.());
        if (err.kind === "auth" || err.kind === "missing" || ++this.failures >= FAILURE_LIMIT) {
            const why = err.kind === "other" ? `reading it failed ${FAILURE_LIMIT} times in a row (last: ${err.message})` : err.message;
            this.o.wakes.push({
                source: "pull-request",
                key: this.id,
                label: `PR #${this.o.number}: stopped watching`,
                text: `Stopped watching pull request #${this.o.number} in ${this.o.repo}: ${why}\nCall WatchPullRequest to try again once that's fixed.`,
            });
            return this.end(why);
        }
        this.schedule(Math.min(prWatchTiming.slowMs * 2 ** (this.failures - 1), prWatchTiming.maxBackoffMs));
    }

    private end(reason: string) {
        if (this.stopped) return;
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.o.onEnd?.(reason);
    }

    private schedule(ms: number) {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.poll(), Math.max(1000, ms));
        // A watch never keeps the process alive by itself.
        (this.timer as { unref?: () => void }).unref?.();
    }
}

export const prWatchId = (repo: string, number: number) => `pr:${repo.toLowerCase()}#${number}`;

/** "123", "#123", or a github.com pull request URL. */
export function parsePrRef(ref: string | number | undefined): { repo?: string; number: number } | undefined {
    if (ref === undefined || ref === "") return undefined;
    if (typeof ref === "number") return Number.isSafeInteger(ref) && ref > 0 ? { number: ref } : undefined;
    const s = ref.trim();
    const n = /^#?(\d{1,9})$/.exec(s);
    if (n) return { number: Number(n[1]) };
    const u = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(s);
    if (u && ![".", ".."].includes(u[1]!) && ![".", ".."].includes(u[2]!)) return { repo: `${u[1]}/${u[2]}`, number: Number(u[3]) };
    return undefined;
}
