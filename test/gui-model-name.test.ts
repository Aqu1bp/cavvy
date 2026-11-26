// Who drafted a commit message, pull request text or branch name, as Generate's and Suggest's tooltips name it.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";

function load(groups: { provider: string; providerName: string; models: { ref: string; id: string; name?: string }[] }[]) {
    let source = readFileSync(new URL("../gui/src/lib/model-name.ts", import.meta.url), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const deps = { modelsFor: () => groups, named: (m: { name?: string; id: string }) => m.name || m.id, shortModelRef: (r: string) => r.slice(r.indexOf(":") + 1) };
    return new Function(...Object.keys(deps), `${code}\nreturn draftedBy;`)(...Object.values(deps)) as (ref: string) => string;
}

test("a model whose name doesn't say whose it is is named with its provider", () => {
    const draftedBy = load([
        { provider: "claude-code", providerName: "Claude Code", models: [{ ref: "claude-code:default", id: "default", name: "Default (recommended)" }, { ref: "claude-code:sonnet", id: "sonnet", name: "Sonnet (1M context)" }] },
        { provider: "mock", providerName: "Mock", models: [{ ref: "mock:mock-haiku", id: "mock-haiku", name: "Mock Haiku" }] },
    ]);
    expect(draftedBy("claude-code:default")).toBe("Claude Code (Default)");
    expect(draftedBy("claude-code:sonnet")).toBe("Claude Code (Sonnet, 1M context)");
    expect(draftedBy("claude-code:typed-by-hand")).toBe("Claude Code (typed-by-hand)");
    expect(draftedBy("mock:mock-haiku")).toBe("Mock Haiku");
    expect(draftedBy("gone:some-model")).toBe("some-model");
});
