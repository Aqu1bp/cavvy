// A session's head (its folder, title, first prompt, message count) as the session list reads it: kept while its
// file is the same, read on from where it left off once it's grown, and read again whole once it's been rewritten.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Session, listSessions } = await import("../src/agent/session");
afterAll(() => iso.cleanup());

const say = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as never;
const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as never;

test("a session's head follows its file: grown, renamed, cut short and rewritten in place", () => {
    const cwd = realpathSync(tempDir());
    const s = Session.create(cwd);
    s.push(say("First prompt"));
    s.push(answer("One."));
    const head = () => listSessions(cwd, 10).find((x) => x.id === s.meta.id)!;
    expect([head().messages, head().title]).toEqual([2, "First prompt"]);
    // Grown: read on from the end of its last whole line.
    s.push(say("Second"));
    s.push(answer("Two."));
    expect(head().messages).toBe(4);
    s.setTitle("Renamed");
    expect(head().title).toBe("Renamed");
    // A line not yet whole isn't counted, and is once it is.
    const line = JSON.stringify({ t: "msg", m: answer("Three.") }) + "\n";
    appendFileSync(s.path, line.slice(0, 10));
    expect(head().messages).toBe(4);
    appendFileSync(s.path, line.slice(10));
    expect(head().messages).toBe(5);
    s.release();
    // Rewritten in place (the same file, other bytes before where it was read to): read again from the start.
    const lines = readFileSync(s.path, "utf8").split("\n");
    const firstMessage = lines.findIndex((l) => l.startsWith('{"t":"msg"'));
    writeFileSync(s.path, lines.slice(0, firstMessage + 1).join("\n") + "\n" + "x".repeat(4096) + "\n");
    expect(head().messages).toBe(1);
});
