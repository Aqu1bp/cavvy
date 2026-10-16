import { expect, test } from "bun:test";
import { componentCode, elements } from "./gui-component-harness";

const node = (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children });
const defaults = { fingerprint: "a".repeat(64), branch: "feature", remote: "origin", target: "feature", destination: "https://github.com/example/project.git", base: "main", protected: false, defaultUnknown: false, gh: true, title: "Prefilled", body: "Commits", hasUpstream: false };
function dialog(info = defaults, read?: () => Promise<unknown>) {
    const effects: (() => unknown)[] = [], calls: { method: string; params: any }[] = [];
    let closed = false, result: unknown, blocked: string | undefined;
    const props = { id: "one" as string | undefined, onClose: () => { closed = true; }, onPublished: (pr: unknown) => { result = pr; } };
    const render = componentCode("PublishDialog", {
        createSignal: (initial: unknown) => { let value = initial; return [() => value, (next: unknown) => { value = next; }]; },
        createEffect: (effect: () => unknown) => effects.push(effect),
        on: (read: () => unknown, effect: (value: unknown) => unknown) => () => effect(read()),
        rpc: { call: async (method: string, params: unknown) => { calls.push({ method, params }); return method === "session.gitPublishInfo" ? read ? read() : info : { pr: { number: 7 } }; } },
        toast() {}, handleFor: () => ({}), commitUnavailable: () => blocked, refreshGitChanges() {}, openExternal() {},
        Dialog: "Dialog", Spinner: "Spinner", Show: "Show", React: { Fragment: "Fragment" }, node,
    });
    const tree = render(props);
    const button = (text: string) => elements(tree, "button").find((n) => n.children.flat(Infinity).some((s: unknown) => typeof s === "string" && s.includes(text)))!;
    const input = (id: string) => elements(tree, "input").find((n) => n.props.id === id)!;
    return { effects, calls, props, tree, button, input, closed: () => closed, result: () => result, block: (s: string) => { blocked = s; } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("opening only previews; push requires protected acknowledgement and sends displayed snapshot", async () => {
    const d = dialog({ ...defaults, protected: true });
    await d.effects[0]!();
    expect(d.calls.map((c) => c.method)).toEqual(["session.gitPublishInfo"]);
    d.button("Confirm push").props.onClick(); await tick();
    expect(d.calls).toHaveLength(1);
    const confirmation = elements(d.tree, "input").find((n) => n.props.type === "checkbox")!;
    confirmation.props.onChange({ currentTarget: { checked: true } });
    d.button("Confirm push").props.onClick(); await tick();
    expect(d.calls[1]).toMatchObject({ method: "session.gitPublish", params: { id: "one", action: "push", fingerprint: defaults.fingerprint, confirmProtected: true, base: "main" } });
    expect(d.closed()).toBe(true);
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
    expect(d.result()).toEqual({ number: 7 });
});

test("busy/untrusted guard and unavailable gh prevent effects even if handler is invoked", async () => {
    const d = dialog({ ...defaults, gh: false }); await d.effects[0]!();
    d.button("Open pull request").props.onClick(); await tick(); expect(d.calls).toHaveLength(1);
    d.block("Wait for work to finish"); d.button("Confirm push").props.onClick(); await tick(); expect(d.calls).toHaveLength(1);
});

test("late preview cannot populate another session or publish from a closed dialog", async () => {
    let resolve!: (value: unknown) => void;
    const d = dialog(defaults, () => new Promise((r) => { resolve = r; }));
    const reading = d.effects[0]!();
    d.props.id = undefined; await d.effects[0]!(); resolve(defaults); await reading;
    d.button("Confirm push").props.onClick(); await tick();
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
