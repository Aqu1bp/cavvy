// Opening a session from Needs you (the rail's pinned rows, the title bar,
// Settings' top line) lands on its conversation, where its request is: never
// left behind Settings or a sub-agent's view.
import { afterEach, expect, spyOn, test } from "bun:test";
import { app, rpc, setApp } from "../gui/src/state/app";
import { openWaiting } from "../gui/src/state/actions";
import { agentFocus, setAgentFocus, setSettingsTab, settingsTab, setTerminalMax, terminalMax, railOpen, setRailOpen, review, setReview, setShellLayout, shellLayout } from "../gui/src/state/ui";
import { prefs, setPrefs } from "../gui/src/state/prefs";

const original = { activeId: app.activeId, opening: app.opening };
const originalLayout = shellLayout();
const originalPanel = prefs.panel;

afterEach(() => {
    setApp({ activeId: original.activeId, opening: original.opening });
    setAgentFocus(undefined);
    setSettingsTab(undefined);
    setTerminalMax(false);
    setRailOpen(false);
    setReview(undefined);
    setShellLayout(originalLayout);
    setPrefs("panel", originalPanel);
});

test("opening a waiting session restores the maximized terminal so its request is visible", () => {
    const call = spyOn(rpc, "call").mockReturnValue(new Promise(() => {}));
    try {
        setApp({ activeId: "parent" });
        setTerminalMax(true);
        void openWaiting("other");
        expect(app.activeId).toBe("other");
        expect(terminalMax()).toBe(false);

        setTerminalMax(true);
        void openWaiting("other");
        expect(terminalMax()).toBe(false);
    } finally { call.mockRestore(); }
});

test("opening the open session from Settings' Needs you leaves its sub-agent's view: its request shows", () => {
    // Never answers: what matters is what changes before the session opens.
    const call = spyOn(rpc, "call").mockReturnValue(new Promise(() => {}));
    try {
        setApp({ activeId: "parent" });
        setAgentFocus("agent-1");
        setSettingsTab("general");
        void openWaiting("parent");
        expect(settingsTab()).toBeUndefined();
        expect(agentFocus()).toBeUndefined();
        expect(app.activeId).toBe("parent");
        // Another session: the same.
        setAgentFocus("agent-1");
        void openWaiting("other");
        expect(agentFocus()).toBeUndefined();
        expect(app.activeId).toBe("other");
    } finally { call.mockRestore(); }
});

test("opening the active session from its agent view closes the overlay rail", () => {
    const call = spyOn(rpc, "call").mockReturnValue(new Promise(() => {}));
    try {
        setApp({ activeId: "parent" });
        setAgentFocus("agent-1");
        setRailOpen(true);
        void openWaiting("parent");
        expect(agentFocus()).toBeUndefined();
        expect(railOpen()).toBe(false);
        expect(app.activeId).toBe("parent");
    } finally { call.mockRestore(); }
});

test("opening a waiting session clears a review hidden under Settings and a floating panel", () => {
    const call = spyOn(rpc, "call").mockReturnValue(new Promise(() => {}));
    try {
        setApp({ activeId: "parent" });
        setSettingsTab("general");
        setReview({});
        setPrefs("panel", true);
        // Settings can report dock mode even though the restored review would fill.
        setShellLayout({ ...originalLayout, inspector: { ...originalLayout.inspector, mode: "dock" } });
        void openWaiting("parent");
        expect(review()).toBeUndefined();
        expect(prefs.panel).toBe(true);
        setShellLayout({ ...originalLayout, inspector: { ...originalLayout.inspector, mode: "float" } });
        void openWaiting("parent");
        expect(prefs.panel).toBe(false);
    } finally { call.mockRestore(); }
});
