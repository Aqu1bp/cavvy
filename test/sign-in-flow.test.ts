// The sign-in flow against a pretend CLI run for real (a terminal of its own, its status command): each kind of
// sign-in, what the card shows on the way, and that success is the status check's word, not the command's exit.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { isolate, tempDir } from "./helpers/isolate";
import { acmeRecipe, fakeSignInCli } from "../scripts/fake-signin-cli";

const iso = isolate();
const dir = tempDir("cavvy-signin-");
const acme = fakeSignInCli(dir);
process.env.PATH = `${acme.bin}:${process.env.PATH}`;

const { SignInFlow, SmallScreen, plain, siteOf, signInReport } = await import("../src/agent/sign-in");
const { localSignInHost } = await import("../src/agent/sign-in-host");
const { findRecipe, recipeError, signInRecipes, signedOutIn, SIGN_IN_RECIPES } = await import("../src/agent/sign-in-recipes");
import type { SignInView, SignInOutcome } from "../src/agent/sign-in";
import type { SignInRecipe } from "../src/agent/sign-in-recipes";

afterAll(() => iso.cleanup());
beforeEach(() => acme.reset());

/** A flow for `acme`, with every card it showed. */
function flow(recipe: Record<string, unknown> | undefined, o: { away?: boolean; command?: string; wants?: { target: string; recipe?: SignInRecipe; command?: string }[]; save?: (w: any) => void } = {}) {
    const views: SignInView[] = [];
    const f = new SignInFlow({
        wants: o.wants ?? [{ target: "acme", recipe: recipe as SignInRecipe | undefined, command: o.command }],
        host: localSignInHost({ away: Boolean(o.away) }),
        show: (v) => views.push(v),
        save: o.save,
        pollMs: 60,
    });
    const abort = new AbortController();
    const done = f.run(abort.signal);
    const last = () => views[views.length - 1]!;
    const until = async (ok: (v: SignInView) => boolean, what: string) => {
        const end = Date.now() + 8000;
        while (Date.now() < end) {
            if (views.length && ok(last())) return last();
            await Bun.sleep(15);
        }
        throw new Error(`never showed ${what}; last: ${JSON.stringify(views[views.length - 1])}`);
    };
    return { f, views, done, last, until, abort };
}

const state = (o: SignInOutcome) => o.results.map((r) => `${r.state}${r.who ? `:${r.who}` : ""}`).join(",");

describe("a sign-in's card, for each kind", () => {
    test("already signed in: no card, and who", async () => {
        acme.signIn("me@example.com");
        const x = flow(acmeRecipe("device"));
        const o = await x.done;
        expect(o.end).toBe("done");
        expect(state(o)).toBe("in:me@example.com");
        expect(x.views).toEqual([]);
    });

    test("already signed in on a server: what makes the sign-in usable still runs (git may not have been told to use it)", async () => {
        acme.signIn("me@example.com");
        const x = flow(acmeRecipe("device", { then: "acme setup" }), { away: true });
        expect((await x.done).end).toBe("done");
        expect(x.views).toEqual([]);
        expect(acme.ranSetup()).toBe(true);
    });

    test("already signed in on the user's own machine: nothing of theirs is changed without a step they took", async () => {
        acme.signIn("me@example.com");
        const x = flow(acmeRecipe("device", { then: "acme setup" }));
        expect((await x.done).end).toBe("done");
        expect(acme.ranSetup()).toBe(false);
    });

    test("a stop doesn't wait for that step", async () => {
        acme.signIn("me@example.com");
        const real = localSignInHost({ away: true });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // Held, and never run for real: the pretend CLI's note that it ran stays unwritten for the tests after this one.
        const host: typeof real = { ...real, run: async (r, w, o) => (w.join(" ") === "acme setup" ? (await held, { code: 0, out: "" }) : real.run(r, w, o)) };
        const stop = new AbortController();
        const done = new SignInFlow({ wants: [{ target: "acme", recipe: acmeRecipe("device", { then: "acme setup" }) as SignInRecipe }], host, show: () => undefined }).run(stop.signal);
        // Past the first look, into the step that never ends.
        await Bun.sleep(300);
        stop.abort();
        expect((await done).end).toBe("stopped");
        release();
        expect(acme.ranSetup()).toBe(false);
    });

    test("a device code: the question, then the code and where to enter it, then done by itself", async () => {
        const x = flow(acmeRecipe("device", { then: "acme setup" }));
        expect(await x.until((v) => v.step === "ask", "the question")).toEqual({ step: "ask", target: "acme", name: "Acme" });
        x.f.act({ action: "start" });
        const code = await x.until((v) => v.step === "code", "the code");
        expect(code).toMatchObject({ code: "WXYZ-1234", url: "https://acme.example/device", site: "acme.example/device" });
        expect(code.busy).toBeUndefined();
        acme.approve("dev@example.com");
        const o = await x.done;
        expect(o.end).toBe("done");
        expect(state(o)).toBe("in:dev@example.com");
        // The card opens the page: the CLI was told not to.
        expect(acme.log()).toMatch(/browser=.*true/);
        expect(acme.ranSetup()).toBe(true);
    });

    test("a browser on this machine: the CLI opens it, the card waits, and Open again has the link", async () => {
        const x = flow(acmeRecipe("browser"));
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        const wait = await x.until((v) => v.step === "browser" && Boolean(v.url), "the wait");
        expect(wait.url).toBe("https://acme.example/authorize?state=abc");
        expect(wait.open).toBeUndefined();
        acme.approve();
        expect(state(await x.done)).toBe("in:me@example.com");
        expect(acme.log()).toContain("browser=default");
    });

    test("paste a code back: a wrong one shows the CLI's words with Try again, the right one signs in", async () => {
        const x = flow(acmeRecipe("paste"));
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        const paste = await x.until((v) => v.step === "paste", "the field");
        expect(paste.url).toBe("https://acme.example/authorize?mode=paste");
        x.f.act({ action: "submit", value: "bad-code" });
        const failed = await x.until((v) => Boolean(v.error), "the error");
        expect(failed.error).toContain("that code is not valid");
        // What was typed is never in what the card says went wrong.
        expect(failed.error).not.toContain("bad-code");
        x.f.act({ action: "retry" });
        await x.until((v) => v.step === "paste" && !v.error, "the field again");
        x.f.act({ action: "submit", value: "good-code" });
        expect(state(await x.done)).toBe("in:pasted@example.com");
    });

    test("a token: a bad one stays in the card without being quoted, a good one signs in", async () => {
        const x = flow(acmeRecipe("device", { token: { run: "acme login --token", url: "https://acme.example/tokens" } }));
        const ask = await x.until((v) => v.step === "ask", "the question");
        expect(ask.canToken).toBe(true);
        x.f.act({ action: "token" });
        expect(await x.until((v) => v.step === "token", "the field")).toMatchObject({ tokenUrl: "https://acme.example/tokens" });
        x.f.act({ action: "submit", value: "wrong-token-999" });
        const failed = await x.until((v) => Boolean(v.error), "the error");
        expect(failed.step).toBe("token");
        expect(failed.error).toContain("Bad credentials");
        expect(failed.error).not.toContain("wrong-token-999");
        x.f.act({ action: "back" });
        await x.until((v) => v.step === "ask", "the question again");
        x.f.act({ action: "token" });
        x.f.act({ action: "submit", value: "good-token-123" });
        expect(state(await x.done)).toBe("in:token-user");
    });

    test("typed at its prompts: the card shows what the CLI shows, and a password isn't echoed", async () => {
        const x = flow(acmeRecipe("typed"));
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        await x.until((v) => v.step === "typed" && /Username: $/.test(v.term ?? ""), "the name prompt");
        x.f.act({ action: "keys", value: "octo\r" });
        await x.until((v) => /Password: $/.test(v.term ?? ""), "the password prompt");
        x.f.act({ action: "keys", value: "hunter22\r" });
        const o = await x.done;
        expect(state(o)).toBe("in:octo");
        const shown = x.views.map((v) => v.term ?? "").join("\n");
        expect(shown).toContain("Username: octo");
        expect(shown).not.toContain("hunter22");
    });

    test("no recipe: the command for the user to run, and their word that they did", async () => {
        const saved: unknown[] = [];
        const x = flow(undefined, { command: "acme login --device", save: (w) => saved.push(w) });
        expect(await x.until((v) => v.step === "command", "the command")).toEqual({ step: "command", target: "acme", name: "acme", command: "acme login --device", canSave: true });
        x.f.act({ action: "ran" });
        await x.until((v) => v.ran === true, "Done");
        x.f.act({ action: "done", save: true });
        const o = await x.done;
        expect(o.end).toBe("done");
        expect(state(o)).toBe("unverified");
        expect(saved).toHaveLength(1);
    });

    test("without a status command nothing is ever called signed in: a sign-in that ran to its end is passed on unchecked, one that failed is shown", async () => {
        const unchecked = { ...acmeRecipe("typed"), status: { run: "" } };
        const x = flow(unchecked);
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        await x.until((v) => /Username: $/.test(v.term ?? ""), "the name prompt");
        x.f.act({ action: "keys", value: "octo\r" });
        await x.until((v) => /Password: $/.test(v.term ?? ""), "the password prompt");
        x.f.act({ action: "keys", value: "hunter22\r" });
        const o = await x.done;
        expect(o.end).toBe("done");
        expect(state(o)).toBe("unverified");
        expect(signInReport(o, undefined, "RequestSignIn")).toMatchObject({ text: "The sign-in to Acme was done, but Cavvy has no way to check it. Try what needed it.", summary: "Done, not checked" });

        acme.reset();
        const y = flow({ ...unchecked, token: { run: "acme login --token" } });
        await y.until((v) => v.step === "ask", "the question");
        y.f.act({ action: "token" });
        y.f.act({ action: "submit", value: "wrong-token-999" });
        expect((await y.until((v) => Boolean(v.error), "the error")).error).toContain("Bad credentials");
        y.f.act({ action: "submit", value: "good-token-123" });
        expect(state(await y.done)).toBe("unverified");
    });

    test("no recipe and no command: nothing to show", async () => {
        const x = flow(undefined);
        const o = await x.done;
        expect(state(o)).toBe("unknown");
        expect(x.views).toEqual([]);
        expect(signInReport(o, undefined, "RequestSignIn").text).toContain("Call RequestSignIn again with `command`");
    });

    test("its CLI isn't installed: said, with no card", async () => {
        const x = flow({ ...acmeRecipe("device"), status: { run: "acme-not-here status" } });
        const o = await x.done;
        expect(state(o)).toBe("none");
        expect(x.views).toEqual([]);
        expect(signInReport(o, "box", "request_sign_in")).toMatchObject({ isError: true, text: "Acme isn't installed on box: its command wasn't found. Install it first, then ask again." });
    });
});

describe("what the user does instead of finishing", () => {
    test("Later ends it, not signed in, and stops the command", async () => {
        const x = flow(acmeRecipe("device"));
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        await x.until((v) => v.step === "code", "the code");
        x.f.act({ action: "later" });
        const o = await x.done;
        expect(o.end).toBe("later");
        expect(state(o)).toBe("out");
        // The page finished afterwards changes nothing: the command that waited for it is gone.
        acme.approve();
        await Bun.sleep(200);
        expect(acme.signedIn()).toBeUndefined();
        expect(signInReport(o, undefined, "RequestSignIn").text).toContain("the user chose Later");
    });

    test("signing in some other way closes the card: at the question, and with a code showing", async () => {
        const a = flow(acmeRecipe("device"));
        await a.until((v) => v.step === "ask", "the question");
        acme.signIn("terminal@example.com");
        expect(state(await a.done)).toBe("in:terminal@example.com");

        acme.reset();
        const b = flow(acmeRecipe("device"));
        await b.until((v) => v.step === "ask", "the question");
        b.f.act({ action: "start" });
        await b.until((v) => v.step === "code", "the code");
        acme.signIn("other@example.com");
        expect(state(await b.done)).toBe("in:other@example.com");
    });

    test("an expired code offers a new one; a refusal shows the CLI's words with Try again", async () => {
        const x = flow(acmeRecipe("device"));
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        await x.until((v) => v.step === "code", "the code");
        acme.expire();
        const expired = await x.until((v) => v.expired === true, "New code");
        expect(expired.error).toBeUndefined();
        acme.reset();
        x.f.act({ action: "retry" });
        await x.until((v) => v.step === "code" && !v.expired, "a new code");
        acme.refuse();
        const refused = await x.until((v) => Boolean(v.error), "the error");
        expect(refused.error).toBe("error: access was denied");
        expect(refused.expired).toBeUndefined();
        acme.reset();
        x.f.act({ action: "retry" });
        await x.until((v) => v.step === "code" && !v.error, "the code again");
        acme.approve();
        expect((await x.done).end).toBe("done");
    });

    test("the turn is interrupted: stopped, and the command with it", async () => {
        const x = flow(acmeRecipe("device"));
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        await x.until((v) => v.step === "code", "the code");
        x.abort.abort();
        const o = await x.done;
        expect(o.end).toBe("stopped");
        expect(signInReport(o, undefined, "RequestSignIn").text).toContain("interrupted");
    });
});

describe("how often a card looks whether it's signed in", () => {
    test("often while the user is at it, far less once it's left sitting, and often again when they come back", async () => {
        const real = localSignInHost({ away: false });
        let checks = 0;
        let shown = false;
        const host: typeof real = { ...real, run: (r, w, o) => { checks++; return real.run(r, w, o); } };
        // The flow's clock is the test's: "two minutes later" is a line here, not a wait.
        let clock = 0;
        const f = new SignInFlow({ wants: [{ target: "acme", recipe: acmeRecipe("device") as SignInRecipe }], host, show: () => void (shown = true), pollMs: 25, quickForMs: 1000, idlePollMs: 600_000, now: () => clock });
        const stop = new AbortController();
        const done = f.run(stop.signal);
        const until = async (ok: () => boolean, what: string) => {
            const end = Date.now() + 15_000;
            while (!ok()) {
                if (Date.now() > end) throw new Error(`never ${what}; ${checks} checks`);
                await Bun.sleep(10);
            }
        };
        await until(() => shown, "showed the card");
        // While the card is new: look after look.
        const first = checks;
        await until(() => checks >= first + 3, "looked three more times");
        // Left sitting. A look already due or under way lands; the one after it is ten minutes off.
        clock = 5000;
        const left = checks;
        await Bun.sleep(700);
        expect(checks).toBeLessThanOrEqual(left + 1);
        // Anything the user does in the card: often again.
        const sitting = checks;
        f.act({ action: "ran" });
        f.act({ action: "back" });
        await until(() => checks >= sitting + 3, "looked often again");
        stop.abort();
        await done;
    });
});

describe("on a server, where the person's browser is elsewhere", () => {
    test("the recipe's other command is used, and its warning shown", async () => {
        const recipe = acmeRecipe("browser", { away: { flow: "device", run: "acme login --device" }, warning: "Agents there can push as you" });
        const x = flow(recipe, { away: true });
        expect(await x.until((v) => v.step === "ask", "the question")).toMatchObject({ warning: "Agents there can push as you" });
        x.f.act({ action: "start" });
        await x.until((v) => v.step === "code", "the code");
        acme.approve();
        expect((await x.done).end).toBe("done");
    });

    test("a sign-in that only opens a browser where it runs is left to the user", async () => {
        const x = flow(acmeRecipe("browser"), { away: true });
        expect(await x.until((v) => v.step === "command", "the command")).toMatchObject({ command: "acme login --browser" });
        expect(x.last().canSave).toBeUndefined();
    });
});

describe("a sign-in whose page calls the CLI's own machine, from a browser on another", () => {
    const recipe = acmeRecipe("browser", { away: { flow: "callback", run: "acme login --browser", port: 18765 } }) as SignInRecipe;
    const run = (o: { forward?: (port: number) => Promise<{ close(): void }>; windowForwards?: boolean }) => {
        const views: SignInView[] = [];
        const f = new SignInFlow({ wants: [{ target: "acme", recipe }], host: { ...localSignInHost({ away: true }), forward: o.forward }, windowForwards: o.windowForwards, show: (v) => views.push(v), pollMs: 60 });
        const done = f.run();
        const until = async (ok: (v: SignInView) => boolean, what: string) => {
            const end = Date.now() + 8000;
            while (Date.now() < end) {
                if (views.length && ok(views[views.length - 1]!)) return views[views.length - 1]!;
                await Bun.sleep(15);
            }
            throw new Error(`never showed ${what}; last: ${JSON.stringify(views[views.length - 1])}`);
        };
        return { f, views, done, until };
    };

    test("the port is brought over first, the card offers the link, and the port is let go when it's over", async () => {
        const log: string[] = [];
        const x = run({ forward: async (port) => (log.push(`open ${port}`), { close: () => void log.push(`close ${port}`) }) });
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        const wait = await x.until((v) => v.step === "browser" && Boolean(v.url), "the link");
        // Nothing opened the page: the card does.
        expect(wait.open).toBe(true);
        expect(log).toEqual(["open 18765"]);
        // The CLI was kept from opening a browser where there's none to see.
        expect(acme.log()).toMatch(/browser=.*true/);
        acme.approve();
        expect((await x.done).end).toBe("done");
        expect(log).toEqual(["open 18765", "close 18765"]);
    });

    test("where only the window can bring it over, the card asks, and waits for its word", async () => {
        const x = run({ windowForwards: true });
        await x.until((v) => v.step === "ask", "the question");
        x.f.act({ action: "start" });
        const asked = await x.until((v) => v.forward === 18765, "the ask for the port");
        expect(asked.url).toBeUndefined();
        x.f.act({ action: "port" });
        await x.until((v) => v.step === "browser" && Boolean(v.url) && v.open === true, "the link");
        acme.approve();
        expect((await x.done).end).toBe("done");
        // Let go of once it's over.
        expect(x.views.some((v, i) => i > x.views.indexOf(asked) && v.forward === undefined)).toBe(true);
    });

    test("a window that can't, or no way at all: said in the card, with Try again", async () => {
        const a = run({ windowForwards: true });
        await a.until((v) => v.step === "ask", "the question");
        a.f.act({ action: "start" });
        await a.until((v) => v.forward === 18765, "the ask for the port");
        a.f.act({ action: "port", error: "bind [127.0.0.1]:18765: Address already in use" });
        expect(await a.until((v) => Boolean(v.error), "the error")).toMatchObject({ ended: true, error: "bind [127.0.0.1]:18765: Address already in use" });
        a.f.act({ action: "later" });
        await a.done;

        const b = run({});
        await b.until((v) => v.step === "ask", "the question");
        b.f.act({ action: "start" });
        expect((await b.until((v) => Boolean(v.error), "the error")).error).toContain("can't be set up from here");
        b.f.act({ action: "later" });
        await b.done;
    });
});

describe("several at once (a new server's sign-ins)", () => {
    const other: SignInRecipe = { id: "beta", name: "Beta", status: { run: "acme-not-here status" }, here: { flow: "device", run: "acme-not-here login" } };

    test("a list of what's signed out; each is its own sign-in, and the list comes back until none is left", async () => {
        const token = acmeRecipe("device", { id: "acme-token", name: "Acme tokens", status: { run: "acme status", signedIn: "never-matches" }, token: { run: "acme login --token" } }) as SignInRecipe;
        const x = flow(undefined, { wants: [{ target: "acme", recipe: acmeRecipe("device") as SignInRecipe }, { target: "beta", recipe: other }, { target: "acme-token", recipe: token }] });
        const list = await x.until((v) => v.step === "list", "the list");
        // One whose CLI isn't there isn't offered.
        expect(list.rows).toEqual([{ target: "acme", name: "Acme", state: "out" }, { target: "acme-token", name: "Acme tokens", state: "out" }]);
        x.f.act({ action: "pick", target: "acme" });
        const code = await x.until((v) => v.step === "code", "the code");
        expect(code.back).toBe(true);
        // Later, from one of them, goes back to the list.
        x.f.act({ action: "later" });
        await x.until((v) => v.step === "list", "the list again");
        x.f.act({ action: "pick", target: "acme" });
        await x.until((v) => v.step === "code", "the code");
        acme.approve("list@example.com");
        const after = await x.until((v) => v.step === "list", "the list, one done");
        expect(after.rows![0]).toEqual({ target: "acme", name: "Acme", state: "in", who: "list@example.com" });
        // One that can take a token asks how first.
        x.f.act({ action: "pick", target: "acme-token" });
        expect(await x.until((v) => v.step === "ask", "its question")).toMatchObject({ canToken: true, back: true });
        x.f.act({ action: "back" });
        await x.until((v) => v.step === "list", "the list");
        x.f.act({ action: "later" });
        const o = await x.done;
        expect(o.end).toBe("later");
        expect(state(o)).toBe("in:list@example.com,none,out");
    });

    test("all signed in already: no card", async () => {
        acme.signIn("me@example.com");
        const x = flow(undefined, { wants: [{ target: "acme", recipe: acmeRecipe("device") as SignInRecipe }, { target: "beta", recipe: other }] });
        const o = await x.done;
        expect(o.end).toBe("done");
        expect(x.views).toEqual([]);
    });

    test("one signed in some other way while the list is up is wrapped up like one signed in through the card", async () => {
        const never = acmeRecipe("device", { id: "acme-token", name: "Acme tokens", status: { run: "acme status", signedIn: "never-matches" } }) as SignInRecipe;
        const x = flow(undefined, { wants: [{ target: "acme", recipe: acmeRecipe("device", { then: "acme setup" }) as SignInRecipe }, { target: "acme-token", recipe: never }] });
        await x.until((v) => v.step === "list", "the list");
        expect(acme.ranSetup()).toBe(false);
        acme.signIn("elsewhere@example.com");
        const after = await x.until((v) => v.step === "list" && v.rows?.[0]?.state === "in", "the list, one done");
        expect(after.rows![0]).toMatchObject({ target: "acme", who: "elsewhere@example.com" });
        expect(acme.ranSetup()).toBe(true);
        x.abort.abort();
        await x.done;
    });
});

describe("the pieces", () => {
    test("terminal output is read as the text it shows", () => {
        expect(plain("\x1b]8;;https://a.example/x\x1b\\https://a.example/x\x1b]8;;\x1b\\ \x1b[94mAB12-CD34\x1b[0m\r\n")).toBe("https://a.example/x AB12-CD34\n");
        expect(siteOf("https://github.com/login/device")).toBe("github.com/login/device");
        expect(siteOf("https://us-east-1.signin.aws.amazon.com/v1/authorize?x=1")).toBe("us-east-1.signin.aws.amazon.com/v1/authorize");
    });

    test("the small screen keeps a prompt's last lines, with its redraws", () => {
        const s = new SmallScreen(3);
        s.write("one\r\ntwo\r\nthree\r\nUser");
        s.write("name: ab\b \bc");
        expect(s.text()).toBe("two\nthree\nUsername: ac");
        s.write("\r\x1b[2KPassword: ");
        expect(s.text()).toBe("two\nthree\nPassword: ");
        // An escape cut in two by a read isn't shown.
        s.write("\x1b[");
        s.write("1mok\x1b[0m");
        expect(s.text()).toBe("two\nthree\nPassword: ok");
    });

    test("recipes: found by id, name or alias; the user's own win; a bad one is left out", () => {
        const all = signInRecipes([{ id: "gh", name: "GitHub (work)", here: { flow: "device", run: "gh auth login -h git.example --web" }, status: { run: "gh auth status -h git.example" } }, { id: "Bad Id", name: "x", here: { flow: "device", run: "x" } }, { id: "fly", name: "Fly.io", here: { flow: "browser", run: "fly auth login" } }]);
        expect(findRecipe("GitHub (work)", all)?.here.run).toContain("git.example");
        expect(findRecipe("fly", all)?.status.run).toBe("");
        expect(all.some((r) => r.id === "Bad Id")).toBe(false);
        expect(findRecipe("github", SIGN_IN_RECIPES)?.id).toBe("gh");
        expect(findRecipe("claude-code", SIGN_IN_RECIPES)?.id).toBe("claude");
        expect(findRecipe("nope", SIGN_IN_RECIPES)).toBeUndefined();
        expect(recipeError({ id: "x", name: "X", here: { flow: "device", run: "x login; rm -rf ~" } })).toBeUndefined();
        expect(recipeError({ id: "x", name: "X", here: { flow: "shell", run: "x" } })).toContain("here needs a flow");
        expect(recipeError({ id: "x", name: "X", here: { flow: "device", run: "x" }, reads: { code: "(" } })).toContain("reads.code");
        for (const r of SIGN_IN_RECIPES) expect(recipeError(r)).toBeUndefined();
    });

    test("a command's output that says it's signed out names the recipe", () => {
        expect(signedOutIn("You are not logged into any GitHub hosts. To log in, run: gh auth login", SIGN_IN_RECIPES, "gh pr view 12")?.id).toBe("gh");
        expect(signedOutIn("To get started with GitHub CLI, please run:  gh auth login", SIGN_IN_RECIPES, "cd repo && /opt/homebrew/bin/gh pr list")?.id).toBe("gh");
        expect(signedOutIn("fatal: could not read Username for 'https://github.com': terminal prompts disabled", SIGN_IN_RECIPES, "git push -u origin work")?.id).toBe("gh");
        expect(signedOutIn("aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials.", SIGN_IN_RECIPES, "aws s3 ls")?.id).toBe("aws");
        expect(signedOutIn("An error occurred (ExpiredToken) when calling the GetCallerIdentity operation", SIGN_IN_RECIPES, "aws sts get-caller-identity")?.id).toBe("aws");
        expect(signedOutIn("ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.", SIGN_IN_RECIPES, "gcloud auth print-access-token")?.id).toBe("gcloud");
        expect(signedOutIn("everything is fine", SIGN_IN_RECIPES, "gh pr view")).toBeUndefined();
    });

    test("text that only mentions a login command says nothing: the failed command has to be that CLI's own", () => {
        // A failing test whose output quotes the advice (this repository's own tests do).
        const quoted = 'error: expect(received).toBe(expected)\nExpected: "Run gh auth login in a terminal."\nYou are not logged into any GitHub hosts. To log in, run: gh auth login';
        expect(signedOutIn(quoted, SIGN_IN_RECIPES, "bun test ./test/git-publish.test.ts")).toBeUndefined();
        expect(signedOutIn("Unable to locate credentials", SIGN_IN_RECIPES, "cat docs/aws.md")).toBeUndefined();
        expect(signedOutIn("see gcloud auth login", SIGN_IN_RECIPES, "grep -r login docs")).toBeUndefined();
        // A file named after the CLI isn't the CLI.
        expect(signedOutIn(quoted, SIGN_IN_RECIPES, "cat notes/gh-setup.md")).toBeUndefined();
        // The CLI's own command, mentioning the login command in passing (a README it printed), isn't its sign-out message.
        expect(signedOutIn("docs: gh auth login signs you in", SIGN_IN_RECIPES, "gh repo view --web")).toBeUndefined();
        // The user's own: its id is its program unless it says otherwise.
        const mine = signInRecipes([{ ...acmeRecipe("device"), commands: ["acme", "acmectl"] }]);
        expect(signedOutIn("Not logged in. Run: acme login", mine, "acmectl deploy")?.id).toBe("acme");
        expect(signedOutIn("Not logged in. Run: acme login", mine, "make deploy")).toBeUndefined();
        expect(recipeError({ ...acmeRecipe("device"), commands: ["acme; rm"] })).toContain("commands must be program names");
    });
});
