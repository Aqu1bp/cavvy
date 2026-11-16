// Every project's sessions, newest first (listAllSessions: the sidebar, recent projects, other sessions): the files
// aren't each statted again at every call (10,000 sessions held the server 22-34 ms a call), yet what's put in, taken
// out or written to is listed as it is.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, realpathSync, rmSync, utimesSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Session, listAllSessions } = await import("../src/agent/session");
afterAll(() => iso.cleanup());

const say = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as never;
const ids = () => listAllSessions(200).map((s) => s.id);

test("made, removed and written to: listed as they are, the old ones a call later", async () => {
    const cwd = realpathSync(tempDir());
    const made = Array.from({ length: 80 }, (_, i) => {
        const s = Session.create(cwd);
        s.push(say(`session ${i}`));
        // Oldest first, a minute apart.
        const at = new Date(Date.now() - (200 - i) * 60_000);
        utimesSync(s.path, at, at);
        return s;
    });
    expect(ids()[0]).toBe(made[79]!.meta.id);
    // A new one: first.
    const fresh = Session.create(cwd);
    fresh.push(say("a new one"));
    expect(ids()[0]).toBe(fresh.meta.id);
    // One taken out: gone.
    rmSync(made[78]!.path);
    expect(ids()).not.toContain(made[78]!.meta.id);
    // The oldest, written to by another program a while after the last whole listing: listed first by the call after
    // the next (that one renews the listing after it's answered).
    await Bun.sleep(1100);
    appendFileSync(made[0]!.path, JSON.stringify({ t: "msg", m: say("later") }) + "\n");
    ids();
    await Bun.sleep(100);
    expect(ids()[0]).toBe(made[0]!.meta.id);
});

test("an old one written to here: listed first at once", () => {
    const cwd = realpathSync(tempDir());
    const made = Array.from({ length: 80 }, (_, i) => {
        const s = Session.create(cwd);
        s.push(say(`session ${i}`));
        const at = new Date(Date.now() - (400 - i) * 60_000);
        utimesSync(s.path, at, at);
        return s;
    });
    expect(ids()).toContain(made[0]!.meta.id);
    // Far below the newest the listing looks at again, reopened and written to by this server.
    made[0]!.push(say("again"));
    expect(ids()[0]).toBe(made[0]!.meta.id);
});
