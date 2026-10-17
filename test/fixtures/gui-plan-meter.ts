import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { component, node, renderer, text } from "../helpers/gui-render";
import { planLimitKey, type AccountInfo } from "../../src/server/protocol";
import { limitAlternatives, meterOf, windowLine } from "../../gui/src/lib/limits";

const source = readFileSync(new URL("../../gui/src/components/PlanMeter.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const accounts: AccountInfo[] = ["default", "work"].map((id) => ({ id, name: id === "default" ? "Default" : "Work", folder: `/fake/${id}`, managed: id !== "default", signedIn: true }));

for (const current of ["default", "work"]) test(`${current}: only another account triggers a status refresh, including reactive changes`, async () => {
    const root = node("root");
    const calls: any[] = [];
    const pending = Promise.withResolvers<AccountInfo[]>();
    const [catalog, setCatalog] = solid.createSignal(accounts.filter((a) => a.id === current));
    const provider = { id: "claude-code", name: "Claude Code", agentCli: { get accounts() { return catalog(); } } };
    const PlanMeter = component(source, "PlanMeter", {
        app: { providers: [provider], limits: { [planLimitKey(provider.id, current)]: { provider: provider.id, accountId: current, reached: true, windows: [], at: Date.now() } } },
        handleFor: () => ({ view: { state: { model: { provider: provider.id }, accounts: { [provider.id]: current } } } }),
        rpc: { call: (...args: any[]) => { calls.push(args); return pending.promise; } },
        now: Date.now, planLimitKey, limitAlternatives, meterOf, windowLine,
        reportError: (error: Error) => { throw error; }, toast() {}, setSettingsTab() {},
        Popover: () => null,
    });
    const dispose = renderer.render(() => PlanMeter({ sessionId: "session" }), root);
    try {
        expect(text(root)).toContain("Limit reached");
        expect(calls).toEqual([]);
        expect(text(root)).not.toContain("Checking accounts");
        setCatalog(accounts);
        expect(calls).toEqual([["accounts.list", { provider: provider.id, refresh: true }]]);
        expect(text(root)).toContain("Checking accounts…");
        pending.resolve(accounts);
        await Bun.sleep(0);
        expect(text(root)).not.toContain("Checking accounts");
        expect(text(root)).toContain(`Switch to ${current === "default" ? "Work" : "Default"}`);
        setCatalog(accounts.filter((a) => a.id === current));
        expect(calls).toHaveLength(1);
        expect(text(root)).not.toContain("Switch to");
    } finally { dispose(); }
});
