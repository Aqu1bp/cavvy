// "Message from another session" for a sender on another of the user's machines (`<machine>/<id>`): the click opens
// that session on its machine, where it used to say "No session box/<id>".
import { expect, test } from "bun:test";

test("the sender of a message from another machine is opened there, and the hover says where it is", async () => {
    const src = await Bun.file(new URL("../gui/src/components/TurnView.tsx", import.meta.url)).text();
    const body = src.slice(src.indexOf("function PeerQuote"), src.indexOf("function PeerQuote") + 1600);
    const at = (id: string) => /^([^/]+)\/(.+)$/.exec(id);
    // The same split the component makes: the machine's name, then the session's id on it.
    expect(body).toContain("/^([^/]+)\\/(.+)$/.exec(p.from.id)");
    expect(at("box/20261118-100828-a60d26")!.slice(1)).toEqual(["box", "20261118-100828-a60d26"]);
    expect(at("20261118-100828-a60d26")).toBeNull();
    // The user's own computer goes by "mac" or "desktop" there (far-peers.ts HOME_NAME): "" to the window.
    const { HOME_NAME } = await import("../src/server/far-peers");
    expect(/^(mac|desktop)$/.test(HOME_NAME)).toBe(true);
    expect(body).toContain('restoredFrom(m[2]!, /^(mac|desktop)$/.test(m[1]!) ? "" : m[1]!);');
    expect(body).toContain("void activate(m ? m[2]! : p.from.id);");
    expect(body).not.toContain("activate(p.from.id)}");
});
