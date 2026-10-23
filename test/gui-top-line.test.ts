// One centre line across the top of the window (--top-line, gui/src/styles/tokens.css): the macOS
// traffic lights, the rail's two buttons and the title bar sit on it, at either density.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRules } from "./helpers/contrast";

const root = join(import.meta.dir, "..");
const css = (file: string) => parseRules(readFileSync(join(root, "gui/src/styles", file), "utf8"));
const decl = (rules: ReturnType<typeof css>, selector: string, property: string) => rules.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);
const px = (v: string | undefined) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v ?? "")?.[1] ?? NaN);

const tokens = css("tokens.css");
const line = px(decl(tokens, ":root", "--top-line"));
const winPad = px(decl(css("shell.css"), ".app", "--win-pad"));

test("the traffic lights are placed on the line", () => {
    const conf = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    const { y } = conf.app.windows[0].trafficLightPosition;
    // Measured in the app (WKWebView, macOS 27): the lights' centre is 2pt above trafficLightPosition.y.
    expect(y - 2).toBe(line);
});

test("the title bar's content is centred on the line at both densities", () => {
    const padding = decl(css("header.css"), ".header", "padding")!;
    // padding-top: max(0px, 2 * (L - win-pad) - header-h): with align-items: center the content's
    // centre is (h + padding-top) / 2 below the bar's top, which is win-pad below the window's.
    expect(padding).toBe("max(0px, 2 * (var(--top-line) - var(--win-pad, 8px)) - var(--header-h)) 9px 0 20px");
    for (const selector of [":root", '[data-density="compact"]']) {
        const h = px(decl(tokens, selector, "--header-h"));
        const top = Math.max(0, 2 * (line - winPad) - h);
        expect({ selector, centre: winPad + (h + top) / 2 }).toEqual({ selector, centre: line });
    }
});

test("the rail's top row is centred on the line", () => {
    expect(decl(css("sidebar.css"), ".side-top", "height")).toBe("calc(2 * (var(--top-line) - var(--win-pad, 8px)))");
    expect(winPad + (2 * (line - winPad)) / 2).toBe(line);
});

// #367: maximized, the terminal is the whole sheet, so its toolbar is the window's top row.
test("a maximized terminal's toolbar sits on the line, clear of the traffic lights wherever they're over the sheet", () => {
    const term = css("terminal.css");
    const height = decl(term, ".terminal-panel.max .terminal-toolbar", "height");
    expect(height).toBe("calc(2 * (var(--top-line) - var(--win-pad, 8px)))");
    // align-items: center puts the tabs' centre half its height below the sheet's top (win-pad).
    expect(decl(term, ".terminal-toolbar", "align-items")).toBe("center");
    expect(winPad + (2 * (line - winPad)) / 2).toBe(line);
    // The lights are over the sheet when the rail is hidden or a drawer: the toolbar starts where the title bar's buttons do.
    const header = css("header.css");
    const titleBar = decl(header, ".header.traffic.rail-off", "padding-left");
    expect(decl(header, '[data-rail="overlay"] .header.traffic', "padding-left")).toBe(titleBar);
    for (const selector of [".app.tauri.os-macos.rail-off .terminal-panel.max .terminal-toolbar", '.app.tauri.os-macos[data-rail="overlay"] .terminal-panel.max .terminal-toolbar']) {
        expect({ selector, left: decl(term, selector, "padding-left") }).toEqual({ selector, left: titleBar });
    }
    // The lights end 78px from the window's left (header.css); the sheet starts win-pad in.
    expect(winPad + px(titleBar)).toBeGreaterThan(78);
});
