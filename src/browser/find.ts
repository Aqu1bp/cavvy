// Find in page, for the Browser pane on a headless Chrome (the desktop app's pages use Chromium's own find). Chrome's
// DevTools protocol has no find, so a script does it, in the pane's own world in the page (Page.choiceWorld): the
// page's scripts don't see it run, and can't change what it finds. Matches are marked with the CSS Custom Highlight
// API, which paints over the text without changing the page's DOM; the current one is scrolled into view.
// It runs only when the person searches: nothing is watched or kept up to date between searches.

import { BrowserError, CHOICE_OBJECTS, type Page } from "./page";

/** The longest search, and the most matches counted and marked. */
export const MAX_QUERY = 500;
export const MAX_MATCHES = 1000;

export interface FindResult {
    matches: number;
    /** The current match, from 1; 0 when there are none. */
    active: number;
}

/**
 * Run in the page: `query` ("" clears), `step` 0 for a new search (or the same one again, as the page may have
 * changed), 1 or -1 for the next or previous match. The state is kept in this world, which goes with the page.
 */
export const FIND_JS = `(query, step, most) => {
    const KEY = "__cavvyFind", ALL = "cavvy-find", NOW = "cavvy-find-active";
    const reg = typeof CSS !== "undefined" && CSS.highlights;
    const clear = () => { if (reg) { reg.delete(ALL); reg.delete(NOW); } delete globalThis[KEY]; };
    if (!query) { clear(); return { matches: 0, active: 0 }; }
    let s = globalThis[KEY];
    if (!s || s.query !== query || step === 0) {
        const keep = s && s.query === query ? s.index : -1;
        const nodes = [], starts = [];
        let text = "";
        const seen = new Map();
        const shows = (el) => {
            if (!el) return false;
            let v = seen.get(el);
            if (v === undefined) {
                v = !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) && (typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true, opacityProperty: false }));
                seen.set(el, v);
            }
            return v;
        };
        const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.data || !shows(n.parentElement)) continue;
            nodes.push(n); starts.push(text.length); text += n.data;
        }
        const hay = text.toLowerCase(), needle = query.toLowerCase();
        const at = (i) => {
            let lo = 0, hi = starts.length - 1;
            while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
            return [nodes[lo], i - starts[lo]];
        };
        const ranges = [];
        // Lower-casing can change a string's length (rare letters): positions are then the original's, near enough.
        for (let i = hay.indexOf(needle); i >= 0 && ranges.length < most && hay.length === text.length; i = hay.indexOf(needle, i + needle.length)) {
            const r = document.createRange();
            const [a, ao] = at(i), [b, bo] = at(i + needle.length - 1);
            r.setStart(a, ao); r.setEnd(b, bo + 1);
            ranges.push(r);
        }
        // A new search starts at the first match from the top of what's in view; the same one again stays on its match.
        let index = keep >= 0 && keep < ranges.length ? keep : ranges.findIndex((r) => r.getBoundingClientRect().bottom >= 0);
        if (index < 0) index = 0;
        s = globalThis[KEY] = { query, ranges, index };
        if (reg) {
            if (!globalThis.__cavvyFindSheet) {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync("::highlight(" + ALL + "){background-color:#fde047;color:#000}::highlight(" + NOW + "){background-color:#fb923c;color:#000}");
                globalThis.__cavvyFindSheet = sheet;
            }
            if (!document.adoptedStyleSheets.includes(globalThis.__cavvyFindSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, globalThis.__cavvyFindSheet];
            reg.set(ALL, new Highlight(...ranges));
        }
    } else if (s.ranges.length) s.index = (s.index + step + s.ranges.length) % s.ranges.length;
    const n = s.ranges.length;
    if (!n) { if (reg) { reg.delete(ALL); reg.delete(NOW); } return { matches: 0, active: 0 }; }
    const r = s.ranges[s.index];
    if (reg) reg.set(NOW, new Highlight(r));
    const box = r.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth) (r.startContainer.parentElement || document.body).scrollIntoView({ block: "center", inline: "nearest" });
    return { matches: n, active: s.index + 1 };
}`;

/** Finds `query` in the page (see FIND_JS); "" clears what it marked. */
export async function findInPage(page: Page, query: string, step: number): Promise<FindResult> {
    if (query.length > MAX_QUERY) throw new BrowserError(`Searches are ${MAX_QUERY} characters at most.`);
    if (page.dialog) throw new BrowserError("The page is showing a dialog: answer it first.");
    const lost = (e: unknown) => /context/i.test(String((e as Error)?.message));
    const ask = async () => {
        // The pane's world, made as interact.ts makes it for dropdowns (Chrome says its id as it's made).
        if (!page.choiceWorld) await page.send("Page.createIsolatedWorld", { frameId: page.targetId, worldName: CHOICE_OBJECTS });
        if (!page.choiceWorld) throw new BrowserError("The page isn't ready to search yet.");
        const world = page.choiceWorld;
        try {
            return await page.send<{ result: { value?: FindResult }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: `(${FIND_JS})(${JSON.stringify(query)}, ${Math.sign(step)}, ${MAX_MATCHES})`, uniqueContextId: world, returnByValue: true }, 5000);
        } catch (e) {
            // A world that's gone while its page stays: made again next time.
            if (page.choiceWorld === world && lost(e)) page.choiceWorld = undefined;
            throw e;
        }
    };
    const r = await ask().catch((e) => (lost(e) ? ask() : Promise.reject(e)));
    const v = r.result.value;
    if (!v || typeof v.matches !== "number" || typeof v.active !== "number") throw new BrowserError("The page couldn't be searched.");
    return { matches: v.matches, active: v.active };
}
