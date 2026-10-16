import { expect, test } from "bun:test";
import { componentCode, elements, node } from "./gui-component-harness";

function dialog(purpose?: "mcp-approval") {
    let continued = 0;
    let request: any = { path: "/project", purpose, then: () => continued++ };
    const decisions: unknown[] = [];
    const TrustDialog = componentCode("TrustDialog", {
        createUniqueId: () => "trust-title",
        node, Show: "Show", ShieldAlert: "ShieldAlert", Dialog: "Dialog",
        createResource: () => [() => ({ needsTrust: [".mcp.json", ".harness/settings.json"] })],
        trustRequest: () => request,
        setTrustRequest: (next: unknown) => { request = next; },
        trustAndContinue: async (...args: unknown[]) => { decisions.push(args); },
        reportError: (error: unknown) => { throw error; },
    });
    return { tree: TrustDialog(), decisions, request: () => request, continued: () => continued };
}

test("MCP trust Cancel dismisses without declining configuration or continuing approval", async () => {
    const d = dialog("mcp-approval");
    const buttons = elements(d.tree, "button");
    expect(buttons.map((button) => button.children.join(""))).toEqual(["Cancel", "Trust this folder"]);
    const text = JSON.stringify(d.tree);
    expect(text).toContain("Cancel keeps the current session trust, project settings and hooks as they are.");
    expect(text).toContain("It does not approve any MCP server.");
    expect(text).not.toContain("those files are ignored");
    await buttons[0]!.props.onClick();
    expect(d.request()).toBeUndefined();
    expect(d.decisions).toEqual([]);
    expect(d.continued()).toBe(0);
});

test("MCP trust still grants explicit trust, and opening a folder still offers Ignore configuration", async () => {
    const mcp = dialog("mcp-approval");
    await elements(mcp.tree, "button")[1]!.props.onClick();
    expect(mcp.decisions).toEqual([["/project", true]]);
    expect(mcp.request()).toBeUndefined();
    expect(mcp.continued()).toBe(1);

    const opening = dialog();
    const ignore = elements(opening.tree, "button")[0]!;
    expect(ignore.children.join("")).toBe("Ignore its configuration");
    expect(JSON.stringify(opening.tree)).toContain("those files are ignored");
    await ignore.props.onClick();
    expect(opening.decisions).toEqual([["/project", false]]);
    expect(opening.continued()).toBe(1);
});

test("trust dialog is named by its visible title", () => {
    const d = dialog();
    const props = elements(d.tree, "Dialog")[0]!.props;
    expect(props.labelledBy).toBe(elements(d.tree, "h2")[0]!.props.id);
    expect(elements(d.tree, "h2")[0]!.children.join("")).toBe("Do you trust the files in this folder?");
});
