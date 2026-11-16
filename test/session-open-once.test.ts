// Opening a session reads its file once: the runtime builds its segments from the lines Session.load just parsed
// (readSegments with the session), and what it builds is what reading the file again would.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
await import("../src/server/server");
const { Session } = await import("../src/agent/session");
const { readSegments } = await import("../src/server/history");
afterAll(() => iso.cleanup());

const prompt = (text: string) => ({ t: "msg", m: { role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" } } });
const reply = (text: string) => ({ t: "msg", m: { role: "assistant", provider: "mock", model: "m", stopReason: "end_turn", content: [{ type: "text", text }] } });

function sessionFile(lines: object[]): string {
    const dir = join(iso.home, "open-once", String(Math.random()).slice(2));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s.jsonl");
    const meta = { t: "meta", id: "s", cwd: dir, createdAt: 1, version: "test" };
    writeFileSync(file, [meta, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n{\"t\":\"msg\",\"m\":");
    return file;
}

test("the segments built from the lines just loaded are the ones the file holds", () => {
    const file = sessionFile([
        { t: "import", source: "claude-code", id: "x", startedAt: 5, omitted: 2 },
        prompt("one"), reply("one done"),
        { t: "notice", index: 1, level: "error", text: "limit", at: 3 },
        prompt("two"), reply("two done"),
        { t: "rewind", count: 2 },
        prompt("two again"), reply("two again done"),
        { t: "compact", summary: "so far", idle: true },
        prompt("three"), reply("three done"), prompt("four"),
        { t: "withdraw", index: 2 },
        { t: "notice", index: 1, level: "info", text: "note", at: 4 },
        { t: "compact", summary: "later", kept: true },
        prompt("five"), reply("five done"),
        { t: "imagesRefused", model: "mock:m", indexes: [0] },
    ]);
    const fresh = readSegments(file);
    expect(fresh).toHaveLength(3);
    const s = Session.peek(file);
    // The one difference: a model's refusal of a message's images (imagesRefused) is marked on the message itself, so
    // the loaded lines have it and a fresh read of them doesn't. The transcript built from them doesn't read it.
    const unmarked = (segments: typeof fresh) => JSON.parse(JSON.stringify(segments, (k, v) => (k === "imagesRefused" ? undefined : v)));
    expect(unmarked(readSegments(file, s))).toEqual(unmarked(fresh));
});

test("the lines are used once, and not kept past the task that loaded them", async () => {
    const file = sessionFile([prompt("one"), reply("done")]);
    const s = Session.peek(file);
    expect(s.takeLoadedLines()).toBeDefined();
    expect(s.takeLoadedLines()).toBeUndefined();
    const later = Session.peek(file);
    await Promise.resolve();
    expect(later.takeLoadedLines()).toBeUndefined();
    // Without them, the file is read: the same segments.
    expect(readSegments(file, later)).toEqual(readSegments(file));
});
