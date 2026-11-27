// A suggested task's card (gui/src/components/blocks/SuggestCard.tsx), compiled with Solid's client reactivity as
// gui-confirm-dialog.test.ts does: only the renderer and what it imports are stand-ins. What it starts with, that
// nothing in it takes focus or starts on Enter, and that changing what it starts with clears the last Start's news.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

const source = readFileSync(new URL("../gui/src/components/blocks/SuggestCard.tsx", import.meta.url), "utf8")
    .replace(/^import [^;]*;\n/gm, "")
    .replace("export default function SuggestCard", "function SuggestCard");

type Node = { tag: string; props: Record<string, any> };

/**
 * A keyed store on the same signals the compiled card uses (solid-js/store resolves to another build of Solid here,
 * whose changes the card's effects wouldn't see): what the card does with one, reading a key and setting a key.
 */
function createStore<T extends Record<string, any>>(init: T) {
    const sigs = new Map<string, [() => any, (v: any) => void]>();
    const at = (k: string) => {
        if (!sigs.has(k)) sigs.set(k, solid.createSignal(init[k]));
        return sigs.get(k)!;
    };
    return [new Proxy({}, { get: (_t, k) => at(String(k))[0]() }), (k: string, v: any) => at(k)[1](() => v)] as const;
}

function card(o: { machine?: string; cwd?: string; start?: (pick: any) => Promise<any> } = {}) {
    const nodes: Node[] = [];
    const resolve = (value: any): any => (typeof value === "function" ? resolve(value()) : value);
    const renderer = {
        ...solid,
        effect: solid.createRenderEffect,
        memo: solid.createMemo,
        createElement: (tag: string) => {
            const node = { tag, props: {} };
            nodes.push(node);
            return node;
        },
        createTextNode: () => ({}),
        insertNode() {},
        setProp: (node: Node, key: string, value: any) => {
            node.props[key] = value;
        },
        // What's put in an element, as its text when it's text (a button's label).
        insert: (node: any, value: any) =>
            solid.createRenderEffect(() => {
                const v = resolve(value);
                if (typeof v === "string") node.text = v;
            }),
    };
    const compiled = transformSync(source, {
        filename: "SuggestCard.tsx",
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]],
        configFile: false,
        babelrc: false,
    })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled).replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;");
    const picker: { props?: any } = {};
    const toggle: { props?: any } = {};
    const starts: any[] = [];
    const models = [{ ref: "mock:a", provider: "mock", id: "a", name: "A" }, { ref: "mock:b", provider: "mock", id: "b", name: "B" }];
    const icon = () => ({});
    const deps = {
        renderer,
        ...solid,
        createStore,
        app: { hello: { servers: 1, homeDir: "/home/me" } },
        connOn: () => "open",
        handleFor: () => ({ view: { state: { cwd: o.cwd ?? "/home/me/repo", title: "Fix the docs", mode: "default", branch: "main", model: { ref: "mock:a" } } } }),
        loadMachine: async () => undefined,
        listsOn: () => ({}),
        machineOf: () => o.machine,
        modelsKnownOn: () => true,
        chooseFolder: async () => undefined,
        setFolderPickerOpen: () => undefined,
        tildify: (path: string) => path.replace("/home/me", "~"),
        windowMachine: undefined,
        awayKey: (on: string | undefined) => (on === undefined ? undefined : on),
        boxName: (on: string | undefined) => on ?? "This Mac",
        chooseEffort: () => undefined,
        chooseModel: (x: any) => x.picked ?? x.suggester,
        defaultsOf: () => ({}),
        HERE: "This Mac",
        linkOn: async () => ({}),
        listServers: async () => [],
        modelsOf: () => models,
        openStarted: () => undefined,
        setSuggestion: async () => true,
        startedOn: () => undefined,
        startSuggestion: async (pick: any) => {
            starts.push(pick);
            return o.start ? o.start(pick) : { kind: "failed", message: "A isn't available on box. Pick another.", retry: false };
        },
        visible: (s: string) => s,
        whyLine: (s: any) => s.why,
        windowCalls: () => ({}),
        ModelPicker: (p: any) => {
            picker.props = p;
            return {};
        },
        Menu: () => ({}),
        Spinner: () => ({}),
        Toggle: (p: any) => {
            toggle.props = p;
            return {};
        },
        Check: icon, ChevronDown: icon, CircleAlert: icon, Folder: icon, GitBranchPlus: icon, Lightbulb: icon, Server: icon, SquareArrowOutUpRight: icon,
    };
    const made = new Function(...Object.keys(deps), `${js}; return { SuggestCard, problemOf };`)(...Object.values(deps));
    const suggestion = { id: "call-1", title: "Fix the flaky test", prompt: "It fails", why: "Saw it fail twice", at: 0, state: "pending" };
    let dispose!: () => void;
    solid.createRoot((d: () => void) => {
        dispose = d;
        made.SuggestCard({ suggestion, sessionId: "s1" });
    });
    const find = (pred: (n: Node) => boolean) => nodes.find(pred);
    const byClass = (c: string) => find((n) => typeof n.props.class === "string" && n.props.class.split(" ").includes(c));
    return { nodes, picker, toggle, starts, byClass, problem: () => made.problemOf["s1#call-1"], dispose };
}

test("it starts on the suggesting session's machine and folder, and nothing in it takes focus", () => {
    const c = card({ machine: "box", cwd: "/srv/repo" });
    try {
        // The model picker is the target machine's: the suggesting session's server.
        expect(c.picker.props.target.machine).toBe("box");
        expect(c.picker.props.currentRef).toBe("mock:a");
        expect(c.byClass("sg-folder")!.props.title).toBe("/srv/repo: choose another folder");
        // Nothing focuses itself.
        expect(c.nodes.some((n) => "autofocus" in n.props || "autoFocus" in n.props)).toBe(false);
    } finally {
        c.dispose();
    }
});

test("Enter in the title doesn't start it; the Start button does", async () => {
    const c = card();
    try {
        let prevented = false;
        c.byClass("sg-title")!.props.onKeyDown({ key: "Enter", preventDefault: () => (prevented = true) });
        expect(prevented).toBe(true);
        expect(c.starts).toHaveLength(0);
        const start = c.nodes.find((n) => n.tag === "button" && n.props.class === "pbtn primary")!;
        expect(start.props.disabled).toBe(false);
        start.props.onClick();
        await Bun.sleep(0);
        expect(c.starts).toHaveLength(1);
    } finally {
        c.dispose();
    }
});

test("picking another model, or turning New worktree off, clears the last Start's news", async () => {
    const c = card({ cwd: "/home/me/r1" });
    try {
        const start = () => c.nodes.find((n) => n.tag === "button" && n.props.class === "pbtn primary")!.props.onClick();
        start();
        await Bun.sleep(0);
        expect(c.problem()?.message).toBe("A isn't available on box. Pick another.");
        c.picker.props.target.model("mock:b");
        expect(c.problem()).toBeUndefined();
        start();
        await Bun.sleep(0);
        expect(c.problem()).toBeDefined();
        c.picker.props.target.effort("high");
        expect(c.problem()).toBeUndefined();
        start();
        await Bun.sleep(0);
        expect(c.problem()).toBeDefined();
        c.toggle.props.onChange(false);
        expect(c.problem()).toBeUndefined();
    } finally {
        c.dispose();
    }
});

test("after a Start that can be tried again, the button says Try again, and Start whenever it can't be pressed", async () => {
    const c = card({ start: async () => ({ kind: "failed", message: "box didn't answer.", retry: true }) });
    try {
        const button = () => c.nodes.find((n) => n.tag === "button" && n.props.class === "pbtn primary")!;
        button().props.onClick();
        for (let i = 0; i < 50 && (button() as any).text !== "Try again"; i++) await Bun.sleep(1);
        expect((button() as any).text).toBe("Try again");
        // Nothing to start with (no title): disabled, and not "Try again".
        c.byClass("sg-title")!.props.onInput({ currentTarget: { value: "" } });
        expect(button().props.disabled).toBe(true);
        expect((button() as any).text).toBe("Start");
    } finally {
        c.dispose();
    }
});
