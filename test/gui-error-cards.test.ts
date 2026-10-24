import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { commandIn, errorPlace, messageParts, splitError } from "../gui/src/lib/error-text";

test("error cards, the title bar and provider rows render errors where they belong", async () => {
    // Solid's browser build, kept apart from the server tests' module resolution.
    const fixture = fileURLToPath(new URL("./fixtures/gui-error-cards.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", "test", fixture], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
});

test("an error's first sentence is its title, unless it's long or inside a command", () => {
    expect(splitError("Codex isn't signed in. Run `codex login` in a terminal, then try again.")).toEqual({ title: "Codex isn't signed in", detail: "Run `codex login` in a terminal, then try again." });
    expect(splitError("Session deleted: Not connected")).toEqual({ title: "Session deleted", detail: "Not connected" });
    expect(splitError("Couldn't read /tmp/a.ts: ENOENT")).toEqual({ title: "Couldn't read /tmp/a.ts", detail: "ENOENT" });
    expect(splitError("Is it running? Try again")).toEqual({ title: "Is it running?", detail: "Try again" });
    expect(splitError("Archive failed")).toEqual({ title: "Archive failed" });
    expect(splitError("Run `git commit -m. x` first. Then push")).toEqual({ title: "Run `git commit -m. x` first", detail: "Then push" });
    const long = "x".repeat(140);
    expect(splitError(long)).toEqual({ detail: long });
    expect(splitError(`${"y".repeat(120)}. More`)).toEqual({ detail: `${"y".repeat(120)}. More` });
});

test("backticked text is code, and the first of it is the command to copy", () => {
    expect(messageParts("Run `codex login` then `codex`.")).toEqual(["Run ", "codex login", " then ", "codex", "."]);
    expect(messageParts("No commands")).toEqual(["No commands"]);
    expect(commandIn("Run `codex login` in a terminal")).toBe("codex login");
    expect(commandIn("Nothing to run")).toBeUndefined();
});

test("errors show in exactly one place, whatever's on screen", () => {
    expect(errorPlace(["window", "composer"], false)).toBe("composer");
    expect(errorPlace(["window", "home"], false)).toBe("home");
    expect(errorPlace(["window"], false)).toBe("window");
    expect(errorPlace(["window", "composer", "settings"], true)).toBe("settings");
    // Settings open but not on screen (the splash): the window's.
    expect(errorPlace(["window", "composer"], true)).toBe("window");
    expect(errorPlace([], false)).toBe("window");
});
