// Home moved back to this computer from a folder on a server (the machines menu, components/Servers.tsx goTo): in
// this computer's latest project, or in none when it has none. It used to keep the server's folder then.
import { expect, test } from "bun:test";

test("back on this computer with no project of its own, Home shows none, not the server's folder", async () => {
    const src = await Bun.file(new URL("../gui/src/components/Servers.tsx", import.meta.url)).text();
    const goTo = src.slice(src.indexOf("const goTo = "), src.indexOf("const goTo = ") + 500);
    expect(goTo).toContain("const cwd = app.projects[0]?.path ?? app.hello?.startCwd;");
    expect(goTo).toContain("newSession(cwd, { machine });");
    expect(goTo).toContain('if (!cwd) setApp("homeCwd", undefined);');
    // And nothing of the folder it left: whether it was a repository, or needed trusting.
    const home = await Bun.file(new URL("../gui/src/components/Home.tsx", import.meta.url)).text();
    expect(home).toContain("const info = () => (app.homeCwd ? inspected() : undefined);");
});
