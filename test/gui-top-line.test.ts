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
