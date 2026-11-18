// The Browser pane's strip and keys: "Agent is using this tab" only while its turn runs, whole or as a dot; a new tab
// puts the cursor in the address bar; F5 and Ctrl+R (⌘R) reload the page, the desktop app's own pages included.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

test("the agent's note shows only while its turn runs, and is never cut", () => {
    const pane = read("gui/src/components/BrowserPane.tsx");
    expect(pane).toContain('status() === "agent" && app.sessions.find((s) => s.id === id())?.status === "running"');
    expect(pane).toContain("<Show when={agentUsing()}>");
    const css = read("gui/src/styles/browser.css");
    expect(css).toMatch(/\.br-tabs \.br-who \{\s*flex: none;/);
    expect(css).toMatch(/@container \(width < 360px\) \{\s*\.br-tabs \.br-who \.truncate \{/);
});

test("a new tab puts the cursor in the address bar", () => {
    const pane = read("gui/src/components/BrowserPane.tsx");
    expect(pane).toContain('void call("new_tab").then(() => requestAnimationFrame(() => address?.focus()));');
    expect(pane).toContain("onClick={newTab}");
});

test("F5 and Ctrl+R reload the page in the pane, and from the desktop app's page itself", () => {
    const tools = read("gui/src/components/BrowserTools.tsx");
    expect(tools).toContain('(e.key === "F5" && !isMod(e)) || (e.key.toLowerCase() === "r" && isMod(e))');
    expect(tools).toContain('else if (e.type === "reload") o.reload();');
    const host = read("desktop-electron/src/browser-host.ts");
    expect(host).toContain('if (reloadKey(input) && !tab.agentKeys) return void (e.preventDefault(), this.toGui({ type: "reload", key }));');
});
