// Find in a conversation whose finished turns come folded (gui/src/components/FindBar.tsx): their matches are the
// server's (session.find). Until the server has answered for the query typed, the last query's answer isn't taken for
// this one's, and a jump from ⌘K into a folded turn waits for it rather than landing somewhere else.
import assert from "node:assert/strict";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
const { createEffect, createMemo, createRoot, createSignal, on, onCleanup, onMount, untrack } = solid;
import { componentCode, node } from "../gui-component-harness";
import { allMatches } from "../../gui/src/lib/find";

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setTimeout(r, 0)); };
const turns = [
    { id: "f", status: "done", folded: true, startedAt: 1, prompt: { text: "first" }, blocks: [] },
    { id: "t", status: "done", startedAt: 2, prompt: { text: "second" }, blocks: [{ t: "text", id: "x", text: "foo here, and there" }] },
];
const [findQuery, setFindQuery] = createSignal("");
const [anchor, setAnchor] = createSignal<{ turnId: string; role: "user" | "assistant" } | undefined>();
const reveals: (string | undefined)[] = [];
const asked: { q: string; answer: (ms: { turnId: string; part: string; n: number }[]) => void }[] = [];
let cleared = 0;
const FindBar = componentCode("FindBar", {
    createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, node, Show: "Show",
    ChevronUp: "i", ChevronDown: "i", X: "i",
    allMatches, clearPaint() {}, MAX_MATCHES: 999, paintMatches() {}, revealInBoxes() {}, textRanges: () => [],
    FAR: "data-far", findFocus: () => 0, findQuery, setFindOpen() {}, setFindQuery, setFindReveal: (r?: { turnId: string }) => reveals.push(r?.turnId),
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
});
createRoot(() => FindBar({
    turns: () => turns, earlier: () => 0, gap: () => undefined,
    elsewhere: (q: string) => new Promise((answer) => asked.push({ q, answer })),
    bring: async () => {}, whole: async () => {}, scroller: () => undefined, col: () => undefined, dock: () => 0, show() {},
    anchor, clearAnchor: () => (cleared++, setAnchor(undefined)),
}));

try {
    await settle();
    // "foo": the server finds it in the folded turn's work too.
    setFindQuery("foo");
    await settle();
    asked.at(-1)!.answer([{ turnId: "f", part: "work:0", n: 0 }]);
    await settle();
    // Refined to "foobar", not answered yet (nothing the window has holds it): the folded turn's "foo" isn't one of
    // its matches, so nothing goes there.
    reveals.length = 0;
    setFindQuery("foobar");
    await settle();
    assert.ok(!reveals.includes("f"), `went to the last query's match: ${JSON.stringify(reveals)}`);

    // A jump from ⌘K into the folded turn, before the server has answered for its query: kept for that answer.
    setAnchor({ turnId: "f", role: "assistant" });
    setFindQuery("there");
    await settle();
    assert.equal(cleared, 0, "the jump waits for the server's answer");
    asked.at(-1)!.answer([{ turnId: "f", part: "work:0", n: 0 }]);
    await settle();
    assert.equal(cleared, 1);
    assert.equal(reveals.at(-1), "f", "the jump lands in its turn");
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
