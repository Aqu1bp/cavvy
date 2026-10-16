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
    const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/fixtures/composer-unload.ts`], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
});
