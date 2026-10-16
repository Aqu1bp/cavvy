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
const mount = async (handle: any) => { dispose(); dispose = render(() => <Transcript handle={handle} />, root); await settle(); };
const scroll = async (value: number) => { scroller().scrollTop = value; await settle(); };

export async function checkTranscriptScroll(target: HTMLElement) {
    root = target;
    const style = root.style.cssText;
    root.style.cssText = "position:relative;width:900px;height:600px;--dock-h:100px;--lane-l:20px;--lane-r:20px;--column-w:736px";
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

        const blocks: any[] = [];
        for (let i = 0; i < 25; i++) {
            blocks.push({ t: "thinking", id: `think${i}`, text: "Reasoning", durationMs: 1000 });
            blocks.push({ t: "text", id: `note${i}`, text: `Work step ${i}\n\n${"Inspect this text. ".repeat(12)}` });
        }
        setView("turns", [{ id: "live", status: "running", archived: true, startedAt: Date.now() - 1042000, prompt: { text: "Long work" }, blocks }]);
        setView("state", { ...state, busy: true, activity: { label: "Thinking", since: Date.now() } });
        await settle();
        await scroll(scroller().scrollHeight);
        check(row(".live-tail")?.textContent?.includes("Thinking"), "working tail remains during pause");
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
    } finally {
        dispose();
        setFindOpen(false);
        root.style.cssText = style;
    }
}
