// Registered values in text that's cut or cleaned up before it's shown (#87): CLI imports, attachment names, and
// the names Git changes show (paths, rename sources, branches), which the GUI still has to act on.
// Fake values only, in an isolated home.
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { claudeSession, codexSession } from "./helpers/cli-stores";
import type { GitChangesInfo, SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { findCliSession, readCliTranscript } = await import("../src/server/cli-sessions");
const { sanitizeName } = await import("../src/server/attachments");
const { trustFolder } = await import("../src/config/trust");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { Engine } = await import("../src/server/engine");
afterAll(() => iso.cleanup());

/** A made-up value no ordinary text contains. */
function fake(seed: number, length: number): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let x = seed, s = "";
    while (s.length < length) {
        x = (x * 1103515245 + 12345) % 2147483648;
        s += chars[(x >>> 16) % chars.length];
    }
    return s;
}
/** Every 6-character piece of `value` found in `text`: none may be. */
const leaks = (text: string, value: string) => [...Array(Math.max(0, value.length - 5)).keys()].map((i) => value.slice(i, i + 6)).filter((w) => text.includes(w));
const registered: string[] = [];
const secret = (value: string, label = "NAME_FAKE") => (registerSecret(value, label), registered.push(value), value);
afterEach(() => { for (const v of registered.splice(0)) unregisterSecret(v); });

test("imported Claude Code and Codex tool calls redact a registered value before cutting it", () => {
    const cwd = realpathSync(tempDir("secret-import-"));
    const long = secret(fake(1, 600), "IMPORT_LONG");
    const mid = secret(fake(2, 32), "IMPORT_MID");
    const codexMid = secret(fake(3, 32), "IMPORT_CODEX");
    const codexCmd = secret(fake(4, 32), "IMPORT_CMD");
    // Spaces at its ends: trimming before redacting would leave the rest.
    const patched = secret(`  ${fake(14, 24)}  `, "IMPORT_PATCH");
    // Crossing the 500-character cut of a tool input, and the 117-character cut of a command title.
    const claude = claudeSession(process.env.CLAUDE_CONFIG_DIR!, { cwd, turns: [{ prompt: "inspect", reply: "done", tools: [["Grep", { pattern: long }], ["Bash", { command: `echo ${"y".repeat(100)}${mid}` }]] }] });
    const codex = codexSession(process.env.CODEX_HOME!, { cwd, turns: [{ prompt: "inspect", reply: "done", tools: [["shell", { command: ["bash", "-lc", `echo ${"y".repeat(100)}${codexMid}`] }], ["exec_command", { cmd: `printf ${"z".repeat(100)}${codexCmd}` }], ["apply_patch", { input: `*** Begin Patch\n*** Update File: ${patched}\n@@\n-a\n+b\n*** End Patch` }]] }] });
    const shown = (source: "claude-code" | "codex", id: string) => JSON.stringify(readCliTranscript(findCliSession(source, cwd, id)!));
    const fromClaude = shown("claude-code", claude.id);
    const fromCodex = shown("codex", codex.id);
    expect({ long: leaks(fromClaude, long), mid: leaks(fromClaude, mid), codex: leaks(fromCodex, codexMid), cmd: leaks(fromCodex, codexCmd), patch: leaks(fromCodex, patched.trim()) }).toEqual({ long: [], mid: [], codex: [], cmd: [], patch: [] });
    expect(fromClaude).toContain("[REDACTED IMPORT_LONG]");
    // The title cut may fall in the marker itself, which hides nothing.
    expect(fromCodex).toContain("[REDACTED");
});

test("an attachment's name is redacted before it's split, cleaned up or cut", () => {
    const straddling = secret(fake(5, 32), "ATTACH_CUT");
    const spaced = secret(`${fake(6, 8)} "${fake(7, 8)} ${fake(8, 10)}`, "ATTACH_SPACED");
    const slashed = secret(`${fake(9, 10)}/${fake(10, 12)}`, "ATTACH_SLASH");
    const names = [sanitizeName("x".repeat(100) + straddling + ".txt"), sanitizeName(`report ${spaced}.txt`), sanitizeName(`notes-${slashed}.md`)];
    const all = names.join("\n");
    expect({ cut: leaks(all, straddling), spaced: leaks(all, spaced), slashed: leaks(all, slashed) }).toEqual({ cut: [], spaced: [], slashed: [] });
    // A value cleanup puts back together is still caught.
    const joined = secret(fake(11, 16), "ATTACH_JOINED");
    expect(leaks(sanitizeName(`${joined.slice(0, 8)}\u200b${joined.slice(8)}.txt`), joined)).toEqual([]);
    // Ordinary names are unchanged.
    expect(sanitizeName("dir/notes v2.md")).toBe("notes v2.md");
});

function repo(cwd: string) {
    const git = (...args: string[]) => {
        const r = Bun.spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
        if (r.exitCode) throw new Error(r.stderr.toString());
        return r.stdout.toString();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Harness Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", join(cwd, ".git", "hooks"));
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
    return git;
}

test("Git changes show registered values in names redacted, and the GUI acts on the real files and branches by handle", async () => {
    const bin = tempDir("secret-git-bin-");
    writeFileSync(join(bin, "code"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "code"), 0o755);
    const launched: string[][] = [];
    const engine = new Engine({ editorEnv: () => ({ platform: "darwin", path: bin, appDirs: [] }), launchEditor: async (argv) => void launched.push(argv) });
    const c = { subs: new Set<string>(), send() {} };
    engine.clients.add(c);
    const call = (method: string, params: unknown): Promise<any> => engine.handle(c, method as never, params);
    const cwd = realpathSync(tempDir("secret-git-"));
    // Two values with one label: their names show the same; a third file is literally named like that.
    const A = secret(fake(12, 24));
    const B = secret(fake(13, 24));
    writeFileSync(join(cwd, "seed.txt"), "seed\n");
    writeFileSync(join(cwd, `old-${A}.md`), "moved\n");
    const git = repo(cwd);
    trustFolder(cwd);
    git("branch", `base-${B}`);
    git("checkout", "-q", "-b", `feature-${A}`);
    writeFileSync(join(cwd, `${A}.txt`), "content of A\n");
    writeFileSync(join(cwd, `${B}.txt`), "content of B\n");
    const MARKED = "[REDACTED NAME_FAKE].txt";
    writeFileSync(join(cwd, MARKED), "a file literally named so\n");
    git("mv", `old-${A}.md`, "moved.md");
    const id = ((await call("session.create", { cwd })) as SessionSnapshot).state.id;
    const changes = (p: Record<string, unknown> = {}): Promise<GitChangesInfo & { files: (GitChangesInfo["files"][number] & { pathToken?: string })[] }> => call("session.gitChanges", { id, scope: "uncommitted", ...p });
    const clean = (o: unknown) => { const t = JSON.stringify(o); return { A: leaks(t, A), B: leaks(t, B) }; };
    try {
        const list = await changes();
        expect(clean(list)).toEqual({ A: [], B: [] });
        const marked = list.files.filter((f) => f.path === MARKED);
        expect(marked).toHaveLength(3);
        const handled = marked.filter((f) => f.pathToken);
        expect(new Set(handled.map((f) => f.pathToken)).size).toBe(2);
        const literal = marked.find((f) => !f.pathToken)!;
        expect(list.files.find((f) => f.path === "moved.md")?.from).toBe("old-[REDACTED NAME_FAKE].md");
        // Checked without asymmetric matchers: toMatchObject can leave one in the object it checked.
        const head = { ...(list.head as { branch?: string; branchToken?: string }) };
        expect(head.branch).toBe("feature-[REDACTED NAME_FAKE]");
        expect(typeof head.branchToken).toBe("string");
        // The same handle for the same file each time the list is read.
        expect((await changes()).files.map((f) => f.pathToken)).toEqual(list.files.map((f) => f.pathToken));
        // One file at a time (as a deferred one loads): by handle, or by its literal name.
        const one = async (p: Record<string, unknown>) => { const r = await changes(p); expect(clean(r)).toEqual({ A: [], B: [] }); return JSON.stringify(r.files); };
        const byContent = new Map<string, string>();
        for (const f of handled) byContent.set((await one({ pathToken: f.pathToken })).includes("content of A") ? "A" : "B", f.pathToken!);
        expect([...byContent.keys()].sort()).toEqual(["A", "B"]);
        expect(await one({ pathToken: byContent.get("B") })).toContain("content of B");
        expect(await one({ path: literal.path })).toContain("a file literally named so");
        // Branches: listed redacted with a handle, compared against by handle.
        const branch = (await changes({ scope: "branch" })) as GitChangesInfo & { baseTokens?: (string | null)[] };
        expect(clean(branch)).toEqual({ A: [], B: [] });
        const at = branch.bases.indexOf("base-[REDACTED NAME_FAKE]");
        expect(at).toBeGreaterThanOrEqual(0);
        const baseToken = branch.baseTokens?.[at];
        expect(typeof baseToken).toBe("string");
        const against = (await changes({ scope: "branch", baseToken })) as GitChangesInfo & { base?: { ref: string; refToken?: string } };
        expect(clean(against)).toEqual({ A: [], B: [] });
        expect(against.base).toMatchObject({ ref: "base-[REDACTED NAME_FAKE]", refToken: baseToken });
        // Handles this session didn't hand out, or of another kind, or another session's, are refused.
        const other = ((await call("session.create", { cwd })) as SessionSnapshot).state.id;
        const theirs = ((await call("session.gitChanges", { id: other, scope: "uncommitted" })) as any).files.find((f: any) => f.pathToken)?.pathToken;
        for (const p of [{ pathToken: "git:never-issued" }, { pathToken: theirs }, { scope: "branch", baseToken: byContent.get("A") }, { pathToken: baseToken }]) {
            await expect(changes(p)).rejects.toMatchObject({ code: "invalid" });
        }
        // Opened by handle: the server opens the real file; the client never gets its name.
        const opened = await call("fs.open", { sessionId: id, gitToken: byContent.get("B"), editor: "vscode" });
        expect(clean(opened)).toEqual({ A: [], B: [] });
        expect(launched.at(-1)?.some((a) => a.includes(join(cwd, `${B}.txt`)))).toBe(true);
        await expect(call("fs.open", { sessionId: id, gitToken: "git:never-issued", editor: "vscode" })).rejects.toMatchObject({ code: "invalid" });
        // A file of another listed worktree: Finder reveals it by handle, as the window reveals one it can name;
        // an editor still opens only the session's folders.
        const wtDir = join(realpathSync(tempDir("secret-git-wt-")), "wt");
        git("worktree", "add", "-q", "-b", "wt-side", wtDir);
        writeFileSync(join(wtDir, `${A}-there.txt`), "in the other worktree\n");
        const there = (await call("session.gitChanges", { id, scope: "uncommitted", worktree: wtDir })) as GitChangesInfo & { files: { path: string; pathToken?: string }[] };
        expect(clean(there)).toEqual({ A: [], B: [] });
        const thereToken = there.files.find((f) => f.pathToken)?.pathToken;
        expect(typeof thereToken).toBe("string");
        await call("fs.open", { sessionId: id, gitToken: thereToken, editor: "finder" });
        expect(launched.at(-1)?.some((a) => a.includes(join(wtDir, `${A}-there.txt`)))).toBe(true);
        const confined = await call("fs.open", { sessionId: id, gitToken: thereToken, editor: "vscode" }).then(() => undefined, (err: { code?: string; message: string }) => err);
        expect(confined).toMatchObject({ code: "outside" });
        expect(leaks((confined as Error).message, A)).toEqual([]);
        // Its handle is the other worktree's: it names nothing in the session's own folder.
        await expect(changes({ pathToken: thereToken })).rejects.toMatchObject({ code: "invalid" });
        // Errors don't show what they name.
        const e = await call("session.gitCommit", { id, paths: [`gone-${A}.txt`], message: "x" }).then(() => undefined, (err: Error) => err);
        expect(e).toBeInstanceOf(Error);
        expect(leaks((e as Error).message, A)).toEqual([]);
        await expect(call("session.gitCommitMessage", { id, paths: [], pathTokens: ["git:never-issued"] })).rejects.toMatchObject({ code: "invalid" });
        // Committed by handle, with the branch checked by handle: exactly A, the literal file and the rename.
        await call("session.gitCommit", { id, paths: [literal.path, "moved.md"], pathTokens: [byContent.get("A")], message: "test: by handle", expectedHead: { detached: false, branchToken: head.branchToken } });
        const committed = git("show", "--name-only", "--no-renames", "--format=", "HEAD").trim().split("\n").sort();
        expect(committed).toEqual([`${A}.txt`, MARKED, "moved.md", `old-${A}.md`].sort());
        expect(git("status", "--porcelain")).toContain(`${B}.txt`);
    } finally {
        await engine.stop();
    }
});

test("an attached file is redacted again when its message is sent: a value registered while it waited in the queue isn't sent", async () => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const cwd = realpathSync(tempDir("secret-queued-"));
    const session = Session.create(cwd, { persist: false });
    const requests: string[] = [];
    const agent = new Agent({
        session, model: { provider: "test", id: "test" } as any,
        client: { stream: async (req: any) => (requests.push(JSON.stringify(req.messages)), { role: "assistant", provider: "test", model: "test", stopReason: "end_turn", content: [{ type: "text", text: "ok" }] }) } as any,
        settings: () => ({}), checker: new PermissionChecker(() => ({}), cwd), tools: [],
        mode: { get: () => "default", set() {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as any,
        host: { emit() {}, ui: {} } as any,
    });
    // As checkFiles left it when the message was queued: then nothing was registered.
    const late = fake(15, 24);
    const file = { type: "file" as const, kind: "text" as const, name: `notes-${late}.txt`, size: 39, lines: 1, text: `deploy token ${late}\n` };
    secret(late, "LATE_FAKE");
    expect(await agent.run([{ type: "text", text: "use the notes" }, file], { signal: new AbortController().signal })).toBe("done");
    expect(requests.length).toBeGreaterThan(0);
    expect({ sent: leaks(requests.join("\n"), late), kept: leaks(JSON.stringify(session.messages), late) }).toEqual({ sent: [], kept: [] });
});

test("a file the list no longer holds (past its 300) is fetched by its handle as the Review pane asks, never by the handle as a name", async () => {
    const { pickOf, pickParams } = await import("../gui/src/lib/review-pick");
    const engine = new Engine({});
    const c = { subs: new Set<string>(), send() {} };
    engine.clients.add(c);
    const call = (method: string, params: unknown): Promise<any> => engine.handle(c, method as never, params);
    const cwd = realpathSync(tempDir("secret-unlisted-"));
    writeFileSync(join(cwd, "seed.txt"), "seed\n");
    repo(cwd);
    trustFolder(cwd);
    const A = secret(fake(16, 24));
    // Sorted after what's added below, so that pushes it out of the list.
    writeFileSync(join(cwd, `zz-${A}.txt`), "the one picked\n");
    const id = ((await call("session.create", { cwd })) as SessionSnapshot).state.id;
    try {
        const listed = (await call("session.gitChanges", { id, scope: "uncommitted" })) as GitChangesInfo;
        const target = listed.files.find((f) => f.pathToken)!;
        const pick = pickOf(target);
        for (let i = 0; i < 301; i++) writeFileSync(join(cwd, `aaa-${String(i).padStart(4, "0")}.txt`), "x\n");
        const later = (await call("session.gitChanges", { id, scope: "uncommitted" })) as GitChangesInfo;
        expect({ listed: later.files.some((f) => f.pathToken === pick.token), more: later.more > 0 }).toEqual({ listed: false, more: true });
        const asked = (await call("session.gitChanges", { id, scope: "uncommitted", ...pickParams(pick) })) as GitChangesInfo;
        expect(asked.files.map((f) => f.pathToken)).toEqual([pick.token]);
        expect(JSON.stringify(asked.files)).toContain("the one picked");
        expect(leaks(JSON.stringify(asked), A)).toEqual([]);
        // The handle sent as a file's name (as the pane asked before) names no file.
        expect(((await call("session.gitChanges", { id, scope: "uncommitted", path: pick.token })) as GitChangesInfo).files).toEqual([]);
    } finally {
        await engine.stop();
    }
});
