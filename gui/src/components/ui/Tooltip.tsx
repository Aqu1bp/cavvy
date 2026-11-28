// Tooltips, drawn as the design draws them: an ink label under what you point at, its keys as chips.
// One set of listeners on the document serves every element with a tooltip, so nothing is mounted or
// running while none shows; the label is created when it shows and removed when it hides.
//
// Any element gets one with `{...tip("Toggle the sidebar", "⌘+B")}` (or data-tip / data-keys by hand).
// A native `title` gets the same: while it's pointed at or focused its title is held back, so the
// system's tooltip doesn't show too, and an element named only by it keeps that name meanwhile.
// "Label (⌘K)", as withShortcut writes it, shows its keys as chips.
//
// Timing and place follow the design's (Radix's Tooltip: delayDuration 450, skipDelayDuration 200;
// side bottom, sideOffset 6, collisionPadding 8): it shows 450 ms after the pointer settles on the
// element, or at once on keyboard focus, or at once when another hid less than 200 ms ago. Keyboard focus is
// focus that a Tab, Shift+Tab or an arrow just moved: not a click's, and not the app's own (a drawer opening on
// its first button). It hides on leave, blur, press, click, Esc and scroll, when its element goes, and when its
// element moves or changes size (a panel opening beside it, the window resized). Not for touch.

import { For, Show, createRoot, onCleanup, onMount } from "solid-js";
import { TIP_DELAY, TIP_SKIP, focusFromKeys, movesFocus, placeTip, sameBox, splitTip } from "../../lib/tip";

export { tip } from "../../lib/tip";

type Shown = { el: Element; box: HTMLElement; dispose: () => void; gone: MutationObserver; at: DOMRect; sized: ResizeObserver };

/** What a transition moving an element's box changes: one of these on what holds the element moves it. */
const MOVES = /^(?:transform|translate|scale|left|top|right|bottom|inset|width|height|margin|padding|grid-template)/;

/** The tooltip runtime: mounted once (main.tsx); it adds the document's listeners and removes them on cleanup. */
export function Tooltips() {
    onMount(() => {
        const doc = document;
        let pending: { el: Element; timer: number } | undefined;
        let shown: Shown | undefined;
        let hiddenAt = -Infinity;
        /** The element a press landed on: it gets no tooltip until the pointer leaves it (as Radix does). */
        let pressed: Element | undefined;
        /** When a key that moves focus (Tab, an arrow) was last pressed: focus that follows it is the keyboard's. */
        let keyAt = -Infinity;

        const target = (n: EventTarget | null) => (n instanceof Element ? n.closest("[data-tip], [title], [data-tip-held]") : null);

        /** The element whose native title is held back while it's pointed at or focused, so the system's tooltip doesn't show too. */
        let held: { el: Element; title: string; named: boolean; described: boolean } | undefined;

        /** Its text: data-tip, or its title, which is taken off until it's let go (an element named only by it keeps the name meanwhile). */
        function take(el: Element): string | undefined {
            if (held?.el === el) return held.title;
            letGo();
            const title = el.getAttribute("title");
            if (title === null) return el.getAttribute("data-tip") || undefined;
            el.removeAttribute("title");
            // Still found as the element with the tooltip while its title is held.
            el.setAttribute("data-tip-held", "");
            const labelled = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
            const named = !labelled && !el.textContent?.trim();
            const described = !named && !el.hasAttribute("aria-describedby") && !el.hasAttribute("aria-description");
            if (named) el.setAttribute("aria-label", title);
            if (described) el.setAttribute("aria-description", title);
            held = { el, title, named, described };
            return title.trim() || undefined;
        }

        function letGo() {
            if (!held) return;
            const { el, title, named, described } = held;
            held = undefined;
            el.removeAttribute("data-tip-held");
            if (named) el.removeAttribute("aria-label");
            if (described) el.removeAttribute("aria-description");
            // Unless the app set a new one meanwhile.
            if (!el.hasAttribute("title")) el.setAttribute("title", title);
        }

        /** `keep`: the title stays held (a press: the pointer is still on the element). */
        function cancel(keep = false) {
            if (!pending) return;
            clearTimeout(pending.timer);
            pending = undefined;
            if (!shown && !keep) letGo();
        }

        function hide(keep = false) {
            cancel(keep);
            if (!shown) return;
            if (!keep) letGo();
            shown.gone.disconnect();
            shown.sized.disconnect();
            shown.dispose();
            shown.box.remove();
            shown = undefined;
            hiddenAt = performance.now();
        }

        function show(el: Element) {
            cancel(true);
            if (shown?.el === el) return;
            if (shown) hide(held?.el === el);
            const text = take(el);
            // A tooltip for something whose menu is open is just noise (the design hides it the same way).
            if (!text || !el.isConnected || doc.querySelector(".menu")) return letGo();
            const given = el.getAttribute("data-keys");
            const { label, keys } = given ? { label: text, keys: given.split(" ").filter(Boolean) } : splitTip(text);
            const [box, dispose] = createRoot((dispose) => [
                (
                    <div class="tooltip" classList={{ lines: label.includes("\n") }} role="tooltip" data-side="bottom">
                        {label}
                        <Show when={keys?.length}>
                            <span class="kbd-group" aria-hidden="true">
                                <For each={keys}>{(k) => <kbd class="kbd">{k}</kbd>}</For>
                            </span>
                        </Show>
                    </div>
                ) as HTMLElement,
                dispose,
            ] as const);
            doc.body.append(box);
            place(el, box);
            // Its element removed (a row re-rendered, a dialog closed) takes the tooltip with it.
            const gone = new MutationObserver(() => {
                if (!el.isConnected) hide();
            });
            gone.observe(doc.body, { childList: true, subtree: true });
            // It or what holds it resized (a panel opened beside it, the rail narrowed): it hides if that moved it.
            const sized = new ResizeObserver(moved);
            for (let n: Element | null = el; n && n !== doc.documentElement; n = n.parentElement) sized.observe(n);
            shown = { el, box, dispose, gone, at: el.getBoundingClientRect(), sized };
        }

        /** Its element moved or changed size since it showed: it would point at the wrong place. */
        function moved() {
            if (shown && !sameBox(shown.el.getBoundingClientRect(), shown.at)) hide();
        }

        function place(el: Element, box: HTMLElement) {
            const at = placeTip(el.getBoundingClientRect(), box.offsetWidth, box.offsetHeight, doc.documentElement.clientWidth, doc.documentElement.clientHeight, el.getAttribute("data-tip-side") === "left" ? "left" : undefined);
            box.style.left = `${at.left}px`;
            box.style.top = `${at.top}px`;
            box.dataset.side = at.side;
        }

        const over = (e: PointerEvent) => {
            if (e.pointerType === "touch") return;
            const el = target(e.target);
            if (!el || el === pressed) return;
            if (shown?.el === el || pending?.el === el) return;
            if (performance.now() - hiddenAt < TIP_SKIP || shown) return show(el);
            cancel();
            if (!take(el)) return letGo();
            pending = { el, timer: window.setTimeout(() => show(el), TIP_DELAY) };
        };
        const out = (e: PointerEvent) => {
            const el = target(e.target);
            if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
            if (el === pressed) pressed = undefined;
            if (pending?.el === el) cancel();
            if (shown?.el === el) hide();
            if (held?.el === el) letGo();
        };
        const down = (e: PointerEvent) => {
            pressed = target(e.target) ?? undefined;
            hide(pressed !== undefined && held?.el === pressed);
        };
        const focusIn = (e: FocusEvent) => {
            const el = target(e.target);
            if (el && el !== pressed && focusFromKeys(keyAt, performance.now()) && e.target instanceof Element && e.target.matches(":focus-visible")) show(el);
        };
        const focusOut = (e: FocusEvent) => {
            const el = shown?.el ?? held?.el;
            if (el && e.target instanceof Node && el.contains(e.target) && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) && el !== pressed && pending?.el !== el) {
                hide();
                letGo();
            }
        };
        const key = (e: KeyboardEvent) => {
            if (movesFocus(e.key)) keyAt = performance.now();
            if (e.key === "Escape" && shown) hide(true);
        };
        /** Something that holds it starts sliding or resizing (a drawer, a panel): it goes at once. Other motion is checked once done. */
        const motion = (e: TransitionEvent) => {
            if (shown && e.target instanceof Element && e.target !== shown.el && e.target.contains(shown.el) && MOVES.test(e.propertyName)) hide();
        };
        const settled = (e: Event) => {
            if (shown && e.target instanceof Node && e.target.contains(shown.el)) moved();
        };
        /** A scroll that moves the element hides its tooltip (as Radix's does); others leave it. */
        const scroll = (e: Event) => {
            const el = shown?.el ?? pending?.el;
            if (el && e.target instanceof Node && (e.target === doc || e.target.contains(el))) hide();
        };

        const on = { capture: true, passive: true };
        const listeners: [string, (e: any) => void][] = [
            ["pointerover", over], ["pointerout", out], ["pointerdown", down], ["click", () => hide(true)],
            ["focusin", focusIn], ["focusout", focusOut], ["keydown", key], ["scroll", scroll],
            ["transitionrun", motion], ["transitionend", settled], ["animationend", settled],
        ];
        for (const [type, fn] of listeners) doc.addEventListener(type, fn, on);
        const blur = () => hide();
        window.addEventListener("blur", blur);
        window.addEventListener("resize", blur);
        onCleanup(() => {
            hide();
            for (const [type, fn] of listeners) doc.removeEventListener(type, fn, on);
            window.removeEventListener("blur", blur);
            window.removeEventListener("resize", blur);
        });
    });
    return null;
}
