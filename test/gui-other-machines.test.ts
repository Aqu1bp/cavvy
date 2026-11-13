// The other machines' sessions in the sidebar (gui/src/components/OtherMachines.tsx): which of a machine's sessions
// are listed and in what order, and that the list is part of the servers code, loaded only when there are servers.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { inPlay } from "../gui/src/lib/in-play";

const s = (id: string, status: "idle" | "running" | "waiting" | "error", updatedAt: number, o: { archived?: boolean; settled?: boolean } = {}) => ({ id, status, updatedAt, archived: false, settled: false, ...o });

test("a machine's sessions: those waiting for the user first, then the working, then the most recent; none archived or set aside", () => {
    const listed = inPlay([s("old", "idle", 1), s("new", "idle", 9), s("busy", "running", 2), s("asks", "waiting", 3), s("failed", "error", 5), s("gone", "running", 8, { archived: true }), s("aside", "waiting", 8, { settled: true })]);
    expect(listed.map((x) => x.id)).toEqual(["asks", "busy", "new", "failed", "old"]);
});

test("nothing of other machines is loaded or asked for unless this Cavvy has servers, or the window is on one", () => {
    const app = readFileSync(new URL("../gui/src/state/app.ts", import.meta.url), "utf8");
    expect(app).toContain("if (machine || app.hello?.servers) void serversUi().then((m) => m.connected());");
    // Only through the servers code, which is fetched when asked for.
    expect(app).not.toContain("OtherMachines");
    expect(readFileSync(new URL("../gui/src/components/Sidebar.tsx", import.meta.url), "utf8")).not.toContain("OtherMachines");
    const others = readFileSync(new URL("../gui/src/components/OtherMachines.tsx", import.meta.url), "utf8");
    // It watches the rail's own children only: not everything that changes inside the sidebar while a reply streams.
    expect(others).toContain("seen.observe(rail, { childList: true });");
    expect(others).not.toContain("subtree");
    expect(others).not.toContain("setInterval");
});
