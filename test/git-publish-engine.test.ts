import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import { publishFixtures } from "./helpers/git-publish";
const iso = isolate();
const fixture = publishFixtures(iso.home);
const { repo, git, calls } = fixture;
const { Engine } = await import("../src/server/engine");
setDefaultTimeout(180_000);
afterAll(() => { fixture.cleanup(); iso.cleanup(); });

async function session(github = false) {
    const project = repo(github);
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} }; engine.clients.add(client);
    const snap = await engine.handle(client, "session.create", { cwd: project.cwd });
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    await rt.ready;
    await engine.handle(client, "projects.trust", { path: project.cwd, trust: true });
    return { ...project, engine, client, id, rt };
}

test("publish RPC validation, trust, busy and protected confirmation are enforced by the engine", async () => {
    const { engine, client, id, rt, cwd, remote, state } = await session();
    try {
        const call = (params: unknown) => engine.handle(client, "session.gitPublish", { id, ...(params as object) });
        for (const params of [{}, { action: "push", fingerprint: "bad" }, { action: "force", fingerprint: "a".repeat(64) }, { action: "push", fingerprint: "a".repeat(64), confirmProtected: "yes" }, { action: "pr", fingerprint: "a".repeat(64), base: ["main"] }]) await expect(call(params)).rejects.toMatchObject({ code: "invalid" });
        git(cwd, "checkout", "main"); git(cwd, "commit", "--allow-empty", "-qm", "main update");
        const info = await engine.handle(client, "session.gitPublishInfo", { id });
        await expect(call({ action: "push", fingerprint: info.fingerprint })).rejects.toMatchObject({ code: "protected_branch" });
        rt.busy = true;
        await expect(call({ action: "push", fingerprint: info.fingerprint, confirmProtected: true })).rejects.toMatchObject({ code: "busy" });
        rt.busy = false;
        rt.ws.trusted = false;
        await expect(call({ action: "push", fingerprint: info.fingerprint, confirmProtected: true })).rejects.toMatchObject({ code: "needs_trust" });
        await expect(engine.handle(client, "session.gitPublishInfo", { id })).rejects.toMatchObject({ code: "needs_trust" });
        expect(calls(state, ".git-calls").filter((args) => args.includes("push"))).toHaveLength(0);
        rt.ws.trusted = true;
        await call({ action: "push", fingerprint: info.fingerprint, confirmProtected: true });
        expect(git(remote, "rev-parse", "main")).toBe(git(cwd, "rev-parse", "HEAD"));
    } finally { await engine.stop(); }
});

test("engine pushes new upstream, exposes rejection and caches PR state after fake gh creation", async () => {
    const { engine, client, id, cwd, remote, state } = await session(true);
    try {
        const info = await engine.handle(client, "session.gitPublishInfo", { id });
        const result = await engine.handle(client, "session.gitPublish", { id, action: "pr", fingerprint: info.fingerprint, base: "main", title: "Engine PR", draft: true });
        expect(result.pr).toMatchObject({ number: 7, state: "draft" });
        expect(git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
        const before = calls(state).length;
        expect(await engine.handle(client, "session.gitPrState", { id })).toEqual(result);
        expect(await engine.handle(client, "session.gitPrState", { id })).toEqual(result);
        expect(calls(state)).toHaveLength(before);
        // Existing PR must still receive new commits on another explicit confirmation.
        git(cwd, "commit", "--allow-empty", "-qm", "update existing PR");
        const next = await engine.handle(client, "session.gitPublishInfo", { id });
        await engine.handle(client, "session.gitPublish", { id, action: "pr", fingerprint: next.fingerprint, base: "main", title: "Existing" });
        expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
        expect(calls(state).filter((args) => args[1] === "create")).toHaveLength(1);
        git(cwd, "reset", "--hard", "HEAD~1"); git(cwd, "commit", "--allow-empty", "-qm", "diverged");
        const diverged = await engine.handle(client, "session.gitPublishInfo", { id });
        await expect(engine.handle(client, "session.gitPublish", { id, action: "push", fingerprint: diverged.fingerprint })).rejects.toThrow("No force push was attempted");
    } finally { await engine.stop(); }
});

test("engine unauthenticated PR request cannot push; missing upstream remote is actionable", async () => {
    const { engine, client, id, cwd, state } = await session(true);
    try {
        process.env.FAKE_PUBLISH_MODE = "unauthenticated";
        const info = await engine.handle(client, "session.gitPublishInfo", { id });
        expect(info.gh).toBe(false);
        await expect(engine.handle(client, "session.gitPublish", { id, action: "pr", fingerprint: info.fingerprint, base: "main", title: "Title" })).rejects.toThrow("not authenticated");
        expect(calls(state, ".git-calls").filter((args) => args.includes("push"))).toHaveLength(0);
        git(cwd, "remote", "remove", "origin");
        await expect(engine.handle(client, "session.gitPublishInfo", { id })).rejects.toThrow("unambiguous");
    } finally { await engine.stop(); }
});
