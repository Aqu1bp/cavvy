import { expect, test } from "bun:test";
import { RequestWatch } from "../src/server/request-watch";

const setup = () => {
    const lines: Record<string, unknown>[] = [];
    let now = 0;
    const watch = new RequestWatch({ afterMs: 20, write: (l) => lines.push(l), now: () => now });
    return { lines, watch, tick: (ms: number) => (now += ms) };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a request answered in time writes nothing", async () => {
    const { lines, watch } = setup();
    const done = watch.start({}, 1, "models.list", {});
    done("answered");
    await wait(40);
    expect(lines).toEqual([]);
});

test("one past its time is noted waiting, then how it ended, with its session and no parameters", async () => {
    const { lines, watch, tick } = setup();
    const done = watch.start({}, 7, "session.open", { id: "20261112-000000-abcdef", secret: "x" });
    tick(15_000);
    await wait(40);
    expect(lines).toEqual([{ what: "waiting", method: "session.open", session: "20261112-000000-abcdef", ms: 15_000 }]);
    tick(5_000);
    done("failed");
    expect(lines[1]).toEqual({ what: "failed", method: "session.open", session: "20261112-000000-abcdef", ms: 20_000 });
    done("answered");
    expect(lines).toHaveLength(2);
});

test("a reply that never left is noted however soon it came", () => {
    const { lines, watch } = setup();
    watch.start({}, 1, "fs.image", { id: 5 })("unsent");
    expect(lines).toEqual([{ what: "unsent", method: "fs.image", session: undefined, ms: 0 }]);
});

test("a window that goes away notes only what had been waiting, and its late replies write nothing more", async () => {
    const { lines, watch } = setup();
    const conn = {};
    const slow = watch.start(conn, 1, "accounts.list", {});
    await wait(40);
    const quick = watch.start(conn, 2, "hello", {});
    watch.drop(conn);
    expect(lines.map((l) => l.what)).toEqual(["waiting", "dropped"]);
    slow("answered");
    quick("answered");
    await wait(40);
    expect(lines).toHaveLength(2);
});

test("connections are kept apart, and close stops pending notes", async () => {
    const { lines, watch } = setup();
    const a = {}, b = {};
    const doneA = watch.start(a, 1, "session.mcp", {});
    watch.start(b, 1, "session.changes", {});
    doneA("answered");
    watch.close();
    await wait(40);
    expect(lines).toEqual([]);
});
