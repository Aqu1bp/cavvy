import { expect, test } from "bun:test";
import { componentCode, elements } from "./gui-component-harness";

const node = (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children });
const defaults = { fingerprint: "a".repeat(64), branch: "feature", remote: "origin", target: "feature", destination: "https://github.com/example/project.git", base: "main", protected: false, defaultUnknown: false, gh: true, title: "Prefilled", body: "Commits", hasUpstream: false };
function dialog(info = defaults, read?: () => Promise<unknown>, prText?: () => Promise<unknown>) {
    const effects: (() => unknown)[] = [], calls: { method: string; params: any }[] = [], toasts: any[][] = [], opened: string[] = [];
    let closed = false, result: unknown, blocked: string | undefined;
    const props = { id: "one" as string | undefined, onClose: () => { closed = true; }, onPublished: (pr: unknown) => { result = pr; } };
    const render = componentCode("PublishDialog", {
        createSignal: (initial: unknown) => { let value = initial; return [() => value, (next: unknown) => { value = next; }]; },
        createEffect: (effect: () => unknown) => effects.push(effect),
        on: (read: () => unknown, effect: (value: unknown) => unknown) => () => effect(read()),
        rpc: { call: async (method: string, params: unknown) => { calls.push({ method, params }); return method === "session.gitPublishInfo" ? read ? read() : info : method === "session.gitPrText" ? prText!() : { pr: { number: 7, url: "https://github.com/example/project/pull/7" } }; } },
        toast(...args: any[]) { toasts.push(args); }, handleFor: () => ({}), commitUnavailable: () => blocked, refreshGitChanges() {}, openExternal(url: string) { opened.push(url); }, takeFocus() {},
        Dialog: "Dialog", Spinner: "Spinner", Show: "Show", React: { Fragment: "Fragment" }, node,
    });
    // The dialog and its footer, where the buttons are.
    const shown = render(props);
    const tree = [shown, shown.props.footer];
    const button = (text: string) => elements(tree, "button").find((n) => n.children.flat(Infinity).some((s: unknown) => typeof s === "string" && s.includes(text)))!;
    const input = (id: string) => elements(tree, "input").find((n) => n.props.id === id)!;
    return { effects, calls, toasts, opened, props, tree, button, input, closed: () => closed, result: () => result, block: (s: string) => { blocked = s; } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("opening only previews; push requires protected acknowledgement and sends displayed snapshot", async () => {
    const d = dialog({ ...defaults, protected: true });
    await d.effects[0]!();
    expect(d.calls.map((c) => c.method)).toEqual(["session.gitPublishInfo"]);
    d.button("Push").props.onClick(); await tick();
    expect(d.calls).toHaveLength(1);
    const confirmation = elements(d.tree, "input").find((n) => n.props.type === "checkbox")!;
    confirmation.props.onChange({ currentTarget: { checked: true } });
    d.button("Push").props.onClick(); await tick();
    expect(d.calls[1]).toMatchObject({ method: "session.gitPublish", params: { id: "one", action: "push", fingerprint: defaults.fingerprint, confirmProtected: true, base: "main" } });
    expect(d.closed()).toBe(true);
});

test("the buttons are in the dialog's footer, kept in view; its tick boxes are the app's check rows", async () => {
    const d = dialog({ ...defaults, protected: true });
    await d.effects[0]!();
    const [body, footer] = d.tree as [any, any];
    const text = (n: any) => n.children.flat(Infinity).filter((s: unknown) => typeof s === "string").join("");
    expect(elements(footer, "button").map(text)).toEqual(expect.arrayContaining(["Cancel", "Push", "Open pull request"]));
    expect(elements(body.children, "button").map(text)).not.toContain("Push");
    const rows = elements(body.children, "label").filter((l) => elements(l.children, "input").some((i) => i.props.type === "checkbox"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.props.class).toBe("check-row");
    // One Cancel, not one per layout: the keyboard put on it while the dialog loaded stays on it once the form comes.
    expect(elements(footer, "button").filter((b) => text(b) === "Cancel")).toHaveLength(1);
    expect(footer.children.flat(Infinity).filter((n: any) => n?.tag === "button").map(text)).toContain("Cancel");
});

test("a new branch to a remote that doesn't say its default pushes without the protected acknowledgement", async () => {
    const d = dialog({ ...defaults, base: undefined, defaultUnknown: true, protected: false } as never);
    await d.effects[0]!();
    d.button("Push").props.onClick(); await tick();
    expect(d.calls[1]).toMatchObject({ method: "session.gitPublish", params: { action: "push", confirmProtected: false } });
});

test("PR click uses edited title, body, base and draft without auto-publishing", async () => {
    const d = dialog(); await d.effects[0]!();
    d.input("pr-title").props.onInput({ currentTarget: { value: "Edited" } });
    d.input("pr-base").props.onInput({ currentTarget: { value: "release" } });
    elements(d.tree, "textarea")[0]!.props.onInput({ currentTarget: { value: "Description" } });
    elements(d.tree, "input").filter((n) => n.props.type === "checkbox").at(-1)!.props.onChange({ currentTarget: { checked: true } });
    expect(d.calls).toHaveLength(1);
    d.button("Open pull request").props.onClick(); await tick();
    expect(d.calls[1]!.params).toMatchObject({ action: "pr", title: "Edited", base: "release", body: "Description", draft: true, fingerprint: defaults.fingerprint });
    expect(d.result()).toEqual({ number: 7, url: "https://github.com/example/project/pull/7" });
    // Not opened by itself: the toast offers it.
    expect(d.opened).toEqual([]);
    const [message, level, action] = d.toasts.at(-1)!;
    expect([message, level, action.label]).toEqual(["Pushed origin/feature · PR #7", "success", "Open"]);
    action.run();
    expect(d.opened).toEqual(["https://github.com/example/project/pull/7"]);
});

test("Generate fills the title and description from the small model, for the base shown; a failure keeps the commits' text", async () => {
    const d = dialog(defaults, undefined, async () => ({ title: "Add SSO", body: "## Summary\nAdds it.", model: "mock:mock-haiku" }));
    await d.effects[0]!();
    d.button("Generate").props.onClick(); await tick();
    expect(d.calls[1]).toEqual({ method: "session.gitPrText", params: { id: "one", base: "main" } });
    d.button("Open pull request").props.onClick(); await tick();
    expect(d.calls[2]!.params).toMatchObject({ action: "pr", title: "Add SSO", body: "## Summary\nAdds it." });

    const failing = dialog(defaults, undefined, async () => { throw new Error("Set a small model in Settings to generate pull request text."); });
    await failing.effects[0]!();
    failing.button("Generate").props.onClick(); await tick();
    failing.button("Open pull request").props.onClick(); await tick();
    expect(failing.calls[2]!.params).toMatchObject({ action: "pr", title: "Prefilled", body: "Commits" });
});

test("busy/untrusted guard and unavailable gh prevent effects even if handler is invoked", async () => {
    const d = dialog({ ...defaults, gh: false }); await d.effects[0]!();
    d.button("Open pull request").props.onClick(); await tick(); expect(d.calls).toHaveLength(1);
    d.block("Wait for work to finish"); d.button("Push").props.onClick(); await tick(); expect(d.calls).toHaveLength(1);
});

test("late preview cannot populate another session or publish from a closed dialog", async () => {
    let resolve!: (value: unknown) => void;
    const d = dialog(defaults, () => new Promise((r) => { resolve = r; }));
    const reading = d.effects[0]!();
    d.props.id = undefined; await d.effects[0]!(); resolve(defaults); await reading;
    d.button("Push").props.onClick(); await tick();
    expect(d.calls).toHaveLength(1);
});

test("PR state refresh is visible-only, at most every 60 seconds, and cleans up", async () => {
    const effects: (() => unknown)[] = [], cleanup: (() => void)[] = [], events = new Map<string, () => void>();
    let interval: (() => void) | undefined, now = 100_000, count = 0, cleared = false;
    const document = { visibilityState: "visible", addEventListener: (key: string, callback: () => void) => events.set(key, callback), removeEventListener: (key: string) => events.delete(key) };
    const render = componentCode("PublishStatus", {
        createSignal: (initial: unknown) => { let value = initial; return [() => value, (next: unknown) => { value = next; }]; },
        createEffect: (callback: () => unknown) => effects.push(callback), onCleanup: (callback: () => void) => cleanup.push(callback),
        rpc: { call: async () => { count++; return {}; } }, sessionReadReady: () => true, openExternal() {},
        setInterval: (callback: () => void, ms: number) => { expect(ms).toBe(60_000); interval = callback; return 1; }, clearInterval: () => { cleared = true; },
        Date: { now: () => now }, document, window: document,
        Show: "Show", PublishDialog: "PublishDialog", React: { Fragment: "Fragment" }, node,
    });
    render({ handle: { id: "one", view: { state: { trusted: true } } }, onClose() {} });
    effects[0]!(); await tick(); expect(count).toBe(1);
    events.get("focus")!(); await tick(); expect(count).toBe(1);
    now += 60_000; document.visibilityState = "hidden"; interval!(); await tick(); expect(count).toBe(1);
    document.visibilityState = "visible"; events.get("visibilitychange")!(); await tick(); expect(count).toBe(2);
    cleanup[0]!(); expect(cleared).toBe(true); expect(events.size).toBe(0);
});


test("a pre-push PR refresh cannot overwrite the newly published PR", async () => {
    const effects: (() => unknown)[] = [], values: unknown[] = [];
    let resolve!: (value: unknown) => void;
    const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
    const render = componentCode("PublishStatus", {
        createSignal: (initial: unknown) => { const index = values.length; values.push(initial); return [() => values[index], (next: unknown) => { values[index] = next; }]; },
        createEffect: (callback: () => unknown) => effects.push(callback), onCleanup() {},
        rpc: { call: () => new Promise((done) => { resolve = done; }) }, sessionReadReady: () => true, openExternal() {},
        setInterval() {}, clearInterval() {}, Date: { now: () => 100_000 }, document, window: document,
        Show: "Show", PublishDialog: "PublishDialog", React: { Fragment: "Fragment" }, node,
    });
    const tree = render({ handle: { id: "one", view: { state: { trusted: true } } }, onClose() {} });
    effects[0]!();
    elements(tree, "PublishDialog")[0]!.props.onPublished({ number: 7 });
    resolve({ pr: undefined }); await tick();
    expect(values[0]).toEqual({ number: 7 });
});

test("where the branch stands says only what isn't zero, and Up to date when nothing is", () => {
    const syncWords = componentCode("syncWords", {}, undefined, "PublishDialog") as (ahead: number, behind: number) => string;
    expect(syncWords(0, 0)).toBe("Up to date");
    expect(syncWords(2, 0)).toBe("2 ahead");
    expect(syncWords(0, 3)).toBe("3 behind");
    expect(syncWords(2, 3)).toBe("2 ahead · 3 behind");
});

test("a refused push leads with what to do, in the dialog's type, and keeps git's output below it as printed", () => {
    const publishError = componentCode("publishError", {}, undefined, "PublishDialog") as (message: string, code?: string) => { text?: string; raw?: string };
    expect(publishError("The remote has commits this branch doesn't. Pull, then push again.\nerror: failed to push some refs\n ! [rejected] (fetch first)\n", "push_failed"))
        .toEqual({ text: "The remote has commits this branch doesn't. Pull, then push again.", raw: "error: failed to push some refs\n ! [rejected] (fetch first)" });
    expect(publishError("Push failed.", "push_failed")).toEqual({ text: "Push failed." });
    expect(publishError("Pushed, but couldn't open the pull request.\nGraphQL: No commits between main and feature\n", "pr_failed")).toEqual({ text: "Pushed, but couldn't open the pull request.", raw: "GraphQL: No commits between main and feature" });
    // Other git failures are git's own words; anything else is Cavvy's sentence.
    expect(publishError("fatal: bad object", "git")).toEqual({ raw: "fatal: bad object" });
    expect(publishError("The branch or destination changed. Reopen the dialog.", "stale")).toEqual({ text: "The branch or destination changed. Reopen the dialog." });
});
