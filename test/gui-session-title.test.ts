// The header's name for a session (components/Header.tsx sessionTitle), loaded with the app's rows and the window's
// turns mocked. An untitled long session was named after the first turn the window had, so the header and its sidebar
// row disagreed, and the header's name changed each time earlier turns were shown.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { component } from "./helpers/gui-render";

const source = readFileSync(new URL("../gui/src/components/Header.tsx", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export function sessionTitle("), source.indexOf("\n}\n", source.indexOf("export function sessionTitle(")) + 3);

test("an untitled session's header shows its row's name, whichever of its turns the window has", () => {
    const app = { sessions: [{ id: "s1", title: "Turn 0: where it started" }], archived: [] as { id: string; title: string }[] };
    const sessionTitle = component(body, "sessionTitle", { app, promptPreview: (s: string) => s });
    const handle = (first: string, title?: string) => ({ id: "s1", view: { state: { title }, turns: [{ prompt: { text: first } }] } });
    expect(sessionTitle(handle("Turn 96: the first of the latest"))).toBe("Turn 0: where it started");
    // More shown: the same name.
    expect(sessionTitle(handle("Turn 56: forty earlier"))).toBe("Turn 0: where it started");
    // Named: its name.
    expect(sessionTitle(handle("Turn 96", "A name"))).toBe("A name");
    // Its row not named yet (its first prompt only just sent): the prompt the window has.
    app.sessions[0]!.title = "New session";
    expect(sessionTitle(handle("Just sent"))).toBe("Just sent");
    // Not listed: likewise.
    expect(sessionTitle({ id: "s2", view: { state: {}, turns: [] } })).toBe("New session");
});
