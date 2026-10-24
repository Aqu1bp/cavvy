// Opening a session from Needs you (the rail's pinned rows, the title bar,
// Settings' top line) lands on its conversation, where its request is: never
// left behind Settings or a sub-agent's view.
import { afterEach, expect, spyOn, test } from "bun:test";
import { app, rpc, setApp } from "../gui/src/state/app";
import { openWaiting } from "../gui/src/state/actions";
import { agentFocus, setAgentFocus, setSettingsTab, settingsTab, setTerminalMax, terminalMax } from "../gui/src/state/ui";

const original = { activeId: app.activeId, opening: app.opening };

afterEach(() => {
    setApp({ activeId: original.activeId, opening: original.opening });
    setAgentFocus(undefined);
    setSettingsTab(undefined);
    setTerminalMax(false);
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
