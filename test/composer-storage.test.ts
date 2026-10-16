import { expect, test } from "bun:test";
import { COMPOSER_MAX_AGE, COMPOSER_MAX_CHARS, COMPOSER_STORAGE_KEY, createComposerStorage, HISTORY_LIMIT } from "../gui/src/lib/drafts";

function storage() {
    const data = new Map<string, string>();
    let writes = 0;
    return { data, get writes() { return writes; }, getItem: (k: string) => data.get(k) ?? null,
        setItem(k: string, v: string) { writes++; data.set(k, v); }, removeItem(k: string) { writes++; data.delete(k); } };
}

test("draft edits debounce, flush synchronously, and restore per session and Home", async () => {
    const disk = storage();
    const state = createComposerStorage(() => disk);
    state.setDraft("a", "first");
    state.setDraft("a", "latest");
    state.setDraft("home", "Home work");
    expect(disk.writes).toBe(0);
    await Bun.sleep(300);
    expect(disk.writes).toBe(1);
    expect(createComposerStorage(() => disk).draft("a")).toBe("latest");
    state.setDraft("b", "second session");
    state.flush();
    const restored = createComposerStorage(() => disk);
    expect(restored.draft("home")).toBe("Home work");
    expect(restored.draft("b")).toBe("second session");
    expect(restored.draft("missing")).toBe("");
    state.setDraft("a", "");
    state.flush();
    expect(createComposerStorage(() => disk).draft("a")).toBe("");
});

test("history is session-local, deduplicated, bounded and persisted; deletion removes both", () => {
    const disk = storage();
    const state = createComposerStorage(() => disk);
    for (let i = 0; i < 120; i++) state.remember("a", `prompt ${i}`);
    state.remember("a", "prompt 30");
    state.remember("b", "only B");
    state.setDraft("a", "unsent");
    state.flush();
    const restored = createComposerStorage(() => disk);
    expect(restored.history("a")).toHaveLength(HISTORY_LIMIT);
    expect(restored.history("a").at(-1)).toBe("prompt 30");
    expect(restored.history("a").filter((t) => t === "prompt 30")).toHaveLength(1);
    expect(restored.history("b")).toEqual(["only B"]);
    state.delete("a");
    expect(createComposerStorage(() => disk).draft("a")).toBe("");
    expect(createComposerStorage(() => disk).history("a")).toEqual([]);
});

test("corrupt, blocked and quota-exceeded storage preserve in-memory operation", () => {
    const disk = storage();
    for (const raw of ["broken", "null", '{}', '[["a",{}]]', '[["a",{"draft":1,"history":[],"updated":0}]]']) {
        disk.data.set(COMPOSER_STORAGE_KEY, raw);
        expect(createComposerStorage(() => disk).draft("a")).toBe("");
    }
    for (const backend of [() => { throw new Error("blocked"); }, () => ({ getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } })]) {
        const state = createComposerStorage(backend);
        state.setDraft("a", "still here");
        state.remember("a", "prompt");
        expect(() => state.flush()).not.toThrow();
        expect(state.draft("a")).toBe("still here");
        expect(state.history("a")).toEqual(["prompt"]);
        expect(() => state.delete("a")).not.toThrow();
    }
});

test("expiry and total persistence budget evict old entries without truncating text", () => {
    const disk = storage();
    let now = 1000;
    const state = createComposerStorage(() => disk, () => now);
    state.setDraft("old", "old draft");
    state.remember("old", "old prompt");
    now += COMPOSER_MAX_AGE + 1;
    state.setDraft("new", "new draft");
    state.flush();
    const restored = createComposerStorage(() => disk, () => now);
    expect(restored.draft("old")).toBe("");
    expect(restored.history("old")).toEqual([]);
    const large = "x".repeat(COMPOSER_MAX_CHARS / 2);
    state.setDraft("large1", large);
    now++;
    state.setDraft("large2", large);
    state.flush();
    expect(disk.data.get(COMPOSER_STORAGE_KEY)!.length).toBeLessThanOrEqual(COMPOSER_MAX_CHARS);
    expect(createComposerStorage(() => disk, () => now).draft("large2")).toBe(large);
    expect(state.draft("large1")).toBe(large); // Eviction only affects persistence.
});

test("only the explicit text schema is restored and serialized", () => {
    const disk = storage();
    disk.data.set(COMPOSER_STORAGE_KEY, JSON.stringify([["a", { draft: "typed", history: ["prompt", { secret: "hidden" }], updated: Date.now(), attachments: [{ data: "SECRET" }] }]]));
    const state = createComposerStorage(() => disk);
    state.flush();
    const saved = disk.data.get(COMPOSER_STORAGE_KEY)!;
    expect(saved).not.toContain("SECRET");
    expect(saved).not.toContain("hidden");
    expect(saved).not.toContain("attachments");
    expect(state.draft("a")).toBe("typed");
});

test("pagehide and beforeunload flush pending text before the debounce", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", `${import.meta.dir}/fixtures/composer-unload.ts`], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
});

const credentialText = [
    "/login openai short-value", "  /LOGIN anthropic pasted-value", "/login", "/login\nprovider key",
    `sk-${"a".repeat(48)}`, `sk-ant-api03-${"a".repeat(25)}`, `sk-or-v1-${"a".repeat(32)}`,
    `sk-proj-${"a".repeat(25)}`, `AIza${"a".repeat(35)}`, `gsk_${"a".repeat(40)}`,
    `xai-${"a".repeat(40)}`, `tvly-${"a".repeat(25)}`, `ghp_${"a".repeat(36)}`,
    `github_pat_${"a".repeat(50)}`, `AKIA${"A".repeat(16)}`, `xoxb-${"a".repeat(20)}`, `ya29.${"a".repeat(25)}`,
];

test("login commands and known credential shapes remain in memory, never in drafts or history on disk", async () => {
    for (const text of credentialText) {
        const disk = storage();
        let now = Date.now();
        const state = createComposerStorage(() => disk, () => now);
        state.setDraft("a", "previous ordinary draft");
        state.remember("a", "ordinary history");
        state.flush();
        state.setDraft("a", text);
        state.remember("a", text);
        expect(state.draft("a")).toBe(text);
        expect(state.history("a")).toEqual(["ordinary history", text]);
        // Sensitive input clears the persisted draft immediately, before the debounce.
        expect(disk.data.get(COMPOSER_STORAGE_KEY)).not.toContain(text);
        const reloaded = createComposerStorage(() => disk);
        expect(reloaded.draft("a")).toBe("");
        expect(reloaded.history("a")).toEqual(["ordinary history"]);
        await Bun.sleep(0);
        state.flush(); // The unload path must not serialize the in-memory secret either.
        expect(disk.data.get(COMPOSER_STORAGE_KEY)).not.toContain(text);
        expect(state.draft("a")).toBe(text);
        now++; // A new edit after the clear, rather than a same-timestamp tie.
        state.setDraft("a", "safe replacement");
        state.flush();
        expect(createComposerStorage(() => disk).draft("a")).toBe("safe replacement");
    }
    const disk = storage();
    const state = createComposerStorage(() => disk);
    state.setDraft("home", "/login openai sk-example");
    await Bun.sleep(300);
    expect(createComposerStorage(() => disk).draft("home")).toBe("");
    expect(disk.data.get(COMPOSER_STORAGE_KEY)).not.toContain("sk-example");
});

test("legacy credentials are purged immediately on load and refresh, including mixed safe history", () => {
    const disk = storage();
    const dirtyValue = JSON.stringify([["a", { draft: credentialText[0], history: ["safe prompt", ...credentialText], updated: Date.now() }]]);
    disk.data.set(COMPOSER_STORAGE_KEY, dirtyValue);
    const state = createComposerStorage(() => disk);
    expect(state.draft("a")).toBe("");
    expect(state.history("a")).toEqual(["safe prompt"]);
    for (const text of credentialText) expect(disk.data.get(COMPOSER_STORAGE_KEY)).not.toContain(text);
    disk.data.set(COMPOSER_STORAGE_KEY, dirtyValue);
    state.refresh(); // Same path as an old tab's storage event.
    for (const text of credentialText) expect(disk.data.get(COMPOSER_STORAGE_KEY)).not.toContain(text);
});

test("several tabs merge only dirty session keys without losing unrelated drafts and histories", () => {
    const disk = storage();
    let now = 100;
    const tabs = Array.from({ length: 3 }, () => createComposerStorage(() => disk, () => now));
    for (const [i, tab] of tabs.entries()) {
        now += 10;
        tab.setDraft(`session-${i}`, `draft ${i}`);
        tab.remember(`session-${i}`, `prompt ${i}`);
    }
    for (const tab of tabs.toReversed()) tab.flush();
    const restored = createComposerStorage(() => disk, () => now);
    for (let i = 0; i < tabs.length; i++) {
        expect(restored.draft(`session-${i}`)).toBe(`draft ${i}`);
        expect(restored.history(`session-${i}`)).toEqual([`prompt ${i}`]);
    }
    const writes = disk.writes;
    tabs[0]!.flush();
    tabs[0]!.flush();
    expect(disk.writes).toBe(writes); // Clean unloads don't publish stale maps or emit write loops.
});

for (const action of ["send", "delete"] as const) {
    test(`an older tab's pending edit or clean unload cannot resurrect a draft after ${action}`, () => {
        const disk = storage();
        let now = 100;
        const first = createComposerStorage(() => disk, () => now);
        first.setDraft("a", "original");
        first.remember("a", "previous prompt");
        first.flush();
        const clean = createComposerStorage(() => disk, () => now);
        const pending = createComposerStorage(() => disk, () => now);
        now = 200;
        pending.setDraft("a", "older pending edit");
        now = 300;
        if (action === "send") first.setDraft("a", ""); else first.delete("a");
        first.flush();
        // Delay notifications to model a background tab unloading before processing them.
        pending.flush();
        clean.flush();
        const restored = createComposerStorage(() => disk, () => now);
        expect(restored.draft("a")).toBe("");
        expect(restored.history("a")).toEqual(action === "send" ? ["previous prompt"] : []);
        expect(pending.draft("a")).toBe("");
    });
}

test("same-timestamp clear beats a pending edit; genuinely newer typing can create a draft again", () => {
    const disk = storage();
    let now = 100;
    const first = createComposerStorage(() => disk, () => now);
    first.setDraft("a", "original");
    first.flush();
    const other = createComposerStorage(() => disk, () => now);
    now = 200;
    first.setDraft("a", "pending");
    other.setDraft("a", "");
    other.flush();
    first.flush();
    expect(createComposerStorage(() => disk, () => now).draft("a")).toBe("");
    now = 300;
    first.setDraft("a", "new work after send");
    first.flush();
    expect(createComposerStorage(() => disk, () => now).draft("a")).toBe("new work after send");
});

test("refresh imports clean keys, preserves dirty keys and memory-only secrets, then timestamps resolve conflicts", () => {
    const disk = storage();
    let now = 100;
    const first = createComposerStorage(() => disk, () => now);
    first.setDraft("a", "initial");
    first.flush();
    const other = createComposerStorage(() => disk, () => now);
    now = 200;
    first.setDraft("a", "pending here");
    first.setDraft("private", "/login openai private-value");
    first.setDraft("a", "pending again");
    now = 300;
    other.setDraft("a", "newer elsewhere");
    other.setDraft("b", "unrelated");
    other.remember("b", "remote history");
    other.flush();
    first.refresh();
    expect(first.draft("a")).toBe("pending again");
    expect(first.draft("b")).toBe("unrelated");
    expect(first.history("b")).toEqual(["remote history"]);
    expect(first.draft("private")).toBe("/login openai private-value");
    first.flush();
    expect(first.draft("a")).toBe("newer elsewhere");
    expect(disk.data.get(COMPOSER_STORAGE_KEY)).not.toContain("private-value");
});

test("several edits in one millisecond cannot outrank another tab's later deletion", () => {
    const disk = storage();
    let now = 1000;
    const first = createComposerStorage(() => disk, () => now);
    first.setDraft("a", "saved");
    first.flush();
    const other = createComposerStorage(() => disk, () => now);
    first.setDraft("a", "pending 1");
    first.setDraft("a", "pending 2");
    first.setDraft("a", "pending 3");
    now = 1001;
    other.delete("a");
    first.flush();
    expect(createComposerStorage(() => disk, () => now).draft("a")).toBe("");
});

test("same-timestamp deletion also beats a pending history-only update", () => {
    const disk = storage();
    let now = 1000;
    const first = createComposerStorage(() => disk, () => now);
    first.remember("a", "old prompt");
    first.flush();
    const other = createComposerStorage(() => disk, () => now);
    now = 2000;
    first.remember("a", "pending prompt");
    other.delete("a");
    first.flush();
    expect(createComposerStorage(() => disk, () => now).history("a")).toEqual([]);
    now = 3000;
    first.remember("a", "new prompt after Undo");
    first.flush();
    expect(createComposerStorage(() => disk, () => now).history("a")).toEqual(["new prompt after Undo"]);
});
