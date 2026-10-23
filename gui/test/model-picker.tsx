// The model picker in a real browser: the current model's marks, the keyboard highlight apart from them,
// and the provider's account switcher. The real component, store and actions; only RPC is stubbed.
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { AccountInfo, ProviderInfo, ProviderModels } from "@shared/protocol";
import { ModelPicker } from "../src/components/ModelPicker";
import { app, rpc, setApp } from "../src/state/app";
import { addAccountFor, setAddAccountFor, setSettingsTab, settingsTab } from "../src/state/ui";
import "../src/styles/composer.css";
import "../src/styles/overlays.css";

function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(`model picker: ${message}`);
}
async function until(ok: () => boolean, what: string) {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    check(ok(), `timed out waiting for ${what}`);
}
const settle = (ms = 0) => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, ms)));

const account = (id: string, name: string, extra: Partial<AccountInfo> = {}): AccountInfo => ({ id, name, folder: `/fixture/${id}`, managed: true, signedIn: true, ...extra });
const models: ProviderModels[] = [
    {
        provider: "claude-code", providerName: "Claude Code", status: "ok", billing: "plan",
        models: [
            ["default", "Default (recommended) (claude-opus-5-5)"], ["opus", "Opus 5.5 (claude-opus-5-5)"], ["fable", "Fable 5.1 (claude-fable-5-1)"], ["claude-haiku-4-5", "Haiku 4.5"],
        ].map(([id, name]) => ({ ref: `claude-code:${id}`, provider: "claude-code", id: id!, name: name! })),
    },
    { provider: "mock", providerName: "Mock", status: "ok", billing: "api", models: [{ ref: "mock:echo", provider: "mock", id: "echo", name: "echo" }, { ref: "mock:local-7b", provider: "mock", id: "local-7b", name: "" }] },
];

export async function checkModelPicker(root: HTMLElement) {
    // Animations on, so closing fades (the page may have them off).
    const motion = document.documentElement.dataset.motion;
    document.documentElement.dataset.motion = "quick";
    const saved = { call: rpc.call, models: app.models, providers: app.providers, activeId: app.activeId, loading: app.modelsLoading };
    const calls: [string, any][] = [];
    let accounts = [account("default", "Personal", { email: "me@example.test", plan: "max" }), account("work", "Work"), account("lab", "Lab", { signedIn: false })];
    let preferred = "work";
    const providers = (): ProviderInfo[] => [{ id: "claude-code", name: "Claude Code", kind: "agent", configured: true, requiresKey: false, agentCli: { accounts, defaultAccount: preferred, installed: true, signIn: "claude", install: "", plan: "Claude subscription" } }];
    rpc.call = (async (method: string, params: any) => {
        calls.push([method, params]);
        if (method === "accounts.setDefault") preferred = params.id;
        if (method === "providers.list") return providers();
        return null;
    }) as typeof rpc.call;
    // Home: the account is the provider's default, which switching sets.
    setApp("activeId", undefined);
    setApp("modelsLoading", false);
    setApp("models", models);
    setApp("providers", providers());
    const [open, setOpen] = createSignal(false);
    const box = document.createElement("div");
    box.style.cssText = "position: fixed; left: 20px; bottom: 20px";
    root.append(box);
    const dispose = render(() => <ModelPicker open={open()} setOpen={setOpen} currentRef="claude-code:opus" placement="top" />, box);
    const trigger = box.querySelector<HTMLButtonElement>("button.pick")!;
    const panel = () => document.querySelector<HTMLElement>(".popover.mp:not(.closing)");
    const rows = () => [...document.querySelectorAll<HTMLElement>(".popover.mp:not(.closing) .mr")];
    const row = (name: string) => rows().find((r) => r.querySelector(".mr-name")?.textContent === name)!;
    const acct = () => document.querySelector<HTMLButtonElement>(".popover.mp:not(.closing) .mp-acct");
    const items = () => [...document.querySelectorAll<HTMLButtonElement>(".mp-acct-menu [role^='menuitem']")];
    const item = (name: string) => items().find((b) => b.textContent?.includes(name))!;
    const key = (key: string, target: Element = document.activeElement!) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const bg = (el: Element) => getComputedStyle(el).backgroundColor;
    try {
        trigger.focus();
        trigger.click();
        await until(() => !!panel() && document.activeElement?.matches(".mp-search input") === true, "the picker to open on the search field");
        await settle(250);

        // The current model: only an accent check (and a hair heavier name). Rows show names, never ids.
        const current = row("Opus 5.5");
        check(current, `rows read as clean names (${rows().map((r) => r.textContent).join(" | ")})`);
        check(rows().every((r) => !/claude-/.test(r.textContent ?? "") && !/claude-/.test(r.querySelector("[role='option']")?.getAttribute("title") ?? "") && !r.querySelector(".mr-sub")), `rows show no model ids, in text or tooltip (${rows().map((r) => r.textContent).join(" | ")})`);
        check(current.querySelector(".mr-mark svg")?.checkVisibility(), "the current model has a check");
        check(rows().filter((r) => r.querySelector(".mr-mark svg")).length === 1, "only the current model has a check");
        check(current.querySelector("[role='option']")?.getAttribute("aria-selected") === "true", "the current model is the selected option");
        const plain = row("Haiku 4.5");
        const weight = (r: Element) => Number(getComputedStyle(r.querySelector(".mr-name")!).fontWeight);
        check(weight(current) >= weight(plain) && weight(current) < 600, `the current model's name is at most a hair heavier (${weight(current)})`);
        // It opens highlighted (the keyboard's place), and that neutral fill is the only one.
        check(current.classList.contains("sel") && bg(current) !== bg(plain), "the picker opens with the current model highlighted");
        const neutral = bg(current);
        // The rail has no mark for the current model's provider: only the open tab's fill, and the label for screen readers.
        const railCurrent = document.querySelector<HTMLElement>(".mp-rail [role='tab'][aria-label^='Claude Code']")!;
        check(/current model/.test(railCurrent.getAttribute("aria-label") ?? ""), "screen readers hear which provider has the current model");
        check(!document.querySelector(".mp-rail .bar, .mp-rail .rb-cur, .mp-rail .rb.cur"), "the rail has no current-provider marker");
        check([...railCurrent.children].every((c) => c.matches(".provider-icon, .provider-mono, svg")), `the current provider's tile holds only its icon (${railCurrent.innerHTML.slice(0, 200)})`);

        // The keyboard highlight is apart from the current model: both shown at once, and different.
        const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
        document.activeElement!.dispatchEvent(down);
        const afterKey = rows().map((r) => r.className).join("|");
        await settle(250);
        const highlighted = row("Fable 5.1");
        check(highlighted.classList.contains("sel") && !current.classList.contains("sel"), `ArrowDown moves the highlight off the current model (prevented ${down.defaultPrevented}, right after: ${afterKey}; sel: ${rows().map((r) => r.className).join("|")}; focus: ${document.activeElement?.outerHTML.slice(0, 80)})`);
        check(document.querySelector(".mp-search input")!.getAttribute("aria-activedescendant") === highlighted.querySelector("[role='option']")!.id, "the search field points at the highlighted row");
        check(bg(highlighted) === neutral && bg(current) === bg(plain), `the highlight is the only fill; the current model's row has none once it moves off (${bg(highlighted)}, ${bg(current)}, ${bg(plain)})`);
        check(current.querySelector(".mr-mark svg") && !highlighted.querySelector(".mr-mark svg"), "the check stays on the current model");
        check(getComputedStyle(highlighted.querySelector("kbd")!).opacity === "1" && getComputedStyle(plain.querySelector("kbd")!).opacity === "0", "shortcut hints show on the highlighted row only");
        check(getComputedStyle(plain.querySelector(".mr-star")!).opacity === "0" && getComputedStyle(highlighted.querySelector(".mr-star")!).opacity === "1", "stars are quiet until the row is highlighted");

        // Search still matches ids, though rows don't show them: "haiku-4-5" isn't in Haiku 4.5's name. Results name the provider.
        const search = document.querySelector<HTMLInputElement>(".mp-search input")!;
        const type = (value: string) => {
            search.value = value;
            search.dispatchEvent(new InputEvent("input", { bubbles: true }));
        };
        type("haiku-4-5");
        await settle();
        check(rows().length === 1 && rows()[0]!.querySelector(".mr-name")?.textContent === "Haiku 4.5" && rows()[0]!.querySelector(".mr-sub")?.textContent === "Claude Code", `search by id finds the model (${rows().map((r) => r.textContent).join(" | ")})`);
        type("");
        await settle();

        // Another provider's list open: its tile has the neutral fill; the current model's provider looks like any other.
        const railMock = document.querySelector<HTMLElement>(".mp-rail [role='tab'][aria-label^='Mock']")!;
        const railFavorites = document.querySelector<HTMLElement>(".mp-rail [role='tab'][aria-label='Favorites']")!;
        railMock.click();
        await settle(200);
        check(railMock.classList.contains("on") && bg(railMock) !== "rgba(0, 0, 0, 0)", "the open tab has a neutral fill");
        check(row("local-7b"), "a model with no name goes by its id");
        check(!railCurrent.classList.contains("on") && bg(railCurrent) === bg(railFavorites) && !railCurrent.querySelector(".rb-cur"), "the current model's provider has no mark while another list is open");
        railCurrent.click();
        await settle();

        // Several accounts: the active one by name in the header, the others a keypress away.
        const button = acct()!;
        check(button?.textContent?.includes("Work") && button.getAttribute("aria-haspopup") === "menu" && button.getAttribute("aria-expanded") === "false", "the header names the active account");
        button.focus();
        key("ArrowDown");
        await until(() => items().length === 4, "the account list");
        check(button.getAttribute("aria-expanded") === "true", "the switcher says it's open");
        check(items().filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.textContent).join().includes("Work"), "the active account is checked");
        check(document.activeElement === item("Work"), "the list opens on the active account");
        // Over the model list, the account list must be solid: rows behind it must not show through, even as it opens.
        const menu = document.querySelector<HTMLElement>(".mp-acct-menu")!;
        const alpha = (c: string) => Number(c.match(/rgba?\(([^)]+)\)/)?.[1]?.split(/[ ,/]+/).filter(Boolean)[3] ?? 1);
        const style = getComputedStyle(menu);
        check(alpha(style.backgroundColor) >= 0.95 && style.backgroundImage === "none", `the account list has an opaque surface (${style.backgroundColor}, ${style.backgroundImage})`);
        check(Number(style.opacity) === 1 && !(menu.getAnimations()[0]?.effect as KeyframeEffect | undefined)?.getKeyframes().some((k) => k.opacity !== undefined && Number(k.opacity) < 1), "the account list never fades in over the rows");
        check(item("Lab").textContent?.includes("Not signed in") && item("Personal").textContent?.includes("me@example.test"), "accounts say who they are and what's wrong");
        key("ArrowDown");
        check(document.activeElement === item("Lab"), "arrows move through the accounts");
        key("Escape");
        await settle();
        check(items().length === 0 && panel(), "Escape closes the account list, not the picker");
        check(document.activeElement === acct(), "and gives focus back to its button");

        // Switching calls setAccount (on Home: the provider's default), and the header follows.
        acct()!.click();
        await until(() => items().length === 4, "the account list again");
        item("Personal").click();
        await until(() => acct()?.textContent?.includes("Personal") === true, "the switched account in the header");
        check(calls.some(([m, p]) => m === "accounts.setDefault" && p.provider === "claude-code" && p.id === "default"), "switching sets the account");
        check(items().length === 0 && panel(), "the picker stays open after switching");

        // A removed account: said so, and the list asks for another.
        preferred = "gone";
        setApp("providers", providers());
        await settle();
        check(acct()?.classList.contains("missing") && acct()!.textContent?.includes("Removed account"), "the header says the account was removed");
        acct()!.click();
        await until(() => items().length === 4, "the account list for a removed account");
        check(document.querySelector(".mp-acct-note")?.textContent?.includes("removed"), "the list explains");
        check(!items().some((b) => b.getAttribute("aria-checked") === "true"), "no account is checked");
        calls.length = 0;
        item("Work").click();
        await until(() => calls.some(([m, p]) => m === "accounts.setDefault" && p.id === "work"), "choosing another account");
        // The switch refreshes the providers; let that land before changing them here.
        await until(() => acct()?.textContent?.includes("Work") === true && !acct()!.classList.contains("missing"), "the chosen account in the header");

        // One account: still shown, with Add account beside it.
        accounts = [account("default", "Default", { email: "me@example.test" })];
        preferred = "default";
        setApp("providers", providers());
        await settle();
        check(acct()?.textContent?.includes("Default"), "a lone account is shown too");
        acct()!.click();
        await until(() => items().length === 2, "the one account and Add account");
        check(item("Default").getAttribute("aria-checked") === "true", "the lone account is checked");

        // Add account: to Settings → Providers, with that provider's new-account form asked for.
        item("Add account").click();
        await until(() => !open(), "the picker to close");
        check(settingsTab() === "providers" && addAccountFor() === "claude-code", "Add account opens the provider's form in Settings");

        // Closing fades a still copy of the panel, which nothing can reach, and then removes it.
        const ghost = document.querySelector<HTMLElement>(".popover.mp.closing");
        check(ghost && ghost.inert && ghost.getAttribute("aria-hidden") === "true" && !ghost.querySelector("[id]"), "the closing copy is inert");
        await until(() => !document.querySelector(".popover.mp.closing"), "the closing copy to go");
        check(document.activeElement === trigger, "focus is back on the model button");
    } finally {
        if (motion === undefined) delete document.documentElement.dataset.motion;
        else document.documentElement.dataset.motion = motion;
        setSettingsTab(undefined);
        setAddAccountFor(undefined);
        dispose();
        box.remove();
        rpc.call = saved.call;
        setApp("models", saved.models);
        setApp("providers", saved.providers);
        setApp("activeId", saved.activeId);
        setApp("modelsLoading", saved.loading);
    }
}
