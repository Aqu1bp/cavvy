// The model picker in a real browser: the current model's marks, the keyboard highlight apart from them, the
// provider filters, and a subscription's accounts in its heading. The real component, store and actions; only RPC is stubbed.
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
    // The open panel's, not the closing copy's: reopening the picker builds them anew.
    const panel = () => document.querySelector<HTMLElement>(".popover.mp:not(.closing)");
    const inPanel = <T extends HTMLElement = HTMLElement>(selector: string) => [...(panel()?.querySelectorAll<T>(selector) ?? [])];
    const rows = () => inPanel(".mr");
    const row = (name: string) => rows().find((r) => r.querySelector(".mr-name")?.textContent === name)!;
    // A filter by its name, after its mark (a provider without one has a monogram: "MO" for Mock).
    const filter = (name: string) => inPanel(".mp-filters [role='tab']").find((t) => t.lastElementChild?.textContent === name)!;
    // A subscription's account in the heading: one button naming the session's, which opens a short list of them (each
    // by its name, and a plan near its limit), then "Add account".
    const acctButton = () => panel()?.querySelector<HTMLButtonElement>(".mp-h .mp-acct-btn");
    const list = () => panel()?.querySelector<HTMLElement>(".mp-h .mp-acct-menu");
    const named = (b: Element) => b.querySelector(".truncate")?.textContent;
    const items = () => inPanel<HTMLButtonElement>(".mp-acct-menu [role='menuitemradio']");
    const item = (name: string) => items().find((b) => named(b) === name)!;
    const checked = () => items().filter((b) => b.getAttribute("aria-checked") === "true").map(named).join();
    const add = () => panel()?.querySelector<HTMLButtonElement>(".mp-acct-menu [role='menuitem']");
    /** Opens the list from its button, as Enter on it does (a click from the keyboard: focus goes into the list). */
    const openList = async () => {
        if (!list()) acctButton()!.click();
        await settle();
        check(list(), "the list of accounts opens from its button");
    };
    const key = (key: string, target: Element = document.activeElement!, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    const bg = (el: Element) => getComputedStyle(el).backgroundColor;
    /** Closes the picker, lets its closing copy go, and opens it again, as a click on the model button does. */
    const reopen = async (what: string) => {
        setOpen(false);
        await until(() => !document.querySelector(".popover.mp"), "the picker to close");
        trigger.click();
        await until(() => !!panel()?.contains(document.activeElement), `the picker to open ${what}`);
        await settle(250);
    };
    try {
        trigger.focus();
        trigger.click();
        await until(() => !!panel() && document.activeElement?.matches(".mp-search input") === true, "the picker to open on the search field");
        await settle(250);

        // The current model: only an accent check (and a hair heavier name). Rows are just names: no ids, context or price.
        const current = row("Opus 5.5");
        check(current, `rows read as clean names (${rows().map((r) => r.textContent).join(" | ")})`);
        check(rows().every((r) => !/claude-/.test(r.querySelector(".mr-name")?.textContent ?? "")), `names show no model ids (${rows().map((r) => r.textContent).join(" | ")})`);
        check(rows().every((r) => !r.querySelector(".mr-sub")), `rows have no line under the name (${rows().map((r) => r.textContent).join(" | ")})`);
        check(current.querySelector(".mr-mark svg")?.checkVisibility(), "the current model has a check");
        check(rows().filter((r) => r.querySelector(".mr-mark svg")).length === 1, "only the current model has a check");
        check(current.querySelector("[role='option']")?.getAttribute("aria-selected") === "true", "the current model is the selected option");
        const plain = row("Haiku 4.5");
        const weight = (r: Element) => Number(getComputedStyle(r.querySelector(".mr-name")!).fontWeight);
        check(weight(current) >= weight(plain) && weight(current) <= 600, `the current model's name is at most semibold (${weight(current)})`);
        // It opens highlighted (the keyboard's place), and that neutral fill is the only one.
        check(current.classList.contains("sel") && bg(current) !== bg(plain), "the picker opens with the current model highlighted");
        const neutral = bg(current);
        // The filters have no mark for the current model's provider: only the open filter's fill, and the label for screen readers.
        const filterCurrent = filter("Claude Code");
        check(/current model/.test(filterCurrent.getAttribute("aria-label") ?? ""), "screen readers hear which provider has the current model");
        check(!panel()!.querySelector(".mp-filters .bar, .mp-filters .mp-f-cur, .mp-filters .mp-f.cur"), "the filters have no current-provider marker");
        check([...filterCurrent.children].every((c) => c.matches(".provider-icon, .provider-mono") || (c.matches("span") && c.textContent === "Claude Code")), `the current provider's pill holds only its mark and name (${filterCurrent.innerHTML.slice(0, 200)})`);

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
        const hint = highlighted.querySelector("kbd")!;
        check(getComputedStyle(hint).opacity === "1" && hint.checkVisibility() && hint.textContent?.endsWith("3"), `the highlighted row shows its shortcut (${hint.textContent})`);
        check(getComputedStyle(plain.querySelector(".mr-star")!).opacity === "0" && getComputedStyle(highlighted.querySelector(".mr-star")!).opacity === "1", "stars are quiet until the row is highlighted");

        // Search still matches ids, though names don't show them: "haiku-4-5" isn't in Haiku 4.5's name. Results sit
        // under their provider's name.
        // The field as it is now: reopening the picker builds a new one.
        const type = (value: string) => {
            const search = document.querySelector<HTMLInputElement>(".mp-search input")!;
            search.value = value;
            search.dispatchEvent(new InputEvent("input", { bubbles: true }));
        };
        type("haiku-4-5");
        await settle();
        const found = rows()[0]?.closest(".mp-group");
        check(rows().length === 1 && rows()[0]!.querySelector(".mr-name")?.textContent === "Haiku 4.5" && found?.getAttribute("aria-label") === "Claude Code" && found.querySelector(".mp-h b")?.textContent === "Claude Code", `search by id finds the model (${rows().map((r) => r.textContent).join(" | ")})`);
        type("");
        await settle();

        // Another provider's list open: its filter has the neutral fill; the current model's provider looks like any other.
        const filterMock = filter("Mock");
        const filterFavorites = filter("Favorites");
        filterMock.click();
        await settle(200);
        check(filterMock.classList.contains("on") && filterMock.getAttribute("aria-selected") === "true" && bg(filterMock) !== "rgba(0, 0, 0, 0)" && rows().length === 2, "the open filter has a neutral fill, and the list is its provider's alone");
        check(row("local-7b"), "a model with no name goes by its id");
        check(!filterCurrent.classList.contains("on") && bg(filterCurrent) === bg(filterFavorites) && getComputedStyle(filterCurrent).color === getComputedStyle(filterFavorites).color, "the current model's provider has no mark while another list is open");
        filterCurrent.click();
        await settle();

        // Several accounts: the heading names the session's; its list has them all, that one checked, then Add account.
        check(named(acctButton()!) === "Work" && acctButton()!.getAttribute("aria-haspopup") === "menu" && acctButton()!.getAttribute("aria-expanded") === "false" && !list(), `the heading names the session's account, its list closed (${acctButton()?.textContent})`);
        await openList();
        check(items().map(named).join() === "Personal,Work,Lab" && list()!.getAttribute("aria-label") === "Claude Code account", `the list has the accounts (${items().map(named).join()})`);
        check(checked() === "Work" && item("Work").querySelector(".mp-acct-ck svg") && !item("Lab").querySelector(".mp-acct-ck svg"), `the session's account is checked (${checked()})`);
        check(acctButton()!.getAttribute("aria-expanded") === "true" && named(add()!) === "Add account", `Add account comes last (${add()?.textContent})`);
        check(item("Personal").title.includes("me@example.test") && item("Lab").title.includes("Not signed in"), `accounts say who they are and what's wrong (${item("Personal").title}; ${item("Lab").title})`);

        // Keys: opened from the keyboard, the list starts on the session's account; ↓, ↑, Home and End move through it, and
        // Escape closes the list (not the picker), back on its button, where ↓ opens it again.
        check(document.activeElement === item("Work"), `the list starts on the session's account (focus: ${document.activeElement?.outerHTML.slice(0, 80)})`);
        key("ArrowDown");
        check(document.activeElement === item("Lab"), "↓ moves down the list");
        key("ArrowDown");
        check(document.activeElement === add(), "and on to Add account");
        key("Home");
        check(document.activeElement === item("Personal"), "Home goes to the first account");
        key("End");
        check(document.activeElement === add(), "End to Add account");
        key("Escape");
        await settle();
        check(!list() && document.activeElement === acctButton() && panel() && open(), `Escape closes the list, not the picker, and focus is back on its button (focus: ${document.activeElement?.outerHTML.slice(0, 80)})`);
        key("ArrowDown");
        check(list() && document.activeElement === item("Work"), "↓ on the button opens the list again");

        // Picking one switches the account (on Home: the provider's default): the list closes, and the heading follows.
        item("Personal").click();
        await until(() => named(acctButton()!) === "Personal" && !list(), "the switched account in the heading");
        check(calls.some(([m, p]) => m === "accounts.setDefault" && p.provider === "claude-code" && p.id === "default"), "switching sets the account");
        check(panel() && open(), "the picker stays open after switching");

        // A removed account: the picker opens on the list of accounts, none checked, and a note asks for another.
        preferred = "gone";
        setApp("providers", providers());
        await reopen("on the accounts");
        check(list() && document.activeElement === item("Personal"), `the picker opens on the list of accounts (focus: ${document.activeElement?.outerHTML.slice(0, 80)})`);
        check(panel()!.querySelector(".mp-acct-note")?.textContent?.includes("removed"), "the note explains");
        check(checked() === "" && named(acctButton()!) === "Choose account" && acctButton()!.classList.contains("missing"), `no account is checked, and the heading asks for one (${checked()}; ${acctButton()?.textContent})`);
        check(trigger.textContent?.includes("Removed account"), "the model button says the account was removed");
        calls.length = 0;
        item("Work").click();
        await until(() => calls.some(([m, p]) => m === "accounts.setDefault" && p.id === "work"), "choosing another account");
        // The switch refreshes the providers; let that land before changing them here.
        await until(() => named(acctButton()!) === "Work" && !panel()!.querySelector(".mp-acct-note"), "the chosen account in the heading");

        // One account: the heading names it, and its list is it and Add account.
        accounts = [account("default", "Default", { email: "me@example.test" })];
        preferred = "default";
        setApp("providers", providers());
        await settle();
        check(named(acctButton()!) === "Default" && acctButton()!.title.includes("me@example.test"), `a lone account goes by its name (${acctButton()?.textContent}; ${acctButton()?.title})`);
        await openList();
        check(items().map(named).join() === "Default" && checked() === "Default" && add(), `its list is it and Add account (${list()?.textContent})`);

        // Add account: to Settings → Providers, with that provider's new-account form asked for.
        add()!.click();
        await until(() => !open(), "the picker to close");
        check(settingsTab() === "providers" && addAccountFor() === "claude-code", "Add account opens the provider's form in Settings");

        // Closing fades a still copy of the panel, which nothing can reach, and then removes it.
        const ghost = document.querySelector<HTMLElement>(".popover.mp.closing");
        check(ghost && ghost.inert && ghost.getAttribute("aria-hidden") === "true" && !ghost.querySelector("[id]"), "the closing copy is inert");
        await until(() => !document.querySelector(".popover.mp.closing"), "the closing copy to go");
        check(document.activeElement === trigger, "focus is back on the model button");
        // Out of Settings again: popovers close while it's open.
        setSettingsTab(undefined);
        setAddAccountFor(undefined);

        // Many accounts (the server allows 20): the list stays inside the picker and scrolls. It opens on the session's
        // account, the last, in view; every account can be scrolled to and clicked, and so can Add account.
        const inside = (el: Element, box: DOMRect) => {
            const r = el.getBoundingClientRect();
            return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        };
        const hit = (el: Element) => {
            const r = el.getBoundingClientRect();
            return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === el;
        };
        // The part of the list in view.
        const shown = () => list()!.getBoundingClientRect();
        for (const n of [8, 20]) {
            accounts = Array.from({ length: n }, (_, i) => account(i ? `a${i}` : "default", `Account ${i + 1}`, { email: `person${i + 1}@example.test`, plan: "max" }));
            preferred = `a${n - 1}`;
            setApp("providers", providers());
            await reopen(`with ${n} accounts`);
            await openList();
            const box = panel()!.getBoundingClientRect();
            check(items().length === n && inside(list()!, box), `the list of ${n} stays inside the picker (${JSON.stringify(shown())} in ${JSON.stringify(box)})`);
            const last = item(`Account ${n}`);
            check(document.activeElement === last && inside(last, shown()) && hit(last), `the list opens on the session's account, the last of ${n}, in view (${JSON.stringify(last.getBoundingClientRect())} in ${JSON.stringify(shown())})`);
            for (const b of [...items(), add()!]) {
                b.scrollIntoView({ block: "nearest", inline: "nearest" });
                check(inside(b, shown()) && hit(b), `${named(b)} can be scrolled to and clicked (of ${n})`);
            }
            // Keys scroll it too: Home to the first account, End to Add account.
            last.focus();
            key("Home");
            check(document.activeElement === item("Account 1") && inside(item("Account 1"), shown()) && hit(item("Account 1")), `Home scrolls to the first of ${n}`);
            key("End");
            check(document.activeElement === add() && inside(add()!, shown()) && hit(add()!), `End scrolls to Add account (${n})`);
        }
        // A search takes the heading's account away (and closes its list); clearing it brings it back, naming the session's.
        await reopen("with 20 accounts again");
        await openList();
        type("haiku");
        await settle();
        check(!acctButton() && !list(), "a search takes the heading's account away");
        type("");
        await settle();
        check(named(acctButton()!) === "Account 20" && !list(), `a cleared search brings it back, naming the session's account, its list closed (${acctButton()?.textContent})`);
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
