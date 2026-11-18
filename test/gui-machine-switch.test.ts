import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Picking a session on another machine opens it in this page (state/app.ts activate), where the window used to load
// again on that machine (lib/machines.ts switchMachine): 0.5-0.8 s each way, its sessions opened afresh each time.
test("switching to a session on another machine opens it in the same page, and no row leaves the sidebar", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-machine-switch.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);

// A server's session shown in a window on this computer: what's on its machine isn't looked for on this one.
test("a server session's sign-in port, plan folder and Finder reveal follow its machine", async () => {
    const read = (f: string) => Bun.file(new URL(`../gui/src/${f}`, import.meta.url)).text();
    // Its sign-in page's port is brought over by this computer's Cavvy, for the session's server.
    const card = await read("components/SignInCard.tsx");
    expect(card).toContain("const name = awayMachine(p.sessionId) || windowMachine;");
    expect(card).toContain("const far = windowMachine ? home : rpc;");
    // Finder shows this computer's files only.
    expect(await read("state/app.ts")).toContain("export const revealsIn = (sessionId: string) => canReveal && awayMachine(sessionId) === undefined;");
    for (const f of ["RightPanel.tsx", "ReviewPane.tsx", "PlanDialogs.tsx"]) expect(await read(`components/${f}`)).not.toContain("canReveal");
    // Where a plan is saved is chosen among its machine's folders.
    expect(await read("components/PlanDialogs.tsx")).toContain("setFolderPickerOpen({ then, link: rpcFor(p.sessionId), ...o })");

// Home in a folder on another machine: its worktrees are that machine's, listed, made and removed over the
// connection to it (rpcFor), and the one picked opens there.
test("Home's worktree picker asks the machine Home is on", async () => {
    const read = (f: string) => Bun.file(new URL(`../gui/src/components/${f}`, import.meta.url)).text();
    const picker = await read("WorktreePicker.tsx");
    expect(picker).toContain('rpcFor(undefined).call("projects.worktrees"');
    expect(picker).toContain("openProject(w.path, true)");
    const dialogs = await read("WorktreeDialogs.tsx");
    // Each dialog's `rpc` is Home's machine's; none is the window's own.
    expect(dialogs.split("const rpc = rpcFor(undefined);").length).toBe(3);
    expect(dialogs).not.toMatch(/import \{[^}]*\brpc\b[^}]*\} from "\.\.\/state\/app"/);
    expect(dialogs).not.toMatch(/openProject\([^,)]*\)/);
    expect(await read("Home.tsx")).toContain("<Show when={app.homeCwd && info()?.git}>");
});
