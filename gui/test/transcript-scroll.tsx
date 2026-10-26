// Real-browser layout checks; the fixture uses local in-memory sessions only.
import { render } from "solid-js/web";
import { createStore } from "solid-js/store";
import { Transcript } from "../src/components/Transcript";
import { setPrefs } from "../src/state/prefs";
import { setFindOpen, setFindQuery } from "../src/state/ui";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/transcript.css";
import "../src/styles/markdown.css";

let root: HTMLElement;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const near = (actual: number, wanted: number, message: string) => check(Math.abs(actual - wanted) <= 2, `${message}: ${actual} vs ${wanted}`);
const makeTurns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, status: "done", archived: true, prompt: { text: `Prompt ${i}` }, blocks: [{ id: `b${i}`, t: "text", text: `Reply ${i}:\n\n${"Readable reply. ".repeat(35)}` }] }));
const state = { id: "scroll-a", busy: false, interactions: [], cwd: "/tmp" };
const [view, setView] = createStore<any>({ turns: makeTurns(45), state, agents: [] });
const a = { id: "scroll-a", view } as any;
const b = { id: "scroll-b", view: { turns: makeTurns(3), state: { ...state, id: "scroll-b" }, agents: [] } } as any;
const scroller = () => root.querySelector<HTMLElement>(".transcript")!;
const row = (selector: string) => root.querySelector<HTMLElement>(selector)!;
const y = (selector: string) => row(selector).getBoundingClientRect().top;
const click = (selector: string) => row(selector).click();
let dispose = () => {};
// A 100px composer dock under the transcript, as SessionView passes it.
const mount = async (handle: any) => { dispose(); dispose = render(() => <Transcript handle={handle} dock={100} />, root); await settle(); await grown(); };
/** Past the first screens, turns go in a few at a time, a frame apart (Transcript's staged mount): until the count holds. */
const grown = async () => {
    for (let last = -1, same = 0, i = 0; same < 2 && i < 100; i++) {
        const n = root.querySelectorAll("[data-turn]").length;
        same = n === last ? same + 1 : 0;
        last = n;
        await settle();
    }
};
const scroll = async (value: number) => { scroller().scrollTop = value; await settle(); };

export async function checkTranscriptScroll(target: HTMLElement) {
    root = target;
    const style = root.style.cssText;
    root.style.cssText = "position:relative;width:900px;height:600px;--lane-l:20px;--lane-r:20px;--column-w:736px";
    try {
        setPrefs({ motion: "instant", showThinking: true });
        await mount(a);
        check(root.querySelectorAll("[data-turn]").length === 40, "initial page is 40 turns");
        await scroll(0);
        const before = y('[data-turn="t5"]');
        click(".earlier"); await settle();
        near(y('[data-turn="t5"]'), before, "paging preserves visible turn");
        await mount(b); await mount(a);
        near(y('[data-turn="t5"]'), before, "session restoration preserves visible turn");
        check(root.querySelectorAll("[data-turn]").length === 45, "restores page count");
        await mount(b); setView("turns", makeTurns(125)); await mount(a);
        near(y('[data-turn="t5"]'), before, "background new turns preserve reading anchor");
        setFindQuery("Reply 2:"); setFindOpen(true); await settle(); await settle();
        const matchTop = y('[data-find="b2"]');
        check(matchTop >= 0 && matchTop < 500, "find navigates and does not get restored away");
        setFindOpen(false);
        await checkFar();

        const blocks: any[] = [];
        for (let i = 0; i < 25; i++) {
            blocks.push({ t: "thinking", id: `think${i}`, text: "Reasoning", durationMs: 1000 });
            blocks.push({ t: "text", id: `note${i}`, text: `Work step ${i}\n\n${"Inspect this text. ".repeat(12)}` });
        }
        setView("turns", [{ id: "live", status: "running", archived: true, startedAt: Date.now() - 1042000, prompt: { text: "Long work" }, blocks }]);
        setView("state", { ...state, busy: true, activity: { label: "Thinking", since: Date.now() } });
        await settle();
        await scroll(scroller().scrollHeight);
        check(row(".live-line")?.textContent?.includes("Thinking"), "the live line stays at the end during a pause");
        await scroll(scroller().scrollTop + y('[data-find="note10"]') - 100);
        const workTop = y('[data-find="note10"]');
        setView("turns", 0, "status", "done"); setView("state", "busy", false); await settle();
        check(row(".worklog"), "completion retains work away from bottom");
        near(y('[data-find="note10"]'), workTop, "completion preserves text under the reader");
        await mount(b); await mount(a);
        near(y('[data-find="note10"]'), workTop, "retained work survives session switch");

        setView("turns", 0, "status", "running"); setView("state", "busy", true); await settle();
        await scroll(scroller().scrollTop + y('[data-find="note10"]') - 100);
        const awayTop = y('[data-find="note10"]');
        await mount(b);
        setView("turns", 0, "status", "done"); setView("state", "busy", false);
        await mount(a);
        near(y('[data-find="note10"]'), awayTop, "completion while away retains work and position");
        await scroll(0);
        const foldTop = y(".fold"); click(".fold"); await settle();
        near(y(".fold"), foldTop, "manual fold retains toggle position");
        click(".fold"); await settle();
        near(y(".fold"), foldTop, "manual unfold retains toggle position");
        await checkGlide();
    } finally {
        dispose();
        setFindOpen(false);
        root.style.cssText = style;
    }
}

/** Far from the view, a turn skips layout and paint at the size it was last drawn at; back near, what's in view stays put. */
async function checkFar() {
    await scroll(scroller().scrollHeight);
    const far = [...root.querySelectorAll<HTMLElement>("[data-turn][data-far]")];
    check(far.length > 60 && getComputedStyle(far[0]!).contentVisibility === "auto", `far turns skip their layout (${far.length} far)`);
    // Turns near the end drawn narrower, then skipped: back near at the full width, they're shorter.
    root.style.width = "600px"; await settle();
    for (let i = 0; i < 6; i++) await scroll(scroller().scrollTop - 500);
    root.style.width = "900px"; await scroll(scroller().scrollHeight);
    // A little each frame, as a wheel or trackpad does (a scroll event every frame), written between frames.
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        const view = scroller().getBoundingClientRect().top;
        const el = [...root.querySelectorAll<HTMLElement>("[data-turn]")].find((t) => t.getBoundingClientRect().bottom > view + 300)!;
        const before = el.getBoundingClientRect().top;
        scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        const was = scroller().scrollTop;
        scroller().scrollTop = was - 100;
        const moved = was - scroller().scrollTop;
        await frames(1);
        near(el.getBoundingClientRect().top - before, moved, `scrolling up past turns skipped at another width, what's in view moves only with the scroll (frame ${i})`);
    }
}

const frames = (n = 2) => new Promise<void>((resolve) => { const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step); });

/** Pinned to the end while a turn runs: growth lands at the end in one write, and the column glides in, clipped. */
async function checkGlide() {
    setPrefs({ motion: "quick" });
    const text = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i} of the answer.`).join("\n\n");
    setView("turns", [{ id: "glide", status: "running", startedAt: Date.now(), prompt: { text: "Go" }, blocks: [{ t: "text", id: "g0", text: text(40) }] }]);
    setView("state", { ...state, busy: true, activity: { label: "Thinking", since: Date.now() } });
    await settle();
    await scroll(scroller().scrollHeight);
    const end = () => scroller().scrollHeight - scroller().clientHeight;
    const col = row(".transcript-col");
    check(!row(".jump"), "glide: starts pinned to the end");
    setView("turns", 0, "blocks", 0, "text", text(46));
    // A frame to lay it out (the observer asks for a pin), the next to write it.
    await frames(3);
    near(scroller().scrollTop, end(), "glide: growth while pinned is at the end at once");
    const moving = row('[data-turn="glide"]').getAnimations().length;
    check(!col.getAnimations().length && moving === 1, `glide: the rows in sight glide into place, not the column (${col.getAnimations().length} on it, ${moving} on the turn)`);
    check(scroller().scrollHeight === row(".transcript-glide").offsetHeight, "glide: its translate adds nothing to what the conversation scrolls through");
    await settle();
    check(!row(".jump"), "glide: our own scroll keeps it pinned");
    // The reader scrolling up, however little, stops following; growth below doesn't move them.
    scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -4, bubbles: true }));
    scroller().scrollTop -= 4;
    await settle();
    check(row(".jump"), "glide: a scroll up unpins it");
    check(row(".jump.is-live .spinner"), "glide: Latest says the turn is still running");
    const top = scroller().scrollTop;
    setView("turns", 0, "blocks", 0, "text", text(52));
    await settle();
    near(scroller().scrollTop, top, "glide: growth doesn't pull an unpinned reader down");
    await checkOpenWhileRunning();
    setPrefs({ motion: "instant" });
}

/** Opening a command row or a tool row while the turn runs: it stays where it was clicked, nothing glides, and growth below leaves it be. */
async function checkOpenWhileRunning() {
    const text = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i} of the answer.`).join("\n\n");
    const bash = { t: "tool", id: "cmd", name: "Bash", title: "", status: "ok", durationMs: 2000, input: { command: "bun test", description: "Run the tests" }, output: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") };
    const read = { t: "tool", id: "read", name: "Read", title: "Read(a.ts)", status: "ok", input: { file_path: "a.ts" }, summary: "Read 3 lines", output: "one\ntwo\nthree" };
    for (const [id, toggle] of [["cmd", ".cmd-h"], ["read", ".tool-line"]] as const) {
        setView("turns", [{ id: "open", status: "running", startedAt: Date.now(), prompt: { text: "Go" }, blocks: [{ t: "text", id: "o0", text: text(30) }, bash, read, { t: "text", id: "o1", text: text(4) }] }]);
        setView("state", { ...state, busy: true, activity: { label: "Thinking", since: Date.now() } });
        await settle();
        // Down to the end from above, as the reader would scroll (already there, no scroll event would come).
        await scroll(0);
        await scroll(scroller().scrollHeight);
        check(!row(".jump"), `open ${id}: starts pinned to the end`);
        const el = row(`[data-find="${id}"] ${toggle}`);
        const before = el.getBoundingClientRect().top;
        el.click();
        check(el.getAttribute("aria-expanded") === "true", `open ${id}: it opens`);
        near(el.getBoundingClientRect().top, before, `open ${id}: the row stays where it was clicked`);
        await frames(3);
        near(el.getBoundingClientRect().top, before, `open ${id}: and stays there, the frames after`);
        check(![...root.querySelectorAll("[data-turn], .transcript-end")].some((n) => n.getAnimations().some((a) => !(a instanceof CSSAnimation))), `open ${id}: nothing glides`);
        check(row(".jump"), `open ${id}: the reader is reading it, so the end isn't followed`);
        // More streamed below doesn't move it.
        setView("turns", 0, "blocks", 3, "text", text(12));
        await settle();
        near(el.getBoundingClientRect().top, before, `open ${id}: growth below leaves it where it is`);
        // Folded again, it stays too.
        el.click();
        await frames(2);
        near(el.getBoundingClientRect().top, before, `fold ${id}: the row stays where it was clicked`);
    }
}
