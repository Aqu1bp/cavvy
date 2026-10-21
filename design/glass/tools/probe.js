// In-page interaction timings, for any engine (webkit-perf.ts runs it in a WKWebView; it also runs
// in Chrome). Evaluated as an async function body; `__CONFIG__` is replaced with
// { runs, only, long, short, css, settleMs }.
//
// Each interaction is dispatched synthetically (el.click(), input events) and timed:
//   script   the synchronous handler (and everything Solid does inside it)
//   gap      from there to the next frame's requestAnimationFrame (microtasks, other tasks, waiting for vsync)
//   style    in that frame: style recalc, forced with getComputedStyle
//   layout   then layout, forced with offsetHeight
//   paint    then until a task posted from the frame runs: painting and committing the frame
//   total    input to that point: the next paint
//   settled  input to the end of the last frame longer than 50ms in the settleMs after it (work that follows, like data arriving)
//   jank     time over 16.7ms summed across those frames
// Interactions: noop (the floor), settings-open, settings-back, switch-short, switch-long,
// panel-open, panel-close, terminal-open, terminal-close; then scroll (frame times while scrolling
// the transcript), typing (per keystroke) and, in the WebKit host, compositing (GPU and page
// process CPU while scrolling, with and without blur).
const CONFIG = __CONFIG__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const round = (v) => Math.round(v * 10) / 10;
if (CONFIG.css) document.head.appendChild(Object.assign(document.createElement("style"), { textContent: CONFIG.css }));

function frame() {
    return new Promise((resolve) => requestAnimationFrame(() => {
        const raf = now();
        getComputedStyle(document.documentElement).color;
        const style = now();
        void document.documentElement.offsetHeight;
        const layout = now();
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve({ raf, style, layout, painted: now() });
        ch.port2.postMessage(0);
    }));
}

async function frames(ms) {
    const out = [];
    const end = now() + ms;
    let last = now();
    while (now() < end) {
        const t = await new Promise((r) => requestAnimationFrame(r));
        out.push([last, t]);
        last = t;
    }
    return out;
}

async function measure(act) {
    const t0 = now();
    act();
    const t1 = now();
    const f = await frame();
    const r = { script: t1 - t0, gap: f.raf - t1, style: f.style - f.raf, layout: f.layout - f.style, paint: f.painted - f.layout, total: f.painted - t0 };
    const after = await frames(CONFIG.settleMs ?? 2000);
    let settled = r.total;
    let jank = 0;
    for (const [a, b] of after) {
        if (b - a > 50) settled = b - t0;
        jank += Math.max(0, b - a - 16.7);
    }
    return { ...r, settled, jank };
}

const $ = (sel, text) => [...document.querySelectorAll(sel)].find((e) => !text || (e.getAttribute("aria-label") ?? e.textContent).trim().startsWith(text));
const click = (sel, text) => () => {
    const el = $(sel, text);
    if (!el) throw new Error(`nothing to click: ${sel} ${text ?? ""}`);
    el.click();
};
const shown = (sel) => Boolean(document.querySelector(sel)?.offsetHeight);
const settle = () => sleep(1200);

const INTERACTIONS = {
    // Nothing to do: the frame latency any interaction pays (waiting for the display's next frame).
    noop: { before: () => {}, act: () => document.body.dispatchEvent(new Event("perf-noop")) },
    "settings-open": { before: () => shown(".set-back") && click(".set-back")(), act: click('button[aria-label="Settings"]') },
    "settings-back": { before: () => !shown(".set-back") && click('button[aria-label="Settings"]')(), act: click(".set-back") },
    "switch-short": { before: () => click(".win-rail .card-hit", CONFIG.long)(), act: click(".win-rail .card-hit", CONFIG.short) },
    "switch-long": { before: () => click(".win-rail .card-hit", CONFIG.short)(), act: click(".win-rail .card-hit", CONFIG.long) },
    "panel-open": { before: () => shown(".insp-resizer") && click('button[aria-label="Toggle panel"]')(), act: click('button[aria-label="Toggle panel"]') },
    "panel-close": { before: () => !shown(".insp-resizer") && click('button[aria-label="Toggle panel"]')(), act: click('button[aria-label="Toggle panel"]') },
    "terminal-open": { before: () => shown(".terminal-panel") && click('button[aria-label="Hide terminal"]')(), act: click('button[aria-label="Toggle terminal"]') },
    "terminal-close": { before: () => !shown(".terminal-panel") && click('button[aria-label="Toggle terminal"]')(), act: click('button[aria-label="Hide terminal"]') },
};

/** 90 frames of scrolling up the transcript, 80px a frame, from its end. */
async function scroll() {
    const s = document.querySelector(".transcript");
    s.scrollTop = s.scrollHeight;
    await sleep(500);
    const gaps = [];
    let last = await new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 90; i++) {
        s.scrollTop -= 80;
        const t = await new Promise((r) => requestAnimationFrame(r));
        gaps.push(t - last);
        last = t;
    }
    gaps.sort((a, b) => a - b);
    const vsync = gaps[Math.floor(gaps.length / 2)];
    return { p50: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps.at(-1), dropped: gaps.filter((g) => g > vsync * 1.5).length, total: gaps.reduce((a, b) => a + b, 0) };
}

/**
 * WebKit host only: the GPU and web-content processes' CPU time per second (ms/s) while idle, while
 * scrolling the transcript, and while scrolling with every backdrop-filter off. What blur costs
 * shows here rather than in frame times: compositing runs in the GPU process.
 */
async function compositing() {
    const cpu = () => window.webkit.messageHandlers.cpu.postMessage("");
    const s = document.querySelector(".transcript");
    const noBlur = Object.assign(document.createElement("style"), { textContent: "*,*::before,*::after{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}" });
    const window_ = async (label, scrolling) => {
        s.scrollTop = s.scrollHeight;
        await sleep(400);
        const a = await cpu();
        const t0 = now();
        let dir = -1;
        let top = s.scrollTop;
        while (now() - t0 < 6000) {
            if (scrolling) {
                top += dir * 60;
                if (top < s.scrollHeight - s.clientHeight - 3000 || top > s.scrollHeight - s.clientHeight) dir = -dir;
                s.scrollTop = top;
            }
            await new Promise((r) => requestAnimationFrame(r));
        }
        const b = await cpu();
        const secs = (now() - t0) / 1000;
        return { [`${label}Gpu`]: ((b.gpu - a.gpu) * 1000) / secs, [`${label}Web`]: ((b.web - a.web) * 1000) / secs };
    };
    const idle = await window_("idle", false);
    const blur = await window_("scroll", true);
    document.head.appendChild(noBlur);
    const flat = await window_("noblur", true);
    noBlur.remove();
    return { ...idle, ...blur, ...flat, total: blur.scrollGpu };
}

/** 30 characters typed into the composer; per keystroke, input to next paint. */
async function typing() {
    const ta = document.querySelector(".composer-box textarea");
    ta.focus();
    await sleep(200);
    const per = [];
    for (const ch of "please refactor the auth module") {
        const t0 = now();
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        ta.setRangeText(ch, ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        const t1 = now();
        const f = await frame();
        per.push({ script: t1 - t0, gap: f.raf - t1, style: f.style - f.raf, layout: f.layout - f.style, paint: f.painted - f.layout, total: f.painted - t0 });
        await sleep(40);
    }
    ta.setRangeText("", 0, ta.value.length, "end");
    ta.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
    const med = (k) => per.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(per.length / 2)];
    return { script: med("script"), gap: med("gap"), style: med("style"), layout: med("layout"), paint: med("paint"), total: med("total"), p95: per.map((p) => p.total).sort((a, b) => a - b)[Math.floor(per.length * 0.95)] };
}

// The long session, at its end.
click(".win-rail .card-hit", CONFIG.long)();
await sleep(3000);
const nodes = document.getElementsByTagName("*").length;

const names = CONFIG.only ?? [...Object.keys(INTERACTIONS), "scroll", "typing", ...(window.webkit?.messageHandlers?.cpu ? ["compositing"] : [])];
const results = {};
for (const name of names) {
    const runs = [];
    for (let i = 0; i < CONFIG.runs; i++) {
        if (name === "scroll") runs.push(await scroll());
        else if (name === "compositing") runs.push(await compositing());
        else if (name === "typing") runs.push(await typing());
        else {
            const it = INTERACTIONS[name];
            it.before();
            await settle();
            runs.push(await measure(it.act));
        }
        await sleep(300);
    }
    const key = name === "scroll" ? "p95" : "total";
    runs.sort((a, b) => a[key] - b[key]);
    const m = runs[Math.floor(runs.length / 2)];
    results[name] = { ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)])), runs: runs.map((r) => round(r[key])) };
}
if (shown(".set-back")) click(".set-back")();
return JSON.stringify({ engine: navigator.userAgent, nodes, results });
