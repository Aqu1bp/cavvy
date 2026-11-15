// A popover's `open` read from the page's listeners (gui/src/components/ui/Popover.tsx). A prop like `open={a() && b()}`
// is compiled to a getter that makes a memo each time it's read: read where nothing owns it (a pointerdown on the
// page), each was never let go of, and kept what passed it (a composer and its conversation) alive after it was gone.
import assert from "node:assert/strict";
import * as solid from "../../gui/node_modules/solid-js/dist/dev.js";
import { componentCode, node } from "../gui-component-harness";

const unowned: string[] = [];
const warn = console.warn;
console.warn = (...x: unknown[]) => (String(x[0]).includes("computations created outside") ? unowned.push(String(x[0])) : warn(...x));
const listeners = new Map<string, ((e: unknown) => void)[]>();
Object.assign(globalThis, {
    document: { addEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, [...(listeners.get(t) ?? []), f]), removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 },
    requestAnimationFrame: () => 0,
});

const Popover = componentCode("Popover", {
    ...solid, node, Show: "Show", Portal: "Portal",
    mountMenu: () => () => {}, placePopover: () => ({ top: 0, left: 0 }), sp: (n: number) => n, settingsTab: () => undefined,
}, undefined, "ui/Popover");

const [picked, setPicked] = solid.createSignal(false);
const [focused] = solid.createSignal(true);
let disposeAll = () => {};
solid.createRoot((dispose) => {
    disposeAll = dispose;
    Popover({
        // As `open={picked() && focused()}` is compiled: a memo made on each read.
        get open() { return solid.createMemo(() => !!picked())() && focused(); },
        anchor: () => undefined, onClose: () => setPicked(false), children: [],
    });
});
try {
    solid.createRoot(() => {}); // flush mounts
    await new Promise((r) => setTimeout(r, 0));
    setPicked(true);
    for (let i = 0; i < 20; i++) for (const f of listeners.get("pointerdown") ?? []) f({ target: {} });
    for (const f of listeners.get("keydown") ?? []) f({ key: "Escape", stopPropagation() {} });
    // It did listen on the page, and a click outside it closed it.
    assert.ok((listeners.get("pointerdown") ?? []).length > 0, "listens for clicks on the page");
    assert.equal(picked(), false, "a click outside it closes it");
    assert.deepEqual(unowned, [], "open read from the page's listeners makes nothing that's never let go of");
    disposeAll();
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
