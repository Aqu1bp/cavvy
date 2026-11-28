// The drawn tooltips (components/ui/Tooltip.tsx) in a real browser: shown after the design's delay, gone on
// leave with the title given back, at once on a neighbour, keys as chips, not over an open menu, nothing left.
import { render } from "solid-js/web";
import { Tooltips } from "../src/components/ui/Tooltip";
import { tip } from "../src/lib/tip";

function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(`tooltips: ${message}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shown = () => document.querySelector<HTMLElement>(".tooltip");
const enter = (el: Element, from: Element | null) => {
    from?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: el }));
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", relatedTarget: from }));
};

export async function checkTooltips(root: HTMLElement) {
    const box = document.createElement("div");
    box.style.cssText = "position: fixed; left: 40px; top: 40px; display: flex; gap: 8px";
    root.append(box);
    const away = document.createElement("div");
    away.style.cssText = "position: fixed; left: 400px; top: 400px; width: 20px; height: 20px";
    root.append(away);
    const dispose = render(() => (
        <>
            <button class="hide" title="Hide sidebar (⌘B)">
                <svg width="16" height="16"><rect width="16" height="16" /></svg>
            </button>
            <button class="near" {...tip("New session", "⌘+N")}>N</button>
            <button class="words" title="Pause the goal (it stops after this step)">Pause</button>
        </>
    ), box);
    const stop = render(() => <Tooltips />, document.createElement("div"));
    try {
        const hide = box.querySelector(".hide")!;
        const icon = hide.querySelector("svg")!;
        check(!shown(), "nothing at rest");
        enter(icon, away);
        await wait(300);
        check(!shown(), "not before the delay");
        check(!hide.hasAttribute("title") && hide.getAttribute("aria-label") === "Hide sidebar (⌘B)", "the title is held, the name kept");
        await wait(250);
        const t = shown();
        check(t?.firstChild?.textContent === "Hide sidebar" && [...t.querySelectorAll("kbd")].map((k) => k.textContent).join(" ") === "⌘ B", `label and key chips: ${t?.outerHTML}`);
        const r = t.getBoundingClientRect();
        const b = hide.getBoundingClientRect();
        check(Math.round(r.top - b.bottom) === 6 && Math.abs(r.left + r.width / 2 - (b.left + b.width / 2)) < 1 || r.left === 8, `6 px under, centred: ${JSON.stringify(r)} ${JSON.stringify(b)}`);
        // Leaving from the icon inside it hides it and gives the title back.
        enter(away, icon);
        check(!shown(), "gone on leave");
        check(hide.getAttribute("title") === "Hide sidebar (⌘B)" && !hide.hasAttribute("aria-label") && !hide.hasAttribute("data-tip-held"), "title given back");
        // A neighbour within 200 ms shows at once.
        const near = box.querySelector(".near")!;
        enter(near, away);
        check(shown()?.textContent === "New session⌘N", "a neighbour shows at once");
        enter(away, near);
        await wait(250);
        enter(near, away);
        check(!shown(), "after the skip window, the delay again");
        await wait(500);
        check(shown(), "and then it shows");
        // A press hides it, and it stays hidden while the pointer is on it.
        near.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
        check(!shown(), "a press hides it");
        enter(away, near);
        // Words in brackets stay words.
        const words = box.querySelector(".words")!;
        await wait(250);
        enter(words, away);
        await wait(500);
        check(shown()?.textContent === "Pause the goal (it stops after this step)" && !shown()!.querySelector("kbd"), "words stay words");
        enter(away, words);
        // Not over an open menu.
        const menu = document.createElement("div");
        menu.className = "menu";
        root.append(menu);
        await wait(250);
        enter(hide, away);
        await wait(500);
        check(!shown(), "no tooltip while a menu is open");
        enter(away, hide);
        menu.remove();
        check(!document.querySelector("[data-tip-held]") && box.querySelector(".hide")!.getAttribute("title") === "Hide sidebar (⌘B)", "nothing held at the end");
    } finally {
        stop();
        dispose();
        box.remove();
        away.remove();
    }
    check(!shown(), "nothing left after cleanup");
}
