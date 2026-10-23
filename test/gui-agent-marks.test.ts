import { expect, test } from "bun:test";
import { agentProvider, agentStep, fullCall, providerStack, stepWords } from "../gui/src/lib/agent-marks";
import { runnerName } from "../gui/src/lib/background";
import { plural } from "../gui/src/lib/format";
import type { ToolBlock } from "../src/server/protocol";
import { componentCode, elements } from "./gui-component-harness";

const tool = (o: Partial<ToolBlock>): ToolBlock => ({ t: "tool", id: "c1", name: "Bash", title: "Bash", status: "running", ...o });
const LONG = "set -e W=/Users/me/Desktop/my-own-harness/.claude/worktrees/agent-1 K=/tmp/k\nbun test ./test/foo.test.ts";
const title = `Bash(${LONG.replace(/\s+/g, " ").slice(0, 117)}…)`;

test("who runs a sub-agent: its model's provider when it isn't the session's own, else the session's", () => {
    expect(agentProvider({ model: "openai:gpt-5" }, "claude-code")).toBe("openai");
    expect(agentProvider({}, "claude-code")).toBe("claude-code");
    expect(agentProvider({ model: "sonnet" }, "codex")).toBe("codex");
    expect(agentProvider({})).toBeUndefined();
});

test("a sub-agent's own child with a bare model runs on its parent's provider, not the session's", () => {
    const run = (id: string, model?: string, parentId?: string) => ({ id, model, parentId }) as any;
    const agents = [run("a1", "claude-code:sonnet"), run("a2", "haiku", "a1"), run("a3", undefined, "a2")];
    // A Codex session: the Claude Code agent's children are Claude Code's, however deep.
    expect(agentProvider(agents[1], "codex", agents)).toBe("claude-code");
    expect(agentProvider(agents[2], "codex", agents)).toBe("claude-code");
    // A parent not listed (yet), or none: the session's.
    expect(agentProvider(run("b", "haiku", "gone"), "codex", agents)).toBe("codex");
    // A loop in parents doesn't hang.
    const loop = [run("x", "haiku", "y"), run("y", "haiku", "x")];
    expect(agentProvider(loop[0], "codex", loop)).toBe("codex");
});

test("a group's providers: distinct, in order, at most three and how many more", () => {
    expect(providerStack(["claude-code", "claude-code"])).toEqual({ shown: ["claude-code"], more: 0 });
    expect(providerStack(["codex", "claude-code", "codex", "openai"])).toEqual({ shown: ["codex", "claude-code", "openai"], more: 0 });
    expect(providerStack(["codex", "claude-code", "openai", "gemini", "xai", "codex"])).toEqual({ shown: ["codex", "claude-code", "openai"], more: 2 });
    // Not known: one robot for all of them.
    expect(providerStack([undefined, "codex", undefined])).toEqual({ shown: [undefined, "codex"], more: 0 });
});

test("a step in a few words: Claude Code's description over the command, the whole call for the tooltip", () => {
    const described = tool({ title, input: { command: LONG, description: "Run the foo tests" } });
    expect(stepWords(described)).toBe("Run the foo tests");
    expect(fullCall(described)).toBe(`Bash(${LONG})`);
    expect(agentStep({ activity: title, blocks: [described] })).toEqual({ text: "Run the foo tests", full: `Bash(${LONG})` });
});

test("without a description: the verb and the command past its cd, on one line; a file by its name", () => {
    const bare = tool({ title: "Bash(cd '/repo' && bun test ./test/foo.test.ts)", input: { command: "cd '/repo' && bun test ./test/foo.test.ts" } });
    expect(agentStep({ activity: bare.title, blocks: [bare] })?.text).toBe("Running bun test ./test/foo.test.ts");
    expect(stepWords({ ...bare, status: "ok" })).toBe("Run bun test ./test/foo.test.ts");
    expect(stepWords(tool({ title: "Bash(x)", input: { command: "echo a\n  && echo b" } }))).toBe("Running echo a");
    const read = tool({ name: "Read", title: "Read(/Users/me/project/src/server/runtime.ts)", input: { file_path: "/Users/me/project/src/server/runtime.ts" } });
    expect(agentStep({ activity: read.title, blocks: [read] })).toEqual({ text: "Reading runtime.ts", full: read.title });
    expect(stepWords(tool({ name: "Grep", title: "Grep(agentStep in gui)", status: "ok" }))).toBe("Search agentStep in gui");
});

test("other activity is already words; a call's title with no call is worded from it", () => {
    expect(agentStep({ activity: "Thinking", blocks: [] })).toEqual({ text: "Thinking" });
    expect(agentStep({ activity: "Waiting for approval", blocks: [] })).toEqual({ text: "Waiting for approval" });
    expect(agentStep({ activity: "Working (step 2)", blocks: [] })).toEqual({ text: "Working (step 2)" });
    expect(agentStep({ activity: "Bash(cd /r && make all)", blocks: [] })).toEqual({ text: "Running make all", full: "Bash(cd /r && make all)" });
    expect(agentStep({ activity: undefined, blocks: [] })).toBeUndefined();
});

test("the group's stack: up to three marks then +N, one for a single provider, named for a screen reader", () => {
    const providers = [{ id: "claude-code", name: "Claude Code" }, { id: "codex", name: "Codex" }, { id: "openai", name: "OpenAI" }, { id: "gemini", name: "Google" }];
    const node = (tag: any, props: Record<string, any> | null, ...children: any[]): any => (typeof tag === "function" ? tag({ ...(props ?? {}), children: children.length === 1 ? children[0] : children }) : { tag, props: props ?? {}, children });
    const ProviderStack = componentCode("ProviderStack", {
        createMemo: (f: () => unknown) => f,
        For: (p: { each: unknown[]; children: (x: unknown) => unknown }) => p.each.map((x) => p.children(x)),
        Show: (p: { when: unknown; children: unknown; fallback?: unknown }) => (p.when ? (typeof p.children === "function" ? p.children(() => p.when) : p.children) : p.fallback),
        Bot: "Bot",
        ProviderIcon: (p: Record<string, unknown>) => ({ tag: "ProviderIcon", props: p, children: [] }),
        app: { providers },
        runnerName,
        providerStack,
        plural,
        React: { Fragment: "Fragment" },
        node,
    }, undefined, "ui/AgentMark");
    const text = (t: any): string => (Array.isArray(t) ? t.map(text).join("") : t && typeof t === "object" ? text(t.children) : t == null || t === false ? "" : String(t));

    const many = ProviderStack({ providers: ["claude-code", "codex", "claude-code", "openai", "gemini", "xai"] });
    expect(many.props["aria-label"]).toBe("6 sub-agents: Claude Code, Codex, OpenAI, Google, xai");
    expect(elements(many, "ProviderIcon").map((i) => [i.props.id, i.props.label])).toEqual([["claude-code", "Claude Code"], ["codex", "Codex"], ["openai", "OpenAI"]]);
    expect(text(many)).toBe("+2");

    const one = ProviderStack({ providers: ["codex", "codex"] });
    expect(elements(one, "ProviderIcon")).toHaveLength(1);
    expect(one.props["aria-label"]).toBe("2 sub-agents: Codex");
    expect(text(one)).toBe("");

    // Not known: a robot, and no names.
    const unknown = ProviderStack({ providers: [undefined] });
    expect(elements(unknown, "Bot")).toHaveLength(1);
    expect(unknown.props["aria-label"]).toBe("1 sub-agent");
});

test("the transcript's card, the side panel and the dock draw a sub-agent with the one mark", async () => {
    const read = (f: string) => Bun.file(new URL(`../gui/src/components/${f}`, import.meta.url)).text();
    const [activity, panel, dock] = await Promise.all([read("blocks/Activity.tsx"), read("BackgroundTasks.tsx"), read("InteractionDock.tsx")]);
    const card = activity.slice(activity.indexOf("export function SubAgentsRow"), activity.indexOf("function StatusIcon"));
    expect(card).toContain("<ProviderStack providers={p.runs.map(providerOf)} />");
    expect(card).toContain("<AgentMark provider={providerOf(a)} />");
    expect(card).not.toContain("<Bot");
    expect(panel).toContain('<AgentMark provider={id()} class="pm" />');
    expect(dock).toContain("<AgentMark provider={askerProvider()} size={12} />");
    expect(dock).not.toContain("<Bot");
});
