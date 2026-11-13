// A CLI that isn't signed in on a server said "In a terminal, run `codex login`": read at the person's own machine,
// that signs in the wrong one, and the command can't open a browser on a server.
import { afterEach, expect, test } from "bun:test";
import { signInAdvice, signInsOnServer } from "../src/backends/account-login";

afterEach(() => signInsOnServer(false));

test("on the person's own machine the advice is as it was", () => {
    expect(signInAdvice("codex")).toBe("In a terminal, run `codex login`, then try again.");
});

test("on a server it says where, with the sign-in that works from there", () => {
    signInsOnServer();
    expect(signInAdvice("codex")).toBe("On this server, run `codex login --device-auth`, then try again.");
    // A CLI with one way to sign in: that one.
    expect(signInAdvice("claude-code")).toMatch(/^On this server, run `claude [^`]+`, then try again\.$/);
});
