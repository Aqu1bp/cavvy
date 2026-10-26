// Watching a pull request: what counts as news (checks, comments, conflicts,
// merge), reading GitHub's answer, and the poller's handling of failures,
// rate limits and stops. GitHub is faked: no network.

import { afterEach, describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { CHATTER_LIMIT, FAILURE_LIMIT, describeChanges, describeSnapshot, evaluate, initialState, parsePrRef, parseSnapshot, PrReadError, PrWatch, prWatchTiming, readPullRequest } = await import("../src/agent/pr-watch");
const { WakeQueue } = await import("../src/agent/wakes");
import type { PrCheck, PrRemark, PrSnapshot } from "../src/agent/pr-watch";

const timing = { ...prWatchTiming };
afterEach(() => Object.assign(prWatchTiming, timing));
process.on("exit", () => iso.cleanup());

const check = (name: string, status: PrCheck["status"], required = false): PrCheck => ({ name, status, required });
const remark = (id: string, author: string, body = "hi", extra: Partial<PrRemark> = {}): PrRemark => ({ id, kind: "comment", author, body, at: "2026-10-20T10:00:00Z", ...extra });

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
    return {
        repo: "acme/app",
        number: 12,
        url: "https://github.com/acme/app/pull/12",
        title: "Add the thing",
        state: "open",
        draft: false,
        headSha: "aaaaaaa1111",
        head: "feature",
        base: "main",
        mergeable: "mergeable",
        checks: [check("test", "pending"), check("lint", "pending")],
        remarks: [remark("c1", "alice", "first")],
        viewer: "me",
        ...over,
    };
}

describe("what counts as news", () => {
    test("on a PR with more comments than the remembered cap, none the poll still returns comes back as new", () => {
        const many = Array.from({ length: 3000 }, (_, i) => remark(`c${i}`, `u${i}`));
        let st = initialState(snap({ remarks: many }));
        for (let i = 0; i < 3; i++) {
            const r = evaluate(st, snap({ remarks: [...many, remark(`n${i}`, "bob")] }));
            expect(r.changes).toEqual([{ kind: "remarks", remarks: [remark(`n${i}`, "bob")] }]);
            st = r.next;
        }
    });

    test("nothing that was already there when the watch started", () => {
        const s = snap({ checks: [check("test", "failure")], mergeable: "conflicting" });
        expect(evaluate(initialState(s), s).changes).toEqual([]);
    });

    test("a check failing wakes once, not again while it stays failed", () => {
        let st = initialState(snap());
        const failed = snap({ checks: [check("test", "failure"), check("lint", "pending")] });
        const r1 = evaluate(st, failed);
        expect(r1.changes).toEqual([{ kind: "checks-failed", failed: [check("test", "failure")] }]);
        st = r1.next;
        expect(evaluate(st, failed).changes).toEqual([]);
        // Another one failing later is news of its own.
        const r2 = evaluate(st, snap({ checks: [check("test", "failure"), check("lint", "timed-out")] }));
        expect(r2.changes).toEqual([{ kind: "checks-failed", failed: [check("lint", "timed-out")] }]);
    });

    test("checks passing wakes once per commit, once a second poll sees the same checks; a push starts over", () => {
        let st = initialState(snap());
        const green = snap({ checks: [check("test", "success"), check("lint", "skipped")] });
        // The first green poll could be the fast checks before the rest have registered.
        let r = evaluate(st, green);
        expect(r.changes).toEqual([]);
        r = evaluate(r.next, green);
        expect(r.changes).toEqual([{ kind: "checks-passed", count: 2, required: false }]);
        st = r.next;
        expect(evaluate(st, green).changes).toEqual([]);
        const pushed = snap({ headSha: "bbbbbbb2222", checks: [] });
        st = evaluate(st, pushed).next;
        st = evaluate(st, { ...green, headSha: "bbbbbbb2222" }).next;
        expect(evaluate(st, { ...green, headSha: "bbbbbbb2222" }).changes).toEqual([{ kind: "checks-passed", count: 2, required: false }]);
    });

    test("a new commit's first green poll isn't confirmed by the previous commit's", () => {
        const lint = [check("fast-lint", "success")];
        let st = initialState(snap({ checks: [] }));
        // The old commit: one green poll, the confirmation pending.
        st = evaluate(st, snap({ checks: lint })).next;
        expect(st.passing).toBeDefined();
        // A push: the new commit's first poll shows the same fast check green, the rest not registered yet.
        const r = evaluate(st, snap({ headSha: "bbbbbbb2222", checks: lint }));
        expect(r.changes).toEqual([]);
        // The rest registers: nothing was announced, so nothing needs taking back.
        expect(evaluate(r.next, snap({ headSha: "bbbbbbb2222", checks: [...lint, check("tests", "pending")] })).changes).toEqual([]);
    });

    test("a fast check green before CI has registered isn't a pass", () => {
        let st = initialState(snap({ checks: [] }));
        st = evaluate(st, snap({ checks: [check("license", "success")] })).next;
        const r = evaluate(st, snap({ checks: [check("license", "success"), check("test", "pending")] }));
        expect(r.changes).toEqual([]);
        expect(r.next.passing).toBeUndefined();
    });

    test("a re-run that fails again after a push is news again", () => {
        let st = initialState(snap({ checks: [check("test", "failure")] }));
        st = evaluate(st, snap({ headSha: "new", checks: [check("test", "pending")] })).next;
        expect(evaluate(st, snap({ headSha: "new", checks: [check("test", "failure")] })).changes.map((c) => c.kind)).toEqual(["checks-failed"]);
    });

    test("with required checks, only they decide 'passed'", () => {
        const st = initialState(snap({ checks: [check("test", "pending", true), check("coverage", "pending")] }));
        const r = evaluate(st, snap({ checks: [check("test", "success", true), check("coverage", "pending")] }));
        expect(r.changes).toEqual([{ kind: "checks-passed", count: 1, required: true }]);
    });

    test("new comments from others wake; the gh account's own and ones already seen don't", () => {
        const st = initialState(snap());
        const s = snap({ remarks: [remark("c1", "alice", "first"), remark("c2", "Me", "I pushed a fix"), remark("c3", "bob", "LGTM?"), remark("r1", "carol", "", { kind: "review", state: "CHANGES_REQUESTED" })] });
        const r = evaluate(st, s);
        expect(r.changes).toHaveLength(1);
        const remarks = (r.changes[0] as { remarks: PrRemark[] }).remarks;
        expect(remarks.map((x) => x.id)).toEqual(["c3", "r1"]);
        expect(evaluate(r.next, s).changes).toEqual([]);
        const text = describeChanges(s, r.changes).text;
        expect(text).toContain('bob: "LGTM?"');
        expect(text).toContain("carol changes requested");
    });

    test("a conflict wakes once; GitHub still computing ('unknown') changes nothing", () => {
        let st = initialState(snap());
        const r = evaluate(st, snap({ mergeable: "conflicting" }));
        expect(r.changes).toEqual([{ kind: "conflicting" }]);
        st = r.next;
        expect(evaluate(st, snap({ mergeable: "unknown" })).changes).toEqual([]);
        expect(evaluate(st, snap({ mergeable: "unknown" })).next.conflicting).toBe(true);
        st = evaluate(st, snap({ mergeable: "mergeable" })).next;
        expect(evaluate(st, snap({ mergeable: "conflicting" })).changes).toEqual([{ kind: "conflicting" }]);
    });

    test("merged or closed is the last news", () => {
        const r = evaluate(initialState(snap()), snap({ state: "merged" }));
        expect(r.changes).toEqual([{ kind: "ended", state: "merged" }]);
        const d = describeChanges(snap({ state: "merged" }), r.changes);
        expect(d.label).toBe("PR #12: merged");
        expect(d.text).toContain("The watch has ended.");
    });

    test(`${CHATTER_LIMIT} comment-only wakes in a row stop the watch; other news resets the count`, () => {
        let st = initialState(snap());
        let exhausted = false;
        for (let i = 0; i < CHATTER_LIMIT; i++) {
            const r = evaluate(st, snap({ remarks: [remark(`bot${i}`, "chatty-bot")] }));
            st = r.next;
            exhausted = r.exhausted;
            if (i === 4) {
                const reset = evaluate(st, snap({ remarks: [remark(`bot${i}x`, "chatty-bot")], checks: [check("test", "failure")] }));
                expect(reset.exhausted).toBe(false);
                expect(reset.next.chatter).toBe(0);
            }
        }
        expect(exhausted).toBe(true);
        expect(describeChanges(snap(), [{ kind: "remarks", remarks: [remark("x", "bot")] }], { exhausted: true }).text).toContain("Stopped watching after");
    });

    test("the wake text is bounded and redacts secrets in comments", () => {
        const many = Array.from({ length: 15 }, (_, i) => remark(`m${i}`, "bob", `ghp_${"x".repeat(40)} ${"y".repeat(500)}`));
        const r = evaluate(initialState(snap()), snap({ remarks: many }));
        const { text, label } = describeChanges(snap(), r.changes);
        expect(label).toBe("PR #12: new comments");
        expect(text).toContain("and 5 more");
        expect(text).not.toContain("ghp_xxxx");
        expect(text.length).toBeLessThan(6000);
    });

    test("the starting report names failing checks and recent comments from others", () => {
        const s = snap({ checks: [check("test", "failure"), check("lint", "success"), check("e2e", "pending")], mergeable: "conflicting", remarks: [remark("a", "me", "mine"), remark("b", "bob", "please fix")] });
        const text = describeSnapshot(s);
        expect(text).toContain("Checks: 1 passed or skipped, 1 pending, 1 failed");
        expect(text).toContain("failed: test");
        expect(text).toContain("conflicts with main");
        expect(text).toContain('bob: "please fix"');
        expect(text).not.toContain("mine");
    });
});

// ---------------------------------------------------------------------------

const graphql = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        data: {
            viewer: { login: "me" },
            rateLimit: { remaining: 4999, resetAt: "2026-10-20T11:00:00Z" },
            repository: {
                pullRequest: {
                    number: 12,
                    url: "https://github.com/acme/app/pull/12",
                    title: "Add the thing",
                    state: "OPEN",
                    isDraft: false,
                    headRefOid: "abc1234def",
                    headRefName: "feature",
                    baseRefName: "main",
                    mergeable: "MERGEABLE",
                    commits: {
                        nodes: [
                            {
                                commit: {
                                    statusCheckRollup: {
                                        contexts: {
                                            nodes: [
                                                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1", isRequired: true },
                                                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/2", isRequired: false },
                                                { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null },
                                                { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "STARTUP_FAILURE" },
                                                { __typename: "StatusContext", context: "deploy/preview", state: "ERROR", targetUrl: "https://preview" },
                                                { __typename: "StatusContext", context: "license", state: "SUCCESS" },
                                            ],
                                        },
                                    },
                                },
                            },
                        ],
                    },
                    comments: { nodes: [{ id: "IC_1", author: { login: "bob" }, body: "nice", createdAt: "2026-10-20T10:00:00Z", url: "u1" }] },
                    reviews: {
                        nodes: [
                            { id: "R_1", author: { login: "carol" }, body: "", state: "COMMENTED", submittedAt: "2026-10-20T10:01:00Z" },
                            { id: "R_2", author: { login: "carol" }, body: "", state: "APPROVED", submittedAt: "2026-10-20T10:02:00Z" },
                            { id: "R_3", author: { login: "me" }, body: "draft", state: "PENDING", submittedAt: null },
                        ],
                    },
                    reviewThreads: { nodes: [{ comments: { nodes: [{ id: "RC_1", author: null, body: "typo", createdAt: "2026-10-20T09:00:00Z", path: "src/a.ts", url: "u2" }] } }] },
                    ...over,
                },
            },
        },
    });

describe("reading GitHub's answer", () => {
    test("checks, reviews and comments map to what the watch compares", () => {
        const s = parseSnapshot("acme/app", graphql());
        expect(s).toMatchObject({ number: 12, state: "open", headSha: "abc1234def", base: "main", head: "feature", mergeable: "mergeable", viewer: "me", rateLimit: { remaining: 4999 } });
        const byName = Object.fromEntries(s.checks.map((c) => [c.name, c]));
        // A failed run and a passing re-run under one name: failing, and required if either is.
        expect(byName.test).toMatchObject({ status: "failure", required: true });
        expect(byName.build!.status).toBe("pending");
        expect(byName.docs!.status).toBe("failure");
        expect(byName["deploy/preview"]!.status).toBe("failure");
        expect(byName.license!.status).toBe("success");
        // The empty "commented" review only wraps inline comments; a pending one is a private draft.
        expect(s.remarks.map((r) => r.id)).toEqual(["RC_1", "IC_1", "R_2"]);
        expect(s.remarks[0]).toMatchObject({ kind: "inline", author: "ghost", path: "src/a.ts" });
    });

    test("merged, closed, draft and conflicting", () => {
        expect(parseSnapshot("acme/app", graphql({ state: "MERGED" })).state).toBe("merged");
        expect(parseSnapshot("acme/app", graphql({ state: "CLOSED" })).state).toBe("closed");
        expect(parseSnapshot("acme/app", graphql({ isDraft: true })).draft).toBe(true);
        expect(parseSnapshot("acme/app", graphql({ mergeable: "CONFLICTING" })).mergeable).toBe("conflicting");
        expect(parseSnapshot("acme/app", graphql({ mergeable: "UNKNOWN", commits: { nodes: [] } }))).toMatchObject({ mergeable: "unknown", checks: [] });
    });

    const fails = async (out: string, err: string, code = 1) => {
        try {
            await readPullRequest(async () => ({ out, err, code }), "acme/app", 12);
        } catch (e) {
            return e as InstanceType<typeof PrReadError>;
        }
        throw new Error("expected a failure");
    };

    test("gh's failures say what kind they are", async () => {
        expect((await fails("", "To get started with GitHub CLI, please run:  gh auth login")).kind).toBe("auth");
        expect((await fails("", "HTTP 401: Bad credentials")).kind).toBe("auth");
        expect((await fails("", "HTTP 403: API rate limit exceeded for user")).kind).toBe("rate");
        expect((await fails(JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 99." }] }), "gh: Could not resolve")).kind).toBe("missing");
        expect((await fails("", "dial tcp: lookup api.github.com: no such host")).kind).toBe("other");
        expect((await fails("not json", "", 0)).kind).toBe("other");
        const secret = await fails("", `token ghp_${"z".repeat(40)} rejected: HTTP 401`);
        expect(secret.message).not.toContain("ghp_zzzz");
    });

    test("more checks or review threads than one page: the rest are read too", async () => {
        const run = (i: number, conclusion = "SUCCESS") => ({ __typename: "CheckRun", name: `job-${i}`, status: "COMPLETED", conclusion });
        const thread = (i: number) => ({ comments: { nodes: [{ id: `RC_${i}`, author: { login: "rev" }, body: `note ${i}`, createdAt: "2026-10-20T09:00:00Z", path: "a.ts" }] } });
        const first = graphql({
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: Array.from({ length: 100 }, (_, i) => run(i)) } } } }] },
            reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "T1" }, nodes: Array.from({ length: 100 }, (_, i) => thread(i)) },
        });
        const pr = (over: object) => JSON.stringify({ data: { repository: { pullRequest: over } } });
        const calls: string[][] = [];
        const gh = async (args: string[]) => {
            calls.push(args);
            const after = args.find((a) => a.startsWith("after="));
            if (!after) return { out: first, err: "", code: 0 };
            if (after === "after=C1") return { out: pr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: "C2" }, nodes: [run(100, "FAILURE")] } } } }] } }), err: "", code: 0 };
            return { out: pr({ reviewThreads: { pageInfo: { hasNextPage: false, endCursor: "T2" }, nodes: [thread(100)] } }), err: "", code: 0 };
        };
        const s = await readPullRequest(gh, "acme/app", 12);
        expect(s.checks).toHaveLength(101);
        expect(s.checks.find((c) => c.name === "job-100")?.status).toBe("failure");
        expect(s.remarks.some((r) => r.id === "RC_100")).toBe(true);
        expect(calls).toHaveLength(3);
    });

    test("pull request references", () => {
        expect(parsePrRef("12")).toEqual({ number: 12 });
        expect(parsePrRef("#12")).toEqual({ number: 12 });
        expect(parsePrRef(12)).toEqual({ number: 12 });
        expect(parsePrRef("https://github.com/acme/app/pull/12/files")).toEqual({ repo: "acme/app", number: 12 });
        for (const bad of ["", "abc", "https://evil.com/acme/app/pull/1", "https://github.com/../x/pull/1", -3, 1.5, "12; rm -rf /"]) expect(parsePrRef(bad as never)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------

/** gh that answers with one snapshot after another (a function of the call number). */
function fakeGh(answer: (n: number) => { out?: string; err?: string; code?: number }) {
    let n = 0;
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
        calls.push(args);
        const a = answer(n++);
        return { out: a.out ?? "", err: a.err ?? "", code: a.code ?? 0 };
    };
    return { gh, calls };
}

function watcher(answer: (n: number) => { out?: string; err?: string; code?: number }, first = parseSnapshot("acme/app", graphql())) {
    const wakes = new WakeQueue({ coalesceMs: 60_000 });
    const ended: string[] = [];
    const { gh, calls } = fakeGh(answer);
    const w = new PrWatch({ repo: "acme/app", number: 12, gh, wakes, snapshot: first, onEnd: (r) => ended.push(r) });
    return { w, wakes, ended, calls };
}

describe("the watch", () => {
    test("one GraphQL request per poll; news becomes one wake keyed to the watch", async () => {
        const next = graphql({ comments: { nodes: [{ id: "IC_1", author: { login: "bob" }, body: "nice", createdAt: "2026-10-20T10:00:00Z" }, { id: "IC_2", author: { login: "dave" }, body: "Can you rename this?", createdAt: "2026-10-20T10:05:00Z" }] } });
        const { w, wakes, calls } = watcher(() => ({ out: next }));
        await w.poll();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
        expect(calls[0]).toContain("number=12");
        const [wake] = wakes.pending();
        expect(wake).toMatchObject({ source: "pull-request", key: "pr:acme/app#12", label: "PR #12: new comment" });
        expect(wake!.text).toContain('dave: "Can you rename this?"');
        // The same answer again is not news.
        await w.poll();
        expect(wakes.size).toBe(1);
        w.stop();
        expect(wakes.size).toBe(0);
        wakes.dispose();
    });

    test("merging ends the watch after telling the agent", async () => {
        const { w, wakes, ended } = watcher(() => ({ out: graphql({ state: "MERGED" }) }));
        await w.poll();
        expect(wakes.pending()[0]!.label).toBe("PR #12: merged");
        expect(ended).toEqual(["it was merged"]);
        expect(w.active).toBe(false);
        wakes.dispose();
    });

    test("a rate limit only delays; it isn't counted as a failure", async () => {
        prWatchTiming.rateLimitMs = 50_000;
        const { w, wakes, ended } = watcher(() => ({ err: "HTTP 403: API rate limit exceeded", code: 1 }));
        for (let i = 0; i < FAILURE_LIMIT + 2; i++) await w.poll();
        expect(ended).toEqual([]);
        expect(wakes.size).toBe(0);
        expect(w.active).toBe(true);
        w.stop();
        wakes.dispose();
    });

    test(`${FAILURE_LIMIT} read failures in a row stop it, with one wake that says why; a success in between resets the count`, async () => {
        let ok = false;
        const { w, wakes, ended } = watcher(() => (ok ? { out: graphql() } : { err: "HTTP 502: Bad gateway", code: 1 }));
        for (let i = 0; i < FAILURE_LIMIT - 1; i++) await w.poll();
        expect(w.detail).toContain("can't reach GitHub");
        ok = true;
        await w.poll();
        ok = false;
        for (let i = 0; i < FAILURE_LIMIT - 1; i++) await w.poll();
        expect(ended).toEqual([]);
        await w.poll();
        expect(ended).toHaveLength(1);
        const [wake] = wakes.pending();
        expect(wake!.label).toBe("PR #12: stopped watching");
        expect(wake!.text).toContain("Bad gateway");
        wakes.dispose();
    });

    test("losing gh's login, or the pull request, stops at once", async () => {
        for (const err of ["HTTP 401: Bad credentials", "GraphQL: Could not resolve to a PullRequest with the number of 12."]) {
            const { w, wakes, ended } = watcher(() => ({ err, code: 1 }));
            await w.poll();
            expect(ended).toHaveLength(1);
            expect(wakes.pending()).toHaveLength(1);
            expect(w.active).toBe(false);
            wakes.dispose();
        }
    });

    test("a poll that comes back after stop() raises nothing", async () => {
        let release!: () => void;
        const wakes = new WakeQueue({ coalesceMs: 60_000 });
        const w = new PrWatch({
            repo: "acme/app",
            number: 12,
            wakes,
            snapshot: parseSnapshot("acme/app", graphql()),
            gh: () => new Promise((r) => (release = () => r({ out: graphql({ state: "MERGED" }), err: "", code: 0 }))),
        });
        const polling = w.poll();
        w.stop();
        release();
        await polling;
        expect(wakes.size).toBe(0);
        wakes.dispose();
    });

    test("polls faster while checks run (or a pass is being confirmed), slower once they're done, and waits out a nearly spent budget", async () => {
        const delays: number[] = [];
        const real = globalThis.setTimeout;
        (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
            delays.push(ms);
            return real(() => {}, 0);
        };
        try {
            const pending = parseSnapshot("acme/app", graphql());
            const done = graphql({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] } });
            const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
            const answers = [done, done, JSON.stringify({ ...JSON.parse(done), data: { ...JSON.parse(done).data, rateLimit: { remaining: 10, resetAt } } })];
            // Its own timer (the "checks passed" wake) is told apart by its length.
            const wakes = new WakeQueue({ coalesceMs: 12_345 });
            const { gh } = fakeGh((n) => ({ out: answers[n] }));
            const w = new PrWatch({ repo: "acme/app", number: 12, gh, wakes, snapshot: pending });
            w.start();
            await w.poll();
            await w.poll();
            await w.poll();
            w.stop();
            wakes.dispose();
            const polls = delays.filter((d) => d !== 12_345);
            // Pending; green once (checking again soon to be sure); green twice (told; slower now); budget nearly spent.
            expect(polls.slice(0, 3)).toEqual([prWatchTiming.fastMs, prWatchTiming.fastMs, prWatchTiming.slowMs]);
            expect(polls[3]).toBeGreaterThan(29 * 60_000);
        } finally {
            (globalThis as any).setTimeout = real;
        }
    });

    test("a new watch on a nearly spent budget waits for the reset before its first poll", () => {
        const delays: number[] = [];
        const real = globalThis.setTimeout;
        (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
            delays.push(ms);
            return real(() => {}, 0);
        };
        try {
            const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
            const low = JSON.parse(graphql());
            low.data.rateLimit = { remaining: 10, resetAt };
            const wakes = new WakeQueue({ coalesceMs: 12_345 });
            const w = new PrWatch({ repo: "acme/app", number: 12, gh: async () => ({ out: "", err: "", code: 1 }), wakes, snapshot: parseSnapshot("acme/app", JSON.stringify(low)) });
            w.start();
            w.stop();
            wakes.dispose();
            expect(delays.filter((d) => d !== 12_345)[0]).toBeGreaterThan(29 * 60_000);
        } finally {
            (globalThis as any).setTimeout = real;
        }
    });

    test("a poll costs little: parsing and comparing a large pull request takes well under a few milliseconds", () => {
        const nodes = Array.from({ length: 100 }, (_, i) => ({ __typename: "CheckRun", name: `job-${i}`, status: "COMPLETED", conclusion: i % 7 ? "SUCCESS" : "FAILURE" }));
        const comments = Array.from({ length: 50 }, (_, i) => ({ id: `C${i}`, author: { login: `u${i}` }, body: "x".repeat(2000), createdAt: "2026-10-20T10:00:00Z" }));
        const big = graphql({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] }, comments: { nodes: comments } });
        let st = initialState(parseSnapshot("acme/app", big));
        const runs = 200;
        const t0 = performance.now();
        for (let i = 0; i < runs; i++) st = evaluate(st, parseSnapshot("acme/app", big)).next;
        const perPoll = (performance.now() - t0) / runs;
        console.log(`pr-watch: parse + compare of a 100-check, 80-remark PR: ${perPoll.toFixed(3)} ms per poll`);
        expect(perPoll).toBeLessThan(5);
    });
});
