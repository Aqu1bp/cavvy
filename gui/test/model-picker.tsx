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
    // A subscription's accounts in the heading, each by its name (and a plan near its limit); + adds one.
    const pills = () => inPanel<HTMLButtonElement>(".mp-h .mp-acs .mp-ac");
    const named = (b: Element) => b.querySelector(".truncate")?.textContent;
    const pill = (name: string) => pills().find((b) => named(b) === name)!;
    const pressed = () => pills().filter((b) => b.getAttribute("aria-pressed") === "true").map(named).join();
    const add = () => panel()?.querySelector<HTMLButtonElement>(".mp-h .mp-ac.add");
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

        // The current model: only an accent check (and a hair heavier name). Names never show ids: the line under one
        // does, for a name that doesn't say it ("Default (recommended)" → claude-opus-5-5), with its context and price, and
        // so does the tooltip.
        const current = row("Opus 5.5");
        check(current, `rows read as clean names (${rows().map((r) => r.textContent).join(" | ")})`);
        check(rows().every((r) => !/claude-/.test(r.querySelector(".mr-name")?.textContent ?? "")), `names show no model ids (${rows().map((r) => r.textContent).join(" | ")})`);
        check(row("Default (recommended)")?.querySelector(".mr-sub")?.textContent?.includes("claude-opus-5-5"), "an alias's line says the id it stands for");
        check(row("Default (recommended)").querySelector("[role='option']")?.getAttribute("title")?.includes("claude-opus-5-5"), "and so does its tooltip");
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
        const search = document.querySelector<HTMLInputElement>(".mp-search input")!;
        const type = (value: string) => {
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

        // Several accounts: pills in the provider's heading, the session's one pressed and filled, the others a click away.
        check(pills().map(named).join() === "Personal,Work,Lab" && pill("Work").closest("[role='group']")?.getAttribute("aria-label") === "Claude Code account", `the heading has the accounts (${pills().map(named).join()})`);
        check(pressed() === "Work" && pill("Work").classList.contains("on") && bg(pill("Work")) !== bg(pill("Lab")), `the session's account is pressed and filled (${pressed()})`);
        check(pill("Personal").title.includes("me@example.test") && pill("Lab").title.includes("Not signed in"), `accounts say who they are and what's wrong (${pill("Personal").title}; ${pill("Lab").title})`);

        // Switching calls setAccount (on Home: the provider's default), and the heading follows.
        pill("Personal").click();
        await until(() => pressed() === "Personal", "the switched account pressed in the heading");
        check(calls.some(([m, p]) => m === "accounts.setDefault" && p.provider === "claude-code" && p.id === "default"), "switching sets the account");
        check(panel() && open(), "the picker stays open after switching");

        // A removed account: the picker opens on the accounts, none pressed, and a note asks for another.
        preferred = "gone";
        setApp("providers", providers());
        await reopen("on the accounts");
        check(document.activeElement === pill("Personal"), `the picker opens on the accounts (focus: ${document.activeElement?.outerHTML.slice(0, 80)})`);
        check(panel()!.querySelector(".mp-acct-note")?.textContent?.includes("removed"), "the note explains");
        check(pressed() === "", "no account is pressed");
        check(trigger.textContent?.includes("Removed account"), "the model button says the account was removed");
        calls.length = 0;
        pill("Work").click();
        await until(() => calls.some(([m, p]) => m === "accounts.setDefault" && p.id === "work"), "choosing another account");
        // The switch refreshes the providers; let that land before changing them here.
        await until(() => pressed() === "Work" && !panel()!.querySelector(".mp-acct-note"), "the chosen account in the heading");

        // One account: shown by its name, with + beside it.
        accounts = [account("default", "Default", { email: "me@example.test" })];
        preferred = "default";
        setApp("providers", providers());
        await settle();
        const lone = panel()!.querySelector<HTMLElement>(".mp-h .mp-acct1");
        check(lone?.textContent === "Default" && lone.title.includes("me@example.test") && !pills().length, "a lone account goes by its name");
        check(add()?.getAttribute("aria-label") === "Add a Claude Code account", "with + beside it");

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

        // Many accounts (the server allows 20): the pills stay inside the picker, which clips what overflows their row.
        // Every account can be scrolled to and clicked, + is always in view, and the keys scroll.
        const inside = (el: Element, box: DOMRect) => {
            const r = el.getBoundingClientRect();
            return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        };
        const hit = (el: Element) => {
            const r = el.getBoundingClientRect();
            return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === el;
        };
        // The accounts' row, and the part of it in view.
        const strip = () => panel()?.querySelector<HTMLElement>(".mp-acs");
        const shown = () => strip()!.getBoundingClientRect();
        for (const n of [8, 20]) {
            accounts = Array.from({ length: n }, (_, i) => account(i ? `a${i}` : "default", `Account ${i + 1}`, { email: `person${i + 1}@example.test`, plan: "max" }));
            preferred = `a${n - 1}`;
            setApp("providers", providers());
            await reopen(`with ${n} accounts`);
            const box = panel()!.getBoundingClientRect();
            check(pills().length === n && inside(strip()!, box), `the ${n} accounts stay inside the picker (${JSON.stringify(shown())} in ${JSON.stringify(box)})`);
            check(inside(add()!, box) && hit(add()!), `+ is in view and clickable with ${n} accounts`);
            for (const b of pills()) {
                b.scrollIntoView({ block: "nearest", inline: "nearest" });
                check(inside(b, shown()) && hit(b), `${named(b)} can be scrolled to and clicked (of ${n})`);
            }
            check(inside(add()!, box) && hit(add()!), `+ stays put while the accounts scroll (${n})`);
            // Keys: Tab onto the first account brings it into view; Shift+Tab from + reaches the last, and Tab goes back.
            filter("Mock").focus();
            key("Tab");
            check(document.activeElement === pill("Account 1") && inside(pill("Account 1"), shown()) && hit(pill("Account 1")), `Tab scrolls to the first of ${n}`);
            add()!.focus();
            key("Tab", undefined, { shiftKey: true });
            check(document.activeElement === pill(`Account ${n}`) && inside(pill(`Account ${n}`), shown()) && hit(pill(`Account ${n}`)), `Shift+Tab from + scrolls to the last of ${n}`);
            key("Tab");
            check(document.activeElement === add() && hit(add()!), `Tab reaches + (${n})`);
        }
        // Opening on many: the session's account, the last of 20, is the one in view.
        await reopen("with 20 accounts again");
        check(pressed() === "Account 20" && inside(pill("Account 20"), shown()) && hit(pill("Account 20")), `the picker opens with the session's account, the last of 20, in view (row ${JSON.stringify(shown())}, account ${JSON.stringify(pill("Account 20").getBoundingClientRect())}, scrolled ${strip()!.scrollLeft} of ${strip()!.scrollWidth - strip()!.clientWidth})`);
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
