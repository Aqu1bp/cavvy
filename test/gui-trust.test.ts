import { expect, test } from "bun:test";
import { componentCode, elements, node } from "./gui-component-harness";

function dialog(purpose?: "mcp-approval") {
    let continued = 0;
    let request: any = { path: "/project", purpose, then: () => continued++ };
    const decisions: unknown[] = [];
    const TrustDialog = componentCode("TrustDialog", {
        node, Show: "Show", For: "For", ShieldQuestion: "ShieldQuestion", Dialog: "Dialog",
        createResource: () => [() => ({ needsTrust: [".mcp.json", ".cavvy/settings.json"] })],
        trustRequest: () => request,
        app: {}, machine: undefined, tildify: (p: string) => p,
        setTrustRequest: (next: unknown) => { request = next; },
        trustAndContinue: async (...args: unknown[]) => { decisions.push(args); },
        reportError: (error: unknown) => { throw error; },
    });
    const tree = TrustDialog();
    // The buttons are the dialog's foot (a prop of Dialog, as its title is).
    return { tree: [tree, tree.props.footer], decisions, request: () => request, continued: () => continued };
}

test("MCP trust Cancel dismisses without declining configuration or continuing approval", async () => {
    const d = dialog("mcp-approval");
    const buttons = elements(d.tree, "button");
    expect(buttons.map((button) => button.children.join(""))).toEqual(["Cancel", "Trust this folder"]);
    const text = JSON.stringify(d.tree);
    expect(text).toContain("Trust it to approve its MCP servers.");
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
    expect(JSON.stringify(opening.tree)).toContain('can run commands on \",\"this computer\"');
    expect(JSON.stringify(opening.tree)).not.toContain("Trust it to approve its MCP servers.");
    await ignore.props.onClick();
    expect(opening.decisions).toEqual([["/project", false]]);
    expect(opening.continued()).toBe(1);
});

test("trust dialog is named by its visible title", () => {
    const d = dialog();
    const props = elements(d.tree, "Dialog")[0]!.props;
    // Dialog draws the title as its heading and names the dialog by it (ui/Dialog.tsx aria-labelledby).
    expect(props.bare).toBeUndefined();
    expect(props.title).toBe("Do you trust the files in this folder?");
});
