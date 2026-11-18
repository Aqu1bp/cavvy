// "Message from another session" for a sender on another of the user's machines (`<machine>/<id>`): the click opens
// that session on its machine, where it used to say "No session box/<id>".
import { expect, test } from "bun:test";

test("the sender of a message from another machine is opened there, and the hover says where it is", async () => {
    const src = await Bun.file(new URL("../gui/src/components/TurnView.tsx", import.meta.url)).text();
    const body = src.slice(src.indexOf("function PeerQuote"), src.indexOf("function PeerQuote") + 2200);
    const at = (id: string) => /^([^/]+)\/(.+)$/.exec(id);
    // The same split the component makes: the machine's name, then the session's id on it.
    expect(body).toContain("/^([^/]+)\\/(.+)$/.exec(p.from.id)");
    expect(at("box/20261118-100828-a60d26")!.slice(1)).toEqual(["box", "20261118-100828-a60d26"]);
    expect(at("20261118-100828-a60d26")).toBeNull();
    // The user's own computer goes by "mac" or "desktop" to a session on a server (far-peers.ts HOME_NAME): "" to
    // the window. The same word in a message to one of this computer's own sessions is a server's name.
    const { HOME_NAME } = await import("../src/server/far-peers");
    expect(/^(mac|desktop)$/.test(HOME_NAME)).toBe(true);
    expect(body).toContain('const home = os === "macos" ? "mac" : "desktop";');
    expect(body).toContain('const on = !m ? here : m[1] === home && (here ?? machine) ? "" : m[1]!;');
    // A sender named by its id alone is on the machine of the session its message came to.
    expect(body).toContain("const here = p.in === undefined ? undefined : awayMachine(p.in);");
    expect(body).toContain("if (on !== undefined) restoredFrom(m ? m[2]! : p.from.id, on);");
    expect(src.split("<PeerQuote ").length).toBe(3);
    expect(src).toContain("<PeerQuote from={from} in={p.sessionId}");
    expect(src).toContain("<PeerQuote from={m().from} in={p.state.id}");
});
